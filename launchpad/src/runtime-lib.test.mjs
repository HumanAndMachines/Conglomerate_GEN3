import { afterAll, expect, test } from "bun:test";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "fs/promises";
import {
  RuntimeActionError,
  bunExecutableCandidates,
  createRuntimeManager,
  resolveBunExecutable,
  windowsPowerShellExecutable,
  windowsTaskkillCommand,
} from "./runtime-lib.mjs";

const tempRoots = [];
// Windows záměrně neumí z vestavěného resolveru ověřit CWD cizího procesu,
// takže adopted/foreign klasifikaci fail-closed drží jako unknown-port. Testy
// pozitivní CWD adopce patří na OS, kde je skutečný process CWD čitelný.
const testWithInspectableProcessCwd = process.platform === "win32" ? test.skip : test;

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("runtime manager spustí, změří a zastaví managed aplikaci", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const initialHealth = await runtime.health("test-company-demo-v1");
  expect(initialHealth.status).toBe("stopped");
  expect(initialHealth.dependencies.state).toBe("ready");
  expect(initialHealth.dependencies.install_command_display).toBe("bun install");
  await runtime.start("test-company-demo-v1");
  const healthy = await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  expect(healthy.managed).toBe(true);
  expect(healthy.pid).toBeNumber();
  const runtimeEnv = await (await fetch(`http://127.0.0.1:${port}/runtime-env`)).json();
  expect(runtimeEnv.organizationRoot).toBe(join(root, "organizations", "TestCompany"));

  const stopped = await runtime.stop("test-company-demo-v1");
  expect(stopped.action).toBe("stop");
  const logs = await runtime.logs("test-company-demo-v1");
  expect(logs.log_path).toBe("logs/apps/test-company-demo-v1.log");
  expect(logs.content).toContain("stop test-company-demo-v1");
  expect((await runtime.health("test-company-demo-v1")).status).toBe("stopped");
});

test("Windows runtime dohledá Bun i bez shell PATH", () => {
  const env = {
    USERPROFILE: "C:\\Users\\builder",
    LOCALAPPDATA: "C:\\Users\\builder\\AppData\\Local",
  };
  const candidates = bunExecutableCandidates({ platform: "win32", env });

  expect(candidates).toEqual([
    "C:\\Users\\builder\\.bun\\bin\\bun.exe",
    "C:\\Users\\builder\\AppData\\Local\\bun\\bin\\bun.exe",
  ]);
  expect(resolveBunExecutable({
    platform: "win32",
    env,
    execPath: "C:\\Program Files\\Launchpad\\Launchpad.exe",
    which: () => null,
    pathExists: (candidate) => candidate === candidates[0],
    probe: (candidate) => candidate === candidates[0],
  })).toBe(candidates[0]);
});

test("Windows runtime přeskočí nefunkční Bun alias a validuje user-local instalaci", () => {
  const broken = "C:\\Users\\builder\\AppData\\Local\\Microsoft\\WindowsApps\\bun.exe";
  const working = "C:\\Users\\builder\\.bun\\bin\\bun.exe";
  const probes = [];

  const resolved = resolveBunExecutable({
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\builder" },
    execPath: "C:\\Program Files\\Launchpad\\Launchpad.exe",
    which: () => broken,
    pathExists: (candidate) => candidate === working,
    probe: (candidate) => {
      probes.push(candidate);
      return candidate === working;
    },
  });

  expect(resolved).toBe(working);
  expect(probes).toEqual([broken, working]);
});

test("Windows managed Stop používá taskkill jen nad známým PID a celým stromem", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const commands = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => null,
    runSystemCommandFn: async (command) => {
      commands.push(command);
      return executeWindowsStopCommand(command);
    },
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  const stopped = await runtime.stop("test-company-demo-v1");

  expect(stopped.runtime.status).toBe("stopped");
  expect(stopped.forced).toBe(true);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("/T");
  expect(commands[0]).toContain("/F");
  expect(commands[0][commands[0].indexOf("/PID") + 1]).toBe(String(stopped.pid));
  expect(windowsTaskkillCommand(123, {
    force: true,
    env: { SystemRoot: "C:\\Windows" },
  })).toEqual(["C:\\Windows\\System32\\taskkill.exe", "/PID", "123", "/T", "/F"]);
  expect(windowsPowerShellExecutable({ SystemRoot: "C:\\Windows" }))
    .toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("Windows Stop nikdy nepoužije taskkill jen podle neověřeného portu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const commands = [];
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    resolvePortOwnerFn: async () => ({ pid: 42_424, cwd_matches: null }),
    runSystemCommandFn: async (command) => {
      commands.push(command);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_not_managed",
    metadata: { owner: "unknown-port" },
  });
  expect(commands).toEqual([]);
});

