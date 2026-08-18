import { existsSync } from "fs";
import { appendFile, mkdir, readFile, realpath, stat, utimes, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { createConnection } from "net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "path";
import {
  discoverLaunchpadApps,
  runtimeScriptPortAuthorityIssues,
  runtimeSourcePortAuthorityIssues,
} from "./discovery-lib.mjs";
import { materializeRuntimeFromModule, normalizeModuleManifest } from "../../lazurio/core/module-contract-lib.mjs";
import { normalizePackageRuntime } from "../../lazurio/core/runtime-contract-lib.mjs";
import { recordAppOpen } from "./usage-lib.mjs";
import { buildWorktreeIndex } from "./worktree-lib.mjs";
import { acquireModuleRuntimeLock } from "./module-runtime-lock-lib.mjs";
import { trustedWindowsSystemExecutable } from "./windows-system-path-lib.mjs";
import {
  buildDesiredModuleState,
  listDesiredModuleStates,
  normalizeDesiredSource,
  readDesiredModuleState,
  writeDesiredModuleState,
} from "./desired-module-state-lib.mjs";

const healthTimeoutMs = 1_200;
const startGraceMs = 30_000;
const startEarlyExitProbeMs = 1_000;
// One-click open (CAC-0044): po startu pollujeme health, dokud port neposlouchá,
// aby URL vrácené frontendu vedlo na živý server, ne na „connection refused".
// Bounded oknem (dev servery vite/next běžně startují 2–5 s), s poll intervalem.
const openHealthyWaitMs = 20_000;
const openHealthyPollMs = 250;
const openHealthyStabilityMs = 1_000;
const listenerReconciliationCacheMs = 1_000;
const windowsOwnerProofCaptureAttempts = 3;
const windowsProcessIdentityTimeoutMs = 5_000;
const stopTimeoutMs = 5_000;
const stopKillWaitMs = 2_000;
const portReclaimTermWaitMs = 1_500;
const portReclaimKillWaitMs = 1_500;
const portReclaimAttempts = 4;
const portOccupancyProbeTimeoutMs = 250;
const logTailBytes = 40_000;
const errorTailBytes = 4_000;
const packageLockfileNames = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const supportedInstallManagers = new Set(["bun"]);

export function runtimeHostsShareListener(left, right) {
  return canonicalRuntimeListenerHost(left) === canonicalRuntimeListenerHost(right);
}

export function canonicalRuntimeListenerHost(host) {
  const value = String(host ?? "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return value === "localhost" ? "127.0.0.1" : value;
}

export function runtimeUrlHost(host) {
  const value = String(host ?? "");
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

export function observedListenerMatchesDeclaration(observed, declared) {
  return Number.isInteger(observed?.port)
    && observed.port === declared?.port
    && runtimeHostsShareListener(observed.host, declared?.host);
}

export function moduleRuntimeLeaseMatches(left, right) {
  return typeof left?.company === "string"
    && left.company !== ""
    && left.company === right?.company
    && typeof left?.module === "string"
    && left.module !== ""
    && left.module === right?.module;
}

export function selectManagedModuleStopRecord(records, app) {
  const matches = [...records].filter((record) =>
    moduleRuntimeLeaseMatches(record?.runtimeApp, app)
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  throw new RuntimeActionError(
    409,
    "app_stop_ambiguous",
    `${app.title ?? app.id}: Launchpad found multiple managed runtimes for the same module lease and did not stop any of them.`,
    matches.map((record) =>
      `runtime_key: ${record.runtimeKey}; source: ${record.runtimeSource?.type ?? "unknown"}${record.runtimeSource?.slug ? `/${record.runtimeSource.slug}` : ""}`
    ),
    {
      failure_kind: "ambiguous_managed_module_runtime",
      module_lease_key: `${app.company}/${app.module}`,
      runtime_keys: matches.map((record) => record.runtimeKey),
    },
  );
}

export function runtimeListenerHasStaticLease(app, listener) {
  return app?.runtime_contract?.schema_version === "lazurio.runtime.v1"
    && app?.personal !== true
    && app?.module_contract?.schema_version === "lazurio.module.v1"
    && listener?.module_lease?.source === app.module_contract.module_path
    && listener?.allocation === "static"
    && Number.isInteger(listener?.port)
    && listener?.claim?.mode === "exclusive";
}

export function runtimeListenerState(app) {
  return (app?.listeners ?? []).map((listener) => ({
    id: listener.id,
    role: listener.role,
    allocation: listener.allocation,
    host: listener.host,
    port: Number.isInteger(listener.port) ? listener.port : null,
    protocol: listener.protocol,
    health: listener.health,
    claim: listener.claim,
  }));
}

export function withRuntimeListenerPorts(app, portsById, { allocation = null } = {}) {
  const listeners = (app?.listeners ?? []).map((listener) => {
    const port = portsById instanceof Map ? portsById.get(listener.id) : portsById?.[listener.id];
    return Number.isInteger(port)
      ? { ...listener, ...(allocation ? { allocation } : {}), port }
      : listener;
  });
  const entrypoint = listeners.find((listener) => listener.id === app?.entrypoint_listener?.id)
    ?? app?.entrypoint_listener;
  return {
    ...app,
    port: entrypoint?.port ?? null,
    host: entrypoint?.host ?? app.host,
    health_path: entrypoint?.health?.kind === "http" ? entrypoint.health.path : "/",
    listeners,
    entrypoint_listener: entrypoint,
    ...(app.runtime_contract
      ? { runtime_contract: { ...app.runtime_contract, listeners } }
      : {}),
  };
}

export function parseProcessGroupListeners(output) {
  const listeners = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const endpoint = line.slice(1).replace(/^TCP\s+/i, "").replace(/\s+\(LISTEN\)$/i, "");
    const port = endpointPort(endpoint);
    if (!Number.isInteger(port)) continue;
    const host = endpoint.slice(0, endpoint.lastIndexOf(":"))
      .replace(/^\[(.*)\]$/, "$1")
      .toLowerCase();
    listeners.push({ endpoint, host, port });
  }
  return listeners.filter((listener, index, all) =>
    all.findIndex((candidate) => candidate.endpoint === listener.endpoint) === index,
  );
}

export class RuntimeActionError extends Error {
  constructor(status, code, message, details = [], metadata = {}) {
    super(message);
    this.name = "RuntimeActionError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.metadata = metadata;
  }
}

// `discover` je injektovatelná discovery funkce se stejným kontraktem jako
// discoverLaunchpadApps ({ apps, invalid_apps, failures }). Default je org lane;
// personalspace lane (CAC-0048) předává vlastní discovery, aby osobní aplikace
// běžely přes stejný runtime engine, ale zůstaly úplně oddělené od org
// auto-discovery. Osobní aplikace mají prefixované id (personal--…), takže se
// runtime stav/logy v žádném namespace nekříží s org aplikacemi.
export function createRuntimeManager({
  companiesRoot,
  launchpadRoot,
  instanceId = randomUUID(),
  discover = discoverLaunchpadApps,
  resolvePortOwnerFn = resolvePortOwner,
  probeNumericPortOccupiedFn = probeNumericPortOccupied,
  resolveObservedPortBindingsFn = null,
  platform = process.platform,
  systemEnvironment = process.env,
  spawnProcess = Bun.spawn,
  spawnProcessIsNative = spawnProcess === Bun.spawn,
  runSystemCommandFn = runCommand,
  resolveProcessIdentityFn = null,
  signalProcessGroupFn = null,
  signalManagedProcessFn = null,
  processGroupAliveFn = null,
  signalPortOwnerFn = null,
  resolvePortOwnerProcessGroupFn = null,
  acquireModuleLockFn = acquireModuleRuntimeLock,
  startedListenerOwnershipTimeoutMs = startGraceMs,
  writeRuntimeStateFile = writeFile,
  bunExecutable = null,
  desiredRestartDelaysMs = [250, 1_000, 5_000],
  desiredRestartStableMs = 30_000,
  sleepFn = sleep,
  writeDesiredModuleStateFn = writeDesiredModuleState,
}) {
  const runtimeBunExecutable = bunExecutable
    ?? (platform === process.platform ? resolveBunExecutable() : resolveBunExecutable({ platform }));
  const managedProcesses = new Map();
  const moduleLeaseLocks = new Map();
  const desiredRestartTrackers = new Map();
  const runtimeRoot = join(launchpadRoot, "runtime");
  const appStateRoot = join(runtimeRoot, "apps");
  const desiredStateRoot = join(runtimeRoot, "desired-modules");
  const moduleLockRoot = join(runtimeRoot, "module-locks");
  const takeoverAuditRoot = join(runtimeRoot, "audit");
  const takeoverAuditPath = join(takeoverAuditRoot, "takeovers.jsonl");
  const logsRoot = join(launchpadRoot, "logs", "apps");
  const processIdentityResolver = resolveProcessIdentityFn
    ?? ((pid) => resolveProcessIdentity(pid, {
      platform,
      runCommandFn: runSystemCommandFn,
      env: systemEnvironment,
    }));
  const processGroupSignaler = signalProcessGroupFn
    ?? ((processGroupId, signal, record) => spawnProcessIsNative
      ? process.kill(-processGroupId, signal)
      : record.child.kill(signal));
  const processGroupAlive = processGroupAliveFn
    ?? ((processGroupId) => {
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        if (error?.code === "EPERM") return true;
        throw error;
      }
    });
  const portOwnerProcessGroupResolver = resolvePortOwnerProcessGroupFn
    ?? ((pid) => resolvePosixProcessGroupId(pid, { runCommandFn: runSystemCommandFn }));
  const observedPortBindingsResolver = resolveObservedPortBindingsFn
    ?? ((port) => resolveObservedPortBindings(port, {
      // Listener observation runs on the actual host OS. `platform` above is
      // injectable for lifecycle semantics in cross-platform contract tests;
      // using that simulated value here would try Windows netstat on Linux or
      // macOS instead of observing the real fixture socket.
      platform: process.platform,
      runCommandFn: runSystemCommandFn,
      env: systemEnvironment,
    }));
  const portOwnerSignaler = signalPortOwnerFn
    ?? (async (pid, signal, context = {}) => {
      if (platform === "win32") {
        const result = await runSystemCommandFn(windowsTaskkillCommand(pid, {
          force: signal === "SIGKILL",
          env: systemEnvironment,
        }));
        if (!result.ok && !isMissingProcessResult(result)) {
          if (signal === "SIGTERM") {
            return { process_group_id: null, method: "taskkill-tree-grace-missed" };
          }
          throw new Error(result.stderr || result.error || `taskkill failed for PID ${pid}`);
        }
        return { process_group_id: null, method: "taskkill-tree" };
      }
      const processGroupId = context.owner?.process_group_id
        ?? await portOwnerProcessGroupResolver(pid);
      if (!Number.isInteger(processGroupId) || processGroupId <= 1) {
        throw new Error(`process group nebyla pro PID ${pid} zjištěna`);
      }
      const launchpadProcessGroupId = await portOwnerProcessGroupResolver(process.pid);
      if (processGroupId === launchpadProcessGroupId) {
        throw new Error(`PID ${pid} sdílí process group ${processGroupId} s Launchpadem; group takeover by ukončil i Launchpad`);
      }
      try {
        process.kill(-processGroupId, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      return { process_group_id: processGroupId, method: "posix-process-group" };
    });
  const requireTakeoverIdentity = signalPortOwnerFn == null;

  async function portOwnerIdentity(pid) {
    if (!requireTakeoverIdentity) return "injected-signaler";
    if (platform === "win32") return processIdentityResolver(pid);
    const result = await runSystemCommandFn(["ps", "-o", "lstart=", "-p", String(pid)]);
    const startedAt = result.ok ? String(result.stdout ?? "").trim() : "";
    return startedAt ? `posix:${startedAt}` : null;
  }

  function samePortOwnerIdentity(left, right) {
    return left != null && right != null && JSON.stringify(left) === JSON.stringify(right);
  }

  async function appsWithRuntime(apps) {
    return Promise.all(
      apps.map(async (app) => {
        const runtime = await healthForApp(app);
        const dependencies = runtime.dependencies;
        const portsById = new Map(
          (runtime.listeners ?? [])
            .filter((listener) => typeof listener?.id === "string" && Number.isInteger(listener.port))
            .map((listener) => [listener.id, listener.port]),
        );
        const materializedApp = withRuntimeListenerPorts(app, portsById);
        return {
          ...materializedApp,
          host: runtime.host ?? materializedApp.host,
          port: runtime.port ?? materializedApp.port,
          url: runtime.url,
          health_url: runtime.health_url,
          dependencies,
          dependency_status: dependencies.state,
          runtime,
          runtime_status: runtime.status,
        };
      }),
    );
  }

  async function health(appId, options = {}) {
    const app = await runtimeAppForAction(appId, { ...options, requireValidDiscovery: false });
    return healthForApp(app);
  }

  async function start(appId, options = {}) {
    const app = await runtimeAppForAction(appId, { ...options, enforcePortContract: true });
    return startRuntimeApp(app);
  }

  // Compatibility endpoint for older Launchpad clients. A switch is now only
  // a named replacement between two versions of the same module lease. Normal
  // Start/Open already performs the same replacement without a separate dialog.
  async function switchApp(appId, { replace_app_id: replaceAppId = null, confirmed = false, source = null } = {}) {
    if (confirmed !== true) {
      throw new RuntimeActionError(
        400,
        "app_switch_confirmation_required",
        "Přepnutí aplikace vyžaduje výslovné potvrzení uživatele.",
      );
    }
    if (typeof replaceAppId !== "string" || replaceAppId.trim() === "" || replaceAppId === appId) {
      throw new RuntimeActionError(
        400,
        "invalid_app_switch",
        "Přepnutí vyžaduje id jiné známé aplikace, která nyní používá stejný port.",
      );
    }

    const target = await runtimeAppForAction(appId, { source, enforcePortContract: true });
    const replaced = await runtimeAppForAction(replaceAppId.trim(), { source: { type: "main" } });
    if (!moduleRuntimeLeaseMatches(target, replaced)) {
      throw new RuntimeActionError(
        409,
        "app_switch_module_mismatch",
        "Přepnutí portu je povolené jen mezi verzemi stejného modulu.",
        [`target_app: ${target.id}`, `replace_app: ${replaced.id}`],
      );
    }
    if (target.port !== replaced.port) {
      throw new RuntimeActionError(
        409,
        "app_switch_port_mismatch",
        `${target.title} a ${replaced.title} nesdílejí stejný app-owned port.`,
        [`target_port: ${target.port}`, `replace_port: ${replaced.port}`],
      );
    }

    const started = await startRuntimeApp(target);
    return {
      action: "switch",
      app_id: target.id,
      replaced_app_id: replaced.id,
      port: target.port,
      stopped: started.reclaimed_listeners?.some((listener) => listener.method === "managed-stop") ?? false,
      started,
      runtime: started.runtime,
      url: started.runtime?.url ?? appUrl(target),
    };
  }

  async function startRuntimeApp(app) {
    return withModuleLeaseLock(app, async () => {
      const result = await startRuntimeAppUnlocked(app, { trigger: "user" });
      let desired;
      try {
        desired = await acceptDesiredRuntime(app);
      } catch (error) {
        await stopRuntimeAppUnlocked(app).catch(() => {});
        throw desiredPersistenceError(app, error);
      }
      resetDesiredRestartTracker(app);
      return { ...result, desired };
    });
  }

  async function startRuntimeAppUnlocked(app, { trigger = "user" } = {}) {
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    app = await materializeRuntimeListeners(app);
    if (managedProcesses.has(runtimeKey)) {
      throw new RuntimeActionError(409, "already_managed", "Aplikace už běží jako managed proces.");
    }

    const dependencies = await dependencyForApp(app);
    if (!dependencies.can_start) {
      throw new RuntimeActionError(409, "app_not_ready", dependencies.message, [
        `dependency_state: ${dependencies.state}`,
        `cwd: ${dependencies.cwd}`,
        dependencies.install_command_display ? `install: ${dependencies.install_command_display}` : "install: unavailable",
      ], {
        failure_kind: dependencies.state === "needs_install" ? "missing_dependencies" : dependencies.state,
        dependencies,
      });
    }

    await ensureRuntimeDirs();
    const logPath = logPathForApp(runtimeKey);
    const startedAt = new Date().toISOString();
    await appendLog(logPath, `\n[launchpad] ${startedAt} start ${app.id} source=${runtimeSource.type} key=${runtimeKey}\n`);
    const reclaimedListeners = await prepareDeclaredListeners(app, {
      runtimeKey,
      logPath,
    });
    const childEnv = runtimeProcessEnv(app, {
      PORT: String(app.port),
      HOST: app.host,
      LAZURIO_RUNTIME_SCHEMA_VERSION: app.runtime_contract?.schema_version ?? "companyascode.launchpad_app.v1",
      LAZURIO_RUNTIME_APP_ID: app.id,
      LAZURIO_RUNTIME_ENTRYPOINT_ID: app.entrypoint_listener?.id ?? "entrypoint",
      LAZURIO_RUNTIME_PORT: String(app.port),
      LAZURIO_RUNTIME_HOST: app.host,
      COMPANIES_WORKSPACE_ROOT: companiesRoot,
      COMPANYASCODE_APP_ID: app.id,
      COMPANYASCODE_RUNTIME_KEY: runtimeKey,
      COMPANYASCODE_RUNTIME_SOURCE: runtimeSource.type,
      ...(runtimeSource.slug ? { COMPANYASCODE_WORKTREE_SLUG: runtimeSource.slug } : {}),
    });

    let child;
    try {
      child = spawnProcess([runtimeBunExecutable, "run", app.dev_script], {
        cwd: join(companiesRoot, app.cwd),
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        detached: platform !== "win32",
      });
    } catch (error) {
      const failureKind = existsSync(join(companiesRoot, app.cwd)) ? "start_spawn_failed" : "bad_cwd";
      const message = `${app.title} nejde spustit: ${failureKind === "bad_cwd" ? `cwd ${app.cwd} neexistuje` : error.message}.`;
      await appendLog(logPath, `[launchpad] start spawn failed ${app.id}: ${error.message}\n`);
      await writeState(runtimeKey, {
        status: "unhealthy",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        port: app.port,
        instance_id: instanceId,
        updated_at: new Date().toISOString(),
        log_path: relativeRuntimePath(logPath),
        last_error: message,
        failure_kind: failureKind,
      });
      throw new RuntimeActionError(500, "app_start_failed", message, [error.message], {
        failure_kind: failureKind,
        cwd: join(companiesRoot, app.cwd),
        log_path: relativeRuntimePath(logPath),
      });
    }

    const record = {
      appId: app.id,
      runtimeKey,
      runtimeSource,
      child,
      pid: child.pid,
      port: app.port,
      runtimeApp: app,
      listeners: app.listeners ?? [],
      processGroupId: platform === "win32" ? null : child.pid,
      startedAt,
      logPath,
      stopping: false,
      exitFinalizing: false,
      finalizeStopOnExit: false,
      finalizeStopForced: false,
      stopExitConfirmed: false,
      stopExitCode: null,
      stopFinalizationReady: false,
      stopFinalizationOptions: null,
      stopFinalizationPromise: null,
      ownerProofCaptured: false,
      ownerProof: null,
      startTrigger: trigger,
      outputPipes: [],
    };
    managedProcesses.set(runtimeKey, record);
    record.outputPipes = [
      pipeOutput(child.stdout, logPath, "stdout"),
      pipeOutput(child.stderr, logPath, "stderr"),
    ];

    await writeState(runtimeKey, {
      status: "starting",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      port: app.port,
      pid: child.pid,
      process_group_id: record.processGroupId,
      listeners: runtimeListenerState(app),
      instance_id: instanceId,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      log_path: relativeRuntimePath(logPath),
    });

    if (platform === "win32") {
      // Launcher identity se začne číst hned po spawnu. Když wrapper předá
      // listener potomkovi a sám skončí, pozdější CIM už jeho PID nemusí znát;
      // capture-time ancestry proto smí poslední článek svázat s touto časnou,
      // creation-time-bound identitou místo s právě reuse-nutým PID.
      // Injektovaný command adapter bez identity resolveru může být úzce
      // určený jen pro taskkill; neposíláme mu nový PowerShell kontrakt potají.
      record.launcherIdentityPromise = resolveProcessIdentityFn || runSystemCommandFn === runCommand
        ? Promise.resolve()
            .then(() => processIdentityResolver(record.pid))
            .then(normalizeWindowsProcessIdentity)
            .catch(() => null)
        : Promise.resolve(null);
      record.ownerProofPromise = persistWindowsRuntimeOwnerProofWhenHealthy(app, record).catch(async (error) => {
        try {
          await appendLog(logPath, `[launchpad] Windows owner proof capture failed ${app.id}: ${error.message}\n`);
        } catch {}
      });
    }

    const finalizeLauncherExit = async (exitCode, { early = false } = {}) => {
      if (record.stopping) {
        record.stopExitConfirmed = true;
        record.stopExitCode = exitCode;
        if (record.finalizeStopOnExit) {
          await finalizeDeferredManagedStop(app, record, runtimeKey, runtimeSource, {
            exitCode,
            forced: record.finalizeStopForced,
          });
        }
        return { survivingListenerProof: null, failure: null, log_excerpt: "" };
      }
      record.exitFinalizing = true;
      const survivingListenerProof = platform === "win32"
        ? await windowsProofForSurvivingListener(app, record)
        : await posixProofForSurvivingProcessGroup(app, record);
      const retainsManagedProcessGroup = platform !== "win32" && Boolean(survivingListenerProof);
      const currentRecord = managedProcesses.get(runtimeKey);
      if (currentRecord === record && !retainsManagedProcessGroup) {
        managedProcesses.delete(runtimeKey);
      }
      if (record.ownerProofWritePromise) {
        await Promise.allSettled([record.ownerProofWritePromise]);
      }
      if (!retainsManagedProcessGroup) {
        await Promise.allSettled(record.outputPipes);
      }
      await appendLog(logPath, `[launchpad] ${new Date().toISOString()} exit ${app.id} source=${runtimeSource.type} code=${exitCode}\n`);
      const log_excerpt = await logTail(logPath, errorTailBytes);
      const failure = early || exitCode !== 0 ? startFailure(app, exitCode, log_excerpt) : null;
      const updatedAt = new Date().toISOString();
      const previousState = await readState(runtimeKey);
      const preservedLazurioEvidence = app.module_contract?.schema_version === "lazurio.module.v1"
        ? {
            active_source: previousState?.active_source,
            process_group_id: previousState?.process_group_id,
            listeners: previousState?.listeners,
            listener_ownership: previousState?.listener_ownership,
            takeover_audit: previousState?.takeover_audit,
          }
        : {};
      await writeState(runtimeKey, survivingListenerProof ? {
        ...preservedLazurioEvidence,
        status: "healthy",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        port: app.port,
        pid: survivingListenerProof.listener_pid,
        launcher_pid: child.pid,
        launcher_exit_code: exitCode,
        instance_id: instanceId,
        started_at: startedAt,
        updated_at: updatedAt,
        log_path: relativeRuntimePath(logPath),
        owner_proof: survivingListenerProof,
      } : {
        status: failure ? "unhealthy" : "stopped",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        port: app.port,
        pid: child.pid,
        instance_id: instanceId,
        started_at: startedAt,
        stopped_at: updatedAt,
        updated_at: updatedAt,
        exit_code: exitCode,
        log_path: relativeRuntimePath(logPath),
        ...(failure ? { last_error: failure.message, failure_kind: failure.kind, log_excerpt } : {}),
      });
      if (retainsManagedProcessGroup) {
        record.launcherExited = true;
        record.stopExitConfirmed = true;
        record.stopExitCode = exitCode;
        record.exitFinalizing = false;
      } else {
        queueDesiredRuntimeRestart(app, record, exitCode);
      }
      return { survivingListenerProof, failure, log_excerpt };
    };

    const earlyExit = await waitForEarlyExit(child, startEarlyExitProbeMs);
    let earlySurvivingListenerProof = null;
    if (earlyExit !== null) {
      record.exitFinalizationPromise = finalizeLauncherExit(earlyExit, { early: true });
      const finalization = await record.exitFinalizationPromise;
      if (!finalization.survivingListenerProof) {
        throw new RuntimeActionError(500, "app_start_failed", finalization.failure.message, [
          finalization.log_excerpt,
        ].filter(Boolean), {
          failure_kind: finalization.failure.kind,
          exit_code: earlyExit,
          log_path: relativeRuntimePath(logPath),
          log_excerpt: finalization.log_excerpt,
        });
      }
      earlySurvivingListenerProof = finalization.survivingListenerProof;
    } else {
      record.exitFinalizationPromise = child.exited
        .then((exitCode) => finalizeLauncherExit(exitCode))
        .catch(async (error) => {
          record.exitFinalizing = false;
          await appendLog(logPath, `[launchpad] exit finalization failed ${app.id}: ${error.message}\n`);
        });
    }

    let ownershipProof;
    try {
      ownershipProof = app.module_contract?.schema_version === "lazurio.module.v1"
        ? await verifyStartedListenerOwnership(app, record, {
            timeoutMs: startedListenerOwnershipTimeoutMs,
          })
        : [];
    } catch (error) {
      try {
        await stopRuntimeAppUnlocked(app);
      } catch {}
      throw error;
    }

    if (app.module_contract?.schema_version === "lazurio.module.v1") {
      if (managedProcesses.get(runtimeKey) !== record || record.stopping) {
        throw new RuntimeActionError(
          409,
          "app_start_superseded",
          `${app.title}: start transakce byla mezitím zastavena nebo nahrazena.`,
          [`runtime_key: ${runtimeKey}`, `pid: ${record.pid}`],
          { failure_kind: "start_superseded" },
        );
      }
      const transactionAudit = {
        schema_version: "lazurio.runtime_takeover_audit.v1",
        transaction_id: randomUUID(),
        company: app.company,
        module: app.module,
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        launcher_pid: child.pid,
        process_group_id: record.processGroupId,
        listeners: ownershipProof,
        reclaimed_listeners: reclaimedListeners,
        completed_at: new Date().toISOString(),
      };
      await writeState(runtimeKey, {
        status: earlySurvivingListenerProof ? "healthy" : "starting",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        active_source: runtimeSource,
        port: app.port,
        pid: earlySurvivingListenerProof?.listener_pid ?? child.pid,
        ...(earlySurvivingListenerProof ? {
          launcher_pid: child.pid,
          launcher_exit_code: earlyExit,
          owner_proof: earlySurvivingListenerProof,
        } : {}),
        process_group_id: record.processGroupId,
        listeners: runtimeListenerState(app),
        listener_ownership: ownershipProof,
        takeover_audit: reclaimedListeners,
        instance_id: instanceId,
        started_at: startedAt,
        updated_at: transactionAudit.completed_at,
        log_path: relativeRuntimePath(logPath),
      });
      if (reclaimedListeners.length > 0) {
        await appendFile(takeoverAuditPath, `${JSON.stringify(transactionAudit)}\n`, "utf8");
      }
    }

    return {
      action: "start",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      pid: child.pid,
      reclaimed_listeners: reclaimedListeners,
      runtime: await healthForApp(app),
    };
  }

  async function install(appId, { action = "install", source = null } = {}) {
    const app = await runtimeAppForAction(appId, { source });
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    const dependencies = await dependencyForApp(app);
    if (!dependencies.can_install) {
      throw new RuntimeActionError(409, "app_install_unavailable", dependencies.message, [
        `dependency_state: ${dependencies.state}`,
        `cwd: ${dependencies.cwd}`,
        dependencies.install_command_display ? `install: ${dependencies.install_command_display}` : "install: unavailable",
      ], {
        action,
        failure_kind: dependencies.state,
        dependencies,
      });
    }
    await ensureRuntimeDirs();
    const logPath = logPathForApp(runtimeKey);
    const startedAt = new Date().toISOString();
    const cwd = join(companiesRoot, app.cwd);
    await appendLog(
      logPath,
      `\n[launchpad] ${startedAt} ${action} ${app.id} command=${dependencies.install_command_display} source=${runtimeSource.type} cwd=${cwd}\n`,
    );

    const child = spawnProcess(runtimePackageCommand(dependencies.install_command, runtimeBunExecutable), {
      cwd,
      env: runtimeProcessEnv(app, {
        COMPANIES_WORKSPACE_ROOT: companiesRoot,
        COMPANYASCODE_APP_ID: app.id,
        COMPANYASCODE_RUNTIME_KEY: runtimeKey,
        COMPANYASCODE_RUNTIME_SOURCE: runtimeSource.type,
        ...(runtimeSource.slug ? { COMPANYASCODE_WORKTREE_SLUG: runtimeSource.slug } : {}),
      }),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const outputPipes = [
      pipeOutput(child.stdout, logPath, "stdout"),
      pipeOutput(child.stderr, logPath, "stderr"),
    ];
    const exitCode = await child.exited;
    await Promise.allSettled(outputPipes);
    await appendLog(logPath, `[launchpad] ${new Date().toISOString()} ${action} ${app.id} code=${exitCode} source=${runtimeSource.type}\n`);
    if (exitCode === 0) {
      await refreshVerifiedStaleLockfile({ app, action, dependencies, cwd, logPath });
    }
    const log_excerpt = await logTail(logPath, errorTailBytes);
    const failureKind = exitCode === 0 ? null : classifyInstallFailure(log_excerpt);
    await writeState(runtimeKey, {
      status: exitCode === 0 ? "stopped" : "unhealthy",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      port: app.port,
      instance_id: instanceId,
      updated_at: new Date().toISOString(),
      last_install: {
        action,
        command: dependencies.install_command,
        command_display: dependencies.install_command_display,
        cwd,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        exit_code: exitCode,
        log_excerpt,
      },
      log_path: relativeRuntimePath(logPath),
      ...(exitCode === 0 ? {} : { last_error: installFailureMessage(app, exitCode, log_excerpt), failure_kind: failureKind, log_excerpt }),
    });

    if (exitCode !== 0) {
      throw new RuntimeActionError(500, "app_install_failed", installFailureMessage(app, exitCode, log_excerpt), [
        log_excerpt,
      ].filter(Boolean), {
        action,
        failure_kind: failureKind,
        command: dependencies.install_command,
        command_display: dependencies.install_command_display,
        cwd,
        exit_code: exitCode,
        log_path: relativeRuntimePath(logPath),
        log_excerpt,
      });
    }

    return {
      action,
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      command: dependencies.install_command,
      command_display: dependencies.install_command_display,
      cwd,
      exit_code: exitCode,
      log_path: relativeRuntimePath(logPath),
      log_excerpt,
      runtime: await healthForApp(app),
    };
  }

  // One-click builder chain (CAC-0044, step-003): idempotentní řetěz
  // ensure install → ensure start → vrátit URL. Každý krok je idempotentní a
  // vlastní kroky (install/start) samy házejí RuntimeActionError s blokujícím
  // stavem. Port se nikdy nepřemapuje: Start/Open převezme statický module lease
  // a nahradí jakoukoli předchozí verzi, worktree nebo zaseklý proces.
  async function open(appId, { source = null } = {}) {
    const app = await runtimeAppForAction(appId, { source, enforcePortContract: true });
    return withModuleLeaseLock(app, () => openRuntimeAppUnlocked(app));
  }

  async function openRuntimeAppUnlocked(app) {
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    const steps = [];
    let shouldConfirmStability = false;

    // 1) Ensure install — jen když dependency stav vyžaduje instalaci a jde
    //    bezpečně provést. Ostatní blokující dependency stavy (missing_access,
    //    restricted, invalid_manifest…) skončí srozumitelnou chybou.
    let dependencies = await dependencyForApp(app);
    if (["needs_install", "stale_lockfile"].includes(dependencies.state)) {
      const action = dependencies.state === "needs_install" ? "install" : "repair";
      const installResult = await install(app.id, { action, source: runtimeSource });
      steps.push({ step: action, exit_code: installResult.exit_code });
      dependencies = await dependencyForApp(app);
    }
    if (!dependencies.can_start) {
      throw new RuntimeActionError(409, "app_not_ready", dependencies.message, [
        `dependency_state: ${dependencies.state}`,
        `cwd: ${dependencies.cwd}`,
        dependencies.install_command_display ? `install: ${dependencies.install_command_display}` : "install: unavailable",
      ], {
        failure_kind: dependencies.state === "needs_install" ? "missing_dependencies" : dependencies.state,
        dependencies,
      });
    }

    // 2) Ensure start — idempotentní jen pro runtime vlastněný touto instancí.
    // Cizí/adoptovaný proces na static lease se při explicitním Open reclaimne
    // a nahradí deklarovaným modulem. Stejně se řízeně zastaví starší managed
    // verze nebo worktree téhož modulu.
    let runtime = await healthForApp(app);
    const hasStaticModuleLease = runtimeListenerHasStaticLease(app, app.entrypoint_listener);
    if (
      runtime.status === "healthy"
      && (runtime.owner === "current-instance" || !hasStaticModuleLease)
    ) {
      // A healthy legacy process remains read-compatible across Launchpad
      // restarts. Legacy manifests grant no destructive reclaim authority, so
      // Open reuses their verified URL while Start stays fail-closed.
      steps.push({ step: "reuse", status: runtime.status });
    } else if (managedProcesses.has(runtimeKey) && runtime.status === "starting") {
      steps.push({ step: "reuse", status: runtime.status });
      shouldConfirmStability = true;
    } else {
      const startResult = await startRuntimeAppUnlocked(app, { trigger: "user" });
      steps.push({ step: "start", status: startResult.runtime?.status ?? "starting" });
      shouldConfirmStability = true;
      runtime = startResult.runtime ?? (await healthForApp(app));
    }

    // 3) Počkej, až port poslouchá, než vrátíme URL. start() se vrací už po
    //    startEarlyExitProbeMs (1 s) se stavem 'starting'; pomalejší dev servery
    //    (vite/next, běžně 2–5 s) v tu chvíli ještě neposlouchají a neprogramátor
    //    by v rezervovaném tabu skončil na „connection refused". Pollujeme health
    //    do openHealthyWaitMs; URL vrátíme jen když je port opravdu zdravý.
    //    Blokující chyby (unhealthy port conflict) už vyhodil start() výše.
    if (runtime.status === "starting") {
      runtime = await waitForHealthy(app, runtime);
    }

    // Když proces mezitím spadl (unhealthy během grace okna), nevracej mrtvé URL —
    // vyhoď stejnou blokující chybu jako start(), aby frontend zobrazil důvod.
    if (runtime.status === "healthy" && shouldConfirmStability) {
      runtime = await confirmStableHealthy(app, runtimeKey, runtime);
    }

    if (["unhealthy", "stopped", "degraded"].includes(runtime.status)) {
      throw new RuntimeActionError(
        500,
        "app_start_failed",
        runtime.last_error ?? runtime.message ?? `${app.title} se po startu nerozeběhl do zdravého stavu.`,
        [runtime.probe?.error, runtime.message].filter(Boolean),
        {
          failure_kind: runtime.failure_kind ?? "unhealthy_after_start",
          runtime,
        },
      );
    }

    let desired;
    try {
      desired = await acceptDesiredRuntime(app);
    } catch (error) {
      if (steps.some((step) => step.step === "start")) {
        await stopRuntimeAppUnlocked(app).catch(() => {});
      }
      throw desiredPersistenceError(app, error);
    }
    resetDesiredRestartTracker(app);

    // Lokální usage tracking pro panel „Nejčastější" (step-007) — best-effort,
    // nikdy neblokuje otevření a nezapisuje žádnou PII (jen app id + agregát).
    try {
      await recordAppOpen({ launchpadRoot, appId: app.id });
    } catch {}

    // URL vydáme jen když port poslouchá (healthy). Pokud po openHealthyWaitMs
    // ještě startuje, vrať status 'starting' bez URL — frontend zavře rezervovaný
    // tab a zobrazí průběh místo „connection refused".
    const ready = runtime.status === "healthy";
    return {
      action: "open",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      url: ready ? (runtime.url ?? appUrl(app)) : null,
      status: runtime.status,
      steps,
      runtime,
      desired,
    };
  }

  // Poll health, dokud port neposlouchá (healthy) nebo nevyprší okno / proces
  // spadne (unhealthy/stopped). Vrací poslední runtime snapshot.
  async function waitForHealthy(app, initialRuntime) {
    const deadline = Date.now() + openHealthyWaitMs;
    let runtime = initialRuntime;
    while (runtime.status === "starting" && Date.now() < deadline) {
      await sleep(openHealthyPollMs);
      runtime = await healthForApp(app);
    }
    return runtime;
  }

  async function confirmStableHealthy(app, runtimeKey, runtime) {
    const record = managedProcesses.get(runtimeKey);
    if (!record) return runtime;
    const result = await Promise.race([
      record.child.exited.then((exitCode) => ({ exited: true, exitCode })),
      sleep(openHealthyStabilityMs).then(() => ({ exited: false })),
    ]);
    if (!result.exited) return healthForApp(app);

    if (platform !== "win32" && await managedProcessGroupAlive(record)) {
      if (record.exitFinalizationPromise) {
        await record.exitFinalizationPromise;
      }
      return healthForApp(app);
    }

    await Promise.allSettled(record.outputPipes);
    const log_excerpt = await logTail(record.logPath, errorTailBytes);
    const failure = startFailure(app, result.exitCode, log_excerpt);
    return {
      ...runtime,
      status: "unhealthy",
      message: failure.message,
      last_error: failure.message,
      failure_kind: failure.kind,
      log_excerpt,
    };
  }

  async function stop(appId, { source = null } = {}) {
    const app = await runtimeAppForAction(appId, { source });
    if (!supportsDurableDesiredRuntime(app)) return stopRuntimeAppUnlocked(app);
    const recordsAtRequest = managedRecordsForModule(app);
    // Capture the exact active source before waiting for the cross-process
    // mutex. An unexpected child exit may remove the managed record while Stop
    // waits, but it must not erase the user's intent or fall back to `main`.
    const requestedRecord = selectManagedModuleStopRecord(recordsAtRequest, app);
    return withModuleLeaseLock(app, async () => {
      const currentRecord = selectManagedModuleStopRecord(managedProcesses.values(), app);
      const record = currentRecord ?? requestedRecord;
      if (!record) {
        const current = await healthForApp(app);
        // A restart coordinator may have removed the exited record before
        // this request and then held the cross-process lease while it tried
        // to restore the durable runtime. Once Stop owns that lease, an
        // ownerless but still-enabled desired state is safe to disable. A
        // visible process owned by another Launchpad remains fail-closed.
        if (current.owner !== "none" || current.desired?.enabled !== true) {
          throw appNotManagedError(app, current);
        }
        const desired = await disableDesiredRuntime(app, { acceptStoredSource: true });
        resetDesiredRestartTracker(app);
        const desiredApp = {
          ...app,
          id: desired.app_id,
          runtime_source: desired.source,
        };
        return {
          action: "stop",
          app_id: desired.app_id,
          runtime_key: desired.source.type === "worktree"
            ? worktreeRuntimeKey(desiredApp, desired.source.slug)
            : desired.app_id,
          runtime_source: desired.source,
          pid: null,
          forced: false,
          already_stopped: true,
          runtime: await healthForApp(app),
          desired,
        };
      }
      const activeApp = record.runtimeApp ?? app;
      // Stop is fail-safe: persistence is the commit point. If this atomic
      // write fails no signal is sent. Once it succeeds, every later stop
      // failure leaves desired disabled, so boot reconcile cannot resurrect
      // a process the user explicitly stopped. The active runtime is selected
      // by module lease rather than the reloaded UI selector: main, app/vN and
      // worktree variants are one durable module process. Ambiguity fails
      // before this commit point and therefore before any process is signaled.
      const desired = await disableDesiredRuntime(activeApp);
      resetDesiredRestartTracker(activeApp);
      if (!currentRecord) {
        return {
          ...await stopActionResult(
            activeApp,
            record,
            record.runtimeKey,
            record.runtimeSource,
            { forced: false },
          ),
          already_stopped: true,
          desired,
        };
      }
      let result;
      try {
        result = await stopRuntimeAppUnlocked(activeApp);
      } catch (error) {
        // Exit finalization is intentionally independent of the module lock.
        // If it wins after the in-lock selection, disabled intent is already
        // committed; report the exact captured runtime as stopped instead of
        // turning a successful no-resurrection transaction into an error.
        if (error?.code !== "app_not_managed") throw error;
        result = {
          ...await stopActionResult(
            activeApp,
            record,
            record.runtimeKey,
            record.runtimeSource,
            { forced: false },
          ),
          already_stopped: true,
        };
      }
      return { ...result, desired };
    });
  }

  async function stopRuntimeAppUnlocked(inputApp) {
    let app = inputApp;
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    const record = managedProcesses.get(runtimeKey);
    if (!record) {
      const current = await healthForApp(app);
      throw appNotManagedError(app, current);
    }
    app = record.runtimeApp ?? app;

    if (record.stopping || record.exitFinalizing) {
      if (record.stopping && record.stopFinalizationReady && record.stopFinalizationOptions) {
        await finalizeManagedStop(
          app,
          record,
          runtimeKey,
          runtimeSource,
          record.stopFinalizationOptions,
        );
        return stopActionResult(app, record, runtimeKey, runtimeSource, {
          forced: record.stopFinalizationOptions.forced,
        });
      }
      throw new RuntimeActionError(
        409,
        "app_stop_in_progress",
        "Aplikace se už zastavuje; Launchpad neposlal další signál.",
        [`runtime_key: ${runtimeKey}`, `pid: ${record.pid}`],
        {
          failure_kind: "stop_in_progress",
          owner: "current-instance",
          pid: record.pid,
        },
      );
    }

    record.stopping = true;
    resetStopAttempt(record);
    if (record.ownerProofWritePromise) {
      await Promise.allSettled([record.ownerProofWritePromise]);
    }
    try {
      await writeState(runtimeKey, {
        status: "stopping",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        port: record.port ?? app.port,
        pid: record.pid,
        process_group_id: record.processGroupId,
        listeners: runtimeListenerState(app),
        instance_id: instanceId,
        started_at: record.startedAt,
        updated_at: new Date().toISOString(),
        log_path: relativeRuntimePath(record.logPath),
        ...windowsRuntimeOwnerProofState(record.ownerProof),
      });
      await appendLog(record.logPath, `[launchpad] ${new Date().toISOString()} stop ${app.id}\n`);
    } catch (error) {
      await recoverRetryableStopAttempt(app, record, runtimeKey, runtimeSource, error, {
        failureKind: "stop_preparation_failed",
      });
      throw error;
    }

    try {
      await signalManagedProcess(record, runtimeKey, "SIGTERM");
    } catch (error) {
      await recoverRetryableStopAttempt(app, record, runtimeKey, runtimeSource, error, {
        failureKind: error?.metadata?.failure_kind ?? "stop_signal_failed",
      });
      throw error;
    }

    const result = platform === "win32"
      ? await Promise.race([
          record.child.exited.then((exitCode) => ({ exitCode, timeout: false })),
          sleep(stopTimeoutMs).then(() => ({ exitCode: null, timeout: true })),
        ])
      : await waitForPosixManagedExit(record, stopTimeoutMs);
    if (!result.timeout) {
      record.stopExitConfirmed = true;
      record.stopExitCode = result.exitCode;
    }

    // Windows už první bezpečně scoped Stop provede přes taskkill /T /F.
    // Druhé cílení stejného PID po timeoutu by po rychlém PID reuse mohlo
    // zasáhnout cizí proces. Identitu proto potvrzuje původní child handle:
    // timeout ponechá ownership, potvrzený exit dovolí uklidit managed záznam.
    let exitCode = result.exitCode;
    const needsForcedGroupStop = platform !== "win32" && result.timeout;
    if (needsForcedGroupStop) {
      try {
        await signalManagedProcess(record, runtimeKey, "SIGKILL");
      } catch (error) {
        await recoverRetryableStopAttempt(app, record, runtimeKey, runtimeSource, error, {
          failureKind: error?.metadata?.failure_kind ?? "stop_signal_failed",
        });
        throw error;
      }
      const killResult = await waitForPosixManagedExit(record, stopKillWaitMs);
      if (killResult.timeout) {
        const error = stopExitUnconfirmedError(app, record);
        await appendLog(
          record.logPath,
          `[launchpad] SIGKILL completed but child exit was not confirmed ${app.id} managed_pid=${record.pid}\n`,
        );
        await recoverRetryableStopAttempt(app, record, runtimeKey, runtimeSource, error, {
          failureKind: "stop_exit_unconfirmed",
          forced: true,
        });
        throw error;
      }
      exitCode = killResult.exitCode;
      record.stopExitConfirmed = true;
      record.stopExitCode = exitCode;
    }

    if (result.timeout && platform === "win32") {
      enableStopFinalizationOnExit(app, record, runtimeKey, runtimeSource, {
        forced: true,
      });
      await appendLog(
        record.logPath,
        `[launchpad] taskkill completed but child exit was not confirmed ${app.id} managed_pid=${record.pid}\n`,
      );
      throw stopExitUnconfirmedError(app, record);
    }

    const forced = platform === "win32" || needsForcedGroupStop;
    prepareStopFinalization(record, {
      exitCode,
      forced,
    });
    if (platform === "win32") {
      // Po potvrzeném child exit je každý listener nový proces, i kdyby Windows
      // mezitím znovu použil stejné číselné PID. Jen ho zalogujeme; health/start
      // jej následně fail-closed klasifikuje podle port ownership kontraktu.
      try {
        const ownerAfterStop = await resolvePortOwnerFn(app.port, {
          expectedCwd: join(companiesRoot, app.cwd ?? dirname(app.package_path ?? "package.json")),
        });
        if (ownerAfterStop) {
          await appendLog(
            record.logPath,
            `[launchpad] stop tree completed and port was reused ${app.id} managed_pid=${record.pid} new_owner=${ownerAfterStop.pid}\n`,
          );
        }
      } catch (error) {
        // Diagnostika po potvrzeném exitu nesmí zablokovat nedestruktivní
        // finalizaci. Když selže i log (AV/OneDrive lock), finalizer zachová
        // retryable managed slot a další Stop zopakuje jen zápis stavu.
        try {
          await appendLog(
            record.logPath,
            `[launchpad] post-stop port diagnostic failed ${app.id}: ${error.message}\n`,
          );
        } catch {}
      }
    }
    await finalizeManagedStop(app, record, runtimeKey, runtimeSource, {
      exitCode,
      forced,
    });

    return stopActionResult(app, record, runtimeKey, runtimeSource, { forced });
  }

  function stopExitUnconfirmedError(app, record) {
    return new RuntimeActionError(
      500,
      "app_stop_failed",
      `${app.title}: ukončení PID ${record.pid} nebylo potvrzené známým process handlem.`,
      [`app_id: ${app.id}`, `managed_pid: ${record.pid}`, `port: ${app.port}`, `platform: ${platform}`],
      {
        failure_kind: "stop_exit_unconfirmed",
        owner: "current-instance",
        managed_pid: record.pid,
        port: app.port,
        platform,
      },
    );
  }

  async function stopActionResult(app, record, runtimeKey, runtimeSource, { forced }) {
    return {
      action: "stop",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      pid: record.pid,
      forced,
      runtime: await healthForApp(app),
    };
  }

  function resetStopAttempt(record) {
    record.finalizeStopOnExit = false;
    record.finalizeStopForced = false;
    record.stopExitConfirmed = false;
    record.stopExitCode = null;
    record.stopFinalizationReady = false;
    record.stopFinalizationOptions = null;
    record.stopFinalizationPromise = null;
  }

  async function recoverRetryableStopAttempt(
    app,
    record,
    runtimeKey,
    runtimeSource,
    error,
    { failureKind, forced = false },
  ) {
    const updatedAt = new Date().toISOString();
    try {
      await writeState(runtimeKey, {
        status: "unhealthy",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        port: record.port ?? app.port,
        pid: record.pid,
        process_group_id: record.processGroupId,
        listeners: runtimeListenerState(record.runtimeApp ?? app),
        instance_id: instanceId,
        started_at: record.startedAt,
        updated_at: updatedAt,
        log_path: relativeRuntimePath(record.logPath),
        last_error: error?.message ?? String(error),
        failure_kind: failureKind,
        ...windowsRuntimeOwnerProofState(record.ownerProof),
      });
    } catch {
      // Původní Stop chyba je pro volajícího směrodatná. Managed record se
      // přesto musí vrátit do retryable stavu, když child stále běží.
    }

    if (record.stopExitConfirmed) {
      enableStopFinalizationOnExit(app, record, runtimeKey, runtimeSource, {
        forced,
      });
      return;
    }

    record.stopping = false;
    record.finalizeStopOnExit = false;
    record.finalizeStopForced = false;
  }

  function enableStopFinalizationOnExit(app, record, runtimeKey, runtimeSource, { forced }) {
    record.finalizeStopOnExit = true;
    record.finalizeStopForced = forced;
    if (!record.stopExitConfirmed) return;
    void finalizeDeferredManagedStop(app, record, runtimeKey, runtimeSource, {
      exitCode: record.stopExitCode,
      forced,
    }).catch(async (error) => {
      try {
        await appendLog(record.logPath, `[launchpad] deferred stop finalization failed ${app.id}: ${error.message}\n`);
      } catch {}
    });
  }

  async function finalizeDeferredManagedStop(
    app,
    record,
    runtimeKey,
    runtimeSource,
    { exitCode, forced },
  ) {
    if (platform !== "win32" && await managedProcessGroupAlive(record)) {
      record.stopping = false;
      record.finalizeStopOnExit = false;
      record.finalizeStopForced = false;
      await appendLog(
        record.logPath,
        `[launchpad] launcher exited but managed process group still survives ${app.id} process_group_id=${record.processGroupId}\n`,
      );
      return false;
    }
    prepareStopFinalization(record, { exitCode, forced });
    await finalizeManagedStop(app, record, runtimeKey, runtimeSource, {
      exitCode,
      forced,
    });
    return true;
  }

  async function managedProcessGroupAlive(record) {
    if (platform === "win32" || !Number.isInteger(record.processGroupId)) return false;
    try {
      return Boolean(await processGroupAlive(record.processGroupId, record));
    } catch (error) {
      await appendLog(
        record.logPath,
        `[launchpad] process group liveness probe failed pid=${record.processGroupId}: ${error.message}\n`,
      );
      return true;
    }
  }

  async function waitForPosixManagedExit(record, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const childExit = Promise.resolve(record.child.exited).then((exitCode) => {
      record.stopExitConfirmed = true;
      record.stopExitCode = exitCode;
      return exitCode;
    });
    while (Date.now() < deadline) {
      if (!record.stopExitConfirmed) {
        await Promise.race([childExit, sleep(Math.min(50, deadline - Date.now()))]);
      }
      if (record.stopExitConfirmed && !(await managedProcessGroupAlive(record))) {
        return { exitCode: record.stopExitCode, timeout: false };
      }
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
    return { exitCode: null, timeout: true };
  }

  function prepareStopFinalization(record, options) {
    record.stopFinalizationReady = true;
    record.stopFinalizationOptions = options;
  }

  async function finalizeManagedStop(app, record, runtimeKey, runtimeSource, { exitCode, forced }) {
    if (record.stopFinalizationPromise) return record.stopFinalizationPromise;

    const finalizationPromise = (async () => {
      const stoppedAt = new Date().toISOString();
      await appendLog(
        record.logPath,
        `[launchpad] ${stoppedAt} stopped ${app.id} code=${exitCode} forced=${forced}\n`,
      );
      await Promise.allSettled(record.outputPipes);
      await writeState(runtimeKey, {
        status: "stopped",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        port: record.port ?? app.port,
        pid: record.pid,
        process_group_id: record.processGroupId,
        listeners: runtimeListenerState(record.runtimeApp ?? app),
        instance_id: instanceId,
        started_at: record.startedAt,
        stopped_at: stoppedAt,
        updated_at: stoppedAt,
        exit_code: exitCode,
        forced,
        log_path: relativeRuntimePath(record.logPath),
      });
      if (managedProcesses.get(runtimeKey) === record) {
        managedProcesses.delete(runtimeKey);
      }
    })();
    record.stopFinalizationPromise = finalizationPromise;
    try {
      return await finalizationPromise;
    } catch (error) {
      if (record.stopFinalizationPromise === finalizationPromise) {
        record.stopFinalizationPromise = null;
      }
      throw error;
    }
  }

  async function signalManagedProcess(record, runtimeKey, signal) {
    if (managedProcesses.get(runtimeKey) !== record) {
      throw new RuntimeActionError(
        409,
        "app_managed_owner_changed",
        "Vlastnictví managed procesu se během zastavování změnilo; Launchpad neposlal signál.",
        [`runtime_key: ${runtimeKey}`, `pid: ${record.pid}`],
        { failure_kind: "managed_owner_changed", pid: record.pid },
      );
    }

    if (signalManagedProcessFn) {
      try {
        await signalManagedProcessFn(record, signal);
        return;
      } catch (error) {
        if (error?.code === "ESRCH") return;
        await appendLog(record.logPath, `[launchpad] managed stop signal failed: ${error.message}\n`);
        throw new RuntimeActionError(
          error?.code === "EPERM" ? 403 : 500,
          error?.code === "EPERM" ? "app_stop_forbidden" : "app_stop_failed",
          `Managed proces PID ${record.pid} nelze zastavit: ${error.message}`,
          [`runtime_key: ${runtimeKey}`, `pid: ${record.pid}`, `signal: ${signal}`],
          { failure_kind: "stop_signal_failed", owner: "current-instance", pid: record.pid, signal },
        );
      }
    }

    if (platform === "win32") {
      const command = windowsTaskkillCommand(record.pid, {
        // taskkill /T bez /F neumí spolehlivě ukončit console procesy. PID je
        // bezpečně svázaný s managedProcesses této instance, takže Windows
        // ukončí celý známý strom atomicky už při prvním Stop pokusu.
        force: true,
        env: systemEnvironment,
      });
      const result = await runSystemCommandFn(command);
      if (!result.ok && !isMissingProcessResult(result)) {
        await appendLog(record.logPath, `[launchpad] taskkill failed: ${result.stderr || result.error || "unknown"}\n`);
        throw new RuntimeActionError(
          500,
          "app_stop_failed",
          `Managed strom procesu PID ${record.pid} se nepodařilo ukončit.`,
          [`runtime_key: ${runtimeKey}`, `pid: ${record.pid}`, `command: ${command.join(" ")}`],
          { failure_kind: "stop_signal_failed", owner: "current-instance", pid: record.pid },
        );
      }
      return;
    }

    try {
      await processGroupSignaler(record.processGroupId, signal, record);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      await appendLog(record.logPath, `[launchpad] stop signal failed: ${error.message}\n`);
      throw new RuntimeActionError(
        error?.code === "EPERM" ? 403 : 500,
        error?.code === "EPERM" ? "app_stop_forbidden" : "app_stop_failed",
        `Managed process group ${record.processGroupId} nelze poslat ${signal}: ${error.message}`,
        [`runtime_key: ${runtimeKey}`, `pid: ${record.pid}`, `process_group_id: ${record.processGroupId}`, `signal: ${signal}`],
        { failure_kind: "stop_signal_failed", owner: "current-instance", pid: record.pid, process_group_id: record.processGroupId, signal },
      );
    }
  }

  async function restart(appId, { source = null } = {}) {
    const app = await runtimeAppForAction(appId, { source, enforcePortContract: true });
    const runtimeSource = runtimeSourceForApp(app);
    return withModuleLeaseLock(app, async () => {
      try {
        await stopRuntimeAppUnlocked(app);
      } catch (error) {
        if (error?.code !== "app_not_managed") throw error;
      }
      const startResult = await startRuntimeAppUnlocked(app, { trigger: "user" });
      let desired;
      try {
        desired = await acceptDesiredRuntime(app);
      } catch (error) {
        await stopRuntimeAppUnlocked(app).catch(() => {});
        throw desiredPersistenceError(app, error);
      }
      resetDesiredRestartTracker(app);
      return {
        action: "restart",
        app_id: app.id,
        runtime_key: runtimeKeyForApp(app),
        runtime_source: runtimeSource,
        start: startResult,
        desired,
      };
    });
  }

  async function logs(appId, { source = null } = {}) {
    const app = await runtimeAppForAction(appId, { source, requireValidDiscovery: false });
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    const logPath = logPathForApp(runtimeKey);
    if (!existsSync(logPath)) {
      return {
        schema_version: "companiesascode.launchpad.logs.v1",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        log_path: relativeRuntimePath(logPath),
        content: "",
        message: "Log zatím neexistuje.",
      };
    }
    const content = await readFile(logPath, "utf8");
    return {
      schema_version: "companiesascode.launchpad.logs.v1",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      log_path: relativeRuntimePath(logPath),
      truncated: content.length > logTailBytes,
      content: content.slice(-logTailBytes),
    };
  }

  async function findApp(appId, { requireValidDiscovery = false } = {}) {
    const globalDiscovery = await discover(companiesRoot);
    let discovery = globalDiscovery;
    let app = discovery.apps.find((item) => item.id === appId);
    if (!app) {
      // Decision 0043: appka s nevalidním manifestem je viditelná, ale runtime
      // akce jsou pro ni zamčené, dokud se manifest neopraví.
      const invalidApp = (discovery.invalid_apps ?? []).find((item) => item.id === appId);
      if (invalidApp) {
        throw new RuntimeActionError(
          409,
          "invalid_manifest",
          `Aplikace ${appId} má nevalidní runtime manifest; oprav lazurio.runtime nebo legacy manifest a spusť Synchronizovat.`,
          invalidApp.manifest_issues ?? [],
          { failure_kind: "invalid_manifest", package_path: invalidApp.package_path },
        );
      }
      throw new RuntimeActionError(404, "app_not_found", `Aplikace ${appId} není v discovery výstupu.`);
    }

    if (requireValidDiscovery && discovery.failures.length > 0) {
      // Runtime jedné validní Organizace nesmí zablokovat nevalidní mount jiné
      // Organizace. Globální discovery zůstává autoritou pro cross-org listener
      // konflikty, ale bezpečnostní gate cílové aplikace ověříme znovu pouze v
      // jejím Organization scope. Root/schema failure se promítne i do scoped
      // výsledku a dál failne zavřeně.
      if (app.organization_kind === "organization" && typeof app.company === "string") {
        const scopedDiscovery = await discover(companiesRoot, {
          organization: app.company,
          organization_path: app.organization_path,
        });
        const scopedApp = scopedDiscovery.apps.find((item) => item.id === appId);
        if (scopedApp && scopedDiscovery.failures.length === 0) {
          app = scopedApp;
          discovery = {
            ...scopedDiscovery,
            port_overlaps: globalDiscovery.port_overlaps ?? scopedDiscovery.port_overlaps ?? [],
            listener_overlaps: globalDiscovery.listener_overlaps ?? scopedDiscovery.listener_overlaps ?? [],
            listener_owners: globalDiscovery.listener_owners ?? scopedDiscovery.listener_owners ?? [],
            module_listener_drifts: globalDiscovery.module_listener_drifts ?? scopedDiscovery.module_listener_drifts ?? [],
          };
        } else {
          throw new RuntimeActionError(
            409,
            "invalid_discovery",
            `Organizace ${app.company} potřebuje opravit nastavení, než lze aplikaci bezpečně spustit.`,
            scopedDiscovery.failures.length > 0 ? scopedDiscovery.failures : discovery.failures,
            { failure_kind: "invalid_discovery", organization: app.company },
          );
        }
      } else {
        throw new RuntimeActionError(
          409,
          "invalid_discovery",
          "Runtime akce vyžaduje validní Launchpad discovery.",
          discovery.failures,
          { failure_kind: "invalid_discovery" },
        );
      }
    }
    return { app, discovery };
  }

  async function runtimeAppForAction(
    appId,
    { source = null, requireValidDiscovery = true, enforcePortContract = false } = {},
  ) {
    const { app, discovery } = await findApp(appId, { requireValidDiscovery });
    const runtimeSource = normalizeRuntimeSource(source);
    const runtimeApp = runtimeSource.type === "main"
      ? {
        ...app,
        runtime_key: app.id,
        runtime_source: { type: "main" },
      }
      : await worktreeRuntimeApp(app, runtimeSource);
    if (enforcePortContract) {
      assertValidRuntimePortContract(runtimeApp, discovery, { discoveryApp: app });
    }
    return runtimeApp;
  }

  function assertValidRuntimePortContract(app, discovery, { discoveryApp = app } = {}) {
    const owns = (owner) => owner?.app_id === app.id
      && [app.package_path, discoveryApp.package_path].includes(owner?.package_path);
    const conflicts = (discovery.port_overlaps ?? [])
      .filter((overlap) => overlap.conflict !== false && overlap.owners?.some(owns));

    // Legacy manifests stay read-compatible during the coordinated migration,
    // but a declared collision is never actionable. Otherwise a currently free
    // duplicate port could bypass the Doctor gate and start two logical owners.
    if (app.runtime_contract?.schema_version !== "lazurio.runtime.v1") {
      if (conflicts.length === 0) return;
      throw new RuntimeActionError(
        409,
        "invalid_runtime_port_contract",
        `${app.title}: declared runtime port conflict blocks Start/Open until the module lease migration is complete.`,
        conflicts.map((overlap) => `port ${overlap.port}: ${overlap.classification}`),
        {
          failure_kind: "invalid_runtime_port_contract",
          conflict_count: conflicts.length,
          module_listener_drift_count: 0,
          port_registry_issue_count: discovery.port_registry_issues?.length ?? 0,
        },
      );
    }

    if (app.module_contract?.schema_version !== "lazurio.module.v1") {
      throw new RuntimeActionError(
        409,
        "missing_module_lease",
        `${app.title}: chybí platný lazurio.module.v1 lease; Doctor musí být před Start/Open zelený.`,
        [],
        { failure_kind: "missing_module_lease" },
      );
    }

    const drifts = (discovery.module_listener_drifts ?? [])
      .filter((drift) => drift.owners?.some(owns));
    if (conflicts.length === 0
      && drifts.length === 0) return;

    const details = [
      ...conflicts.map((overlap) => `port ${overlap.port}: ${overlap.classification}`),
      ...drifts.map((drift) => `${drift.module_lease}: module listener drift`),
    ];
    throw new RuntimeActionError(
      409,
      "invalid_runtime_port_contract",
      `${app.title}: runtime port contract is invalid; Doctor must be green before Start/Open.`,
      details,
      {
        failure_kind: "invalid_runtime_port_contract",
        conflict_count: conflicts.length,
        module_listener_drift_count: drifts.length,
        port_registry_issue_count: discovery.port_registry_issues?.length ?? 0,
      },
    );
  }

  function normalizeRuntimeSource(source) {
    try {
      return normalizeDesiredSource(source);
    } catch (error) {
      throw new RuntimeActionError(400, "invalid_runtime_source", error.message);
    }
  }

  function runtimeProcessEnv(app, overrides) {
    const env = { ...process.env };
    // Launchpad může být sám spuštěný v Organization-scoped procesu. Každý
    // child dostane scope znovu odvozený z discovery; Personalspace a lokální
    // surfaces nesmí zdědit Organization root rodiče.
    delete env.COMPANYASCODE_ORGANIZATION_ROOT;
    return {
      ...env,
      ...organizationRuntimeEnv(app),
      ...listenerRuntimeEnv(app),
      ...overrides,
    };
  }

  function listenerRuntimeEnv(app) {
    const listeners = runtimeListenerState(app);
    const values = {
      LAZURIO_RUNTIME_LISTENERS_JSON: JSON.stringify(listeners),
    };
    for (const listener of listeners) {
      const key = String(listener.id ?? "listener").toUpperCase().replace(/[^A-Z0-9]/g, "_");
      values[`LAZURIO_RUNTIME_LISTENER_${key}_HOST`] = listener.host;
      if (Number.isInteger(listener.port)) {
        values[`LAZURIO_RUNTIME_LISTENER_${key}_PORT`] = String(listener.port);
      }
    }
    return values;
  }

  function organizationRuntimeEnv(app) {
    if (app.organization_kind !== "organization") return {};

    const declaredPath = typeof app.organization_path === "string" ? app.organization_path.trim() : "";
    if (!declaredPath || isAbsolute(declaredPath) || win32.isAbsolute(declaredPath)) {
      throw new RuntimeActionError(
        409,
        "invalid_organization_path",
        `Aplikace ${app.id} má nebezpečný organization_path.`,
        [`organization_path: ${app.organization_path ?? "<missing>"}`],
      );
    }

    const organizationRoot = resolve(companiesRoot, declaredPath);
    const organizationBoundary = relative(companiesRoot, organizationRoot);
    if (
      !organizationBoundary ||
      isAbsolute(organizationBoundary) ||
      win32.isAbsolute(organizationBoundary) ||
      organizationBoundary.startsWith("..") ||
      resolve(companiesRoot, organizationBoundary) !== organizationRoot
    ) {
      throw new RuntimeActionError(
        409,
        "invalid_organization_path",
        `Aplikace ${app.id} má nebezpečný organization_path.`,
        [`organization_path: ${app.organization_path}`],
      );
    }

    return { COMPANYASCODE_ORGANIZATION_ROOT: organizationRoot };
  }

  async function worktreeRuntimeApp(app, source) {
    if (!app.organization_path || !app.module) {
      throw new RuntimeActionError(409, "worktree_runtime_unavailable", "Worktree runtime vyžaduje organization_path a module v app manifestu.", [
        `app_id: ${app.id}`,
      ]);
    }
    const index = await buildWorktreeIndex({ companiesRoot, organization: app.company, module: app.module });
    const worktree = index.worktrees.find((item) => item.slug === source.slug && item.module === app.module);
    if (!worktree) {
      throw new RuntimeActionError(404, "worktree_not_found", `Worktree ${source.slug} pro ${app.company}/${app.module} nebyl nalezen.`);
    }
    if (worktree.ownership_status !== "owned") {
      throw new RuntimeActionError(409, "worktree_not_owned", "Worktree bez Mission Control vlastníka nelze spustit.", [
        worktree.message,
      ].filter(Boolean), {
        worktree,
      });
    }

    const runtimeKey = worktreeRuntimeKey(app, worktree.slug);
    const modulePath = normalizeRelativePath(worktree.metadata?.module_path ?? `modules/${app.module}`);
    const mainModulePath = normalizeRelativePath(`${app.organization_path}/${modulePath}`);
    const worktreePath = normalizeRelativePath(worktree.path);
    const cwd = replacePathPrefix(app.cwd, mainModulePath, worktreePath);
    const packagePath = replacePathPrefix(app.package_path, mainModulePath, worktreePath);
    const worktreeContract = await materializeWorktreeRuntimeContract({
      app,
      worktree,
      worktreePath,
      packagePath,
    });

    return {
      ...app,
      ...worktreeContract,
      // Plugin paths/capabilities are validated only by main discovery. A
      // worktree may change its Module App runtime, but it cannot smuggle a
      // different plugin boundary into a lifecycle action.
      plugin: app.plugin,
      cwd,
      package_path: packagePath,
      runtime_key: runtimeKey,
      runtime_source: {
        type: "worktree",
        slug: worktree.slug,
        branch: worktree.branch,
        plan_code: worktree.plan_code,
        plan_title: worktree.owner_plan?.title ?? null,
        owner_plan: worktree.owner_plan,
        worktree_path: worktree.path,
        status: worktree.status,
      },
    };
  }

  async function materializeWorktreeRuntimeContract({
    app,
    worktree,
    worktreePath,
    packagePath,
  }) {
    const absoluteWorktreeRoot = resolve(companiesRoot, worktreePath);
    const absolutePackagePath = resolve(companiesRoot, packagePath);
    const packageBoundary = relative(absoluteWorktreeRoot, absolutePackagePath);
    if (
      !packageBoundary
      || isAbsolute(packageBoundary)
      || win32.isAbsolute(packageBoundary)
      || packageBoundary === ".."
      || packageBoundary.startsWith(`..${sep}`)
    ) {
      throw invalidWorktreeRuntimeContract(app, worktree, [
        `${packagePath}: runtime package neleží uvnitř canonical worktree ${worktreePath}`,
      ]);
    }

    let packageJson;
    try {
      packageJson = JSON.parse(await readFile(absolutePackagePath, "utf8"));
    } catch (error) {
      throw invalidWorktreeRuntimeContract(app, worktree, [
        `${packagePath}: package.json nejde přečíst: ${error.message}`,
      ]);
    }
    const normalizedRuntime = normalizePackageRuntime({ packageJson, packagePath });
    if (!normalizedRuntime) {
      throw invalidWorktreeRuntimeContract(app, worktree, [
        `${packagePath}: chybí lazurio.runtime nebo legacy companyascode.app`,
      ]);
    }

    const issues = [...normalizedRuntime.issues];
    let worktreeApp = normalizedRuntime.app;
    if (worktreeApp.runtime_contract?.legacy !== true) {
      const moduleManifestPath = `${worktreePath}/lazurio.module.json`;
      let moduleManifest;
      try {
        moduleManifest = JSON.parse(await readFile(resolve(companiesRoot, moduleManifestPath), "utf8"));
      } catch (error) {
        issues.push(`${moduleManifestPath}: lazurio.module.json nejde přečíst: ${error.message}`);
      }
      if (moduleManifest) {
        const normalizedModule = normalizeModuleManifest({
          manifest: moduleManifest,
          modulePath: moduleManifestPath,
        });
        issues.push(...normalizedModule.issues);
        const materialized = materializeRuntimeFromModule({
          runtime: worktreeApp,
          module: normalizedModule.module,
          packagePath,
        });
        worktreeApp = materialized.app;
        issues.push(...materialized.issues);
      }
    } else if (app.runtime_contract?.schema_version === "lazurio.runtime.v1") {
      issues.push(`${packagePath}: worktree používá legacy companyascode.app, ale main už vyžaduje lazurio.runtime.v1`);
    }
    if (worktreeApp.runtime_contract?.schema_version === "lazurio.runtime.v1") {
      issues.push(...runtimeScriptPortAuthorityIssues({
        packageJson,
        packagePath,
        module: worktreeApp.module_contract,
      }));
      issues.push(...await runtimeSourcePortAuthorityIssues({
        packageDirectory: dirname(absolutePackagePath),
        packagePath,
        module: worktreeApp.module_contract,
      }));
    }

    if (worktreeApp.id !== app.id) {
      issues.push(`${packagePath}: worktree app id ${String(worktreeApp.id)} neodpovídá zvolenému app id ${app.id}`);
    }
    if (worktreeApp.company !== app.company) {
      issues.push(`${packagePath}: worktree company ${String(worktreeApp.company)} neodpovídá ${app.company}`);
    }
    if (worktreeApp.module !== app.module) {
      issues.push(`${packagePath}: worktree module ${String(worktreeApp.module)} neodpovídá ${app.module}`);
    }
    if (
      app.module_contract?.schema_version === "lazurio.module.v1"
      && Array.isArray(app.module_contract.port_leases)
      && app.module_contract.port_leases.length > 0
      && moduleLeaseSignature(worktreeApp.module_contract) !== moduleLeaseSignature(app.module_contract)
    ) {
      issues.push(`${packagePath}: worktree module lease se liší od main; worktree nesmí měnit stabilní porty ani hosty Modulu`);
    }
    if (issues.length > 0) throw invalidWorktreeRuntimeContract(app, worktree, issues);

    return {
      title: worktreeApp.title,
      company: worktreeApp.company,
      module: worktreeApp.module,
      surface: worktreeApp.surface,
      port: worktreeApp.port,
      host: worktreeApp.host,
      health_path: worktreeApp.health_path,
      dev_script: worktreeApp.dev_script,
      preview_script: worktreeApp.preview_script ?? null,
      build_script: worktreeApp.build_script ?? null,
      listeners: worktreeApp.listeners ?? [],
      entrypoint_listener: worktreeApp.entrypoint_listener ?? null,
      module_contract: worktreeApp.module_contract ?? null,
      runtime_contract: worktreeApp.runtime_contract ?? null,
      tags: worktreeApp.tags ?? [],
    };
  }

  function moduleLeaseSignature(moduleContract) {
    return JSON.stringify((moduleContract?.port_leases ?? [])
      .map((lease) => ({
        id: lease.id,
        host: canonicalRuntimeListenerHost(lease.host),
        port: lease.port,
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))));
  }

  function invalidWorktreeRuntimeContract(app, worktree, issues) {
    return new RuntimeActionError(
      409,
      "invalid_worktree_runtime_contract",
      `${app.title}: zvolený worktree nemá platný a kompatibilní Module App runtime contract.`,
      issues,
      {
        failure_kind: "invalid_worktree_runtime_contract",
        worktree_slug: worktree.slug,
        worktree_path: worktree.path,
      },
    );
  }

  function runtimeKeyForApp(app) {
    return app.runtime_key ?? app.id;
  }

  function moduleLeaseKeyForApp(app) {
    return typeof app?.company === "string" && app.company !== ""
      && typeof app?.module === "string" && app.module !== ""
      ? `${app.company}/${app.module}`
      : `app/${app.id}`;
  }

  async function withModuleLeaseLock(app, action, { timeoutMs = null } = {}) {
    const key = moduleLeaseKeyForApp(app);
    const previous = moduleLeaseLocks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.catch(() => {}).then(() => current);
    moduleLeaseLocks.set(key, tail);
    await previous.catch(() => {});
    let osLock = null;
    try {
      osLock = await acquireModuleLockFn({
        root: moduleLockRoot,
        key,
        instanceId,
        ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });
      return await action();
    } finally {
      try {
        if (osLock) await osLock.release();
      } catch (error) {
        console.warn(`[launchpad] Module lock ${key} could not be released cleanly: ${error?.message ?? error}`);
      } finally {
        release();
        if (moduleLeaseLocks.get(key) === tail) moduleLeaseLocks.delete(key);
      }
    }
  }

  function appNotManagedError(app, current) {
    return new RuntimeActionError(409, "app_not_managed", "Aplikace neběží jako managed proces tohoto Launchpadu.", [
      `app_id: ${app.id}`,
      `runtime_status: ${current.status}`,
      `owner: ${current.owner}`,
    ], {
      failure_kind: "not_managed",
      owner: current.owner,
    });
  }

  function desiredPersistenceError(app, error) {
    return new RuntimeActionError(
      500,
      "desired_state_persist_failed",
      `${app.title}: lifecycle transition was not accepted because desired state could not be persisted.`,
      [error?.message ?? String(error)],
      { failure_kind: "desired_state_persist_failed" },
    );
  }

  function supportsDurableDesiredRuntime(app) {
    return app?.personal !== true
      && app?.module_contract?.schema_version === "lazurio.module.v1"
      && typeof app?.company === "string"
      && typeof app?.module === "string";
  }

  async function readDesiredRuntime(app) {
    if (!supportsDurableDesiredRuntime(app)) return null;
    return readDesiredModuleState({
      root: desiredStateRoot,
      company: app.company,
      module: app.module,
    });
  }

  async function readDesiredRuntimeForHealth(app) {
    try {
      return await readDesiredRuntime(app);
    } catch (error) {
      return {
        schema_version: "lazurio.launchpad.desired_module.v1",
        company: app.company,
        module: app.module,
        module_lease_key: moduleLeaseKeyForApp(app),
        app_id: app.id,
        enabled: true,
        source: runtimeSourceForApp(app),
        status: "degraded",
        last_error: error.message,
        failure_kind: "invalid_desired_state",
      };
    }
  }

  async function acceptDesiredRuntime(app, { reconciled = false } = {}) {
    if (!supportsDurableDesiredRuntime(app)) return null;
    const state = buildDesiredModuleState({
      app,
      source: runtimeSourceForApp(app),
      enabled: true,
      status: "active",
      reconciled,
    });
    await writeDesiredModuleStateFn({ root: desiredStateRoot, state });
    return state;
  }

  async function disableDesiredRuntime(app, { acceptStoredSource = false } = {}) {
    if (!supportsDurableDesiredRuntime(app)) return null;
    let previous = null;
    try {
      previous = await readDesiredRuntime(app);
    } catch {}
    const expectedSource = runtimeSourceForApp(app);
    if (!acceptStoredSource && previous && (
      previous.app_id !== app.id
      || !runtimeSourcesEqual(previous.source, expectedSource)
    )) {
      throw new RuntimeActionError(
        409,
        "app_stop_superseded",
        `${app.title}: Stop did not disable a desired runtime accepted for a different source.`,
        [
          `expected_app_id: ${app.id}`,
          `actual_app_id: ${previous.app_id}`,
          `expected_source: ${JSON.stringify(expectedSource)}`,
          `actual_source: ${JSON.stringify(previous.source)}`,
        ],
        { failure_kind: "desired_runtime_superseded" },
      );
    }
    const state = buildDesiredModuleState({
      app: previous ? { ...app, id: previous.app_id } : app,
      source: previous?.source ?? expectedSource,
      enabled: false,
      status: "disabled",
      previous,
    });
    await writeDesiredModuleStateFn({ root: desiredStateRoot, state });
    return state;
  }

  async function updateDesiredRuntimeReconciliation(state, {
    status,
    error = null,
    failureKind = null,
  }) {
    const next = buildDesiredModuleState({
      app: { id: state.app_id, company: state.company, module: state.module },
      source: state.source,
      enabled: state.enabled,
      status,
      previous: state,
      reconciled: true,
      error,
      failureKind,
    });
    await writeDesiredModuleStateFn({ root: desiredStateRoot, state: next });
    return next;
  }

  function resetDesiredRestartTracker(app) {
    const key = moduleLeaseKeyForApp(app);
    const tracker = desiredRestartTrackers.get(key);
    if (tracker) {
      tracker.generation += 1;
      tracker.running = false;
    }
    desiredRestartTrackers.delete(key);
  }

  function queueDesiredRuntimeRestart(app, record, exitCode) {
    if (!supportsDurableDesiredRuntime(app)) return;
    const key = moduleLeaseKeyForApp(app);
    const existing = desiredRestartTrackers.get(key);
    if (existing?.running) return;
    const tracker = existing ?? { attempts: 0, generation: 0, running: false };
    tracker.running = true;
    tracker.generation += 1;
    desiredRestartTrackers.set(key, tracker);
    const generation = tracker.generation;
    void runDesiredRestartSeries(app, record, exitCode, tracker, generation).catch(async (error) => {
      tracker.running = false;
      try {
        await appendLog(record.logPath, `[launchpad] desired restart coordinator failed ${app.id}: ${error.message}\n`);
      } catch {}
    });
  }

  async function runDesiredRestartSeries(app, record, exitCode, tracker, generation) {
    const expectedAppId = app.id;
    const expectedSource = runtimeSourceForApp(app);
    while (tracker.attempts < desiredRestartDelaysMs.length && tracker.generation === generation) {
      const delayMs = desiredRestartDelaysMs[tracker.attempts];
      tracker.attempts += 1;
      await appendLog(
        record.logPath,
        `[launchpad] desired child exit ${app.id} code=${exitCode} restart_attempt=${tracker.attempts} backoff_ms=${delayMs}\n`,
      );
      await sleepFn(delayMs);
      let outcome;
      try {
        outcome = await withModuleLeaseLock(app, async () => {
          const desired = await readDesiredRuntime(app);
          if (!desired?.enabled || desired.status === "disabled") return { state: "cancelled" };
          if (desired.app_id !== expectedAppId || !runtimeSourcesEqual(desired.source, expectedSource)) {
            return { state: "superseded" };
          }
          let desiredApp;
          try {
            desiredApp = await runtimeAppForAction(desired.app_id, {
              source: desired.source,
              enforcePortContract: true,
            });
          } catch (error) {
            await updateDesiredRuntimeReconciliation(desired, {
              status: "degraded",
              error: error.message,
              failureKind: error.code ?? "desired_source_invalid",
            });
            return { state: "permanent-failure" };
          }
          const activeRecord = managedRecordForModule(desiredApp);
          if (activeRecord
            && activeRecord.appId === desiredApp.id
            && runtimeSourcesEqual(activeRecord.runtimeSource, runtimeSourceForApp(desiredApp))) {
            let activeRuntime = await healthForApp(desiredApp);
            if (activeRuntime.status === "starting") {
              activeRuntime = await waitForHealthy(desiredApp, activeRuntime);
            }
            if (activeRuntime.status === "healthy") {
              return { state: "already-running", app: desiredApp };
            }
            await stopRuntimeAppUnlocked(desiredApp);
          }
          const started = await startRuntimeAppUnlocked(desiredApp, { trigger: "desired-restart" });
          let runtime = started.runtime ?? await healthForApp(desiredApp);
          if (runtime.status === "starting") runtime = await waitForHealthy(desiredApp, runtime);
          if (runtime.status !== "healthy") {
            await stopRuntimeAppUnlocked(desiredApp).catch(() => {});
            throw new RuntimeActionError(
              500,
              "desired_restart_unhealthy",
              `${desiredApp.title}: desired restart did not become healthy.`,
              [],
              { failure_kind: runtime.failure_kind ?? "desired_restart_unhealthy", runtime },
            );
          }
          await updateDesiredRuntimeReconciliation(desired, { status: "active" });
          return { state: "started", app: desiredApp };
        });
      } catch (error) {
        outcome = { state: "retry", error };
        try {
          await withModuleLeaseLock(app, async () => {
            const desired = await readDesiredRuntime(app);
            if (desired?.enabled
              && desired.app_id === expectedAppId
              && runtimeSourcesEqual(desired.source, expectedSource)) {
              await updateDesiredRuntimeReconciliation(desired, {
                status: "degraded",
                error: error.message,
                failureKind: error.code ?? error.metadata?.failure_kind ?? "desired_restart_failed",
              });
            }
          });
        } catch {}
      }

      if (["cancelled", "superseded", "permanent-failure"].includes(outcome.state)) {
        tracker.running = false;
        return;
      }
      if (["started", "already-running"].includes(outcome.state)) {
        tracker.running = false;
        scheduleDesiredRestartReset(outcome.app, tracker, generation);
        return;
      }
    }

    if (tracker.generation !== generation) return;
    tracker.running = false;
    try {
      await withModuleLeaseLock(app, async () => {
        const desired = await readDesiredRuntime(app);
        if (desired?.enabled
          && desired.app_id === expectedAppId
          && runtimeSourcesEqual(desired.source, expectedSource)) {
          await updateDesiredRuntimeReconciliation(desired, {
            status: "degraded",
            error: `Desired child exited repeatedly; ${tracker.attempts} bounded restart attempts were exhausted.`,
            failureKind: "desired_restart_exhausted",
          });
          await appendLog(
            record.logPath,
            `[launchpad] desired restart exhausted ${app.id} attempts=${tracker.attempts}; no further restart scheduled\n`,
          );
        }
      });
    } catch {}
  }

  function scheduleDesiredRestartReset(app, tracker, generation) {
    void sleepFn(desiredRestartStableMs).then(() => {
      if (tracker.generation !== generation || tracker.running) return;
      const active = managedRecordForModule(app);
      if (!active || active.appId !== app.id || !runtimeSourcesEqual(active.runtimeSource, runtimeSourceForApp(app))) return;
      desiredRestartTrackers.delete(moduleLeaseKeyForApp(app));
    });
  }

  function managedRecordForModule(app) {
    return managedRecordsForModule(app)[0] ?? null;
  }

  function managedRecordsForModule(app) {
    return [...managedProcesses.values()].filter((record) =>
      moduleRuntimeLeaseMatches(record.runtimeApp, app)
    );
  }

  function runtimeSourcesEqual(left, right) {
    return left?.type === right?.type
      && (left?.type !== "worktree" || left.slug === right?.slug);
  }

  async function reconcileDesiredState() {
    const entries = await listDesiredModuleStates({ root: desiredStateRoot });
    const results = [];
    for (const entry of entries) {
      if (!entry.ok) {
        results.push({ status: "degraded", file: entry.file, failure_kind: "invalid_desired_state", error: entry.error });
        continue;
      }
      const desired = entry.state;
      if (!desired.enabled) {
        results.push({
          status: "disabled",
          module_lease_key: desired.module_lease_key,
          app_id: desired.app_id,
          source: desired.source,
        });
        continue;
      }
      const lockApp = { id: desired.app_id, company: desired.company, module: desired.module };
      try {
        const result = await withModuleLeaseLock(lockApp, async () => {
          const current = await readDesiredModuleState({
            root: desiredStateRoot,
            company: desired.company,
            module: desired.module,
          });
          if (!current?.enabled || current.revision !== desired.revision) {
            return { status: "superseded", desired: current };
          }
          const app = await runtimeAppForAction(current.app_id, {
            source: current.source,
            enforcePortContract: true,
          });
          if (!moduleRuntimeLeaseMatches(app, lockApp)) {
            throw new RuntimeActionError(
              409,
              "desired_module_mismatch",
              `Desired app ${current.app_id} no longer belongs to ${current.module_lease_key}.`,
            );
          }
          const activeRecord = managedRecordForModule(app);
          let runtime;
          if (activeRecord
            && activeRecord.appId === app.id
            && runtimeSourcesEqual(activeRecord.runtimeSource, runtimeSourceForApp(app))) {
            runtime = await healthForApp(app);
          } else {
            const started = await startRuntimeAppUnlocked(app, { trigger: "boot-reconcile" });
            runtime = started.runtime ?? await healthForApp(app);
          }
          if (runtime.status === "starting") runtime = await waitForHealthy(app, runtime);
          if (runtime.status !== "healthy") {
            throw new RuntimeActionError(
              500,
              "desired_reconcile_unhealthy",
              `${app.title}: boot reconcile did not establish a healthy listener.`,
              [],
              { failure_kind: runtime.failure_kind ?? "desired_reconcile_unhealthy", runtime },
            );
          }
          const reconciled = await updateDesiredRuntimeReconciliation(current, { status: "active" });
          resetDesiredRestartTracker(app);
          return { status: "active", desired: reconciled, runtime };
        });
        results.push({
          status: result.status,
          module_lease_key: desired.module_lease_key,
          app_id: desired.app_id,
          source: desired.source,
          ...(result.runtime ? { runtime_status: result.runtime.status } : {}),
        });
      } catch (error) {
        let degraded = desired;
        try {
          await withModuleLeaseLock(lockApp, async () => {
            const latest = await readDesiredModuleState({
              root: desiredStateRoot,
              company: desired.company,
              module: desired.module,
            });
            if (latest?.enabled && latest.revision === desired.revision) {
              degraded = await updateDesiredRuntimeReconciliation(latest, {
                status: "degraded",
                error: error.message,
                failureKind: error.code ?? error.metadata?.failure_kind ?? "desired_reconcile_failed",
              });
            }
          });
        } catch {}
        results.push({
          status: "degraded",
          module_lease_key: desired.module_lease_key,
          app_id: desired.app_id,
          source: desired.source,
          failure_kind: degraded.failure_kind ?? error.code ?? "desired_reconcile_failed",
          error: degraded.last_error ?? error.message,
        });
      }
    }
    return {
      schema_version: "lazurio.launchpad.boot_reconcile.v1",
      reconciled_at: new Date().toISOString(),
      total: results.length,
      active: results.filter((result) => result.status === "active").length,
      disabled: results.filter((result) => result.status === "disabled").length,
      degraded: results.filter((result) => result.status === "degraded").length,
      results,
    };
  }

  function runtimeSourceForApp(app) {
    return app.runtime_source ?? { type: "main" };
  }

  function worktreeRuntimeKey(app, slug) {
    return `${app.id}--worktree--${slug}`;
  }

  function normalizeRelativePath(value) {
    return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  }

  function replacePathPrefix(value, oldPrefix, newPrefix) {
    const normalized = normalizeRelativePath(value);
    const prefix = normalizeRelativePath(oldPrefix);
    if (normalized === prefix) return normalizeRelativePath(newPrefix);
    if (normalized.startsWith(`${prefix}/`)) {
      return `${normalizeRelativePath(newPrefix)}/${normalized.slice(prefix.length + 1)}`;
    }
    return normalized;
  }

  async function materializeRuntimeListeners(app) {
    const invalid = (app.listeners ?? []).filter(
      (listener) => listener.allocation !== "static" || !Number.isInteger(listener.port),
    );
    if (invalid.length > 0) {
      throw new RuntimeActionError(
        409,
        "runtime_listener_not_static",
        `${app.title}: každý runtime listener musí mít pevný deklarovaný port; dynamické porty nejsou povolené.`,
        invalid.map((listener) => `${listener.id}: allocation=${listener.allocation}, port=${listener.port ?? "missing"}`),
        { failure_kind: "dynamic_runtime_listener_forbidden", listeners: invalid },
      );
    }
    return app;
  }

  async function verifyStartedListenerOwnership(app, record, { timeoutMs }) {
    const expectedCwd = join(companiesRoot, app.cwd ?? dirname(app.package_path ?? "package.json"));
    const deadline = Date.now() + timeoutMs;
    let evidence = [];
    do {
      evidence = [];
      for (const listener of app.listeners ?? []) {
        const owner = await resolvePortOwnerFn(listener.port, {
          expectedCwd,
          host: listener.host,
        });
        let owned = false;
        let processGroupId = null;
        if (Number.isInteger(owner?.pid) && owner.pid > 0) {
          if (platform === "win32") {
            if (owner.pid === record.pid) {
              owned = true;
            } else {
              const knownLauncherIdentity = await record.launcherIdentityPromise;
              owned = Boolean(await captureWindowsProcessAncestry(
                owner.pid,
                record.pid,
                processIdentityResolver,
                knownLauncherIdentity,
              ));
              if (!owned
                && validWindowsRuntimeOwnerProof(record.ownerProof)
                && record.ownerProof.listener_pid === owner.pid) {
                let currentListenerIdentity = null;
                try {
                  currentListenerIdentity = normalizeWindowsProcessIdentity(
                    await processIdentityResolver(owner.pid),
                  );
                } catch {}
                owned = sameWindowsProcessIdentity(
                  record.ownerProof.listener_identity,
                  currentListenerIdentity,
                );
              }
            }
          } else {
            processGroupId = await portOwnerProcessGroupResolver(owner.pid);
            owned = processGroupId === record.processGroupId;
          }
        }
        let observedBindings = [];
        if (owned) {
          observedBindings = await observedPortBindingsResolver(listener.port);
          owned = observedBindings.some((binding) =>
            observedListenerMatchesDeclaration(binding, listener)
          );
        }
        evidence.push({
          listener_id: listener.id,
          lease_id: listener.lease ?? null,
          host: listener.host,
          port: listener.port,
          owner_pid: owner?.pid ?? null,
          process_group_id: processGroupId,
          observed_endpoints: observedBindings.map((binding) => binding.endpoint),
          owned,
        });
      }
      if (evidence.length > 0 && evidence.every((item) => item.owned)) return evidence;
      await sleep(50);
    } while (Date.now() < deadline);
    throw new RuntimeActionError(
      500,
      "runtime_listener_ownership_unverified",
      `${app.title}: nový managed proces nepřevzal všechny deklarované module leases.`,
      evidence.map((item) =>
        `${item.listener_id}: ${item.host}:${item.port}, owner_pid=${item.owner_pid ?? "none"}, process_group_id=${item.process_group_id ?? "unknown"}`,
      ),
      {
        failure_kind: "started_listener_ownership_unverified",
        launcher_pid: record.pid,
        process_group_id: record.processGroupId,
        listeners: evidence,
      },
    );
  }

  async function prepareDeclaredListeners(app, { runtimeKey, logPath }) {
    const expectedCwd = join(companiesRoot, app.cwd ?? dirname(app.package_path ?? "package.json"));
    const conflicts = [];
    const reclaimed = [];
    const declaredListeners = [...(app.listeners ?? [])];
    const declaredPorts = new Set(declaredListeners.map((listener) => `${listener.host}:${listener.port}`));
    for (const lease of app.module_contract?.port_leases ?? []) {
      if (declaredPorts.has(`${lease.host}:${lease.port}`)) continue;
      declaredListeners.push({
        id: `reserved-${lease.id}`,
        role: "auxiliary",
        lease: lease.id,
        protocol: "tcp",
        health: { kind: "tcp" },
        allocation: "static",
        host: lease.host,
        port: lease.port,
        claim: { mode: "exclusive" },
        module_lease: {
          id: lease.id,
          module_id: app.module_contract.id,
          company: app.module_contract.company,
          source: app.module_contract.module_path,
        },
      });
    }
    for (const listener of declaredListeners) {
      if (!Number.isInteger(listener.port)) continue;
      let owner = await resolveOccupiedPortOwner(listener, expectedCwd);
      if (!owner) continue;
      if (!runtimeListenerHasStaticLease(app, listener)) {
        conflicts.push({ listener, owner });
        continue;
      }

      const managedPeer = [...managedProcesses.values()].find((record) =>
        record.runtimeKey !== runtimeKey
        && (record.runtimeApp?.listeners ?? []).some((candidate) =>
          candidate.port === listener.port
          && runtimeHostsShareListener(candidate.host, listener.host)
        )
      );
      if (managedPeer) {
        try {
          await stopRuntimeAppUnlocked(managedPeer.runtimeApp);
        } catch (error) {
          if (!["app_not_found", "worktree_not_found", "worktree_not_owned"].includes(error?.code)) {
            throw error;
          }
          managedProcesses.delete(managedPeer.runtimeKey);
          await appendLog(
            logPath,
            `[launchpad] managed peer ${managedPeer.runtimeKey} is no longer discoverable; reclaiming its declared listener directly\n`,
          );
        }
        reclaimed.push({
          listener_id: listener.id,
          host: listener.host,
          port: listener.port,
          previous_pid: managedPeer.pid,
          method: "managed-stop",
        });
        owner = await resolveOccupiedPortOwner(listener, expectedCwd);
        if (!owner) continue;
      }

      const result = await reclaimReservedListener(app, listener, {
        expectedCwd,
        logPath,
      });
      reclaimed.push(...result);
    }
    if (conflicts.length === 0) return reclaimed;
    throw new RuntimeActionError(
      409,
      "runtime_listener_preflight_failed",
      `${app.title} nelze spustit: obsazený listener nemá Lazurio static lease, který by Launchpadu dovolil port reclaimnout.`,
      conflicts.map(({ listener, owner }) =>
        `${listener.id}: ${listener.host}:${listener.port}, pid=${owner.pid ?? "unknown"}, cwd_verified=${owner.cwd_matches === true}`,
      ),
      {
        failure_kind: "listener_preflight_conflict",
        listeners: conflicts.map(({ listener, owner }) => ({
          listener_id: listener.id,
          host: listener.host,
          port: listener.port,
          pid: owner.pid ?? null,
          cwd_matches: owner.cwd_matches ?? null,
        })),
      },
    );
  }

  async function reclaimReservedListener(app, listener, { expectedCwd, logPath }) {
    const reclaimed = [];
    for (let attempt = 1; attempt <= portReclaimAttempts; attempt += 1) {
      const owner = await resolveOccupiedPortOwner(listener, expectedCwd);
      if (!owner) return reclaimed;
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid === process.pid) {
        throw new RuntimeActionError(
          409,
          "runtime_listener_reclaim_failed",
          `${app.title}: vlastník rezervovaného portu ${listener.port} nemá bezpečně signalizovatelný PID.`,
          [`listener: ${listener.id}`, `pid: ${owner.pid ?? "unknown"}`],
          { failure_kind: "reserved_port_owner_unresolvable", listener, owner },
        );
      }
      const initialIdentity = await portOwnerIdentity(owner.pid);
      if (!initialIdentity) {
        const currentOwner = await resolveOccupiedPortOwner(listener, expectedCwd);
        if (!currentOwner || currentOwner.pid !== owner.pid) continue;
        throw new RuntimeActionError(
          409,
          "runtime_listener_reclaim_failed",
          `${app.title}: identitu PID ${owner.pid} na rezervovaném portu ${listener.port} nelze bezpečně svázat s takeover transakcí.`,
          [`listener: ${listener.id}`, `pid: ${owner.pid}`],
          { failure_kind: "reserved_port_owner_identity_unresolved", listener, owner },
        );
      }

      await appendLog(
        logPath,
        `[launchpad] reclaim ${app.id} listener=${listener.id} endpoint=${listener.host}:${listener.port} pid=${owner.pid} signal=SIGTERM attempt=${attempt}\n`,
      );
      let signalTarget;
      try {
        const currentIdentity = await portOwnerIdentity(owner.pid);
        if (!samePortOwnerIdentity(initialIdentity, currentIdentity)) continue;
        signalTarget = await portOwnerSignaler(owner.pid, "SIGTERM", { app, listener, owner });
      } catch (error) {
        throw reservedPortSignalError(app, listener, owner, "SIGTERM", error);
      }
      let remainingOwner = await waitForReservedListenerChange(
        listener,
        expectedCwd,
        owner.pid,
        portReclaimTermWaitMs,
      );
      if (!remainingOwner) {
        reclaimed.push({
          listener_id: listener.id,
          host: listener.host,
          port: listener.port,
          previous_pid: owner.pid,
          previous_process_group_id: signalTarget?.process_group_id ?? null,
          method: "SIGTERM",
        });
        return reclaimed;
      }
      if (remainingOwner.pid !== owner.pid) continue;

      await appendLog(
        logPath,
        `[launchpad] reclaim ${app.id} listener=${listener.id} endpoint=${listener.host}:${listener.port} pid=${owner.pid} signal=SIGKILL attempt=${attempt}\n`,
      );
      try {
        const currentIdentity = await portOwnerIdentity(owner.pid);
        if (!samePortOwnerIdentity(initialIdentity, currentIdentity)) continue;
        signalTarget = await portOwnerSignaler(owner.pid, "SIGKILL", { app, listener, owner });
      } catch (error) {
        throw reservedPortSignalError(app, listener, owner, "SIGKILL", error);
      }
      remainingOwner = await waitForReservedListenerChange(
        listener,
        expectedCwd,
        owner.pid,
        portReclaimKillWaitMs,
      );
      if (!remainingOwner) {
        reclaimed.push({
          listener_id: listener.id,
          host: listener.host,
          port: listener.port,
          previous_pid: owner.pid,
          previous_process_group_id: signalTarget?.process_group_id ?? null,
          method: "SIGKILL",
        });
        return reclaimed;
      }
      if (remainingOwner.pid !== owner.pid) continue;
    }
    const owner = await resolveOccupiedPortOwner(listener, expectedCwd);
    throw new RuntimeActionError(
      500,
      "runtime_listener_reclaim_failed",
      `${app.title}: rezervovaný port ${listener.port} se nepodařilo uvolnit.`,
      [`listener: ${listener.id}`, `pid: ${owner?.pid ?? "unknown"}`],
      { failure_kind: "reserved_port_reclaim_failed", listener, owner },
    );
  }

  async function waitForReservedListenerChange(listener, expectedCwd, previousPid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let owner = null;
    do {
      owner = await resolveOccupiedPortOwner(listener, expectedCwd);
      if (!owner || owner.pid !== previousPid) return owner;
      await sleep(50);
    } while (Date.now() < deadline);
    return owner;
  }

  async function resolveOccupiedPortOwner(listener, expectedCwd) {
    const owner = await resolvePortOwnerFn(listener.port, {
      expectedCwd,
      host: listener.host,
    });
    if (owner) return owner;
    const occupied = await probeNumericPortOccupiedFn(listener.port, { host: listener.host });
    return occupied
      ? { pid: null, cwd_matches: null, lookup_failed: true }
      : null;
  }

  function reservedPortSignalError(app, listener, owner, signal, error) {
    return new RuntimeActionError(
      error?.code === "EPERM" ? 403 : 500,
      error?.code === "EPERM" ? "runtime_listener_reclaim_forbidden" : "runtime_listener_reclaim_failed",
      `${app.title}: PID ${owner.pid} na rezervovaném portu ${listener.port} se nepodařilo ukončit (${signal}).`,
      [error?.message ?? String(error)],
      {
        failure_kind: "reserved_port_signal_failed",
        listener,
        pid: owner.pid,
        signal,
      },
    );
  }

  async function reconcileRuntimeListeners(app, record, expectedCwd) {
    if (!record || app.runtime_contract?.auxiliary_listeners_known !== true) return null;
    const now = Date.now();
    if (
      record.listenerReconciliation
      && Number.isFinite(record.listenerReconciledAt)
      && now - record.listenerReconciledAt < listenerReconciliationCacheMs
    ) {
      return record.listenerReconciliation;
    }
    let observed = [];
    let groupObservation = "unavailable";
    if (platform !== "win32" && spawnProcessIsNative && Number.isInteger(record.processGroupId)) {
      try {
        const result = await runSystemCommandFn([
          "lsof", "-nP", "-a", "-g", String(record.processGroupId), "-iTCP", "-sTCP:LISTEN", "-FnP",
        ]);
        if (result.ok) {
          observed = parseProcessGroupListeners(result.stdout);
          groupObservation = "available";
        }
      } catch {}
    }
    const declared = [];
    for (const listener of app.listeners ?? []) {
      if (!Number.isInteger(listener.port)) {
        declared.push({ listener_id: listener.id, port: null, status: "unallocated" });
        continue;
      }
      const healthProbe = await probeRuntimeListener(listener);
      const observedOnPort = observed.filter((candidate) => candidate.port === listener.port);
      const exactObserved = observedOnPort.some((candidate) =>
        observedListenerMatchesDeclaration(candidate, listener)
      );
      let owner = null;
      if (!exactObserved && observedOnPort.length === 0) {
        try {
          owner = await resolvePortOwnerFn(listener.port, { expectedCwd });
        } catch {}
      }
      const ownershipStatus = exactObserved
        ? "observed"
        : observedOnPort.length > 0
          ? "host-mismatch"
          : owner?.cwd_matches === true
            ? "observed"
        : owner
          ? "foreign-or-unverified"
          : "missing";
      const status = ownershipStatus === "observed" && !healthProbe.ok
        ? "unhealthy"
        : ownershipStatus;
      declared.push({
        listener_id: listener.id,
        role: listener.role,
        host: listener.host,
        port: listener.port,
        status,
        pid: owner?.pid ?? null,
        observed_endpoints: observedOnPort.map((candidate) => candidate.endpoint),
        health: healthProbe,
      });
    }
    const unannounced = groupObservation === "available"
      ? observed.filter((candidate) => !(app.listeners ?? []).some((listener) =>
        observedListenerMatchesDeclaration(candidate, listener)
      ))
      : [];
    const deviations = declared.filter((listener) =>
      ["missing", "host-mismatch", "foreign-or-unverified", "unhealthy"].includes(listener.status),
    );
    const reconciliation = {
      status: deviations.length === 0 && unannounced.length === 0 ? "ok" : "warn",
      group_observation: groupObservation,
      process_group_id: record.processGroupId,
      declared,
      observed,
      unannounced,
    };
    record.listenerReconciliation = reconciliation;
    record.listenerReconciledAt = now;
    return reconciliation;
  }

  async function healthForApp(app) {
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    const state = await readState(runtimeKey);
    const desired = await readDesiredRuntimeForHealth(app);
    const record = managedProcesses.get(runtimeKey);
    app = record?.runtimeApp ?? await materializeRuntimeListeners(app);
    const dependencies = await dependencyForApp(app);
    const probe = await probeHealth(app);
    const expectedCwd = join(companiesRoot, app.cwd ?? dirname(app.package_path ?? "package.json"));
    const portOwner = record ? null : await resolveVerifiedPortOwner(app, state, expectedCwd);
    const listenerReconciliation = await reconcileRuntimeListeners(app, record, expectedCwd);
    // Pozitivně ověřený canonical cwd zpřesní diagnostickou klasifikaci na
    // adopted-port. Ani tak se ale proces nestane managed a Stop/Restart se mu
    // nikdy nezpřístupní. Unknown lookup zůstává fail-closed.
    const adoptablePortOwner = portOwner?.cwd_matches === true ? portOwner : null;
    const now = Date.now();
    const startedAt = record?.startedAt ? Date.parse(record.startedAt) : null;
    const logPath = logPathForApp(runtimeKey);
    const base = {
      schema_version: "lazurio.launchpad.runtime_state.v1",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      host: app.host,
      port: app.port,
      url: appUrl(app),
      pid: record?.pid ?? portOwner?.pid ?? state?.pid ?? null,
      managed: Boolean(record),
      controllable: Boolean(record),
      owner: record
        ? "current-instance"
        : adoptablePortOwner
          ? "adopted-port"
          : portOwner?.cwd_matches === false
            ? "foreign-port"
            : portOwner
              ? "unknown-port"
              : "none",
      instance_id: record ? instanceId : (state?.instance_id ?? null),
      health_url: healthUrl(app),
      log_path: relativeRuntimePath(logPath),
      updated_at: new Date().toISOString(),
      dependencies,
      last_error: state?.last_error ?? null,
      failure_kind: state?.failure_kind ?? null,
      last_install: state?.last_install ?? null,
      probe,
      port_owner: portOwner,
      listeners: runtimeListenerState(app),
      listener_reconciliation: listenerReconciliation,
      desired,
      desired_alignment: record && desired?.enabled === false
        ? "managed-but-disabled"
        : desired?.enabled === true && desired.app_id === app.id && runtimeSourcesEqual(desired.source, runtimeSource)
          ? "matches"
          : desired
            ? "different-source"
            : "not-declared",
    };

    if (record) {
      if (probe.reachable && probe.ok) {
        return {
          ...base,
          status: "healthy",
          message: "Managed proces odpovídá na health endpoint.",
        };
      }
      if (probe.reachable && !probe.ok) {
        return {
          ...base,
          status: "unhealthy",
          message: `Managed proces odpověděl HTTP ${probe.status_code}.`,
        };
      }
      if (startedAt !== null && now - startedAt < startGraceMs) {
        return {
          ...base,
          status: "starting",
          message: "Managed proces běží, health endpoint ještě neodpovídá.",
        };
      }
      return {
        ...base,
        status: "unhealthy",
        message: `Managed proces běží, ale health endpoint neodpovídá: ${probe.error ?? "unknown"}.`,
      };
    }

    if (portOwner?.cwd_matches === false) {
      return {
        ...base,
        status: "unhealthy",
        failure_kind: "port_owner_cwd_mismatch",
        message: `Port ${app.port} používá proces z jiného checkoutu; Launchpad ho nepřevzal jako ${app.title}.`,
      };
    }

    if (portOwner && portOwner.cwd_matches !== true) {
      return {
        ...base,
        status: "unhealthy",
        failure_kind: "port_owner_cwd_unknown",
        message: `Port ${app.port} používá PID ${portOwner.pid}, ale Launchpad nedokázal ověřit jeho checkout; proces nepřevzal.`,
      };
    }

    if (portOwner && probe.reachable && probe.ok) {
      return {
        ...base,
        status: "healthy",
        message: "Aplikace běží na app-owned portu; Launchpad ji převzal podle manifestu.",
      };
    }

    if (portOwner && probe.reachable && !probe.ok) {
      return {
        ...base,
        status: "unhealthy",
        message: `Aplikace běží na app-owned portu, ale health endpoint odpověděl HTTP ${probe.status_code}.`,
      };
    }

    if (portOwner) {
      return {
        ...base,
        status: "unhealthy",
        message: `Port je obsazený PID ${portOwner.pid}, ale health endpoint neodpovídá: ${probe.error ?? "unknown"}.`,
      };
    }

    if (probe.reachable) {
      return {
        ...base,
        status: "unhealthy",
        owner: "unknown-port",
        message: "Port odpovídá, ale Launchpad nedokázal zjistit PID procesu pro převzetí kontroly.",
      };
    }

    if (desired?.enabled && desired.status === "degraded") {
      return {
        ...base,
        status: "degraded",
        failure_kind: desired.failure_kind ?? "desired_reconcile_failed",
        message: desired.last_error ?? "Desired module runtime is degraded and was not replaced with main.",
      };
    }

    return {
      ...base,
      status: "stopped",
      message: state?.last_error
        ?? (state?.status === "unhealthy" && state.exit_code !== undefined
          ? `Poslední managed proces skončil s kódem ${state.exit_code}. Otevři Logs pro detail.`
          : "Aplikace neběží."),
    };
  }

  async function resolveVerifiedPortOwner(app, state, expectedCwd) {
    if (!Number.isInteger(app.port)) return null;
    const owner = await resolvePortOwnerFn(app.port, {
      expectedCwd,
      host: app.entrypoint_listener?.host ?? app.host,
    });
    if (!owner || owner.cwd_matches === true || owner.cwd_matches === false || platform !== "win32") {
      return owner;
    }
    const proof = state?.owner_proof;
    if (
      !validWindowsRuntimeOwnerProof(proof)
      || proof.listener_pid !== owner.pid
      || state.app_id !== app.id
      || state.runtime_key !== runtimeKeyForApp(app)
      || state.port !== app.port
      || !stateAllowsWindowsRuntimeOwnerProof(state)
    ) {
      return owner;
    }

    const canonicalExpectedCwd = await canonicalPath(expectedCwd);
    const canonicalProofCwd = await canonicalPath(proof.expected_cwd);
    if (canonicalExpectedCwd !== canonicalProofCwd) return owner;

    let currentIdentity = null;
    try {
      currentIdentity = normalizeWindowsProcessIdentity(await processIdentityResolver(owner.pid));
    } catch {}
    if (!sameWindowsProcessIdentity(proof.listener_identity, currentIdentity)) return owner;
    return {
      ...owner,
      cwd_matches: true,
      verified_by: "runtime-owner-proof",
    };
  }

  async function windowsProofForSurvivingListener(app, record) {
    if (
      platform !== "win32"
      || record.stopping
      || managedProcesses.get(record.runtimeKey) !== record
    ) {
      return null;
    }
    const initialProbe = await probeHealth(app);
    if (!initialProbe.reachable || !initialProbe.ok) return null;

    // Launcher může korektně předat port potomkovi a skončit dřív, než
    // background capture dopíše proof. Managed slot proto držíme až do konce
    // bounded capture lane; jinak její guard uvidí smazaný record a bezpečně,
    // ale nevratně, přeživší listener opustí.
    if (record.ownerProofPromise) {
      await record.ownerProofPromise;
    }
    if (record.ownerProofWritePromise) {
      await Promise.allSettled([record.ownerProofWritePromise]);
    }
    if (
      record.stopping
      || managedProcesses.get(record.runtimeKey) !== record
      || !record.ownerProofCaptured
      || !validWindowsRuntimeOwnerProof(record.ownerProof)
    ) {
      return null;
    }

    const expectedCwd = join(
      companiesRoot,
      app.cwd ?? dirname(app.package_path ?? "package.json"),
    );
    const confirmedOwner = await resolveVerifiedPortOwner(app, {
      status: "healthy",
      app_id: app.id,
      runtime_key: record.runtimeKey,
      port: app.port,
      owner_proof: record.ownerProof,
    }, expectedCwd);
    if (
      confirmedOwner?.pid !== record.ownerProof.listener_pid
      || confirmedOwner.cwd_matches !== true
    ) {
      return null;
    }
    const finalProbe = await probeHealth(app);
    return finalProbe.reachable && finalProbe.ok ? record.ownerProof : null;
  }

  async function posixProofForSurvivingProcessGroup(app, record) {
    if (
      platform === "win32"
      || record.stopping
      || managedProcesses.get(record.runtimeKey) !== record
      || !(await managedProcessGroupAlive(record))
    ) {
      return null;
    }
    const initialProbe = await probeHealth(app);
    if (!initialProbe.reachable || !initialProbe.ok) return null;

    const expectedCwd = join(
      companiesRoot,
      app.cwd ?? dirname(app.package_path ?? "package.json"),
    );
    const listeners = [];
    for (const listener of app.listeners ?? []) {
      const owner = await resolvePortOwnerFn(listener.port, {
        expectedCwd,
        host: listener.host,
      });
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || owner.cwd_matches !== true) return null;
      const processGroupId = await portOwnerProcessGroupResolver(owner.pid);
      if (processGroupId !== record.processGroupId) return null;
      const observedBindings = await observedPortBindingsResolver(listener.port);
      if (!observedBindings.some((binding) => observedListenerMatchesDeclaration(binding, listener))) {
        return null;
      }
      listeners.push({
        listener_id: listener.id,
        lease_id: listener.lease ?? null,
        listener_pid: owner.pid,
        process_group_id: processGroupId,
        host: listener.host,
        port: listener.port,
      });
    }
    if (listeners.length === 0) return null;
    const finalProbe = await probeHealth(app);
    if (!finalProbe.reachable || !finalProbe.ok || !(await managedProcessGroupAlive(record))) {
      return null;
    }
    return {
      schema_version: "lazurio.posix_process_group_owner_proof.v1",
      platform,
      launcher_pid: record.pid,
      listener_pid: listeners[0].listener_pid,
      process_group_id: record.processGroupId,
      listeners,
      captured_at: new Date().toISOString(),
    };
  }

  async function persistWindowsRuntimeOwnerProofWhenHealthy(app, record) {
    const deadline = Date.now() + startGraceMs;
    let captureAttempts = 0;
    while (
      managedProcesses.get(record.runtimeKey) === record
      && !record.stopping
      && Date.now() < deadline
    ) {
      const probe = await probeHealth(app);
      if (probe.reachable && probe.ok) {
        captureAttempts += 1;
        if (await captureWindowsRuntimeOwnerProof(app, record)) return;
        if (captureAttempts >= windowsOwnerProofCaptureAttempts) {
          await appendLog(
            record.logPath,
            `[launchpad] Windows owner proof unavailable ${app.id} after ${captureAttempts} verified-health attempts\n`,
          );
          return;
        }
      }
      await sleep(openHealthyPollMs);
    }
  }

  async function captureWindowsRuntimeOwnerProof(app, record, expectedCwd = null) {
    if (
      platform !== "win32"
      || !record
      || record.ownerProofCaptured
      || record.stopping
      || managedProcesses.get(record.runtimeKey) !== record
    ) {
      return false;
    }

    const appExpectedCwd = expectedCwd
      ?? join(companiesRoot, app.cwd ?? dirname(app.package_path ?? "package.json"));
    const owner = await resolvePortOwnerFn(app.port, {
      expectedCwd: appExpectedCwd,
      host: app.entrypoint_listener?.host ?? app.host,
    });
    if (
      !Number.isInteger(owner?.pid)
      || owner.pid <= 0
      || owner.cwd_matches === false
    ) {
      return false;
    }

    const knownLauncherIdentity = await record.launcherIdentityPromise;
    const ancestry = await captureWindowsProcessAncestry(
      owner.pid,
      record.pid,
      processIdentityResolver,
      knownLauncherIdentity,
    );
    if (!ancestry) return false;
    const state = await readState(record.runtimeKey);
    if (
      !state
      || state.pid !== record.pid
      || state.instance_id !== instanceId
      || state.app_id !== app.id
      || state.runtime_key !== record.runtimeKey
      || state.port !== app.port
      || !["starting", "healthy"].includes(state.status)
      || record.stopping
      || managedProcesses.get(record.runtimeKey) !== record
    ) {
      return false;
    }

    const canonicalExpectedCwd = await canonicalPath(appExpectedCwd);
    const capturedAt = new Date().toISOString();
    const listenerIdentity = ancestry[0];
    const launcherIdentity = ancestry.at(-1);
    const ownerProof = {
      schema_version: "companiesascode.launchpad.runtime_owner_proof.v1",
      platform: "win32",
      launcher_pid: record.pid,
      launcher_identity: launcherIdentity,
      listener_pid: owner.pid,
      listener_identity: listenerIdentity,
      ancestry,
      expected_cwd: canonicalExpectedCwd,
      captured_at: capturedAt,
    };
    if (
      !validWindowsRuntimeOwnerProof(ownerProof)
      || record.stopping
      || managedProcesses.get(record.runtimeKey) !== record
    ) {
      return false;
    }
    // Mezi posledním guardem a přiřazením promise nesmí přibýt await: Stop i
    // exit handler pak spolehlivě počkají na tento už rozběhnutý zápis a jejich
    // terminální stav ho vždy přepíše až potom.
    record.ownerProof = ownerProof;
    const proofWritePromise = writeState(record.runtimeKey, {
      ...state,
      updated_at: capturedAt,
      owner_proof: ownerProof,
    });
    record.ownerProofWritePromise = proofWritePromise;
    try {
      await proofWritePromise;
      record.ownerProofCaptured = true;
      return true;
    } finally {
      if (record.ownerProofWritePromise === proofWritePromise) {
        record.ownerProofWritePromise = null;
      }
    }
  }

  async function dependencyForApp(app) {
    const appCwd = app.cwd ?? dirname(app.package_path ?? "package.json");
    const packagePath = app.package_path ?? join(appCwd, "package.json");
    const appRoot = join(companiesRoot, appCwd);
    const absolutePackagePath = join(companiesRoot, packagePath);
    const checkedAt = new Date().toISOString();

    if (!existsSync(absolutePackagePath)) {
      return dependencyResult({
        app,
        state: "missing_package",
        appCwd,
        packagePath,
        packageJsonPresent: false,
        nodeModulesPresent: false,
        lockfile: null,
        declaredDependencyCount: 0,
        packageManager: null,
        packageManagerSource: "missing_package",
        installCommand: null,
        checkedAt,
        message: `Chybí package.json pro ${app.title}. Spusť Doctor sync nebo oprav manifest package_path.`,
      });
    }

    let packageJson;
    try {
      packageJson = JSON.parse(await readFile(absolutePackagePath, "utf8"));
    } catch (error) {
      return dependencyResult({
        app,
        state: "missing_package",
        appCwd,
        packagePath,
        packageJsonPresent: true,
        nodeModulesPresent: false,
        lockfile: null,
        declaredDependencyCount: 0,
        packageManager: null,
        packageManagerSource: "invalid_package_json",
        installCommand: null,
        checkedAt,
        message: `package.json pro ${app.title} nejde přečíst: ${error.message}`,
      });
    }

    const nodeModulesPresent = existsSync(join(appRoot, "node_modules"));
    const lockfile = await firstExistingLockfile(appRoot);
    const manager = detectPackageManager({ packageJson, lockfile });
    const declaredDependencyCount = countDeclaredDependencies(packageJson);
    const packageNeedsInstall = declaredDependencyCount > 0 || Boolean(lockfile);
    const requiredSlot = await requiredModuleSlotState({ companiesRoot, app });

    if (requiredSlot) {
      return dependencyResult({
        app,
        state: requiredSlot.state,
        appCwd,
        packagePath,
        packageJsonPresent: true,
        nodeModulesPresent,
        lockfile,
        declaredDependencyCount,
        packageManager: manager.name,
        packageManagerSource: manager.source,
        installCommand: null,
        checkedAt,
        message: requiredSlot.message,
      });
    }

    if (!manager.supported) {
      return dependencyResult({
        app,
        state: "unknown_package_manager",
        appCwd,
        packagePath,
        packageJsonPresent: true,
        nodeModulesPresent,
        lockfile,
        declaredDependencyCount,
        packageManager: manager.name,
        packageManagerSource: manager.source,
        installCommand: null,
        checkedAt,
        message: `Package manager ${manager.name ?? "unknown"} není zatím podporovaný Launchpad Install akcí. Použij Doctor nebo terminál.`,
      });
    }

    let state = "ready";
    let message = `${app.title}: dependency state je ready.`;
    if (packageNeedsInstall && !nodeModulesPresent) {
      state = "needs_install";
      message = `${app.title}: chybí node_modules. Použij Install (${manager.installCommand.join(" ")}) v ${appCwd}.`;
    } else if (lockfile && nodeModulesPresent && await isPackageJsonNewerThanLockfile(absolutePackagePath, lockfile.absolute_path)) {
      state = "stale_lockfile";
      message = `${app.title}: package.json je novější než ${lockfile.path}. Spusť Install/Repair a zkontroluj případný lockfile diff.`;
    }

    return dependencyResult({
      app,
      state,
      appCwd,
      packagePath,
      packageJsonPresent: true,
      nodeModulesPresent,
      lockfile,
      declaredDependencyCount,
      packageManager: manager.name,
      packageManagerSource: manager.source,
      installCommand: manager.installCommand,
      checkedAt,
      message,
    });
  }

  async function readState(appId) {
    const path = statePathForApp(appId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  }

  async function writeState(appId, state) {
    await ensureRuntimeDirs();
    await writeRuntimeStateFile(statePathForApp(appId), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function ensureRuntimeDirs() {
    await mkdir(appStateRoot, { recursive: true });
    await mkdir(desiredStateRoot, { recursive: true });
    await mkdir(logsRoot, { recursive: true });
    await mkdir(takeoverAuditRoot, { recursive: true });
  }

  function statePathForApp(appId) {
    return join(appStateRoot, `${appId}.json`);
  }

  function logPathForApp(appId) {
    return join(logsRoot, `${appId}.log`);
  }

  function relativeRuntimePath(path) {
    // API/state cesty jsou přenositelné identifikátory, ne nativní filesystem
    // cesty. Na Windows proto nikdy nepropouštějí zpětná lomítka.
    return relative(launchpadRoot, path).replace(/\\/g, "/");
  }

  return {
    instanceId,
    appsWithRuntime,
    health,
    start,
    switchApp,
    install,
    open,
    stop,
    restart,
    logs,
    reconcileDesiredState,
  };
}

async function requiredModuleSlotState({ companiesRoot, app }) {
  const requiredSlots = Array.isArray(app?.required_module_slots)
    ? app.required_module_slots
    : [];
  if (requiredSlots.length === 0) return null;

  const organizationPath = typeof app?.organization_path === "string"
    ? app.organization_path
    : null;
  if (!organizationPath) {
    return {
      state: "required_slot_unavailable",
      message: `${app.title} deklaruje povinný Organization slot, ale runtime nemá bezpečně určenou cestu Organizace. Oprav runtime manifest.`,
    };
  }

  const organizationRoot = join(companiesRoot, organizationPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(organizationRoot, "modules.manifest.json"), "utf8"));
  } catch (error) {
    return {
      state: "required_slot_unavailable",
      message: `${app.title} nejde spustit, protože modules.manifest.json nelze přečíst: ${error.message}`,
    };
  }

  const slots = Array.isArray(manifest?.module_slots) ? manifest.module_slots : [];
  for (const requiredPath of requiredSlots) {
    const slot = slots.find((candidate) => candidate?.path === requiredPath);
    if (!slot) {
      return {
        state: "required_slot_unavailable",
        message: `${app.title} nejde spustit, protože modules.manifest.json nedeklaruje povinný slot ${requiredPath}.`,
      };
    }
    if (slot.status === "planned_slot") {
      return {
        state: "planned_slot",
        message: `${app.title} zatím nejde spustit: datový slot ${requiredPath} je plánovaný. Dokonči jeho schválenou manifestem řízenou aktivaci; repozitář ručně neklonuj.`,
      };
    }
    if (!existsSync(join(organizationRoot, requiredPath))) {
      return {
        state: "required_slot_unavailable",
        message: `${app.title} nejde spustit, protože povinný slot ${requiredPath} není na této mašině dostupný. Spusť Synchronizovat a Doctor.`,
      };
    }
  }
  return null;
}

function dependencyResult({
  app,
  state,
  appCwd,
  packagePath,
  packageJsonPresent,
  nodeModulesPresent,
  lockfile,
  declaredDependencyCount,
  packageManager,
  packageManagerSource,
  installCommand,
  checkedAt,
  message,
}) {
  const canInstall = packageJsonPresent && Boolean(installCommand) && ["ready", "needs_install", "stale_lockfile"].includes(state);
  return {
    schema_version: "companiesascode.launchpad.dependencies.v1",
    app_id: app.id,
    state,
    package_manager: packageManager,
    package_manager_source: packageManagerSource,
    install_command: installCommand,
    install_command_display: installCommand?.join(" ") ?? null,
    cwd: appCwd,
    package_path: packagePath,
    package_json_present: packageJsonPresent,
    node_modules_present: nodeModulesPresent,
    lockfile: lockfile
      ? {
          path: lockfile.path,
          package_manager: lockfile.package_manager,
        }
      : null,
    declared_dependency_count: declaredDependencyCount,
    can_install: canInstall,
    can_start: state === "ready" || state === "stale_lockfile",
    checked_at: checkedAt,
    cache: {
      status: "fresh",
      ttl_ms: 0,
    },
    message,
  };
}

async function refreshVerifiedStaleLockfile({ app, action, dependencies, cwd, logPath }) {
  if (dependencies.state !== "stale_lockfile") return;
  const lockfilePath = dependencies.lockfile?.path;
  if (!lockfilePath) return;
  const absoluteLockfilePath = join(cwd, lockfilePath);
  const verifiedAt = new Date();
  try {
    await utimes(absoluteLockfilePath, verifiedAt, verifiedAt);
    await appendLog(
      logPath,
      `[launchpad] ${verifiedAt.toISOString()} ${action} ${app.id} verified ${lockfilePath}; refreshed lockfile mtime after successful install\n`,
    );
  } catch (error) {
    await appendLog(
      logPath,
      `[launchpad] ${new Date().toISOString()} ${action} ${app.id} could not refresh ${lockfilePath} mtime: ${error.message}\n`,
    );
  }
}

async function firstExistingLockfile(appRoot) {
  for (const name of packageLockfileNames) {
    const absolutePath = join(appRoot, name);
    if (!existsSync(absolutePath)) continue;
    return {
      path: name,
      absolute_path: absolutePath,
      package_manager: packageManagerForLockfile(name),
    };
  }
  return null;
}

function detectPackageManager({ packageJson, lockfile }) {
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager.trim() : "";
  if (declared) {
    const name = packageManagerName(declared);
    return {
      name,
      source: "packageManager",
      supported: supportedInstallManagers.has(name),
      installCommand: supportedInstallManagers.has(name) ? [name, "install"] : null,
    };
  }

  if (lockfile) {
    return {
      name: lockfile.package_manager,
      source: `lockfile:${lockfile.path}`,
      supported: supportedInstallManagers.has(lockfile.package_manager),
      installCommand: supportedInstallManagers.has(lockfile.package_manager) ? [lockfile.package_manager, "install"] : null,
    };
  }

  return {
    name: "bun",
    source: "default",
    supported: true,
    installCommand: ["bun", "install"],
  };
}

function packageManagerName(value) {
  if (!value) return null;
  if (value.startsWith("@")) {
    const parts = value.split("@").filter(Boolean);
    return parts.length >= 2 ? `@${parts[0]}` : value;
  }
  return value.split("@")[0];
}

function packageManagerForLockfile(name) {
  return (
    {
      "bun.lock": "bun",
      "bun.lockb": "bun",
      "package-lock.json": "npm",
      "pnpm-lock.yaml": "pnpm",
      "yarn.lock": "yarn",
    }[name] ?? "unknown"
  );
}

function countDeclaredDependencies(packageJson) {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .map((key) => packageJson[key])
    .filter((value) => value && typeof value === "object" && !Array.isArray(value))
    .reduce((count, value) => count + Object.keys(value).length, 0);
}

async function isPackageJsonNewerThanLockfile(packagePath, lockfilePath) {
  try {
    const [packageStat, lockStat] = await Promise.all([stat(packagePath), stat(lockfilePath)]);
    return packageStat.mtimeMs > lockStat.mtimeMs + 1_000;
  } catch {
    return false;
  }
}

async function waitForEarlyExit(child, timeoutMs) {
  return Promise.race([
    child.exited,
    sleep(timeoutMs).then(() => null),
  ]);
}

async function logTail(logPath, bytes = logTailBytes) {
  if (!existsSync(logPath)) return "";
  const content = await readFile(logPath, "utf8");
  return content.slice(-bytes).trim();
}

function startConflictForRuntime(runtime) {
  if (runtime.owner === "foreign-port") {
    return {
      code: "app_port_conflict",
      message: `Port ${runtime.port} používá proces z jiného checkoutu. Zastav cizí instanci a potom Start zopakuj.`,
      details: [`pid: ${runtime.port_owner?.pid ?? "unknown"}`, `expected_cwd: ${runtime.dependencies?.cwd ?? "unknown"}`],
      metadata: { failure_kind: "port_owner_cwd_mismatch", runtime },
    };
  }
  if (runtime.owner === "unknown-port") {
    return {
      code: "app_port_conflict",
      message: runtime.port_owner?.pid
        ? `Port ${runtime.port} používá PID ${runtime.port_owner.pid}, ale Launchpad nedokázal ověřit jeho checkout. Proces nepřevzal ani ho neukončí.`
        : "Port aplikace odpovídá, ale Launchpad nedokázal zjistit PID procesu pro převzetí kontroly.",
      details: [`health: ${runtime.health_url}`, `owner: ${runtime.owner}`],
      metadata: { failure_kind: runtime.failure_kind ?? "port_conflict", runtime },
    };
  }
  if (runtime.port_owner?.pid && runtime.status === "unhealthy") {
    return {
      code: "app_port_conflict",
      message: `Port aplikace je obsazený PID ${runtime.port_owner.pid}, ale health endpoint není zdravý. Použij Stop nebo uvolni port.`,
      details: [`pid: ${runtime.port_owner.pid}`, `health: ${runtime.health_url}`],
      metadata: { failure_kind: "port_conflict", runtime },
    };
  }
  return {
    code: "app_already_running",
    message: "Aplikace už běží na app-owned portu. Použij Restart nebo Stop.",
    details: [`status: ${runtime.status}`, `owner: ${runtime.owner}`],
    metadata: { failure_kind: "already_running", runtime },
  };
}

function startFailure(app, exitCode, logExcerpt) {
  const kind = classifyStartFailure(logExcerpt);
  const nextAction = {
    missing_dependencies: "Použij Install/Repair a potom Start zopakuj.",
    missing_script: "Oprav dev_script v package.json nebo app manifestu.",
    bad_cwd: "Oprav cwd/package_path nebo spusť Doctor sync.",
    port_conflict: "Uvolni obsazený port nebo zastav starou instanci a potom Start zopakuj.",
    unknown_early_exit: "Otevři Logs a oprav runtime chybu v aplikaci.",
  }[kind] ?? "Otevři Logs a oprav runtime chybu v aplikaci.";
  const suffix = logExcerpt ? ` Poslední log:\n${logExcerpt}` : " Log je zatím prázdný.";
  return {
    kind,
    message: `${app.title} skončil hned po startu s exit code ${exitCode}. ${nextAction}${suffix}`,
  };
}

function classifyStartFailure(logExcerpt) {
  const text = String(logExcerpt ?? "");
  if (/Cannot find (module|package)|Module not found|ERR_MODULE_NOT_FOUND|Could not resolve/i.test(text)) {
    return "missing_dependencies";
  }
  if (/script.*not found|Missing script|could not find script/i.test(text)) {
    return "missing_script";
  }
  if (/no such file or directory|ENOENT|chdir/i.test(text)) {
    return "bad_cwd";
  }
  if (/EADDRINUSE|address already in use|port .*in use|port .*obsazen/i.test(text)) {
    return "port_conflict";
  }
  return "unknown_early_exit";
}

function classifyInstallFailure(logExcerpt) {
  const text = String(logExcerpt ?? "");
  if (/Cannot find (module|package)|Module not found|ERR_MODULE_NOT_FOUND|Could not resolve|No matching version|404 Not Found/i.test(text)) {
    return "missing_dependencies";
  }
  if (/preinstall|postinstall|lifecycle|script/i.test(text)) {
    return "install_script_failed";
  }
  if (/lockfile|lock file|bun\.lock|package-lock|yarn\.lock|pnpm-lock/i.test(text)) {
    return "lockfile_error";
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network|fetch failed|certificate/i.test(text)) {
    return "network_error";
  }
  return "install_failed";
}

function installFailureMessage(app, exitCode, logExcerpt) {
  const suffix = logExcerpt ? ` Poslední log:\n${logExcerpt}` : " Log je zatím prázdný.";
  return `Instalace balíčků pro ${app.title} selhala s exit code ${exitCode}.${suffix}`;
}

let cachedBunExecutable;
let hasCachedBunExecutable = false;

export function resolveBunExecutable(options = {}) {
  const useCache = Object.keys(options).length === 0;
  if (useCache && hasCachedBunExecutable) return cachedBunExecutable;

  const resolved = resolveBunExecutableUncached(options);
  if (useCache) {
    cachedBunExecutable = resolved;
    hasCachedBunExecutable = true;
  }
  return resolved;
}

function resolveBunExecutableUncached({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  which = defaultWhich,
  pathExists = existsSync,
  probe = probeBunExecutableSync,
} = {}) {
  const pathCommand = platform === "win32" ? "bun.exe" : "bun";
  const fromPath = which(pathCommand) ?? which("bun");
  const runningBun = /^bun(?:\.exe)?$/i.test(basename(execPath ?? "")) && pathExists(execPath)
    ? execPath
    : null;
  const installedCandidates = bunExecutableCandidates({ platform, env })
    .filter((candidate) => pathExists(candidate));
  for (const candidate of [...new Set([
    fromPath,
    runningBun,
    ...installedCandidates,
    pathCommand,
  ].filter(Boolean))]) {
    if (probe(candidate)) return candidate;
  }
  // Zachováme stávající spawn/catch failure path s lidskou chybou, i když
  // žádný kandidát validací neprošel.
  return pathCommand;
}

export function bunExecutableCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return [];
  return [...new Set([
    env.USERPROFILE ? win32.join(env.USERPROFILE, ".bun", "bin", "bun.exe") : null,
    env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "bun", "bin", "bun.exe") : null,
  ].filter(Boolean))];
}

export function resetBunExecutableCacheForTests() {
  cachedBunExecutable = undefined;
  hasCachedBunExecutable = false;
}

export function windowsTaskkillCommand(pid, { force = false, env = process.env } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid Windows process id: ${pid}`);
  const executable = trustedWindowsSystemExecutable(["System32", "taskkill.exe"], env);
  return [executable, "/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
}

export function windowsPowerShellExecutable(env = process.env) {
  return trustedWindowsSystemExecutable(
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    env,
  );
}

export function windowsProcessIdentityCommand(pid, env = process.env) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid Windows process id: ${pid}`);
  const script = [
    `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue`,
    "if ($null -eq $process) { exit 3 }",
    "[ordered]@{ pid = [int]$process.ProcessId; parent_pid = [int]$process.ParentProcessId; created_at = $process.CreationDate.ToUniversalTime().ToString('o'); executable_path = [string]$process.ExecutablePath } | ConvertTo-Json -Compress",
  ].join("; ");
  return [
    windowsPowerShellExecutable(env),
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ];
}

export function parseWindowsProcessIdentity(output) {
  try {
    return normalizeWindowsProcessIdentity(JSON.parse(String(output ?? "").trim()));
  } catch {
    return null;
  }
}

async function resolveProcessIdentity(
  pid,
  { platform = process.platform, runCommandFn = runCommand, env = process.env } = {},
) {
  if (platform !== "win32") return null;
  const result = await runCommandFn(windowsProcessIdentityCommand(pid, env), {
    timeoutMs: windowsProcessIdentityTimeoutMs,
  });
  return result.ok ? parseWindowsProcessIdentity(result.stdout) : null;
}

async function captureWindowsProcessAncestry(
  listenerPid,
  launcherPid,
  resolveIdentity,
  knownLauncherIdentity = null,
) {
  if (
    !Number.isInteger(listenerPid)
    || listenerPid <= 0
    || !Number.isInteger(launcherPid)
    || launcherPid <= 0
  ) {
    return null;
  }
  const ancestry = [];
  const seen = new Set();
  let currentPid = listenerPid;
  for (let depth = 0; depth < 8; depth += 1) {
    if (seen.has(currentPid)) return null;
    seen.add(currentPid);
    let identity = null;
    if (currentPid === launcherPid) {
      identity = normalizeWindowsProcessIdentity(knownLauncherIdentity);
    }
    if (!identity) {
      try {
        identity = normalizeWindowsProcessIdentity(await resolveIdentity(currentPid));
      } catch {}
    }
    if (!identity || identity.pid !== currentPid) return null;
    ancestry.push(identity);
    if (identity.pid === launcherPid) return ancestry;
    if (!Number.isInteger(identity.parent_pid) || identity.parent_pid <= 0) return null;
    currentPid = identity.parent_pid;
  }
  return null;
}

function validWindowsRuntimeOwnerProof(proof) {
  if (
    !proof
    || proof.schema_version !== "companiesascode.launchpad.runtime_owner_proof.v1"
    || proof.platform !== "win32"
    || !Number.isInteger(proof.launcher_pid)
    || proof.launcher_pid <= 0
    || !Number.isInteger(proof.listener_pid)
    || proof.listener_pid <= 0
    || typeof proof.expected_cwd !== "string"
    || proof.expected_cwd.trim() === ""
    || typeof proof.captured_at !== "string"
    || !Number.isFinite(Date.parse(proof.captured_at))
    || !Array.isArray(proof.ancestry)
    || proof.ancestry.length < 1
    || proof.ancestry.length > 8
  ) {
    return false;
  }
  const ancestry = proof.ancestry.map(normalizeWindowsProcessIdentity);
  if (ancestry.some((identity) => !identity)) return false;
  const listenerIdentity = normalizeWindowsProcessIdentity(proof.listener_identity);
  const launcherIdentity = normalizeWindowsProcessIdentity(proof.launcher_identity ?? ancestry.at(-1));
  if (
    !listenerIdentity
    || !launcherIdentity
    || proof.listener_pid !== listenerIdentity.pid
    || proof.launcher_pid !== launcherIdentity.pid
    || !sameWindowsProcessIdentity(listenerIdentity, ancestry[0])
    || !sameWindowsProcessIdentity(launcherIdentity, ancestry.at(-1))
  ) {
    return false;
  }
  const seen = new Set();
  for (let index = 0; index < ancestry.length; index += 1) {
    const identity = ancestry[index];
    if (seen.has(identity.pid)) return false;
    seen.add(identity.pid);
    if (index < ancestry.length - 1) {
      const parentIdentity = ancestry[index + 1];
      if (
        identity.parent_pid !== parentIdentity.pid
        || Date.parse(parentIdentity.created_at) > Date.parse(identity.created_at)
      ) {
        return false;
      }
    }
  }
  return true;
}

function windowsRuntimeOwnerProofState(proof) {
  return validWindowsRuntimeOwnerProof(proof) ? { owner_proof: proof } : {};
}

function stateAllowsWindowsRuntimeOwnerProof(state) {
  if (["starting", "healthy", "stopping"].includes(state?.status)) return true;
  return state?.status === "unhealthy"
    && ["stop_preparation_failed", "stop_signal_failed"].includes(state?.failure_kind);
}

function normalizeWindowsProcessIdentity(identity) {
  if (
    !Number.isInteger(identity?.pid)
    || identity.pid <= 0
    || !Number.isInteger(identity?.parent_pid)
    || identity.parent_pid < 0
    || typeof identity?.created_at !== "string"
    || !Number.isFinite(Date.parse(identity.created_at))
    || typeof identity?.executable_path !== "string"
    || identity.executable_path.trim() === ""
  ) {
    return null;
  }
  return {
    pid: identity.pid,
    parent_pid: identity.parent_pid,
    created_at: new Date(identity.created_at).toISOString(),
    executable_path: identity.executable_path,
  };
}

function sameWindowsProcessIdentity(expected, actual) {
  const left = normalizeWindowsProcessIdentity(expected);
  const right = normalizeWindowsProcessIdentity(actual);
  return Boolean(
    left
    && right
    && left.pid === right.pid
    && left.parent_pid === right.parent_pid
    && left.created_at === right.created_at
    && win32.normalize(left.executable_path).toLowerCase()
      === win32.normalize(right.executable_path).toLowerCase(),
  );
}

export function windowsNetstatCommand(env = process.env) {
  const executable = trustedWindowsSystemExecutable(["System32", "netstat.exe"], env);
  // Bez `-p tcp`: Windows rozlišuje filtry `tcp` a `tcpv6`, zatímco
  // nefiltrovaný výstup obsahuje listenery obou rodin a parser si vybírá TCP.
  return [executable, "-ano"];
}

export function parseWindowsListeningPid(output, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0].toUpperCase() !== "TCP") continue;
    const localPort = endpointPort(fields[1]);
    const foreignPort = endpointPort(fields[2]);
    const pid = Number(fields[4]);
    // A TCP listener has no connected peer (foreign port 0). Avoid depending
    // on the localized Windows state label while still excluding established
    // connections that happen to use the same local port.
    if (localPort === port && foreignPort === 0 && Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

export function parseWindowsListeningBindings(output, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
  const bindings = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0].toUpperCase() !== "TCP") continue;
    if (endpointPort(fields[1]) !== port || endpointPort(fields[2]) !== 0) continue;
    const endpoint = fields[1];
    const host = endpoint.slice(0, endpoint.lastIndexOf(":"))
      .replace(/^\[(.*)\]$/, "$1")
      .toLowerCase();
    bindings.push({ endpoint, host, port });
  }
  return bindings.filter((binding, index, all) =>
    all.findIndex((candidate) => candidate.endpoint === binding.endpoint) === index
  );
}

