import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  BUDDY_SERVICE_BACKUP_SUFFIX,
  BUDDY_SERVICE_UNIT,
  HERMES_CONTEXT_DROPIN,
  HERMES_SERVICE_UNIT,
  assertRootOwnedImmutableTree,
  inspectBridgeEnvironment,
  inspectProfileDirectory,
  isTrustedResidentExecutablePath,
  installBuddyBridgeService,
  renderBuddyBridgeUnit,
  restorePreResidentBuddyService,
  residentGitInvocation,
  runCommand,
  trustedGitExecutable,
  trustedSystemExecutable,
  verifyHermesRuntime,
  waitForBuddyBridgeReadiness,
  waitForHermesGatewayReadiness,
} from "./runtime/buddy-service-lib.mjs";

const scratches = [];
// The service transaction deliberately targets systemd hosts. Windows keeps
// the resident lifecycle fail-closed, and its filesystem does not model POSIX
// execute/0600 bits, so only filesystem-neutral helpers run there.
const linuxHostTest = process.platform === "win32" ? test.skip : test;
const linuxSystemdTest = process.platform === "linux" ? test : test.skip;
afterEach(async () => {
  await Promise.all(scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(prefix = "lazurio-buddy-service-") {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratches.push(path);
  return path;
}

async function fixture({ currentUnit = "# old Buddy unit\n[Service]\nExecStart=/opt/legacy/bridge\n" } = {}) {
  const root = await scratch();
  const installRoot = join(root, "opt", "lazurio");
  const artifactRoot = join(installRoot, "versions", "candidate-a");
  const unitDirectory = join(root, "etc", "systemd", "system");
  const environmentFile = join(root, "run", "buddy", "buddy-bridge.env");
  const queueRoot = join(root, "var", "lib", "buddy-bridge");
  const profileDirectory = join(installRoot, "state", "personalspace", "owner_GEN3", "buddy");
  await Promise.all([
    mkdir(join(artifactRoot, "resident", "services"), { recursive: true }),
    mkdir(join(artifactRoot, "bridge"), { recursive: true }),
    mkdir(unitDirectory, { recursive: true }),
    mkdir(join(environmentFile, ".."), { recursive: true }),
    mkdir(join(queueRoot, "queue", "state"), { recursive: true }),
    mkdir(join(installRoot, "state", "organizations"), { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ]);
  await symlink(join("versions", "candidate-a"), join(installRoot, "active"));
  await symlink(join("..", "..", "state", "personalspace"), join(artifactRoot, "personalspace"));
  await symlink(join("..", "..", "state", "organizations"), join(artifactRoot, "organizations"));
  await writeFile(
    join(artifactRoot, "resident", "services", "buddy-bridge.service.template"),
    [
      "# Managed by Lazurio resident service installer.",
      "[Service]",
      "User=buddy-bridge",
      "WorkingDirectory=@@ACTIVE_ROOT@@",
      "EnvironmentFile=@@ENVIRONMENT_FILE@@",
      "ExecStart=@@BUN_BIN@@ @@ACTIVE_ROOT@@/bridge/run.ts",
      "RestartPreventExitStatus=78",
      "ReadWritePaths=@@QUEUE_ROOT@@",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(artifactRoot, "resident", "services", "hermes-lazurio-root.conf.template"),
    "# Managed by Lazurio resident Hermes context installer.\n[Service]\nEnvironment=TERMINAL_CWD=@@ACTIVE_ROOT@@\n",
  );
  await writeFile(join(artifactRoot, "bridge", "run.ts"), "export {};\n");
  await writeFile(join(profileDirectory, "CONSTITUTION.md"), "# Constitution\n");
  await writeFile(join(profileDirectory, "MANDATES.md"), "# Mandates\n");
  await writeFile(
    environmentFile,
    [
      "ZULIP_SITE=https://realm.test",
      "BUDDY_BOT_EMAIL=buddy@realm.test",
      "BUDDY_BOT_API_KEY=synthetic-bot-key",
      "AGENT_RUNTIME_URL=http://127.0.0.1:8642/v1/chat/completions",
      "AGENT_RUNTIME_KEY=synthetic-runtime-key",
      `BUDDY_PROFILE_DIR=${profileDirectory}`,
      `BUDDY_BRIDGE_QUEUE_DIR=${join(queueRoot, "queue")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await chmod(environmentFile, 0o600);
  await writeFile(
    join(queueRoot, "queue", "state", "poller.json"),
    `${JSON.stringify({ version: 1, registered: true, registrations: 1, at: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  const unitPath = join(unitDirectory, BUDDY_SERVICE_UNIT);
  if (currentUnit !== null) await writeFile(unitPath, currentUnit, { mode: 0o644 });
  return {
    root,
    installRoot,
    artifactRoot,
    unitDirectory,
    environmentFile,
    queueRoot,
    profileDirectory,
    unitPath,
    currentUnit,
  };
}

function options(paths) {
  return {
    installRoot: paths.installRoot,
    unitDirectory: paths.unitDirectory,
    environmentFile: paths.environmentFile,
    queueRoot: paths.queueRoot,
    bunPath: process.execPath,
    expectedTarget: `${process.platform}-${process.arch}`,
    platform: "linux",
    requireRootOwnership: false,
    verifyArtifact: async () => ({ ok: true, failures: [] }),
    verifyHermes: async () => ({ commit: "a".repeat(40), lock_sha256: "b".repeat(64) }),
  };
}

function successfulSystemctl(log) {
  return (args) => {
    log.push(args.join(" "));
    return { status: args[0] === "is-failed" ? 1 : 0, stdout: "", stderr: "" };
  };
}

linuxHostTest("Buddy service cutover preserves the old unit and installs only the active-root unit", async () => {
  const paths = await fixture();
  const commands = [];
  const result = await installBuddyBridgeService({
    ...options(paths),
    commandRunner: successfulSystemctl(commands),
    preTransitionProbe: async () => ({ bridge_queue_registered: true }),
    hermesReadinessProbe: async () => ({ hermes_gateway_healthy: true }),
    readinessProbe: async () => ({ bridge_queue_registered: true }),
  });
  expect(result).toMatchObject({
    action: "installed",
    backup_preserved: true,
    bridge_queue_registered: true,
  });
  const rendered = await readFile(paths.unitPath, "utf8");
  expect(rendered).toContain(`WorkingDirectory=${join(paths.installRoot, "active")}`);
  expect(rendered).toContain(`ExecStart=${process.execPath} ${join(paths.installRoot, "active", "bridge", "run.ts")}`);
  expect(rendered).not.toContain("/opt/legacy");
  const hermesDropin = await readFile(
    join(paths.unitDirectory, `${HERMES_SERVICE_UNIT}.d`, HERMES_CONTEXT_DROPIN),
    "utf8",
  );
  expect(hermesDropin).toContain(`Environment=TERMINAL_CWD=${join(paths.installRoot, "active")}`);
  expect(await readFile(`${paths.unitPath}${BUDDY_SERVICE_BACKUP_SUFFIX}`, "utf8"))
    .toBe(paths.currentUnit);
  expect((await lstat(`${paths.unitPath}${BUDDY_SERVICE_BACKUP_SUFFIX}`)).mode & 0o777).toBe(0o600);
  expect(commands).toEqual([
    "daemon-reload",
    `restart ${HERMES_SERVICE_UNIT}`,
    `enable ${BUDDY_SERVICE_UNIT}`,
    `restart ${BUDDY_SERVICE_UNIT}`,
  ]);
});

linuxHostTest("a failed post-restart hearing gate restores the exact previous unit", async () => {
  const paths = await fixture();
  const commands = [];
  await expect(installBuddyBridgeService({
    ...options(paths),
    commandRunner: successfulSystemctl(commands),
    preTransitionProbe: async () => ({ bridge_queue_registered: true }),
    hermesReadinessProbe: async () => ({ hermes_gateway_healthy: true }),
    rollbackHermesReadinessProbe: async () => ({ hermes_gateway_healthy: true }),
    readinessProbe: async () => {
      throw new Error("synthetic poller timeout");
    },
  })).rejects.toThrow("previous unit restored");
  expect(await readFile(paths.unitPath, "utf8")).toBe(paths.currentUnit);
  expect(commands).toEqual([
    "daemon-reload",
    `restart ${HERMES_SERVICE_UNIT}`,
    `enable ${BUDDY_SERVICE_UNIT}`,
    `restart ${BUDDY_SERVICE_UNIT}`,
    "daemon-reload",
    `restart ${HERMES_SERVICE_UNIT}`,
    `restart ${BUDDY_SERVICE_UNIT}`,
    `is-active --quiet ${BUDDY_SERVICE_UNIT}`,
  ]);
});

linuxHostTest("the preserved unit remains an explicit operator rollback after a successful cutover", async () => {
  const paths = await fixture();
  const commands = [];
  await installBuddyBridgeService({
    ...options(paths),
    commandRunner: successfulSystemctl(commands),
    preTransitionProbe: async () => ({ bridge_queue_registered: true }),
    hermesReadinessProbe: async () => ({ hermes_gateway_healthy: true }),
    readinessProbe: async () => ({ bridge_queue_registered: true }),
  });
  await restorePreResidentBuddyService({
    unitDirectory: paths.unitDirectory,
    environmentFile: paths.environmentFile,
    queueRoot: paths.queueRoot,
    commandRunner: successfulSystemctl(commands),
    hermesReadinessProbe: async () => ({ hermes_gateway_healthy: true }),
    bridgeReadinessProbe: async () => ({ bridge_queue_registered: true }),
    requireRootOwnership: false,
    platform: "linux",
  });
  expect(await readFile(paths.unitPath, "utf8")).toBe(paths.currentUnit);
});

linuxHostTest("EnvironmentFile validation names conflicting keys but never their secret values", async () => {
  const paths = await fixture();
  await writeFile(
    paths.environmentFile,
    [
      "ZULIP_SITE=https://realm.test",
      "BUDDY_BOT_EMAIL=buddy@realm.test",
      "BUDDY_BOT_API_KEY=do-not-print-bot-secret",
      "AGENT_RUNTIME_URL=http://127.0.0.1:8642/v1/chat/completions",
      "AGENT_RUNTIME_KEY=do-not-print-primary-secret",
      "HERMES_API_KEY=do-not-print-conflicting-secret",
      `BUDDY_PROFILE_DIR=${paths.profileDirectory}`,
      `BUDDY_BRIDGE_QUEUE_DIR=${join(paths.queueRoot, "queue")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  let message = "";
  try {
    await inspectBridgeEnvironment(paths.environmentFile, {
      queueRoot: paths.queueRoot,
      requireRootOwnership: false,
    });
  } catch (error) {
    message = error.message;
  }
  expect(message).toContain("AGENT_RUNTIME_KEY");
  expect(message).toContain("HERMES_API_KEY");
  expect(message).not.toContain("do-not-print");
});

test("profile inspection follows a directory symlink and catches secret-shaped entries", async () => {
  const paths = await fixture();
  const outside = await scratch("lazurio-private-profile-target-");
  await writeFile(join(outside, ".env"), "PRIVATE=value\n");
  await symlink(outside, join(paths.profileDirectory, "linked"));
  const result = await inspectProfileDirectory(paths.profileDirectory);
  expect(result.ok).toBe(false);
  expect(result.reason).toContain(".env");
  expect(result.reason).not.toContain("PRIVATE=value");
});

test("service preflight refuses contract files symlinked outside the profile", async () => {
  const paths = await fixture();
  const outside = await scratch("lazurio-private-contract-target-");
  const privateContract = join(outside, "principal-memory.md");
  await writeFile(privateContract, "PRIVATE profile memory\n");
  await rm(join(paths.profileDirectory, "CONSTITUTION.md"));
  await symlink(privateContract, join(paths.profileDirectory, "CONSTITUTION.md"));

  const result = await inspectProfileDirectory(paths.profileDirectory);
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("regular non-symlink file");
  expect(result.reason).not.toContain("PRIVATE profile memory");
});

linuxHostTest("Buddy service preflight refuses Organization data on a Personalspace host", async () => {
  const paths = await fixture();
  await writeFile(join(paths.installRoot, "state", "organizations", "foreign-org"), "must stay absent\n");
  await expect(installBuddyBridgeService({
    ...options(paths),
    commandRunner: successfulSystemctl([]),
    preTransitionProbe: async () => ({ bridge_queue_registered: true }),
    hermesReadinessProbe: async () => ({ hermes_gateway_healthy: true }),
    readinessProbe: async () => ({ bridge_queue_registered: true }),
  })).rejects.toThrow("empty organizations mount");
});

test("unit rendering refuses systemd specifiers and unresolved template markers", () => {
  const template = [
    "# Managed by Lazurio resident service installer.",
    "WorkingDirectory=@@ACTIVE_ROOT@@",
    "EnvironmentFile=@@ENVIRONMENT_FILE@@",
    "ExecStart=@@BUN_BIN@@ @@ACTIVE_ROOT@@/bridge/run.ts",
    "User=buddy-bridge",
    "RestartPreventExitStatus=78",
    "ReadWritePaths=@@QUEUE_ROOT@@",
  ].join("\n");
  expect(() => renderBuddyBridgeUnit(template, {
    activeRoot: "/opt/lazurio/%n",
    bunPath: "/usr/local/bin/bun",
    environmentFile: "/run/buddy/buddy-bridge.env",
    queueRoot: "/var/lib/buddy-bridge",
  })).toThrow("specifier");
  expect(() => renderBuddyBridgeUnit(`${template}\nUnknown=@@UNKNOWN@@\n`, {
    activeRoot: "/opt/lazurio/active",
    bunPath: "/usr/local/bin/bun",
    environmentFile: "/run/buddy/buddy-bridge.env",
    queueRoot: "/var/lib/buddy-bridge",
  })).toThrow("unresolved marker");
});

test("readiness requires a fresh registered poller state, not only active systemd", async () => {
  const paths = await fixture();
  const staleAt = Date.now() - 60_000;
  await writeFile(
    join(paths.queueRoot, "queue", "state", "poller.json"),
    `${JSON.stringify({ version: 1, registered: true, registrations: 1, at: new Date(staleAt).toISOString() })}\n`,
  );
  const commandRunner = successfulSystemctl([]);
  await expect(waitForBuddyBridgeReadiness({
    queueRoot: paths.queueRoot,
    notBefore: Date.now(),
    commandRunner,
    timeoutMs: 0,
  })).rejects.toThrow("fresh registered poller state");
});

test("live Hermes compatibility requires the exact commit, clean tree and lock digest", async () => {
  const root = await scratch("lazurio-hermes-pin-");
  const activeRoot = join(root, "active");
  const hermesRoot = join(root, "hermes");
  await mkdir(join(activeRoot, "resident", "dependencies"), { recursive: true });
  await mkdir(hermesRoot, { recursive: true });
  const lock = Buffer.from("synthetic uv lock\n");
  const digest = createHash("sha256").update(lock).digest("hex");
  const commit = "a".repeat(40);
  await writeFile(join(hermesRoot, "uv.lock"), lock);
  await writeFile(
    join(activeRoot, "resident", "dependencies", "hermes.json"),
    `${JSON.stringify({ repository: "Lazurio/hermes-agent", commit, lock_file: "uv.lock", lock_sha256: digest })}\n`,
  );
  const cleanGit = (_command, args) => ({
    status: 0,
    stdout: args.includes("rev-parse") ? `${commit}\n` : "",
    stderr: "",
  });
  await expect(verifyHermesRuntime({ activeRoot, hermesRoot, processRunner: cleanGit }))
    .resolves.toMatchObject({ commit, lock_sha256: digest });
  await writeFile(join(hermesRoot, "uv.lock"), "drifted\n");
  await expect(verifyHermesRuntime({ activeRoot, hermesRoot, processRunner: cleanGit }))
    .rejects.toThrow("lock digest");
});

linuxHostTest("Hermes verification ignores poisoned PATH Git and checkout-local fsmonitor", async () => {
  const root = await scratch("lazurio-hermes-hostile-git-");
  const activeRoot = join(root, "active");
  const hermesRoot = join(root, "hermes");
  const fakeBin = join(root, "fake-bin");
  await Promise.all([
    mkdir(join(activeRoot, "resident", "dependencies"), { recursive: true }),
    mkdir(hermesRoot, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
  ]);

  const gitExecutable = trustedGitExecutable();
  expect(gitExecutable).not.toBeNull();
  const git = (args) => {
    const fixtureGitEnvironment = {
      LC_ALL: "C",
      LANG: "C",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    };
    const result = spawnSync(gitExecutable, [
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgSign=false",
      ...args,
    ], {
      cwd: hermesRoot,
      encoding: "utf8",
      env: fixtureGitEnvironment,
      shell: false,
      windowsHide: true,
    });
    expect(result.status, String(result.stderr ?? "")).toBe(0);
    return String(result.stdout ?? "").trim();
  };
  git(["init"]);
  git(["config", "user.name", "Lazurio fixture"]);
  git(["config", "user.email", "fixture@invalid.example"]);
  const lock = Buffer.from("trusted runtime lock\n");
  await writeFile(join(hermesRoot, "uv.lock"), lock);
  git(["add", "uv.lock"]);
  git(["commit", "-m", "fixture"]);
  const commit = git(["rev-parse", "HEAD"]);

  const fsmonitorHook = join(hermesRoot, ".git", "hostile-fsmonitor.sh");
  const fsmonitorMarker = join(hermesRoot, ".git", "fsmonitor-invoked");
  await writeFile(
    fsmonitorHook,
    "#!/bin/sh\n: > \"$(dirname \"$0\")/fsmonitor-invoked\"\nprintf 'fixture-token\\n'\n",
  );
  await chmod(fsmonitorHook, 0o755);
  git(["config", "core.fsmonitor", fsmonitorHook]);
  git(["config", "core.fsmonitorHookVersion", "2"]);
  git(["status", "--porcelain=v1"]);
  expect(existsSync(fsmonitorMarker)).toBe(true);
  await rm(fsmonitorMarker, { force: true });

  const fakeGit = join(fakeBin, "git");
  const fakeGitMarker = join(fakeBin, "invoked");
  await writeFile(fakeGit, "#!/bin/sh\n: > \"$(dirname \"$0\")/invoked\"\nexit 97\n");
  await chmod(fakeGit, 0o755);
  await writeFile(
    join(activeRoot, "resident", "dependencies", "hermes.json"),
    `${JSON.stringify({
      repository: "Lazurio/hermes-agent",
      commit,
      lock_file: "uv.lock",
      lock_sha256: createHash("sha256").update(lock).digest("hex"),
    })}\n`,
  );

  await expect(verifyHermesRuntime({
    activeRoot,
    hermesRoot,
    environment: { ...process.env, PATH: fakeBin },
  })).resolves.toMatchObject({ commit });
  expect(existsSync(fakeGitMarker)).toBe(false);
  expect(existsSync(fsmonitorMarker)).toBe(false);

  await expect(verifyHermesRuntime({
    activeRoot,
    hermesRoot,
    requireRootOwnership: true,
    platform: "linux",
    processRunner: () => {
      throw new Error("Git must not run before the ownership gate");
    },
  })).rejects.toThrow("root-owned non-writable path");
});

test("privileged Hermes immutable-tree gate rejects a writable nested runtime file", () => {
  const root = "/trusted/hermes";
  const runtime = join(root, "runtime");
  const agent = join(runtime, "agent.py");
  const directory = (mode = 0o755) => ({
    uid: 0,
    mode,
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false,
  });
  const file = (mode) => ({
    uid: 0,
    mode,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true,
  });
  const entries = new Map([
    [root, directory()],
    [runtime, directory()],
    [agent, file(0o664)],
  ]);
  expect(() => assertRootOwnedImmutableTree(root, {
    lstatEntry: (path) => entries.get(path),
    listEntries: (path) => path === root ? ["runtime"] : ["agent.py"],
  })).toThrow(/writable entry: runtime[\\/]agent\.py/u);
});

linuxHostTest("resident runtime rejects an executable below a user-writable path", async () => {
  const root = await scratch("lazurio-untrusted-executable-");
  const executable = join(root, "git");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  expect(isTrustedResidentExecutablePath(executable)).toBe(false);
});

test("privileged Hermes Git verification uses runuser with no privileged buddy groups", () => {
  const invocation = residentGitInvocation({
    gitExecutable: "/usr/bin/git",
    environment: { PATH: "/hostile" },
    platform: "linux",
    requireRootOwnership: true,
    effectiveUid: 0,
    identityResolver: (username) => {
      expect(username).toBe("buddy");
      return { uid: 12_345, gid: 12_346, groups: [12_346, 12_347] };
    },
    systemExecutableResolver: () => "/usr/sbin/runuser",
  });
  expect(invocation.command).toMatch(/\/runuser$/u);
  expect(invocation.argsPrefix).toEqual(["-u", "buddy", "--", "/usr/bin/git"]);
  expect(invocation.options.env.PATH).toBeUndefined();
  expect(() => residentGitInvocation({
    gitExecutable: "/usr/bin/git",
    platform: "linux",
    requireRootOwnership: true,
    effectiveUid: 0,
    identityResolver: () => ({ uid: 12_345, gid: 0, groups: [0, 12_345] }),
    systemExecutableResolver: () => "/usr/sbin/runuser",
  })).toThrow("unprivileged buddy identity");
});

linuxSystemdTest("systemctl lifecycle ignores a poisoned PATH executable", async () => {
  const root = await scratch("lazurio-hostile-systemctl-");
  const fakeBin = join(root, "fake-bin");
  const fakeSystemctl = join(fakeBin, "systemctl");
  const marker = join(fakeBin, "invoked");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(fakeSystemctl, "#!/bin/sh\n: > \"$(dirname \"$0\")/invoked\"\nexit 97\n");
  await chmod(fakeSystemctl, 0o755);

  const result = runCommand(["--version"], {
    allowFailure: true,
    environment: { ...process.env, PATH: fakeBin },
    platform: "linux",
  });
  if (trustedSystemExecutable("systemctl", "linux")) {
    expect(result.status, result.stderr).toBe(0);
  } else {
    expect(result).toMatchObject({ status: 127 });
  }
  expect(existsSync(marker)).toBe(false);
});

test("Hermes readiness requires both the bounded health contract and active systemd", async () => {
  const commands = [];
  const result = await waitForHermesGatewayReadiness({
    healthUrl: "http://127.0.0.1:8642/health",
    commandRunner: successfulSystemctl(commands),
    fetcher: async () => ({
      ok: true,
      json: async () => ({ status: "ok", platform: "hermes-agent" }),
    }),
  });
  expect(result).toEqual({ hermes_gateway_healthy: true });
  expect(commands).toEqual([
    `is-failed --quiet ${HERMES_SERVICE_UNIT}`,
    `is-active --quiet ${HERMES_SERVICE_UNIT}`,
  ]);
});