test("Windows managed Stop po taskkill fail-closed ověří, že app-owned port nezůstal obsazený", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  let signalSent = false;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "windows-test-instance",
    platform: "win32",
    bunExecutable: process.execPath,
    resolvePortOwnerFn: async () => signalSent
      ? { pid: 54_321, cwd_matches: null }
      : null,
    runSystemCommandFn: async (command) => {
      signalSent = true;
      return executeWindowsStopCommand(command);
    },
  });

  await runtime.start("test-company-demo-v1");
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");
  await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
    status: 500,
    code: "app_stop_failed",
    metadata: {
      failure_kind: "stop_failed",
      port_owner_pid: 54_321,
      port,
    },
  });
});

test("runtime manager nepředá stale Organization root lokálnímu surface ani Personalspace lane", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const previousOrganizationRoot = process.env.COMPANYASCODE_ORGANIZATION_ROOT;
  process.env.COMPANYASCODE_ORGANIZATION_ROOT = join(root, "organizations", "ForeignCompany");
  const app = fixtureDiscoveryApp({
    port,
    overrides: {
      organization_path: "guide",
      organization_kind: null,
      discovery_source: "local_surface",
    },
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    discover: discoveryWithApp(app),
  });

  let started = false;
  try {
    await runtime.start(app.id);
    started = true;
    await waitForStatus(() => runtime.health(app.id), "healthy");
    const runtimeEnv = await (await fetch(`http://127.0.0.1:${port}/runtime-env`)).json();
    expect(runtimeEnv.organizationRoot).toBeNull();
  } finally {
    if (started) await runtime.stop(app.id);
    if (previousOrganizationRoot === undefined) delete process.env.COMPANYASCODE_ORGANIZATION_ROOT;
    else process.env.COMPANYASCODE_ORGANIZATION_ROOT = previousOrganizationRoot;
  }
});

test("runtime manager odmítne Windows drive path mimo Organization boundary", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const app = fixtureDiscoveryApp({
    port,
    overrides: {
      organization_path: "D:\\outside\\Macano-Tech_GEN3",
      organization_kind: "organization",
    },
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    discover: discoveryWithApp(app),
  });

  await expect(runtime.start(app.id)).rejects.toMatchObject({
    status: 409,
    code: "invalid_organization_path",
  });
});

testWithInspectableProcessCwd("runtime manager adoptuje app-owned port a Stop ukončí proces z jiné Launchpad instance", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const previousLaunchpadProcess = Bun.spawn(["bun", "server.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    const adopted = await runtime.health("test-company-demo-v1");
    expect(adopted.owner).toBe("adopted-port");
    expect(adopted.pid).toBe(previousLaunchpadProcess.pid);
    await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
    });
    const stopped = await runtime.stop("test-company-demo-v1");
    expect(stopped).toMatchObject({
      action: "stop",
      owner: "adopted-port",
      pid: previousLaunchpadProcess.pid,
      forced: false,
    });
    expect(stopped.runtime.status).toBe("stopped");
    expect((await runtime.health("test-company-demo-v1")).status).toBe("stopped");
    const logs = await runtime.logs("test-company-demo-v1");
    expect(logs.content).toContain(`stop adopted test-company-demo-v1 pid=${previousLaunchpadProcess.pid}`);
  } finally {
    try {
      previousLaunchpadProcess.kill("SIGKILL");
    } catch {
      // Cleanup only; proces už běžně ukončil runtime.stop.
    }
  }
});

