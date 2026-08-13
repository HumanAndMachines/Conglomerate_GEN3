import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, realpathSync, statSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 as pathWin32 } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256, verifyArtifactTree } from "./integrity.mjs";

export const BUDDY_SERVICE_UNIT = "buddy-bridge.service";
export const BUDDY_SERVICE_BACKUP_SUFFIX = ".lazurio-pre-resident";
export const BUDDY_SERVICE_MARKER = "# Managed by Lazurio resident service installer.";
export const HERMES_SERVICE_UNIT = "hermes-gateway.service";
export const HERMES_CONTEXT_DROPIN = "20-lazurio-root.conf";
export const HERMES_CONTEXT_MARKER = "# Managed by Lazurio resident Hermes context installer.";
const REQUIRED_ENV_KEYS = ["ZULIP_SITE", "BUDDY_BOT_EMAIL", "BUDDY_BOT_API_KEY"];
const PROFILE_FILES = ["CONSTITUTION.md", "MANDATES.md"];
const PROFILE_FORBIDDEN = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /\.(key|pem|p12|pfx|secret|tfstate)$/,
  /^id_(rsa|ecdsa|ed25519)/,
  /^authorized_keys$/,
  /^\.git-credentials$/,
  /^\.netrc$/,
  /^personal\.gen3\.json$/,
];
const UNSCANNED_PROFILE_DIRECTORIES = new Set([".git", "node_modules"]);
const TRUSTED_LINUX_EXECUTABLES = Object.freeze({
  systemctl: ["/usr/bin/systemctl", "/bin/systemctl"],
  id: ["/usr/bin/id", "/bin/id"],
  runuser: ["/usr/sbin/runuser", "/sbin/runuser"],
  test: ["/usr/bin/test", "/bin/test"],
  find: ["/usr/bin/find", "/bin/find"],
});

export async function preflightBuddyBridgeService({
  installRoot,
  unitDirectory = "/etc/systemd/system",
  environmentFile = "/run/buddy/buddy-bridge.env",
  queueRoot = "/var/lib/buddy-bridge",
  hermesRoot = "/opt/buddy-runtime/hermes",
  bunPath = process.execPath,
  expectedTarget = `linux-${process.arch}`,
  requireRootOwnership = true,
  verifyArtifact = verifyArtifactTree,
  verifyHermes = verifyHermesRuntime,
  runtimeAccessProbe = probeBuddyRuntimeAccess,
  platform = process.platform,
} = {}) {
  assertLinux(platform);
  for (const [label, path] of Object.entries({
    installRoot,
    unitDirectory,
    environmentFile,
    queueRoot,
    hermesRoot,
    bunPath,
  })) {
    assertSystemdSafeAbsolutePath(label, path);
  }

  const activeLink = join(resolve(installRoot), "active");
  const activeStat = await lstat(activeLink).catch(() => null);
  if (!activeStat?.isSymbolicLink()) {
    throw new Error(`${activeLink} must be the atomic resident active symlink`);
  }
  const activeRoot = await realpath(activeLink);
  const versionsRoot = await realpath(join(resolve(installRoot), "versions"));
  if (!isWithin(versionsRoot, activeRoot)) {
    throw new Error("resident active symlink resolves outside the versions directory");
  }
  const health = await verifyArtifact(activeRoot, {
    expectedProfile: "buddy",
    expectedTarget,
  });
  if (!health?.ok) {
    throw new Error(`active Buddy artifact failed Doctor: ${(health?.failures ?? ["unknown failure"]).join("; ")}`);
  }
  const hermes = await verifyHermes({ activeRoot, hermesRoot, requireRootOwnership });

  const bunStat = await lstat(bunPath).catch(() => null);
  if (!bunStat || (!bunStat.isFile() && !bunStat.isSymbolicLink())) {
    throw new Error("Bun executable is not a file or symlink");
  }
  const resolvedBun = await realpath(bunPath);
  const executable = await stat(resolvedBun);
  if (!executable.isFile() || (executable.mode & 0o111) === 0) {
    throw new Error("Bun executable is not an executable regular file");
  }
  assertSystemdSafeAbsolutePath("resolved Bun", resolvedBun);
  const environment = await inspectBridgeEnvironment(environmentFile, {
    queueRoot,
    requireRootOwnership,
  });
  for (const [label, path] of [
    ["Buddy queue root", queueRoot],
    ["Buddy queue directory", environment.queueDirectory],
  ]) {
    const queueStat = await lstat(path).catch(() => null);
    if (!queueStat?.isDirectory() || queueStat.isSymbolicLink()) {
      throw new Error(`${label} must be an existing non-symlink directory`);
    }
  }
  const profile = await inspectProfileDirectory(environment.profileDirectory);
  if (!profile.ok) throw new Error(`Buddy profile refused: ${profile.reason}`);
  const activePersonalspace = await realpath(join(activeRoot, "personalspace")).catch(() => null);
  if (!activePersonalspace || !isWithin(activePersonalspace, profile.resolved)) {
    throw new Error("active Lazurio personalspace does not contain the declared Buddy profile");
  }
  const organizations = await readdir(join(activeRoot, "organizations")).catch(() => null);
  if (!organizations || organizations.length !== 0) {
    throw new Error("Buddy Personalspace host must carry an empty organizations mount");
  }
  if (requireRootOwnership) {
    runtimeAccessProbe({
      activeRoot,
      bunPath: resolvedBun,
      hermesRoot: hermes.root ?? await realpath(hermesRoot),
      profileDirectory: profile.resolved,
      queueDirectory: environment.queueDirectory,
    });
  }

  const templatePath = join(activeRoot, "resident", "services", "buddy-bridge.service.template");
  const templateStat = await lstat(templatePath).catch(() => null);
  if (!templateStat?.isFile() || templateStat.isSymbolicLink()) {
    throw new Error("active artifact has no regular Buddy service template");
  }
  const renderedUnit = renderBuddyBridgeUnit(await readFile(templatePath, "utf8"), {
    activeRoot: activeLink,
    bunPath: resolvedBun,
    environmentFile,
    queueRoot,
  });
  const hermesTemplatePath = join(
    activeRoot,
    "resident",
    "services",
    "hermes-lazurio-root.conf.template",
  );
  const hermesTemplateStat = await lstat(hermesTemplatePath).catch(() => null);
  if (!hermesTemplateStat?.isFile() || hermesTemplateStat.isSymbolicLink()) {
    throw new Error("active artifact has no regular Hermes Lazurio context template");
  }
  const renderedHermesContext = renderHermesContextDropin(
    await readFile(hermesTemplatePath, "utf8"),
    { activeRoot: activeLink },
  );
  const unitPath = join(unitDirectory, BUDDY_SERVICE_UNIT);
  const unit = await readOptionalRegularFile(unitPath);
  const backupPath = `${unitPath}${BUDDY_SERVICE_BACKUP_SUFFIX}`;
  const backup = await readOptionalRegularFile(backupPath);
  if (backup && unit && !unit.bytes.includes(Buffer.from(BUDDY_SERVICE_MARKER))
    && !backup.bytes.equals(unit.bytes)) {
    throw new Error("a preserved pre-resident unit already exists and differs from the current unmanaged unit");
  }
  const hermesDropinDirectory = join(unitDirectory, `${HERMES_SERVICE_UNIT}.d`);
  const hermesDropinPath = join(hermesDropinDirectory, HERMES_CONTEXT_DROPIN);
  const hermesBackupPath = `${hermesDropinPath}${BUDDY_SERVICE_BACKUP_SUFFIX}`;
  const hermesDropin = await readOptionalRegularFile(hermesDropinPath);
  const hermesBackup = await readOptionalRegularFile(hermesBackupPath);
  if (hermesBackup && hermesDropin
    && !hermesDropin.bytes.includes(Buffer.from(HERMES_CONTEXT_MARKER))
    && !hermesBackup.bytes.equals(hermesDropin.bytes)) {
    throw new Error("a preserved pre-resident Hermes context drop-in differs from the current unmanaged drop-in");
  }

  return {
    schema_version: "lazurio.buddy-service.preflight.v1",
    active_root: activeLink,
    active_artifact: activeRoot,
    bun: resolvedBun,
    environment_file: environmentFile,
    profile_directory: profile.resolved,
    queue_root: queueRoot,
    runtime_health_url: environment.runtimeHealthUrl,
    hermes_runtime: hermes,
    unit_path: unitPath,
    backup_path: backupPath,
    current_unit: unit,
    existing_backup: backup,
    rendered_unit: renderedUnit,
    hermes_dropin_path: hermesDropinPath,
    hermes_backup_path: hermesBackupPath,
    current_hermes_dropin: hermesDropin,
    existing_hermes_backup: hermesBackup,
    rendered_hermes_context: renderedHermesContext,
  };
}

