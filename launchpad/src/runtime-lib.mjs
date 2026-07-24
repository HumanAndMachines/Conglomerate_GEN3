import { existsSync } from "fs";
import { appendFile, mkdir, readFile, realpath, stat, utimes, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { createServer } from "net";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "path";
import { discoverLaunchpadApps } from "./discovery-lib.mjs";
import { recordAppOpen } from "./usage-lib.mjs";
import { buildWorktreeIndex } from "./worktree-lib.mjs";

const healthTimeoutMs = 1_200;
const startGraceMs = 30_000;
const startEarlyExitProbeMs = 1_000;
// One-click open (CAC-0044): po startu pollujeme health, dokud port neposlouchá,
// aby URL vrácené frontendu vedlo na živý server, ne na „connection refused".
// Bounded oknem (dev servery vite/next běžně startují 2–5 s), s poll intervalem.
const openHealthyWaitMs = 20_000;
const openHealthyPollMs = 250;
const openHealthyStabilityMs = 1_000;
const stopTimeoutMs = 5_000;
const stopPollMs = 100;
const stopKillWaitMs = 2_000;
const logTailBytes = 40_000;
const errorTailBytes = 4_000;
const packageLockfileNames = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const supportedInstallManagers = new Set(["bun"]);

export function runtimeHostsShareListener(left, right) {
  const normalize = (host) => host === "localhost" ? "127.0.0.1" : host;
  return normalize(left) === normalize(right);
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
  platform = process.platform,
  spawnProcess = Bun.spawn,
  runSystemCommandFn = runCommand,
  writeRuntimeStateFile = writeFile,
  bunExecutable = null,
}) {
  const runtimeBunExecutable = bunExecutable
    ?? (platform === process.platform ? resolveBunExecutable() : resolveBunExecutable({ platform }));
  const managedProcesses = new Map();
  const runtimeRoot = join(launchpadRoot, "runtime");
  const appStateRoot = join(runtimeRoot, "apps");
  const logsRoot = join(launchpadRoot, "logs", "apps");

  async function appsWithRuntime(apps) {
    return Promise.all(
      apps.map(async (app) => {
        const runtime = await healthForApp(app);
        const dependencies = runtime.dependencies;
        return {
          ...app,
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
    const app = await runtimeAppForAction(appId, options);
    return startRuntimeApp(app);
  }

  // Dvě známé app surfaces různých Organizací smějí vlastnit stejný
  // deklarovaný port, ale běžet může jen jedna. Switch vyžaduje explicitní
  // intent (samostatné potvrzení nebo uživatelské Open), main runtime na obou
  // stranách a před Stopem znovu sváže živý PID s pozitivně ověřeným checkoutem
  // nahrazované aplikace. Foreign/unknown listenery se nikdy neukončují.
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

    const target = await runtimeAppForAction(appId, { source });
    if (runtimeSourceForApp(target).type !== "main") {
      throw new RuntimeActionError(
        409,
        "app_switch_main_only",
        "Přepnutí sdíleného app-owned portu je povolené jen mezi main checkouty; worktree runtime používá vlastní DEV port.",
      );
    }
    const replaced = await runtimeAppForAction(replaceAppId.trim(), { source: { type: "main" } });
    if (target.company === replaced.company) {
      throw new RuntimeActionError(
        409,
        "app_switch_same_organization",
        "Přepnutí sdíleného portu je povolené jen mezi různými Organizacemi; uvnitř jedné Organizace musí být app-owned porty unikátní.",
        [`organization: ${target.company}`, `target_app: ${target.id}`, `replace_app: ${replaced.id}`],
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

    const [targetRuntime, replacedRuntime] = await Promise.all([
      healthForApp(target),
      healthForApp(replaced),
    ]);
    const targetPid = targetRuntime.port_owner?.pid ?? targetRuntime.pid;
    const replacedOwner = await resolvePortOwnerFn(replaced.port, {
      expectedCwd: join(companiesRoot, replaced.cwd ?? dirname(replaced.package_path ?? "package.json")),
    });
    if (
      !["current-instance", "adopted-port"].includes(replacedRuntime.owner)
      || targetRuntime.owner !== "foreign-port"
      || !Number.isInteger(targetPid)
      || replacedOwner?.cwd_matches !== true
      || replacedOwner.pid !== targetPid
    ) {
      throw new RuntimeActionError(
        409,
        "app_switch_owner_unverified",
        "Proces na sdíleném portu už nelze bezpečně přiřadit zvolené Launchpad aplikaci; obnov stav a zkontroluj Doctor.",
        [
          `target_owner: ${targetRuntime.owner}`,
          `target_pid: ${targetPid ?? "unknown"}`,
          `replace_owner: ${replacedRuntime.owner}`,
          `replace_listener_pid: ${replacedOwner?.pid ?? "unknown"}`,
          `replace_cwd_verified: ${replacedOwner?.cwd_matches === true}`,
        ],
        { failure_kind: "port_owner_unverified", port: target.port },
      );
    }

    const stopped = await stop(replaced.id, { source: { type: "main" } });
    const started = await startRuntimeApp(target);
    return {
      action: "switch",
      app_id: target.id,
      replaced_app_id: replaced.id,
      port: target.port,
      stopped,
      started,
      runtime: started.runtime,
      url: started.runtime?.url ?? appUrl(target),
    };
  }

  async function runningCrossOrganizationPortPeer(app) {
    if (runtimeSourceForApp(app).type !== "main") return null;
    const discovery = await discover(companiesRoot);
    if (discovery.failures.length > 0) return null;
    const candidates = discovery.apps.filter((candidate) =>
      candidate.id !== app.id
      && candidate.company !== app.company
      && candidate.port === app.port
      && runtimeHostsShareListener(candidate.host, app.host)
    );
    for (const candidate of candidates) {
      const runtime = await healthForApp(candidate);
      if (["current-instance", "adopted-port"].includes(runtime.owner)) return candidate;
    }
    return null;
  }

  async function startRuntimeApp(app) {
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    const current = await healthForApp(app);
    if (managedProcesses.has(runtimeKey)) {
      throw new RuntimeActionError(409, "already_managed", "Aplikace už běží jako managed proces.");
    }
    if (current.status !== "stopped") {
      const conflict = startConflictForRuntime(current);
      throw new RuntimeActionError(
        409,
        conflict.code,
        conflict.message,
        conflict.details,
        conflict.metadata,
      );
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
    const childEnv = runtimeProcessEnv(app, {
      PORT: String(app.port),
      HOST: app.host,
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
      startedAt,
      logPath,
      stopping: false,
      finalizeStopOnExit: false,
      finalizeStopForced: false,
      stopExitConfirmed: false,
      stopExitCode: null,
      stopFinalizationReady: false,
      stopFinalizationOptions: null,
      stopFinalizationPromise: null,
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
      instance_id: instanceId,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      log_path: relativeRuntimePath(logPath),
    });

    child.exited.then(async (exitCode) => {
      if (record.stopping) {
        record.stopExitConfirmed = true;
        record.stopExitCode = exitCode;
        if (record.finalizeStopOnExit) {
          prepareStopFinalization(record, {
            exitCode,
            forced: record.finalizeStopForced,
          });
          await finalizeManagedStop(app, record, runtimeKey, runtimeSource, {
            exitCode,
            forced: record.finalizeStopForced,
          });
        }
        return;
      }
      const currentRecord = managedProcesses.get(runtimeKey);
      if (currentRecord === record) {
        managedProcesses.delete(runtimeKey);
      }
      await Promise.allSettled(record.outputPipes);
      await appendLog(logPath, `[launchpad] ${new Date().toISOString()} exit ${app.id} source=${runtimeSource.type} code=${exitCode}\n`);
      const log_excerpt = await logTail(logPath, errorTailBytes);
      const failure = exitCode === 0 ? null : startFailure(app, exitCode, log_excerpt);
      await writeState(runtimeKey, {
        status: exitCode === 0 ? "stopped" : "unhealthy",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        port: app.port,
        pid: child.pid,
        instance_id: instanceId,
        started_at: startedAt,
        stopped_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        exit_code: exitCode,
        log_path: relativeRuntimePath(logPath),
        ...(failure ? { last_error: failure.message, failure_kind: failure.kind, log_excerpt } : {}),
      });
    }).catch(async (error) => {
      await appendLog(logPath, `[launchpad] exit finalization failed ${app.id}: ${error.message}\n`);
    });

    const earlyExit = await waitForEarlyExit(child, startEarlyExitProbeMs);
    if (earlyExit !== null) {
      record.stopping = true;
      managedProcesses.delete(runtimeKey);
      await Promise.allSettled(record.outputPipes);
      const log_excerpt = await logTail(logPath, errorTailBytes);
      const failure = startFailure(app, earlyExit, log_excerpt);
      await writeState(runtimeKey, {
        status: "unhealthy",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        port: app.port,
        pid: child.pid,
        instance_id: instanceId,
        started_at: startedAt,
        stopped_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        exit_code: earlyExit,
        log_path: relativeRuntimePath(logPath),
        last_error: failure.message,
        failure_kind: failure.kind,
        log_excerpt,
      });
      throw new RuntimeActionError(500, "app_start_failed", failure.message, [log_excerpt].filter(Boolean), {
        failure_kind: failure.kind,
        exit_code: earlyExit,
        log_path: relativeRuntimePath(logPath),
        log_excerpt,
      });
    }

    return {
      action: "start",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      pid: child.pid,
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
  // stavem — port se nikdy tiše nepřemapuje. Open poslední aplikace smí převzít
  // port jen od pozitivně ověřené známé aplikace jiné Organizace.
  async function open(appId, { source = null } = {}) {
    const app = await runtimeAppForAction(appId, { source });
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

    // 2) Ensure start — idempotentní. Když už appka běží (managed nebo
    //    adopted-port healthy), start přeskočíme a jen vrátíme URL. Pokud port
    //    drží známá appka jiné Organizace, poslední uživatelské Open ji bezpečně
    //    vystřídá. Foreign/unknown proces propadne do blokujícího konfliktu.
    let runtime = await healthForApp(app);
    if (runtime.status === "healthy") {
      steps.push({ step: "reuse", status: runtime.status });
    } else if (managedProcesses.has(runtimeKey) && runtime.status === "starting") {
      steps.push({ step: "reuse", status: runtime.status });
      shouldConfirmStability = true;
    } else {
      const sharedPortPeer = runtime.owner === "foreign-port"
        ? await runningCrossOrganizationPortPeer(app)
        : null;
      const startResult = sharedPortPeer
        ? await switchApp(app.id, {
            replace_app_id: sharedPortPeer.id,
            confirmed: true,
            source: runtimeSource,
          })
        : await startRuntimeApp(app);
      steps.push(sharedPortPeer
        ? { step: "switch", replaced_app_id: sharedPortPeer.id, status: startResult.runtime?.status ?? "starting" }
        : { step: "start", status: startResult.runtime?.status ?? "starting" });
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

    if (runtime.status === "unhealthy" || runtime.status === "stopped") {
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
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    const record = managedProcesses.get(runtimeKey);
    if (!record) {
      const current = await healthForApp(app);
      if (current.owner === "adopted-port" && Number.isInteger(current.port_owner?.pid)) {
        return stopAdoptedRuntimeApp(app, current);
      }
      throw new RuntimeActionError(409, "app_not_managed", "Aplikace neběží jako managed proces tohoto Launchpadu.", [
        `app_id: ${app.id}`,
        `runtime_status: ${current.status}`,
        `owner: ${current.owner}`,
      ], {
        failure_kind: "not_managed",
        owner: current.owner,
      });
    }

    if (record.stopping) {
      if (record.stopFinalizationReady && record.stopFinalizationOptions) {
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
    try {
      await writeState(runtimeKey, {
        status: "stopping",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        port: record.port ?? app.port,
        pid: record.pid,
        instance_id: instanceId,
        started_at: record.startedAt,
        updated_at: new Date().toISOString(),
        log_path: relativeRuntimePath(record.logPath),
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

    const result = await Promise.race([
      record.child.exited.then((exitCode) => ({ exitCode, timeout: false })),
      sleep(stopTimeoutMs).then(() => ({ exitCode: null, timeout: true })),
    ]);
    if (!result.timeout) {
      record.stopExitConfirmed = true;
      record.stopExitCode = result.exitCode;
    }

    // Windows už první bezpečně scoped Stop provede přes taskkill /T /F.
    // Druhé cílení stejného PID po timeoutu by po rychlém PID reuse mohlo
    // zasáhnout cizí proces. Identitu proto potvrzuje původní child handle:
    // timeout ponechá ownership, potvrzený exit dovolí uklidit managed záznam.
    let exitCode = result.exitCode;
    if (result.timeout && platform !== "win32") {
      try {
        await signalManagedProcess(record, runtimeKey, "SIGKILL");
      } catch (error) {
        await recoverRetryableStopAttempt(app, record, runtimeKey, runtimeSource, error, {
          failureKind: error?.metadata?.failure_kind ?? "stop_signal_failed",
        });
        throw error;
      }
      const killResult = await Promise.race([
        record.child.exited.then((confirmedExitCode) => ({
          exitCode: confirmedExitCode,
          timeout: false,
        })),
        sleep(stopKillWaitMs).then(() => ({ exitCode: null, timeout: true })),
      ]);
      if (killResult.timeout) {
        enableStopFinalizationOnExit(app, record, runtimeKey, runtimeSource, {
          forced: true,
        });
        await appendLog(
          record.logPath,
          `[launchpad] SIGKILL completed but child exit was not confirmed ${app.id} managed_pid=${record.pid}\n`,
        );
        throw stopExitUnconfirmedError(app, record);
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

    const forced = platform === "win32" || result.timeout;
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
    { failureKind },
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
        instance_id: instanceId,
        started_at: record.startedAt,
        updated_at: updatedAt,
        log_path: relativeRuntimePath(record.logPath),
        last_error: error?.message ?? String(error),
        failure_kind: failureKind,
      });
    } catch {
      // Původní Stop chyba je pro volajícího směrodatná. Managed record se
      // přesto musí vrátit do retryable stavu, když child stále běží.
    }

    if (record.stopExitConfirmed) {
      enableStopFinalizationOnExit(app, record, runtimeKey, runtimeSource, {
        forced: false,
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
    prepareStopFinalization(record, {
      exitCode: record.stopExitCode,
      forced,
    });
    void finalizeManagedStop(app, record, runtimeKey, runtimeSource, {
      exitCode: record.stopExitCode,
      forced,
    }).catch(async (error) => {
      await appendLog(record.logPath, `[launchpad] deferred stop finalization failed ${app.id}: ${error.message}\n`);
    });
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

    if (platform === "win32") {
      const command = windowsTaskkillCommand(record.pid, {
        // taskkill /T bez /F neumí spolehlivě ukončit console procesy. PID je
        // bezpečně svázaný s managedProcesses této instance, takže Windows
        // ukončí celý známý strom atomicky už při prvním Stop pokusu.
        force: true,
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
      record.child.kill(signal);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      await appendLog(record.logPath, `[launchpad] stop signal failed: ${error.message}\n`);
      throw new RuntimeActionError(
        error?.code === "EPERM" ? 403 : 500,
        error?.code === "EPERM" ? "app_stop_forbidden" : "app_stop_failed",
        `Managed procesu PID ${record.pid} nelze poslat ${signal}: ${error.message}`,
        [`runtime_key: ${runtimeKey}`, `pid: ${record.pid}`, `signal: ${signal}`],
        { failure_kind: "stop_signal_failed", owner: "current-instance", pid: record.pid, signal },
      );
    }
  }

  // App-owned port je source of truth i po restartu / paralelním spuštění
  // Launchpadu. Před každým signálem znovu ověříme, že port pořád vlastní PID,
  // který health snapshot adoptoval. Když se PID mezitím změní (např. supervisor
  // proces appku respawnul), nový proces bez další explicitní akce nezabíjíme.
  async function stopAdoptedRuntimeApp(app, current) {
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    const expectedPid = current.port_owner.pid;
    const logPath = logPathForApp(runtimeKey);
    const expectedCwd = join(companiesRoot, app.cwd ?? dirname(app.package_path ?? "package.json"));
    const confirmedOwner = await resolvePortOwnerFn(app.port, { expectedCwd });

    if (!confirmedOwner) {
      return {
        action: "stop",
        app_id: app.id,
        runtime_key: runtimeKey,
        runtime_source: runtimeSource,
        owner: "adopted-port",
        pid: expectedPid,
        forced: false,
        already_stopped: true,
        runtime: await healthForApp(app),
      };
    }
    assertExpectedPortOwner(app, expectedPid, confirmedOwner);

    await ensureRuntimeDirs();
    await writeState(runtimeKey, {
      status: "stopping",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      port: app.port,
      pid: expectedPid,
      owner: "adopted-port",
      stop_instance_id: instanceId,
      updated_at: new Date().toISOString(),
      log_path: relativeRuntimePath(logPath),
    });
    await appendLog(logPath, `[launchpad] ${new Date().toISOString()} stop adopted ${app.id} pid=${expectedPid} port=${app.port}\n`);

    signalAdoptedProcess(app, expectedPid, "SIGTERM");
    let outcome = await waitForPortOwnerChange(app.port, expectedPid, stopTimeoutMs, resolvePortOwnerFn);
    let forced = false;

    if (outcome.owner?.pid === expectedPid) {
      // PID/port vazbu ověřujeme znovu těsně před nevratným SIGKILL.
      const ownerBeforeKill = await resolvePortOwnerFn(app.port, { expectedCwd });
      if (!ownerBeforeKill) {
        outcome = { owner: null };
      } else {
        assertExpectedPortOwner(app, expectedPid, ownerBeforeKill);
        signalAdoptedProcess(app, expectedPid, "SIGKILL");
        forced = true;
        outcome = await waitForPortOwnerChange(app.port, expectedPid, stopKillWaitMs, resolvePortOwnerFn);
      }
    }

    if (outcome.owner?.pid && outcome.owner.pid !== expectedPid) {
      await appendLog(logPath, `[launchpad] stop adopted owner changed ${app.id} expected=${expectedPid} actual=${outcome.owner.pid}\n`);
      throw portOwnerChangedError(app, expectedPid, outcome.owner.pid);
    }
    if (outcome.owner?.pid === expectedPid) {
      throw new RuntimeActionError(
        500,
        "app_stop_failed",
        `${app.title} se nepodařilo zastavit; PID ${expectedPid} stále poslouchá na portu ${app.port}.`,
        [`app_id: ${app.id}`, `pid: ${expectedPid}`, `port: ${app.port}`],
        { failure_kind: "stop_failed", owner: "adopted-port", pid: expectedPid, port: app.port },
      );
    }

    const stoppedAt = new Date().toISOString();
    await appendLog(logPath, `[launchpad] ${stoppedAt} stopped adopted ${app.id} pid=${expectedPid} forced=${forced}\n`);
    await writeState(runtimeKey, {
      status: "stopped",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      port: app.port,
      pid: expectedPid,
      owner: "adopted-port",
      stop_instance_id: instanceId,
      stopped_at: stoppedAt,
      updated_at: stoppedAt,
      forced,
      log_path: relativeRuntimePath(logPath),
    });

    return {
      action: "stop",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      owner: "adopted-port",
      pid: expectedPid,
      forced,
      runtime: await healthForApp(app),
    };
  }

  function signalAdoptedProcess(app, pid, signal) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw new RuntimeActionError(
        error?.code === "EPERM" ? 403 : 500,
        error?.code === "EPERM" ? "app_stop_forbidden" : "app_stop_failed",
        `${app.title}: procesu PID ${pid} nelze poslat ${signal}: ${error.message}`,
        [`app_id: ${app.id}`, `pid: ${pid}`, `port: ${app.port}`, `signal: ${signal}`],
        { failure_kind: "stop_signal_failed", owner: "adopted-port", pid, port: app.port, signal },
      );
    }
  }

  function assertExpectedPortOwner(app, expectedPid, owner) {
    if (!owner) return;
    if (owner.pid !== expectedPid) throw portOwnerChangedError(app, expectedPid, owner.pid);
    if (owner.cwd_matches !== true) {
      const cwdUnknown = owner.cwd_matches === null || owner.cwd_matches === undefined;
      throw new RuntimeActionError(
        409,
        cwdUnknown ? "app_port_owner_cwd_unknown" : "app_port_owner_cwd_mismatch",
        cwdUnknown
          ? `${app.title}: Launchpad nedokázal ověřit checkout procesu na portu ${app.port}; proces neukončil.`
          : `${app.title}: proces na portu ${app.port} běží z jiného checkoutu; Launchpad ho neukončil.`,
        [`app_id: ${app.id}`, `pid: ${expectedPid}`, `port: ${app.port}`],
        {
          failure_kind: cwdUnknown ? "port_owner_cwd_unknown" : "port_owner_cwd_mismatch",
          owner: cwdUnknown ? "unknown-port" : "foreign-port",
          pid: expectedPid,
          port: app.port,
        },
      );
    }
  }

  function portOwnerChangedError(app, expectedPid, actualPid) {
    return new RuntimeActionError(
      409,
      "app_port_owner_changed",
      `${app.title}: vlastník portu ${app.port} se během zastavování změnil; nový proces nebyl ukončen.`,
      [`app_id: ${app.id}`, `expected_pid: ${expectedPid}`, `actual_pid: ${actualPid}`, `port: ${app.port}`],
      { failure_kind: "port_owner_changed", owner: "adopted-port", expected_pid: expectedPid, actual_pid: actualPid, port: app.port },
    );
  }

  async function restart(appId, { source = null } = {}) {
    const app = await runtimeAppForAction(appId, { source });
    const runtimeSource = runtimeSourceForApp(app);
    await stop(app.id, { source: runtimeSource });
    return {
      action: "restart",
      app_id: app.id,
      runtime_key: runtimeKeyForApp(app),
      runtime_source: runtimeSource,
      start: await startRuntimeApp(app),
    };
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
    const discovery = await discover(companiesRoot);
    if (requireValidDiscovery && discovery.failures.length > 0) {
      throw new RuntimeActionError(
        409,
        "invalid_discovery",
        "Runtime akce vyžaduje validní Launchpad discovery.",
        discovery.failures,
      );
    }
    const app = discovery.apps.find((item) => item.id === appId);
    if (!app) {
      // Decision 0043: appka s nevalidním manifestem je viditelná, ale runtime
      // akce jsou pro ni zamčené, dokud se manifest neopraví.
      const invalidApp = (discovery.invalid_apps ?? []).find((item) => item.id === appId);
      if (invalidApp) {
        throw new RuntimeActionError(
          409,
          "invalid_manifest",
          `Aplikace ${appId} má nevalidní companyascode.app manifest; oprav manifest a spusť Synchronizovat.`,
          invalidApp.manifest_issues ?? [],
          { failure_kind: "invalid_manifest", package_path: invalidApp.package_path },
        );
      }
      throw new RuntimeActionError(404, "app_not_found", `Aplikace ${appId} není v discovery výstupu.`);
    }
    return app;
  }

  async function runtimeAppForAction(appId, { source = null, requireValidDiscovery = true } = {}) {
    const app = await findApp(appId, { requireValidDiscovery });
    const runtimeSource = normalizeRuntimeSource(source);
    if (runtimeSource.type === "main") {
      return {
        ...app,
        runtime_key: app.id,
        runtime_source: { type: "main" },
      };
    }
    return worktreeRuntimeApp(app, runtimeSource);
  }

  function normalizeRuntimeSource(source) {
    if (!source || source.type === undefined || source.type === "main") return { type: "main" };
    if (source.type !== "worktree") {
      throw new RuntimeActionError(400, "invalid_runtime_source", `Neznámý runtime source: ${source.type}`);
    }
    if (typeof source.slug !== "string" || source.slug.trim() === "") {
      throw new RuntimeActionError(400, "invalid_runtime_source", "Worktree runtime source vyžaduje slug.");
    }
    return { type: "worktree", slug: source.slug.trim() };
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
      ...overrides,
    };
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
    const existingPort = managedProcesses.get(runtimeKey)?.port ?? (await readState(runtimeKey))?.port;
    const port = Number.isInteger(existingPort) && existingPort !== app.port
      ? existingPort
      : await allocateDevPort({ avoid: [app.port] });
    const modulePath = normalizeRelativePath(worktree.metadata?.module_path ?? `modules/${app.module}`);
    const mainModulePath = normalizeRelativePath(`${app.organization_path}/${modulePath}`);
    const worktreePath = normalizeRelativePath(worktree.path);
    const cwd = replacePathPrefix(app.cwd, mainModulePath, worktreePath);
    const packagePath = replacePathPrefix(app.package_path, mainModulePath, worktreePath);

    return {
      ...app,
      port,
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

  function runtimeKeyForApp(app) {
    return app.runtime_key ?? app.id;
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

  async function allocateDevPort({ avoid = [] } = {}) {
    const blocked = new Set(avoid.filter(Number.isInteger));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await allocateEphemeralPort();
      if (!blocked.has(port)) return port;
    }
    throw new RuntimeActionError(500, "dev_port_allocation_failed", "Launchpad nenašel volný DEV port pro worktree runtime.");
  }

  async function healthForApp(app) {
    const runtimeKey = runtimeKeyForApp(app);
    const runtimeSource = runtimeSourceForApp(app);
    const state = await readState(runtimeKey);
    const record = managedProcesses.get(runtimeKey);
    const dependencies = await dependencyForApp(app);
    const probe = await probeHealth(app);
    const expectedCwd = join(companiesRoot, app.cwd ?? dirname(app.package_path ?? "package.json"));
    const portOwner = record ? null : await resolvePortOwnerFn(app.port, { expectedCwd });
    // Adoption is destructive authority: only a positively verified canonical
    // cwd match may become managed. Unknown lookup (including Windows) stays
    // fail-closed and cannot expose Stop/Restart.
    const adoptablePortOwner = portOwner?.cwd_matches === true ? portOwner : null;
    const now = Date.now();
    const startedAt = record?.startedAt ? Date.parse(record.startedAt) : null;
    const logPath = logPathForApp(app.id);
    const base = {
      schema_version: "companiesascode.launchpad.runtime.v1",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      host: app.host,
      port: app.port,
      url: appUrl(app),
      pid: record?.pid ?? portOwner?.pid ?? state?.pid ?? null,
      managed: Boolean(record || adoptablePortOwner),
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

    return {
      ...base,
      status: "stopped",
      message: state?.last_error
        ?? (state?.status === "unhealthy" && state.exit_code !== undefined
          ? `Poslední managed proces skončil s kódem ${state.exit_code}. Otevři Logs pro detail.`
          : "Aplikace neběží."),
    };
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
    await mkdir(logsRoot, { recursive: true });
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
  };
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
  const executable = env.SystemRoot
    ? win32.join(env.SystemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
  return [executable, "/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
}

export function windowsPowerShellExecutable(env = process.env) {
  return env.SystemRoot
    ? win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

export function windowsNetstatCommand(env = process.env) {
  const executable = env.SystemRoot
    ? win32.join(env.SystemRoot, "System32", "netstat.exe")
    : "netstat.exe";
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

async function resolvePortOwner(port, { expectedCwd = null } = {}) {
  const pid = process.platform === "win32" ? await resolvePortOwnerWindows(port) : await resolvePortOwnerUnix(port);
  if (!pid || pid === process.pid) return null;
  if (!expectedCwd) return { pid };

  const processCwd = await resolveProcessCwd(pid);
  if (!processCwd) return { pid, cwd_matches: null };
  const [actual, expected] = await Promise.all([canonicalPath(processCwd), canonicalPath(expectedCwd)]);
  return { pid, cwd_matches: actual === expected };
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

async function waitForPortOwnerChange(port, expectedPid, timeoutMs, resolveOwner = resolvePortOwner) {
  const deadline = Date.now() + timeoutMs;
  let owner = await resolveOwner(port);
  while (owner?.pid === expectedPid && Date.now() < deadline) {
    await sleep(stopPollMs);
    owner = await resolveOwner(port);
  }
  return { owner };
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

async function runCommand(command) {
  try {
    const process = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { ok: exitCode === 0, exitCode, stdout, stderr };
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetch(healthUrl(app), {
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

function healthUrl(app) {
  return `http://${app.host}:${app.port}${app.health_path}`;
}

function appUrl(app) {
  return `http://${app.host}:${app.port}`;
}

async function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (Number.isInteger(port)) resolve(port);
        else reject(new Error("ephemeral port allocation failed"));
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