testWithInspectableProcessCwd("runtime manager neadoptuje zdravý app-owned port z jiného checkoutu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const foreignCwd = await mkdtemp(join(tmpdir(), "launchpad-foreign-checkout-"));
  tempRoots.push(foreignCwd);
  const foreignProcess = Bun.spawn(["bun", join(appRoot, "server.mjs")], {
    cwd: foreignCwd,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    const health = await runtime.health("test-company-demo-v1");
    expect(health).toMatchObject({
      status: "unhealthy",
      owner: "foreign-port",
      managed: false,
      failure_kind: "port_owner_cwd_mismatch",
      port_owner: { pid: foreignProcess.pid, cwd_matches: false },
    });
    expect(health.message).toContain("jiného checkoutu");
    await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_port_conflict",
      metadata: { failure_kind: "port_owner_cwd_mismatch" },
    });
    await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_not_managed",
      metadata: { owner: "foreign-port" },
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally {
    try {
      foreignProcess.kill("SIGKILL");
    } catch {
      // Cleanup only; foreign proces nesmí ukončit runtime manager.
    }
  }
});

test("runtime manager fail-closed neadoptuje zdravý port při neznámém CWD (Windows/restricted lookup)", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const foreignProcess = Bun.spawn(["bun", "server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
    resolvePortOwnerFn: async () => ({ pid: foreignProcess.pid, cwd_matches: null }),
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    const health = await runtime.health("test-company-demo-v1");
    expect(health).toMatchObject({
      status: "unhealthy",
      owner: "unknown-port",
      managed: false,
      failure_kind: "port_owner_cwd_unknown",
      port_owner: { pid: foreignProcess.pid, cwd_matches: null },
    });
    await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_port_conflict",
      metadata: { failure_kind: "port_owner_cwd_unknown" },
    });
    await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_not_managed",
      metadata: { owner: "unknown-port" },
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally {
    try {
      foreignProcess.kill("SIGKILL");
    } catch {}
  }
});

test("adopted Stop odmítne signál, když opakované CWD ověření přejde na unknown", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const adoptedProcess = Bun.spawn(["bun", "server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  let ownerProbeCount = 0;
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
    resolvePortOwnerFn: async () => ({
      pid: adoptedProcess.pid,
      cwd_matches: ++ownerProbeCount <= 2 ? true : null,
    }),
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    expect(await runtime.health("test-company-demo-v1")).toMatchObject({ owner: "adopted-port", managed: true });
    await expect(runtime.stop("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_port_owner_cwd_unknown",
      metadata: { failure_kind: "port_owner_cwd_unknown", owner: "unknown-port" },
    });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
  } finally {
    try {
      adoptedProcess.kill("SIGKILL");
    } catch {}
  }
});

testWithInspectableProcessCwd("runtime manager po timeoutu ukončí stále stejného adopted vlastníka přes SIGKILL", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "process.on('SIGTERM', () => {});",
      "const server = Bun.serve({",
      "  hostname: process.env.HOST,",
      "  port: Number(process.env.PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    return new Response('ok');",
      "  },",
      "});",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  const stubbornProcess = Bun.spawn(["bun", "server.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "new-launchpad-instance",
  });

  try {
    await waitForFetch(`http://127.0.0.1:${port}/health`);
    const adopted = await runtime.health("test-company-demo-v1");
    expect(adopted).toMatchObject({ owner: "adopted-port", pid: stubbornProcess.pid });

    const stopped = await runtime.stop("test-company-demo-v1");
    expect(stopped).toMatchObject({ owner: "adopted-port", pid: stubbornProcess.pid, forced: true });
    expect(stopped.runtime.status).toBe("stopped");
  } finally {
    try {
      stubbornProcess.kill("SIGKILL");
    } catch {
      // Cleanup only; proces už běžně ukončil runtime.stop.
    }
  }
}, 12_000);

test("runtime manager umí nainstalovat balíčky aplikace a zapsat install log", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const result = await runtime.install("test-company-demo-v1");
  expect(result.action).toBe("install");
  expect(result.exit_code).toBe(0);
  expect(result.command_display).toBe("bun install");
  expect(result.cwd.endsWith(join("organizations", "TestCompany", "modules", "demo", "app", "v1"))).toBe(true);
  expect(result.log_path).toBe("logs/apps/test-company-demo-v1.log");
  const repair = await runtime.install("test-company-demo-v1", { action: "repair" });
  expect(repair.action).toBe("repair");
  const logs = await runtime.logs("test-company-demo-v1");
  expect(logs.content).toContain("install test-company-demo-v1 command=bun install");
  expect(logs.content).toContain("repair test-company-demo-v1 command=bun install");
  expect(logs.content).toContain("code=0");
});