export async function installBuddyBridgeService({
  commandRunner = runCommand,
  preTransitionProbe = assertExistingBuddyBridgeReady,
  legacyPreTransitionProbe = assertLegacyBuddyBridgeReady,
  hermesReadinessProbe = waitForHermesGatewayReadiness,
  rollbackHermesReadinessProbe = waitForHermesGatewayReadiness,
  readinessProbe = waitForBuddyBridgeReadiness,
  rollbackReadinessProbe = waitForBuddyBridgeReadiness,
  legacyRollbackReadinessProbe = assertLegacyBuddyBridgeReady,
  now = () => Date.now(),
  ...options
} = {}) {
  const preflight = await preflightBuddyBridgeService(options);
  if (typeof process.getuid === "function" && process.getuid() !== 0
    && options.requireRootOwnership !== false) {
    throw new Error("Buddy service install must run as root");
  }
  const priorBytes = preflight.current_unit?.bytes ?? null;
  const currentManaged = priorBytes?.includes(Buffer.from(BUDDY_SERVICE_MARKER)) ?? false;
  if (preflight.current_unit) {
    const probe = currentManaged ? preTransitionProbe : legacyPreTransitionProbe;
    await probe({ queueRoot: preflight.queue_root, commandRunner });
  }
  if (!preflight.existing_backup && priorBytes && !currentManaged) {
    await atomicWrite(preflight.backup_path, priorBytes, 0o600, { replace: false });
  }
  const priorHermesBytes = preflight.current_hermes_dropin?.bytes ?? null;
  const hermesContextManaged = priorHermesBytes?.includes(Buffer.from(HERMES_CONTEXT_MARKER)) ?? false;
  if (!preflight.existing_hermes_backup && priorHermesBytes && !hermesContextManaged) {
    await atomicWrite(preflight.hermes_backup_path, priorHermesBytes, 0o600, { replace: false });
  }

  const transitionStartedAt = now();
  try {
    await atomicWrite(preflight.unit_path, preflight.rendered_unit, 0o644);
    await atomicWrite(preflight.hermes_dropin_path, preflight.rendered_hermes_context, 0o644);
    assertCommand(commandRunner, ["daemon-reload"]);
    assertCommand(commandRunner, ["restart", HERMES_SERVICE_UNIT]);
    await hermesReadinessProbe({ healthUrl: preflight.runtime_health_url, commandRunner });
    assertCommand(commandRunner, ["enable", BUDDY_SERVICE_UNIT]);
    assertCommand(commandRunner, ["restart", BUDDY_SERVICE_UNIT]);
    await readinessProbe({
      queueRoot: preflight.queue_root,
      notBefore: transitionStartedAt,
      commandRunner,
    });
  } catch (error) {
    const rollbackFailures = [];
    try {
      if (priorBytes) await atomicWrite(preflight.unit_path, priorBytes, preflight.current_unit.mode);
      else await unlink(preflight.unit_path).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
      if (priorHermesBytes) {
        await atomicWrite(
          preflight.hermes_dropin_path,
          priorHermesBytes,
          preflight.current_hermes_dropin.mode,
        );
      } else {
        await unlink(preflight.hermes_dropin_path).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
      }
      assertCommand(commandRunner, ["daemon-reload"]);
      assertCommand(commandRunner, ["restart", HERMES_SERVICE_UNIT]);
      await rollbackHermesReadinessProbe({
        healthUrl: preflight.runtime_health_url,
        commandRunner,
      });
      if (priorBytes) {
        const rollbackStartedAt = now();
        assertCommand(commandRunner, ["restart", BUDDY_SERVICE_UNIT]);
        const probe = currentManaged ? rollbackReadinessProbe : legacyRollbackReadinessProbe;
        await probe({
          queueRoot: preflight.queue_root,
          notBefore: rollbackStartedAt,
          commandRunner,
        });
      } else {
        commandRunner(["disable", "--now", BUDDY_SERVICE_UNIT], { allowFailure: true });
      }
    } catch (rollbackError) {
      rollbackFailures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    }
    const rollbackDetail = rollbackFailures.length === 0
      ? "previous unit restored"
      : `rollback incomplete: ${rollbackFailures.join("; ")}`;
    throw new Error(
      `Buddy service transition failed; ${rollbackDetail}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    schema_version: "lazurio.buddy-service.result.v1",
    action: preflight.current_unit?.bytes.equals(Buffer.from(preflight.rendered_unit))
      ? "reconciled"
      : "installed",
    unit: BUDDY_SERVICE_UNIT,
    active_root: preflight.active_root,
    backup_preserved: Boolean((priorBytes && !currentManaged) || preflight.existing_backup),
    hermes_context_backup_preserved: Boolean(
      (priorHermesBytes && !hermesContextManaged) || preflight.existing_hermes_backup,
    ),
    hermes_context_cwd: preflight.active_root,
    bridge_queue_registered: true,
  };
}

export async function restorePreResidentBuddyService({
  unitDirectory = "/etc/systemd/system",
  environmentFile = "/run/buddy/buddy-bridge.env",
  queueRoot = "/var/lib/buddy-bridge",
  commandRunner = runCommand,
  hermesReadinessProbe = waitForHermesGatewayReadiness,
  bridgeReadinessProbe = assertLegacyBuddyBridgeReady,
  runtimeHealthUrl,
  requireRootOwnership = true,
  platform = process.platform,
} = {}) {
  assertLinux(platform);
  assertSystemdSafeAbsolutePath("unitDirectory", unitDirectory);
  if (typeof process.getuid === "function" && process.getuid() !== 0 && requireRootOwnership) {
    throw new Error("Buddy service restore must run as root");
  }
  const environment = await inspectBridgeEnvironment(environmentFile, {
    queueRoot,
    requireRootOwnership,
  });
  const unitPath = join(unitDirectory, BUDDY_SERVICE_UNIT);
  const backupPath = `${unitPath}${BUDDY_SERVICE_BACKUP_SUFFIX}`;
  const backup = await readOptionalRegularFile(backupPath);
  if (!backup) throw new Error("no preserved pre-resident Buddy service unit exists");
  const hermesDropinPath = join(
    unitDirectory,
    `${HERMES_SERVICE_UNIT}.d`,
    HERMES_CONTEXT_DROPIN,
  );
  const hermesBackupPath = `${hermesDropinPath}${BUDDY_SERVICE_BACKUP_SUFFIX}`;
  const hermesBackup = await readOptionalRegularFile(hermesBackupPath);
  const hermesDropin = await readOptionalRegularFile(hermesDropinPath);
  if (!hermesBackup && !hermesDropin?.bytes.includes(Buffer.from(HERMES_CONTEXT_MARKER))) {
    throw new Error("no managed Hermes Lazurio context drop-in or preserved predecessor exists");
  }
  await atomicWrite(unitPath, backup.bytes, 0o644);
  if (hermesBackup) await atomicWrite(hermesDropinPath, hermesBackup.bytes, 0o644);
  else await unlink(hermesDropinPath);
  assertCommand(commandRunner, ["daemon-reload"]);
  assertCommand(commandRunner, ["restart", HERMES_SERVICE_UNIT]);
  await hermesReadinessProbe({
    healthUrl: runtimeHealthUrl ?? environment.runtimeHealthUrl,
    commandRunner,
  });
  assertCommand(commandRunner, ["restart", BUDDY_SERVICE_UNIT]);
  await bridgeReadinessProbe({ commandRunner });
  return {
    schema_version: "lazurio.buddy-service.result.v1",
    action: "restored_pre_resident_unit",
    unit: BUDDY_SERVICE_UNIT,
  };
}

export function renderHermesContextDropin(template, { activeRoot }) {
  assertSystemdSafeAbsolutePath("activeRoot", activeRoot);
  const rendered = String(template).split("@@ACTIVE_ROOT@@").join(activeRoot);
  if (/@@[A-Z_]+@@/.test(rendered)) throw new Error("Hermes context template has an unresolved marker");
  for (const required of [HERMES_CONTEXT_MARKER, `Environment=TERMINAL_CWD=${activeRoot}`]) {
    if (!rendered.split(/\r?\n/).includes(required)) {
      throw new Error(`rendered Hermes context drop-in is missing required line ${required}`);
    }
  }
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

export function renderBuddyBridgeUnit(template, {
  activeRoot,
  bunPath,
  environmentFile,
  queueRoot,
}) {
  for (const [label, path] of Object.entries({ activeRoot, bunPath, environmentFile, queueRoot })) {
    assertSystemdSafeAbsolutePath(label, path);
  }
  let rendered = String(template);
  const replacements = new Map([
    ["@@ACTIVE_ROOT@@", activeRoot],
    ["@@BUN_BIN@@", bunPath],
    ["@@ENVIRONMENT_FILE@@", environmentFile],
    ["@@QUEUE_ROOT@@", queueRoot],
  ]);
  for (const [marker, value] of replacements) rendered = rendered.split(marker).join(value);
  if (/@@[A-Z_]+@@/.test(rendered)) throw new Error("Buddy service template has an unresolved marker");
  for (const required of [
    BUDDY_SERVICE_MARKER,
    `WorkingDirectory=${activeRoot}`,
    `ExecStart=${bunPath} ${activeRoot}/bridge/run.ts`,
    `EnvironmentFile=${environmentFile}`,
    "RestartPreventExitStatus=78",
    "User=buddy-bridge",
    `ReadWritePaths=${queueRoot}`,
  ]) {
    if (!rendered.split(/\r?\n/).includes(required)) {
      throw new Error(`rendered Buddy unit is missing required line ${required}`);
    }
  }
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

export async function inspectBridgeEnvironment(environmentFile, {
  queueRoot = "/var/lib/buddy-bridge",
  requireRootOwnership = true,
} = {}) {
  const file = await readOptionalRegularFile(environmentFile);
  if (!file) throw new Error("Buddy runtime EnvironmentFile does not exist");
  if ((file.mode & 0o077) !== 0) {
    throw new Error("Buddy runtime EnvironmentFile must not be group- or world-accessible");
  }
  if (requireRootOwnership && file.uid !== 0) {
    throw new Error("Buddy runtime EnvironmentFile must be owned by root");
  }
  const values = parseEnvironmentFile(file.bytes.toString("utf8"));
  const missing = REQUIRED_ENV_KEYS.filter((key) => !values.get(key));
  const runtimeUrl = resolveAliases(values, "AGENT_RUNTIME_URL", ["HERMES_API_URL"]);
  const runtimeKey = resolveAliases(values, "AGENT_RUNTIME_KEY", ["API_SERVER_KEY", "HERMES_API_KEY"]);
  if (!runtimeUrl) missing.push("AGENT_RUNTIME_URL");
  if (!runtimeKey) missing.push("AGENT_RUNTIME_KEY");
  if (!values.get("BUDDY_PROFILE_DIR")) missing.push("BUDDY_PROFILE_DIR");
  if (!values.get("BUDDY_BRIDGE_QUEUE_DIR")) missing.push("BUDDY_BRIDGE_QUEUE_DIR");
  if (missing.length > 0) {
    throw new Error(`Buddy runtime EnvironmentFile is missing keys: ${[...new Set(missing)].join(", ")}`);
  }
  const runtimeHealthUrl = derivePrivateRuntimeHealthUrl(runtimeUrl);
  const configuredQueue = resolve(values.get("BUDDY_BRIDGE_QUEUE_DIR"));
  const expectedQueue = join(resolve(queueRoot), "queue");
  if (!isAbsolute(values.get("BUDDY_BRIDGE_QUEUE_DIR"))) {
    throw new Error("BUDDY_BRIDGE_QUEUE_DIR must be an absolute path");
  }
  if (configuredQueue !== expectedQueue) {
    throw new Error("BUDDY_BRIDGE_QUEUE_DIR does not match the service writable queue boundary");
  }
  return {
    profileDirectory: values.get("BUDDY_PROFILE_DIR"),
    queueDirectory: configuredQueue,
    keyNames: [...values.keys()].sort(),
    runtimeHealthUrl,
  };
}

export async function verifyHermesRuntime({
  activeRoot,
  hermesRoot = "/opt/buddy-runtime/hermes",
  processRunner = runProcess,
  environment = process.env,
  requireRootOwnership = false,
  platform = process.platform,
  effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : null,
  identityResolver = resolveLinuxIdentity,
  systemExecutableResolver = trustedSystemExecutable,
} = {}) {
  const descriptor = JSON.parse(
    await readFile(join(activeRoot, "resident", "dependencies", "hermes.json"), "utf8"),
  );
  const resolvedHermesRoot = await realpath(hermesRoot).catch(() => null);
  if (!resolvedHermesRoot) throw new Error("Hermes runtime root cannot be resolved");
  const gitExecutable = trustedGitExecutable(platform);
  if (!gitExecutable) {
    throw new Error("Hermes verification requires Git from a trusted system-owned path");
  }
  const gitInvocation = residentGitInvocation({
    gitExecutable,
    environment,
    platform,
    requireRootOwnership,
    effectiveUid,
    identityResolver,
    systemExecutableResolver,
  });
  const commit = processText(processRunner, gitInvocation.command, [
    ...gitInvocation.argsPrefix,
    ...safeGitArguments(platform, requireRootOwnership ? resolvedHermesRoot : null),
    "-C",
    resolvedHermesRoot,
    "rev-parse",
    "HEAD",
  ], gitInvocation.options);
  if (commit !== descriptor.commit) throw new Error("live Hermes runtime commit does not match the resident pin");
  await assertHermesTrackedTreeMatchesCommit({
    root: resolvedHermesRoot,
    pinnedCommit: descriptor.commit,
    gitInvocation,
    processRunner,
    platform,
  });
  const status = processText(processRunner, gitInvocation.command, [
    ...gitInvocation.argsPrefix,
    ...safeGitArguments(platform, requireRootOwnership ? resolvedHermesRoot : null),
    "-C",
    resolvedHermesRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ], gitInvocation.options);
  if (status !== "") throw new Error("live Hermes runtime checkout is dirty");
  const lockPath = join(resolvedHermesRoot, descriptor.lock_file);
  const lockStat = await lstat(lockPath).catch(() => null);
  if (!lockStat?.isFile() || lockStat.isSymbolicLink()) {
    throw new Error("live Hermes lock file is missing or not regular");
  }
  if (sha256(await readFile(lockPath)) !== descriptor.lock_sha256) {
    throw new Error("live Hermes lock digest does not match the resident pin");
  }
  return {
    repository: descriptor.repository,
    commit,
    lock_sha256: descriptor.lock_sha256,
    root: resolvedHermesRoot,
  };
}

export async function inspectProfileDirectory(profileDirectory, maxDepth = 4) {
  if (!profileDirectory || !isAbsolute(profileDirectory)) {
    return { ok: false, reason: "BUDDY_PROFILE_DIR must be an absolute path" };
  }
  let resolved;
  try {
    resolved = await realpath(profileDirectory);
  } catch {
    return { ok: false, reason: "BUDDY_PROFILE_DIR cannot be resolved" };
  }
  const rootStat = await stat(resolved).catch(() => null);
  if (!rootStat?.isDirectory()) return { ok: false, reason: "BUDDY_PROFILE_DIR is not a directory" };
  for (const file of PROFILE_FILES) {
    const contractPath = join(resolved, file);
    const contractStat = await lstat(contractPath).catch(() => null);
    if (!contractStat?.isFile() || contractStat.isSymbolicLink()) {
      return { ok: false, reason: `${file} must be a regular non-symlink file` };
    }
    const handle = await open(
      contractPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    ).catch(() => null);
    if (!handle) return { ok: false, reason: `${file} is missing, unreadable or empty` };
    let content = null;
    try {
      if ((await handle.stat()).isFile()) content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    if (!content?.trim()) return { ok: false, reason: `${file} is missing, unreadable or empty` };
  }
  const offenders = [];
  const walk = async (directory, depth) => {
    if (depth > maxDepth || offenders.length >= 20) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (PROFILE_FORBIDDEN.some((pattern) => pattern.test(entry.name))) {
        offenders.push(relative(resolved, join(directory, entry.name)));
      } else if (!UNSCANNED_PROFILE_DIRECTORIES.has(entry.name)) {
        const entryStat = await stat(join(directory, entry.name)).catch(() => null);
        if (entryStat?.isDirectory()) await walk(join(directory, entry.name), depth + 1);
      }
      if (offenders.length >= 20) return;
    }
  };
  await walk(resolved, 1);
  if (offenders.length > 0) {
    return { ok: false, reason: `secret-shaped entries found: ${offenders.sort().join(", ")}` };
  }
  return { ok: true, resolved };
}

export async function waitForBuddyBridgeReadiness({
  queueRoot,
  notBefore,
  commandRunner = runCommand,
  timeoutMs = 45_000,
  pollMs = 250,
  clock = () => Date.now(),
  delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
} = {}) {
  const deadline = clock() + timeoutMs;
  const statePath = join(queueRoot, "queue", "state", "poller.json");
  while (clock() <= deadline) {
    const failed = commandRunner(["is-failed", "--quiet", BUDDY_SERVICE_UNIT], { allowFailure: true });
    if (failed.status === 0) throw new Error("Buddy bridge entered failed state before registering its queue");
    const state = await readPollerState(statePath);
    if (state?.registered === true && state.version === 1
      && Number.isInteger(state.registrations) && state.registrations > 0
      && Number.isFinite(Date.parse(state.at)) && Date.parse(state.at) >= notBefore - 1_000) {
      assertCommand(commandRunner, ["is-active", "--quiet", BUDDY_SERVICE_UNIT]);
      return { bridge_queue_registered: true, at: state.at };
    }
    if (clock() >= deadline) break;
    await delay(pollMs);
  }
  throw new Error("Buddy bridge did not publish a fresh registered poller state before timeout");
}

export async function waitForHermesGatewayReadiness({
  healthUrl,
  commandRunner = runCommand,
  timeoutMs = 45_000,
  pollMs = 250,
  clock = () => Date.now(),
  delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  fetcher = fetch,
} = {}) {
  const deadline = clock() + timeoutMs;
  while (clock() <= deadline) {
    const failed = commandRunner(["is-failed", "--quiet", HERMES_SERVICE_UNIT], { allowFailure: true });
    if (failed.status === 0) throw new Error("Hermes gateway entered failed state before health passed");
    try {
      const response = await fetcher(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.status === "ok" && body?.platform === "hermes-agent") {
          assertCommand(commandRunner, ["is-active", "--quiet", HERMES_SERVICE_UNIT]);
          return { hermes_gateway_healthy: true };
        }
      }
    } catch {
      // A bounded retry is expected while systemd starts the pinned gateway.
    }
    if (clock() >= deadline) break;
    await delay(pollMs);
  }
  throw new Error("Hermes gateway did not pass its health endpoint before timeout");
}

export async function assertExistingBuddyBridgeReady({
  queueRoot,
  commandRunner = runCommand,
} = {}) {
  assertCommand(commandRunner, ["is-enabled", "--quiet", HERMES_SERVICE_UNIT]);
  assertCommand(commandRunner, ["is-active", "--quiet", HERMES_SERVICE_UNIT]);
  assertCommand(commandRunner, ["is-enabled", "--quiet", BUDDY_SERVICE_UNIT]);
  assertCommand(commandRunner, ["is-active", "--quiet", BUDDY_SERVICE_UNIT]);
  const state = await readPollerState(join(queueRoot, "queue", "state", "poller.json"));
  if (state?.registered !== true || state.version !== 1
    || !Number.isInteger(state.registrations) || state.registrations < 1
    || !Number.isFinite(Date.parse(state.at))) {
    throw new Error("existing Buddy bridge is not demonstrably registered; refusing a transition without a rollback baseline");
  }
  return { bridge_queue_registered: true, at: state.at };
}

export async function assertLegacyBuddyBridgeReady({
  commandRunner = runCommand,
} = {}) {
  // An unmanaged predecessor may be the outgoing-webhook bridge, which has no
  // resident poller state by design. Its honest portable baseline is the state
  // systemd owned before Lazurio touched the unit; requiring poller.json here
  // would make the very first migration impossible and would also make the
  // explicit restore command report failure after a successful legacy restore.
  assertCommand(commandRunner, ["is-enabled", "--quiet", HERMES_SERVICE_UNIT]);
  assertCommand(commandRunner, ["is-active", "--quiet", HERMES_SERVICE_UNIT]);
  assertCommand(commandRunner, ["is-enabled", "--quiet", BUDDY_SERVICE_UNIT]);
  assertCommand(commandRunner, ["is-active", "--quiet", BUDDY_SERVICE_UNIT]);
  return { legacy_bridge_service_active: true };
}

function parseEnvironmentFile(text) {
  const values = new Map();
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`Buddy runtime EnvironmentFile has invalid syntax on line ${index + 1}`);
    if (values.has(match[1])) throw new Error(`Buddy runtime EnvironmentFile repeats key ${match[1]}`);
    values.set(match[1], decodeEnvironmentValue(match[2], index + 1));
  }
  return values;
}

function decodeEnvironmentValue(raw, lineNumber) {
  const value = raw.trim();
  if (value.includes("\0")) throw new Error(`Buddy runtime EnvironmentFile has NUL on line ${lineNumber}`);
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith('"') || value.endsWith('"') || value.startsWith("'") || value.endsWith("'")) {
    throw new Error(`Buddy runtime EnvironmentFile has unmatched quotes on line ${lineNumber}`);
  }
  return value;
}

function resolveAliases(values, canonical, aliases) {
  const present = [canonical, ...aliases]
    .map((key) => [key, values.get(key)])
    .filter(([, value]) => value);
  const distinct = new Set(present.map(([, value]) => value));
  if (distinct.size > 1) {
    throw new Error(`Buddy runtime EnvironmentFile carries different values for ${present.map(([key]) => key).join(", ")}`);
  }
  return present[0]?.[1] ?? "";
}

async function readOptionalRegularFile(path) {
  const fileStat = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!fileStat) return null;
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${path} must be a regular non-symlink file`);
  }
  return {
    bytes: await readFile(path),
    mode: fileStat.mode & 0o777,
    uid: fileStat.uid,
  };
}

