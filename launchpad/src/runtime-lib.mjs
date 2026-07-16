import { existsSync } from "fs";
import { appendFile, mkdir, readFile, realpath, stat, utimes, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { createServer } from "net";
import { dirname, join, relative, resolve } from "path";
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
}) {
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

    let child;
    try {
      child = Bun.spawn(["bun", "run", app.dev_script], {
        cwd: join(companiesRoot, app.cwd),
        env: {
          ...process.env,
          PORT: String(app.port),
          HOST: app.host,
          COMPANIES_WORKSPACE_ROOT: companiesRoot,
          COMPANYASCODE_APP_ID: app.id,
          COMPANYASCODE_RUNTIME_KEY: runtimeKey,
          COMPANYASCODE_RUNTIME_SOURCE: runtimeSource.type,
          ...(runtimeSource.slug ? { COMPANYASCODE_WORKTREE_SLUG: runtimeSource.slug } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
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
      const currentRecord = managedProcesses.get(runtimeKey);
      if (currentRecord?.pid === child.pid) {
        managedProcesses.delete(runtimeKey);
      }
      if (record.stopping) return;
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

    const child = Bun.spawn(dependencies.install_command, {
      cwd,
      env: {
        ...process.env,
        COMPANIES_WORKSPACE_ROOT: companiesRoot,
        COMPANYASCODE_APP_ID: app.id,
        COMPANYASCODE_RUNTIME_KEY: runtimeKey,
        COMPANYASCODE_RUNTIME_SOURCE: runtimeSource.type,
        ...(runtimeSource.slug ? { COMPANYASCODE_WORKTREE_SLUG: runtimeSource.slug } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
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
  // stavem — port kolize nikdy tiše nefallbackuje (decision 0049).
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
    //    adopted-port healthy), start přeskočíme a jen vrátíme URL. Nezdravý
    //    obsazený port propadne do start(), který vyhodí blokující konflikt.
    let runtime = await healthForApp(app);
    if (runtime.status === "healthy") {
      steps.push({ step: "reuse", status: runtime.status });
    } else if (managedProcesses.has(runtimeKey) && runtime.status === "starting") {
      steps.push({ step: "reuse", status: runtime.status });
      shouldConfirmStability = true;
    } else {
      const startResult = await startRuntimeApp(app);
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

    record.stopping = true;
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

    try {
      record.child.kill("SIGTERM");
    } catch (error) {
      await appendLog(record.logPath, `[launchpad] stop signal failed: ${error.message}\n`);
    }

    const result = await Promise.race([
      record.child.exited.then((exitCode) => ({ exitCode, timeout: false })),
      sleep(stopTimeoutMs).then(() => ({ exitCode: null, timeout: true })),
    ]);

    if (result.timeout) {
      try {
        record.child.kill("SIGKILL");
      } catch (error) {
        await appendLog(record.logPath, `[launchpad] kill signal failed: ${error.message}\n`);
      }
    }
    await appendLog(
      record.logPath,
      `[launchpad] ${new Date().toISOString()} stopped ${app.id} code=${result.exitCode} forced=${result.timeout}\n`,
    );
    await Promise.allSettled(record.outputPipes);

    managedProcesses.delete(runtimeKey);
    await writeState(runtimeKey, {
      status: "stopped",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      port: record.port ?? app.port,
      pid: record.pid,
      instance_id: instanceId,
      started_at: record.startedAt,
      stopped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      exit_code: result.exitCode,
      forced: result.timeout,
      log_path: relativeRuntimePath(record.logPath),
    });

    return {
      action: "stop",
      app_id: app.id,
      runtime_key: runtimeKey,
      runtime_source: runtimeSource,
      pid: record.pid,
      forced: result.timeout,
      runtime: await healthForApp(app),
    };
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
    await writeFile(statePathForApp(appId), `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
    return relative(launchpadRoot, path);
  }

  return {
    instanceId,
    appsWithRuntime,
    health,
    start,
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
  const command = [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    `$ownerPid = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($ownerPid) { Write-Output $ownerPid }`,
  ];
  const result = await runCommand(command);
  return result.ok ? parsePid(result.stdout) : null;
}

async function runCommand(command) {
  try {
    const process = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(process.stdout).text();
    const exitCode = await process.exited;
    return { ok: exitCode === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function parsePid(output) {
  const value = output
    .split(/\s+/)
    .map((item) => Number(item))
    .find((item) => Number.isInteger(item) && item > 0);
  return value ?? null;
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