test("runtime manager předá absolutní Organization root i install lifecycle procesu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    installScripts: { preinstall: "bun capture-install-env.mjs" },
  });
  const appRoot = join(root, "organizations", "TestCompany", "modules", "demo", "app", "v1");
  await writeFile(
    join(appRoot, "capture-install-env.mjs"),
    [
      "await Bun.write(",
      "  'install-env.json',",
      "  JSON.stringify({ organizationRoot: process.env.COMPANYASCODE_ORGANIZATION_ROOT ?? null }),",
      ");",
      "",
    ].join("\n"),
    "utf8",
  );
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  await runtime.install("test-company-demo-v1");
  const captured = JSON.parse(await readFile(join(appRoot, "install-env.json"), "utf8"));
  expect(captured.organizationRoot).toBe(join(root, "organizations", "TestCompany"));
});

test("runtime manager classifyuje selhaný Install/Repair s failure_kind", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    installScripts: {
      preinstall: "node -e \"console.error('fixture install script failed: lifecycle script'); process.exit(13)\"",
    },
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  let failure;
  try {
    await runtime.install("test-company-demo-v1", { action: "repair" });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    status: 500,
    code: "app_install_failed",
  });
  expect(failure.metadata.action).toBe("repair");
  expect(["install_failed", "install_script_failed"]).toContain(failure.metadata.failure_kind);
  const health = await runtime.health("test-company-demo-v1");
  expect(["install_failed", "install_script_failed"]).toContain(health.failure_kind);
  expect(health.last_install.action).toBe("repair");
});

test("runtime manager rozlišuje missing dependency state a blokuje Start před Install", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { "@fixture/needs-install": "1.0.0" },
    writeLockfile: true,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies.state).toBe("needs_install");
  expect(health.dependencies.can_install).toBe(true);
  expect(health.dependencies.can_start).toBe(false);
  let startError;
  try {
    await runtime.start("test-company-demo-v1");
  } catch (error) {
    startError = error;
  }
  expect(startError).toMatchObject({
    status: 409,
    code: "app_not_ready",
  });
  expect(startError.metadata.failure_kind).toBe("missing_dependencies");
});

test("runtime manager dependency model hlásí stale lockfile", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { "@fixture/stale": "1.0.0" },
    writeLockfile: true,
    withNodeModules: true,
    staleLockfile: true,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies.state).toBe("stale_lockfile");
  expect(health.dependencies.lockfile.path).toBe("bun.lock");
  expect(health.dependencies.can_start).toBe(true);
});

test("runtime manager Repair pro stale lockfile obnoví dependency state na ready i po no-op installu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    writeLockfile: true,
    withNodeModules: true,
    staleLockfile: true,
  });
  const runtimeWithNoopInstall = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
    spawnProcess: (command, options) => Bun.spawn(
      command.slice(1).includes("install")
        ? [process.execPath, "-e", "console.log('fake bun install no changes')"]
        : command,
      options,
    ),
  });

  expect((await runtimeWithNoopInstall.health("test-company-demo-v1")).dependencies.state).toBe("stale_lockfile");

  const result = await runtimeWithNoopInstall.install("test-company-demo-v1", { action: "repair" });

  expect(result.action).toBe("repair");
  expect(result.exit_code).toBe(0);
  expect(result.log_excerpt).toContain("repair test-company-demo-v1 code=0");
  expect(result.runtime.dependencies.state).toBe("ready");
  expect((await runtimeWithNoopInstall.health("test-company-demo-v1")).dependencies.state).toBe("ready");
});

test("runtime manager dependency model hlásí missing package a unknown package manager", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    packageManager: "pnpm@9.0.0",
    dependencies: { "@fixture/pnpm": "1.0.0" },
    withNodeModules: true,
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies.state).toBe("unknown_package_manager");
  expect(health.dependencies.package_manager).toBe("pnpm");
  expect(health.dependencies.can_install).toBe(false);
  await expect(runtime.install("test-company-demo-v1")).rejects.toMatchObject({
    status: 409,
    code: "app_install_unavailable",
  });

  const [missing] = await runtime.appsWithRuntime([
    {
      id: "missing-package-demo",
      title: "Missing package demo",
      company: "test-company",
      module: "demo",
      surface: "internal",
      port: await findFreePort(),
      host: "127.0.0.1",
      health_path: "/health",
      dev_script: "dev",
      package_path: "organizations/TestCompany/modules/missing/app/v1/package.json",
      cwd: "organizations/TestCompany/modules/missing/app/v1",
      tags: ["test"],
    },
  ]);
  expect(missing.dependencies.state).toBe("missing_package");
  expect(missing.dependencies.can_install).toBe(false);
});