async function readPollerState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function atomicWrite(path, bytes, mode, { replace = true } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  if (!replace && existsSync(path)) throw new Error(`${path} already exists`);
  const temporary = join(dirname(path), `.${randomBytes(12).toString("hex")}.lazurio.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await chmod(temporary, mode);
    if (!replace && existsSync(path)) throw new Error(`${path} already exists`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertCommand(commandRunner, args) {
  const result = commandRunner(args, { allowFailure: false });
  if (!result || result.status !== 0) {
    const detail = String(result?.stderr ?? result?.stdout ?? "").trim().slice(0, 500);
    throw new Error(`systemctl ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export function runCommand(args, {
  allowFailure = false,
  environment = process.env,
  platform = process.platform,
} = {}) {
  const executable = trustedSystemExecutable("systemctl", platform);
  if (!executable) {
    return {
      status: 127,
      stdout: "",
      stderr: "systemctl is unavailable at a trusted system-owned path",
    };
  }
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: residentSystemEnvironment(environment),
    shell: false,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const response = {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
  if (!allowFailure && response.status !== 0) return response;
  return response;
}

export function runProcess(command, args, { env } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...(env ? { env } : {}),
    shell: false,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}

export function probeBuddyRuntimeAccess({
  activeRoot,
  bunPath,
  hermesRoot,
  profileDirectory,
  queueDirectory,
  commandRunner = spawnSync,
  systemExecutableResolver = trustedSystemExecutable,
  environment = process.env,
}) {
  const idExecutable = systemExecutableResolver("id", "linux");
  const runuserExecutable = systemExecutableResolver("runuser", "linux");
  const testExecutable = systemExecutableResolver("test", "linux");
  const findExecutable = systemExecutableResolver("find", "linux");
  if (!idExecutable || !runuserExecutable || !testExecutable || !findExecutable) {
    throw new Error("Buddy runtime access probe requires trusted id, runuser, test, and find executables");
  }
  for (const [label, path] of Object.entries({ activeRoot, bunPath, hermesRoot, profileDirectory, queueDirectory })) {
    assertSystemdSafeAbsolutePath(label, path);
  }
  const commandOptions = {
    encoding: "utf8",
    env: residentSystemEnvironment(environment),
    shell: false,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  };
  const checks = [
    [idExecutable, ["-u", "buddy-bridge"], "runtime user buddy-bridge does not exist"],
    [runuserExecutable, ["-u", "buddy-bridge", "--", testExecutable, "-x", bunPath], "buddy-bridge cannot execute pinned Bun"],
    [runuserExecutable, ["-u", "buddy-bridge", "--", testExecutable, "-r", join(activeRoot, "bridge", "run.ts")], "buddy-bridge cannot read the active bridge"],
    [runuserExecutable, ["-u", "buddy-bridge", "--", testExecutable, "-r", join(profileDirectory, "CONSTITUTION.md")], "buddy-bridge cannot read CONSTITUTION.md"],
    [runuserExecutable, ["-u", "buddy-bridge", "--", testExecutable, "-r", join(profileDirectory, "MANDATES.md")], "buddy-bridge cannot read MANDATES.md"],
    [runuserExecutable, ["-u", "buddy-bridge", "--", testExecutable, "-w", queueDirectory], "buddy-bridge cannot write its durable queue"],
    [idExecutable, ["-u", "buddy"], "runtime user buddy does not exist"],
    [runuserExecutable, ["-u", "buddy", "--", testExecutable, "-r", join(activeRoot, "AGENTS.md")], "buddy cannot read the active Lazurio AGENTS.md"],
    [runuserExecutable, ["-u", "buddy", "--", testExecutable, "-d", join(activeRoot, "personalspace")], "buddy cannot traverse the active Lazurio Personalspace mount"],
  ];
  for (const [command, args, failure] of checks) {
    const result = commandRunner(command, args, commandOptions);
    if (result.status !== 0) throw new Error(failure);
  }

  // Principál may own and edit these dependencies. The two long-running
  // service identities must not be able to replace the sandbox beneath
  // themselves, including through a writable ancestor directory.
  const replacementBoundaries = [...new Set([
    ...pathAndAncestors(bunPath),
    ...pathAndAncestors(dirname(hermesRoot)),
  ])];
  for (const username of ["buddy", "buddy-bridge"]) {
    for (const path of replacementBoundaries) {
      const result = commandRunner(runuserExecutable, [
        "-u", username, "--", testExecutable, "!", "-w", path,
      ], commandOptions);
      if (result.status !== 0) {
        throw new Error(`${username} can replace a pinned Buddy runtime dependency through ${path}`);
      }
    }
    const writable = commandRunner(runuserExecutable, [
      "-u", username, "--", findExecutable, hermesRoot, "-writable", "-print", "-quit",
    ], commandOptions);
    if (writable.status !== 0) {
      throw new Error(`cannot verify that ${username} has read-only access to the Hermes sandbox checkout`);
    }
    if (String(writable.stdout ?? "").trim() !== "") {
      throw new Error(`${username} can modify the Hermes sandbox checkout`);
    }
  }
}

function pathAndAncestors(path) {
  const paths = [];
  let current = resolve(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

function derivePrivateRuntimeHealthUrl(runtimeUrl) {
  let parsed;
  try {
    parsed = new URL(runtimeUrl);
  } catch {
    throw new Error("AGENT_RUNTIME_URL is not a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("AGENT_RUNTIME_URL must be an HTTP(S) URL without embedded credentials");
  }
  if (!isPrivateRuntimeHost(parsed.hostname)) {
    throw new Error("AGENT_RUNTIME_URL must target loopback or a private host address");
  }
  return new URL("/health", parsed).toString();
}

export function isPrivateRuntimeHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return octets[0] === 127
    || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function processOutput(processRunner, command, args, options) {
  const result = processRunner(command, args, options);
  if (!result || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return String(result.stdout ?? "");
}

function processText(processRunner, command, args, options) {
  return processOutput(processRunner, command, args, options).trim();
}

async function assertHermesTrackedTreeMatchesCommit({
  root,
  pinnedCommit,
  gitInvocation,
  processRunner,
  platform,
}) {
  const gitBase = [
    ...gitInvocation.argsPrefix,
    ...safeGitArguments(platform, root),
    "-C",
    root,
  ];
  const objectFormat = processText(processRunner, gitInvocation.command, [
    ...gitBase,
    "rev-parse",
    "--show-object-format",
  ], gitInvocation.options);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`unsupported Hermes Git object format ${objectFormat || "<empty>"}`);
  }
  const listing = processOutput(processRunner, gitInvocation.command, [
    ...gitBase,
    "ls-tree",
    "-rz",
    "--full-tree",
    pinnedCommit,
  ], gitInvocation.options);
  const records = listing.split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.length === 0) throw new Error("pinned Hermes commit has an empty tree");

  for (const record of records) {
    const separator = record.indexOf("\t");
    const metadata = separator < 0 ? "" : record.slice(0, separator);
    const path = separator < 0 ? "" : record.slice(separator + 1);
    const match = metadata.match(/^([0-7]{6}) (blob|commit) ([0-9a-f]+)$/u);
    if (!match || !path) throw new Error("pinned Hermes tree has an invalid entry");
    const [, mode, type, expectedObject] = match;
    if (type !== "blob") {
      throw new Error(`pinned Hermes tree contains unsupported submodule ${path}`);
    }
    const candidate = resolve(root, path);
    if (!isWithin(root, candidate)) {
      throw new Error("pinned Hermes tree contains a path outside its checkout");
    }
    const entry = await lstat(candidate).catch(() => null);
    let bytes;
    if (mode === "120000") {
      if (!entry?.isSymbolicLink()) {
        throw new Error(`live Hermes tracked tree differs from pinned commit at ${path}`);
      }
      bytes = Buffer.from(await readlink(candidate));
    } else if (mode === "100644" || mode === "100755") {
      if (!entry?.isFile() || entry.isSymbolicLink()) {
        throw new Error(`live Hermes tracked tree differs from pinned commit at ${path}`);
      }
      if (platform !== "win32" && ((entry.mode & 0o111) !== 0) !== (mode === "100755")) {
        throw new Error(`live Hermes tracked tree differs from pinned commit at ${path}`);
      }
      bytes = await readFile(candidate);
    } else {
      throw new Error(`pinned Hermes tree uses unsupported mode ${mode} at ${path}`);
    }
    const actualObject = createHash(objectFormat)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (actualObject !== expectedObject) {
      throw new Error(`live Hermes tracked tree differs from pinned commit at ${path}`);
    }
  }
}

export function trustedGitExecutable(platform = process.platform) {
  const candidates = platform === "darwin"
    ? ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
    : platform === "linux"
      ? ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"]
      : platform === "win32"
        ? [
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files\\Git\\bin\\git.exe",
          "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
          "C:\\Program Files (x86)\\Git\\bin\\git.exe",
        ]
        : [];
  return firstTrustedExecutable(candidates, platform);
}

export function trustedSystemExecutable(command, platform = process.platform) {
  if (platform !== "linux") return null;
  return firstTrustedExecutable(TRUSTED_LINUX_EXECUTABLES[command] ?? [], platform);
}

function firstTrustedExecutable(candidates, platform) {
  for (const candidate of candidates) {
    try {
      const canonicalPath = realpathSync.native(candidate);
      if (isTrustedResidentExecutablePath(canonicalPath, platform)) {
        return canonicalPath;
      }
    } catch {
      // Fail closed and try only the next hard-coded system-owned candidate.
    }
  }
  return null;
}

export function isTrustedResidentExecutablePath(canonicalPath, platform = process.platform) {
  if (!isAbsolute(canonicalPath)) return false;
  let executable;
  try {
    executable = statSync(canonicalPath);
  } catch {
    return false;
  }
  if (!executable.isFile()) return false;
  if (platform === "win32") {
    const normalized = pathWin32.normalize(canonicalPath).toLowerCase();
    return ["C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git"]
      .some((root) => normalized.startsWith(`${root.toLowerCase()}\\`));
  }
  if ((executable.mode & 0o111) === 0) return false;
  return isRootOwnedNonWritablePath(canonicalPath, { requireFile: true });
}

function isRootOwnedNonWritablePath(canonicalPath, { requireDirectory = false, requireFile = false } = {}) {
  if (!isAbsolute(canonicalPath)) return false;
  try {
    const target = statSync(canonicalPath);
    if (requireDirectory && !target.isDirectory()) return false;
    if (requireFile && !target.isFile()) return false;
    let component = canonicalPath;
    while (true) {
      const componentStat = statSync(component);
      if (componentStat.uid !== 0 || (componentStat.mode & 0o022) !== 0) return false;
      const parent = dirname(component);
      if (parent === component) return true;
      component = parent;
    }
  } catch {
    return false;
  }
}

function safeGitArguments(platform = process.platform, safeDirectory = null) {
  return [
    "-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.gitProxy=",
    "-c", "protocol.ext.allow=never",
    ...(safeDirectory ? ["-c", `safe.directory=${safeDirectory}`] : []),
  ];
}

function residentGitEnvironment(base = process.env, platform = process.platform) {
  const environment = residentProcessEnvironment(base);
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_COUNT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "cat";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export function residentGitInvocation({
  gitExecutable,
  environment = process.env,
  platform = process.platform,
  requireRootOwnership = false,
  effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : null,
  identityResolver = resolveLinuxIdentity,
  systemExecutableResolver = trustedSystemExecutable,
} = {}) {
  const options = { env: residentGitEnvironment(environment, platform) };
  if (!requireRootOwnership || effectiveUid !== 0) {
    return { command: gitExecutable, argsPrefix: [], options };
  }
  if (platform !== "linux") {
    throw new Error("privileged Hermes Git verification is supported only on Linux");
  }
  const identity = identityResolver("buddy", environment);
  if (
    !Number.isInteger(identity?.uid)
    || !Number.isInteger(identity?.gid)
    || !Array.isArray(identity?.groups)
    || identity.groups.some((group) => !Number.isInteger(group) || group <= 0)
    || identity.uid <= 0
    || identity.gid <= 0
  ) {
    throw new Error("Hermes Git verification cannot resolve an unprivileged buddy identity");
  }
  const runuserExecutable = systemExecutableResolver("runuser", platform);
  if (!runuserExecutable) throw new Error("trusted runuser executable is unavailable");
  return {
    command: runuserExecutable,
    argsPrefix: ["-u", "buddy", "--", gitExecutable],
    options,
  };
}

function resolveLinuxIdentity(username, environment = process.env) {
  const idExecutable = trustedSystemExecutable("id", "linux");
  if (!idExecutable) throw new Error("trusted id executable is unavailable");
  const run = (flag) => {
    const result = spawnSync(idExecutable, [flag, username], {
      encoding: "utf8",
      env: residentSystemEnvironment(environment),
      shell: false,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const value = String(result.stdout ?? "").trim();
    if (result.status !== 0 || !/^\d+(?:\s+\d+)*$/.test(value)) {
      throw new Error(`cannot resolve ${username} identity`);
    }
    return value.split(/\s+/u).map(Number);
  };
  return { uid: run("-u")[0], gid: run("-g")[0], groups: run("-G") };
}

function residentSystemEnvironment(base = process.env) {
  const environment = residentProcessEnvironment(base);
  environment.SYSTEMD_COLORS = "0";
  environment.SYSTEMD_PAGER = "cat";
  return environment;
}

function residentProcessEnvironment(base = process.env) {
  const environment = {};
  for (const key of ["TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (typeof base[key] === "string") environment[key] = base[key];
  }
  environment.LC_ALL = "C";
  environment.LANG = "C";
  return environment;
}

function assertLinux(platform) {
  if (platform !== "linux") {
    throw new Error("Buddy systemd service lifecycle is supported only on Linux");
  }
}

function assertSystemdSafeAbsolutePath(label, value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  if (/[\s%\r\n]/.test(value)) {
    throw new Error(`${label} cannot contain whitespace or systemd specifier characters`);
  }
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