export async function resolveObservedPortBindings(
  port,
  { platform = process.platform, runCommandFn = runCommand, env = process.env } = {},
) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
  if (platform === "win32") {
    const result = await runCommandFn(windowsNetstatCommand(env));
    return result?.ok ? parseWindowsListeningBindings(result.stdout, port) : [];
  }
  const result = await runCommandFn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FnP"]);
  return result?.ok
    ? parseProcessGroupListeners(result.stdout).filter((binding) => binding.port === port)
    : [];
}

function runtimePackageCommand(command, bunExecutable) {
  if (!Array.isArray(command) || command.length === 0) return command;
  return command[0] === "bun" || command[0] === "bun.exe"
    ? [bunExecutable, ...command.slice(1)]
    : command;
}

function defaultWhich(command) {
  try {
    return typeof Bun.which === "function" ? Bun.which(command) : null;
  } catch {
    return null;
  }
}

function probeBunExecutableSync(executable) {
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
      timeout: 5_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function isMissingProcessResult(result) {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}\n${result.error ?? ""}`;
  return /not found|no running instance|nenalezena|nebyla nalezena/i.test(text);
}

export async function resolvePortOwner(port, { expectedCwd = null, includeSelf = false } = {}) {
  // Test-only escape hatch: production callers must keep self ownership
  // excluded so a runtime lifecycle can never target the Launchpad process.
  // Port leases are global by numeric TCP port, not by a particular loopback
  // address. Always resolve the OS listener first: a successful bind on ::1
  // must not hide an existing owner on 127.0.0.1 (or vice versa).
  const pid = process.platform === "win32" ? await resolvePortOwnerWindows(port) : await resolvePortOwnerUnix(port);
  if (!pid || (!includeSelf && pid === process.pid)) return null;
  if (!expectedCwd) return { pid };

  const processCwd = await resolveProcessCwd(pid);
  if (!processCwd) return { pid, cwd_matches: null };
  const [actual, expected] = await Promise.all([canonicalPath(processCwd), canonicalPath(expectedCwd)]);
  return { pid, cwd_matches: actual === expected };
}

export async function probeNumericPortOccupied(port, { host = null } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  const hosts = [...new Set([
    host ? canonicalRuntimeListenerHost(host) : null,
    "127.0.0.1",
    "::1",
  ].filter(Boolean))];
  const results = await Promise.all(hosts.map((candidateHost) => new Promise((resolveOccupied) => {
    const socket = createConnection({ host: candidateHost, port });
    let settled = false;
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOccupied(occupied);
    };
    socket.setTimeout(portOccupancyProbeTimeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  })));
  return results.some(Boolean);
}

async function resolveProcessCwd(pid) {
  if (process.platform === "linux") {
    try {
      return await realpath(`/proc/${pid}/cwd`);
    } catch {
      // Fall through to lsof for restricted /proc mounts.
    }
  }
  if (process.platform === "win32") return null;

  const lsof = await runCommand(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (!lsof.ok) return null;
  const cwdLine = lsof.stdout.split(/\r?\n/).find((line) => line.startsWith("n"));
  return cwdLine?.slice(1) || null;
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function resolvePortOwnerUnix(port) {
  const lsof = await runCommand(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (lsof.ok) return parsePid(lsof.stdout);

  const ss = await runCommand(["ss", "-ltnp", `sport = :${port}`]);
  if (!ss.ok) return null;
  const match = ss.stdout.match(/pid=(\d+)/);
  return match ? Number(match[1]) : null;
}

async function resolvePortOwnerWindows(port) {
  const result = await runCommand(windowsNetstatCommand());
  return result.ok ? parseWindowsListeningPid(result.stdout, port) : null;
}

export async function resolvePosixProcessGroupId(pid, { runCommandFn = runCommand } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = await runCommandFn(["ps", "-o", "pgid=", "-p", String(pid)]);
  if (!result?.ok) return null;
  return parsePid(result.stdout);
}

async function runCommand(command, { timeoutMs = null } = {}) {
  try {
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const readStream = (stream) => new Response(stream).text()
      .then((value) => ({ value, error: null }))
      .catch((error) => ({ value: "", error }));
    const stdoutPromise = readStream(child.stdout);
    const stderrPromise = readStream(child.stderr);
    const timeoutToken = Symbol("command-timeout");
    let timeoutId = null;
    const exitCode = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? await Promise.race([
          child.exited,
          new Promise((resolveTimeout) => {
            timeoutId = setTimeout(() => resolveTimeout(timeoutToken), timeoutMs);
          }),
        ])
      : await child.exited;
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (exitCode === timeoutToken) {
      try {
        child.kill("SIGKILL");
      } catch {}
      return { ok: false, exitCode: null, stdout: "", stderr: "", error: `timeout after ${timeoutMs}ms` };
    }
    const [stdoutResult, stderrResult] = await Promise.all([stdoutPromise, stderrPromise]);
    const streamError = stdoutResult.error ?? stderrResult.error;
    return {
      ok: exitCode === 0 && !streamError,
      exitCode,
      stdout: stdoutResult.value,
      stderr: stderrResult.value,
      ...(streamError ? { error: `stream read failed: ${streamError.message}` } : {}),
    };
  } catch (error) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: error.message };
  }
}

function parsePid(output) {
  const value = output
    .split(/\s+/)
    .map((item) => Number(item))
    .find((item) => Number.isInteger(item) && item > 0);
  return value ?? null;
}

function endpointPort(endpoint) {
  const match = String(endpoint ?? "").match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function pipeOutput(stream, logPath, label) {
  if (!stream) return;
  try {
    const content = await new Response(stream).text();
    if (content) {
      await appendLog(logPath, `[${label}] ${content}`);
    }
  } catch (error) {
    await appendLog(logPath, `[launchpad] pipe ${label} failed: ${error.message}\n`);
  }
}

async function appendLog(logPath, content) {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, content, "utf8");
}

async function probeHealth(app) {
  const listener = app?.entrypoint_listener
    ? { ...app.entrypoint_listener, port: app.port }
    : {
        host: app?.host,
        port: app?.port,
        protocol: "http",
        health: { kind: "http", path: app?.health_path },
      };
  return probeRuntimeListener(listener);
}

export async function probeRuntimeListener(listener) {
  if (!Number.isInteger(listener?.port)) {
    return { reachable: false, ok: false, error: "module port lease is missing" };
  }
  if (listener.health?.kind === "tcp") {
    return probeTcpListener(listener);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetch(listenerHealthUrl(listener), {
      cache: "no-store",
      signal: controller.signal,
    });
    return {
      reachable: true,
      ok: response.ok,
      status_code: response.status,
    };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      error: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function probeTcpListener(listener) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: listener.host, port: listener.port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(healthTimeoutMs);
    socket.once("connect", () => finish({ reachable: true, ok: true }));
    socket.once("timeout", () => finish({ reachable: false, ok: false, error: "timeout" }));
    socket.once("error", (error) => finish({ reachable: false, ok: false, error: error.message }));
  });
}

function listenerHealthUrl(listener) {
  if (!Number.isInteger(listener?.port)) return null;
  const protocol = listener.protocol === "https" ? "https" : "http";
  return `${protocol}://${runtimeUrlHost(listener.host)}:${listener.port}${listener.health?.path ?? "/"}`;
}

function healthUrl(app) {
  if (!Number.isInteger(app?.port)) return null;
  return listenerHealthUrl({
    ...(app.entrypoint_listener ?? {}),
    host: app.host,
    port: app.port,
    health: app.entrypoint_listener?.health ?? { kind: "http", path: app.health_path },
  });
}

function appUrl(app) {
  if (!Number.isInteger(app?.port)) return null;
  const protocol = app.entrypoint_listener?.protocol === "https" ? "https" : "http";
  return `${protocol}://${runtimeUrlHost(app.host)}:${app.port}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