test("runtime manager open blokuje 409 app_port_conflict na obsazeném nezdravém portu (decision 0049)", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  // Cizí PROCES (ne tenhle test proces — jinak resolvePortOwner vrátí null kvůli
  // pid === process.pid) obsadí app port raw TCP listenerem, který nemluví HTTP →
  // health probe je unreachable, runtime je unhealthy s port_owner. open() nesmí
  // tiše fallbacknout: musí propadnout do start() → startConflictForRuntime →
  // blokující 409 app_port_conflict.
  const squatter = Bun.spawn(
    [
      "bun",
      "-e",
      "const net=require('net');net.createServer((s)=>{}).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('squatting'));setInterval(()=>{},2147483647);",
    ],
    {
      env: { ...process.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  try {
    // Počkej, až listener obsadí port (raw TCP → connect uspěje).
    await waitForTcpListen(port);

    const health = await runtime.health("test-company-demo-v1");
    expect(health.status).toBe("unhealthy");
    expect(["adopted-port", "foreign-port", "unknown-port"]).toContain(health.owner);

    await expect(runtime.open("test-company-demo-v1")).rejects.toMatchObject({
      status: 409,
      code: "app_port_conflict",
    });

    // Squatter běží dál — open ho nesmí zabít ani přepsat.
    expect(squatter.killed).toBe(false);
  } finally {
    try {
      squatter.kill("SIGKILL");
    } catch {
      // Cleanup only.
    }
  }
}, 10_000);

test("runtime manager vrátí konkrétní log excerpt, když appka spadne hned po startu", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "console.error('fixture missing dependency: Cannot find package @missing/demo');",
      "process.exit(42);",
      "",
    ].join("\n"),
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  let failure;
  try {
    await runtime.start("test-company-demo-v1");
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    status: 500,
    code: "app_start_failed",
  });
  expect(["unknown_early_exit", "missing_dependencies"]).toContain(failure.metadata.failure_kind);
  await expect(runtime.start("test-company-demo-v1")).rejects.toMatchObject({
    status: 500,
    code: "app_start_failed",
  });
  const health = await runtime.health("test-company-demo-v1");
  expect(["unknown_early_exit", "missing_dependencies"]).toContain(health.failure_kind);
  expect(health.message).toMatch(/Otevři Logs|Použij Install\/Repair/);
  const logs = await runtime.logs("test-company-demo-v1");
  expect(logs.content).toContain("exit test-company-demo-v1");
});

test("runtime manager open chain spustí ready aplikaci a vrátí URL", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const result = await runtime.open("test-company-demo-v1");
  expect(result.action).toBe("open");
  expect(result.url).toBe(`http://127.0.0.1:${port}`);
  expect(result.steps.some((step) => step.step === "start")).toBe(true);
  await waitForStatus(() => runtime.health("test-company-demo-v1"), "healthy");

  // Idempotence: druhé open na běžící appce jen vrátí URL (reuse), nespouští znovu.
  const again = await runtime.open("test-company-demo-v1");
  expect(again.url).toBe(`http://127.0.0.1:${port}`);
  expect(again.steps.some((step) => step.step === "reuse")).toBe(true);

  await runtime.stop("test-company-demo-v1");
});

test("runtime manager open chain odmítne proces, který spadne hned po prvním healthy response", async () => {
  const port = await findFreePort();
  const blockedPort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    serverSource: [
      "const server = Bun.serve({",
      "  hostname: process.env.HOST,",
      "  port: Number(process.env.PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    return new Response('ok');",
      "  },",
      "});",
      "console.log(`fixture listening ${server.port}`);",
      "setTimeout(() => {",
      `  console.error('fixture sidecar failed: Failed to start server. Is port ${blockedPort} in use? EADDRINUSE');`,
      "  server.stop(true);",
      "  process.exit(1);",
      "}, 1200);",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  let failure;
  try {
    await runtime.open("test-company-demo-v1");
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    status: 500,
    code: "app_start_failed",
  });
  expect(failure.metadata.failure_kind).toBe("port_conflict");
  expect(failure.message).toContain("EADDRINUSE");
  expect(failure.message).toContain(String(blockedPort));
});

