import { afterEach, expect, test } from "bun:test";
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
import {
  BUDDY_SERVICE_BACKUP_SUFFIX,
  BUDDY_SERVICE_UNIT,
  HERMES_CONTEXT_DROPIN,
  HERMES_SERVICE_UNIT,
  inspectBridgeEnvironment,
  inspectProfileDirectory,
  installBuddyBridgeService,
  renderBuddyBridgeUnit,
  restorePreResidentBuddyService,
  verifyHermesRuntime,
  waitForBuddyBridgeReadiness,
  waitForHermesGatewayReadiness,
} from "./runtime/buddy-service-lib.mjs";

const scratches = [];
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
  const profileDirectory = join(root, "srv", "personalspace", "owner_GEN3", "buddy");
  await Promise.all([
    mkdir(join(artifactRoot, "resident", "services"), { recursive: true }),
    mkdir(join(artifactRoot, "bridge"), { recursive: true }),
    mkdir(unitDirectory, { recursive: true }),
    mkdir(join(environmentFile, ".."), { recursive: true }),
    mkdir(join(queueRoot, "queue", "state"), { recursive: true }),
    mkdir(profileDirectory, { recursive: true }),
  ]);
  await symlink(join("versions", "candidate-a"), join(installRoot, "active"));
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

test("Buddy service cutover preserves the old unit and installs only the active-root unit", async () => {
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

test("a failed post-restart hearing gate restores the exact previous unit", async () => {
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

test("the preserved unit remains an explicit operator rollback after a successful cutover", async () => {
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
    commandRunner: successfulSystemctl(commands),
    requireRootOwnership: false,
    platform: "linux",
  });
  expect(await readFile(paths.unitPath, "utf8")).toBe(paths.currentUnit);
});

test("EnvironmentFile validation names conflicting keys but never their secret values", async () => {
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