test("runtime manager spustí worktree DEV instanci vedle main runtime bez port kolize", async () => {
  const mainPort = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port: mainPort });
  const orgRoot = join(root, "organizations", "TestCompany");
  const mainModuleRoot = join(orgRoot, "modules", "demo");
  const worktreeSlug = "CAC-0042-demo-runtime-selector";
  const worktreeRoot = join(orgRoot, ".worktrees", "workspace", "demo", worktreeSlug);
  await mkdir(join(orgRoot, ".worktrees", "workspace", "demo"), { recursive: true });
  await mkdir(join(orgRoot, "mission-control", "plans", "2026", "07"), { recursive: true });
  await cp(mainModuleRoot, worktreeRoot, { recursive: true });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-demo-runtime-selector.yaml"),
    "dev_code: CAC-0042\ntitle: Demo runtime selector\nstatus: in_progress\n",
  );
  await writeJson(join(orgRoot, ".worktrees", "workspace", "demo", `${worktreeSlug}.worktree.json`), {
    schema_version: "companiesascode.worktree.v1",
    organization: "TestCompany",
    organization_path: "organizations/TestCompany",
    workspace: "workspace",
    module: "demo",
    module_path: "modules/demo",
    repo_kind: "module",
    base_branch: "main",
    branch: "CAC-0042-demo-runtime-selector",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-demo-runtime-selector.yaml",
    worktree_path: ".worktrees/workspace/demo/CAC-0042-demo-runtime-selector",
    created_at: "2026-07-04T00:00:00.000Z",
    created_by: "examplebuddy-buddy",
    status: "active",
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const main = await runtime.open("test-company-demo-v1");
  const worktree = await runtime.open("test-company-demo-v1", {
    source: { type: "worktree", slug: worktreeSlug },
  });

  expect(main.url).toBe(`http://127.0.0.1:${mainPort}`);
  expect(worktree.url).toStartWith("http://127.0.0.1:");
  expect(worktree.url).not.toBe(main.url);
  expect(worktree.runtime_source).toMatchObject({
    type: "worktree",
    slug: worktreeSlug,
    plan_code: "CAC-0042",
    branch: "CAC-0042-demo-runtime-selector",
  });
  expect(worktree.runtime.runtime_source.type).toBe("worktree");
  expect(worktree.runtime.runtime_key).toBe(`test-company-demo-v1--worktree--${worktreeSlug}`);
  expect(worktree.runtime.port).not.toBe(mainPort);
  expect(worktree.runtime.dependencies.cwd).toContain(`.worktrees/workspace/demo/${worktreeSlug}/app/v1`);
  const worktreeEnv = await (await fetch(`${worktree.url}/runtime-env`)).json();
  expect(worktreeEnv.organizationRoot).toBe(orgRoot);

  await runtime.stop("test-company-demo-v1", { source: { type: "worktree", slug: worktreeSlug } });
  await runtime.stop("test-company-demo-v1");
}, 15_000);

test("runtime manager open chain nejdřív nainstaluje chybějící balíčky", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({
    port,
    dependencies: { "left-pad": "^1.0.0" },
  });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  const health = await runtime.health("test-company-demo-v1");
  expect(health.dependencies.state).toBe("needs_install");

  const result = await runtime.open("test-company-demo-v1");
  expect(result.steps[0].step).toBe("install");
  expect(result.steps[0].exit_code).toBe(0);
  expect(result.steps.some((step) => step.step === "start")).toBe(true);
  expect(result.url).toBe(`http://127.0.0.1:${port}`);

  await runtime.stop("test-company-demo-v1");
}, 15_000);

test("runtime manager vrací 404 pro aplikaci mimo discovery", async () => {
  const port = await findFreePort();
  const root = await createCompaniesWorkspaceFixture({ port });
  const runtime = createRuntimeManager({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    instanceId: "test-instance",
  });

  await expect(runtime.health("unknown-app")).rejects.toBeInstanceOf(RuntimeActionError);
  await expect(runtime.health("unknown-app")).rejects.toMatchObject({
    status: 404,
    code: "app_not_found",
  });
});

async function createCompaniesWorkspaceFixture({
  port,
  serverSource = null,
  packageManager = null,
  dependencies = null,
  devDependencies = null,
  writeLockfile = false,
  withNodeModules = false,
  staleLockfile = false,
  installScripts = {},
}) {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-launchpad-"));
  tempRoots.push(root);
  const companyRoot = join(root, "organizations", "TestCompany");
  const appRoot = join(companyRoot, "modules", "demo", "app", "v1");
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(appRoot, { recursive: true });

  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  // Scan-first: slug žije v namountovaném company.gen3.json, ne v registry.
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "test-company", display_name: "Test Company" },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {});
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const packageJson = {
    name: "test-company-demo-v1",
    private: true,
    type: "module",
    ...(packageManager ? { packageManager } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(devDependencies ? { devDependencies } : {}),
    scripts: {
      ...installScripts,
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-demo-v1",
        title: "Demo v1",
        company: "test-company",
        module: "demo",
        surface: "internal",
        port,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["test"],
      },
    },
  };
  await writeJson(join(appRoot, "package.json"), packageJson);
  if (writeLockfile) {
    await writeFile(join(appRoot, "bun.lock"), "# fixture lockfile\n", "utf8");
  }
  if (withNodeModules) {
    await mkdir(join(appRoot, "node_modules"), { recursive: true });
  }
  if (staleLockfile) {
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date();
    await utimes(join(appRoot, "bun.lock"), oldTime, oldTime);
    await utimes(join(appRoot, "package.json"), newTime, newTime);
  }
  await writeFile(
    join(appRoot, "server.mjs"),
    serverSource ?? [
      "const server = Bun.serve({",
      "  hostname: process.env.HOST,",
      "  port: Number(process.env.PORT),",
      "  fetch(request) {",
      "    const url = new URL(request.url);",
      "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
      "    if (url.pathname === '/runtime-env') return Response.json({ organizationRoot: process.env.COMPANYASCODE_ORGANIZATION_ROOT ?? null });",
      "    return new Response('ok');",
      "  },",
      "});",
      "console.log(`fixture listening ${server.port}`);",
      "setInterval(() => {}, 2147483647);",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

function fixtureDiscoveryApp({ port, overrides = {} }) {
  return {
    id: "test-company-demo-v1",
    title: "Demo v1",
    company: "test-company",
    module: "demo",
    surface: "internal",
    port,
    host: "127.0.0.1",
    health_path: "/health",
    dev_script: "dev",
    plugin: null,
    package_path: "organizations/TestCompany/modules/demo/app/v1/package.json",
    organization_path: "organizations/TestCompany",
    organization_kind: "organization",
    discovery_source: "filesystem",
    company_workspace_path: "organizations/TestCompany",
    cwd: "organizations/TestCompany/modules/demo/app/v1",
    tags: ["test"],
    ...overrides,
  };
}

function discoveryWithApp(app) {
  return async () => ({ apps: [app], invalid_apps: [], failures: [], warnings: [] });
}

async function writeJson(path, data) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function waitForStatus(readStatus, expectedStatus) {
  let lastStatus = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastStatus = await readStatus();
    if (lastStatus.status === expectedStatus) return lastStatus;
    await sleep(100);
  }
  throw new Error(`Čekal jsem status ${expectedStatus}, poslední byl ${lastStatus?.status}`);
}

async function waitForFetch(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error(`Čekal jsem na ${url}`);
}

async function waitForTcpListen(port) {
  const { connect } = await import("net");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const connected = await new Promise((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (connected) return;
    await sleep(100);
  }
  throw new Error(`Port ${port} nezačal poslouchat`);
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeWindowsStopCommand(command) {
  if (process.platform === "win32") {
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  }

  const pid = Number(command[command.indexOf("/PID") + 1]);
  try {
    // POSIX test double ověřuje command contract, ale nemá taskkill /T
    // process-tree semantics. SIGTERM nechá Bun parent korektně zavřít child
    // a pipe; skutečné /T /F chování ověřuje windows-latest.
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return { ok: true, exitCode: 0, stdout: "", stderr: "" };
}
