import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

import {
  computeServerInstallGeneration,
  computeServerRootId,
} from "./core/server-identity-lib.mjs";

export const LAZURIO_CLI_IDENTITY_SCHEMA = "lazurio.cli.identity.v1";
export const LAZURIO_CLI_INSTALLATION_SCHEMA = "lazurio.cli.installation.v1";
export const LAZURIO_CLI_PRODUCT = "lazurio-cli";

const packageName = "lazurio";
const cliRelativePath = "lazurio/cli.mjs";
const sha256Pattern = /^[a-f0-9]{64}$/;

export class LazurioCliInstallError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LazurioCliInstallError";
    this.code = code;
    this.details = details;
    this.lazurioExitCode = 1;
  }
}

export function buildLazurioCliIdentity({ root }) {
  const canonicalRoot = canonicalizeInstallRoot(root);
  return Object.freeze({
    schema_version: LAZURIO_CLI_IDENTITY_SCHEMA,
    product: LAZURIO_CLI_PRODUCT,
    root_id: computeServerRootId(canonicalRoot),
    install_generation: computeServerInstallGeneration(canonicalRoot),
  });
}

export function isValidLazurioCliIdentity(identity) {
  return Boolean(
    identity
    && typeof identity === "object"
    && !Array.isArray(identity)
    && identity.schema_version === LAZURIO_CLI_IDENTITY_SCHEMA
    && identity.product === LAZURIO_CLI_PRODUCT
    && sha256Pattern.test(identity.root_id ?? "")
    && sha256Pattern.test(identity.install_generation ?? ""),
  );
}

export function resolveBunGlobalLayout({
  environment = process.env,
  homeDirectory = homedir(),
} = {}) {
  const installRoot = configuredAbsolutePath(
    environment.BUN_INSTALL,
    join(homeDirectory, ".bun"),
    "BUN_INSTALL",
  );
  const globalDirectory = configuredAbsolutePath(
    environment.BUN_INSTALL_GLOBAL_DIR,
    join(installRoot, "install", "global"),
    "BUN_INSTALL_GLOBAL_DIR",
  );
  const globalBin = configuredAbsolutePath(
    environment.BUN_INSTALL_BIN,
    join(installRoot, "bin"),
    "BUN_INSTALL_BIN",
  );
  return Object.freeze({
    install_root: installRoot,
    global_directory: globalDirectory,
    global_bin: globalBin,
    registration_path: join(globalDirectory, "node_modules", packageName),
  });
}

export function inspectLazurioCliInstallation({
  root,
  environment = process.env,
  platform = process.platform,
  bunExecutable = process.execPath,
  homeDirectory = homedir(),
  runProcess = runProcessSync,
  resolveCommand = findPathCommand,
  probeIdentity = true,
} = {}) {
  const canonicalRoot = assertInstallableLazurioRoot(root);
  const expectedIdentity = buildLazurioCliIdentity({ root: canonicalRoot });
  const layout = resolveBunGlobalLayout({ environment, homeDirectory });
  const bunEnvironment = bunGlobalEnvironment(environment, layout);
  const registration = inspectRegistration(layout.registration_path, canonicalRoot, platform);
  const layoutReadback = inspectBunGlobalBin({
    bunExecutable,
    canonicalRoot,
    environment: bunEnvironment,
    expectedGlobalBin: layout.global_bin,
    globalDirectory: layout.global_directory,
    runProcess,
    platform,
  });
  const globalBinOnPath = pathContainsDirectory(
    environmentPathValue(environment, platform),
    layout.global_bin,
    platform,
  );
  const commandPath = resolveCommand(packageName, {
    environment,
    platform,
    cwd: canonicalRoot,
  });
  const commandInGlobalBin = commandPath
    ? samePath(dirname(commandPath), layout.global_bin, platform)
    : false;
  const expectedEntrypoint = join(canonicalRoot, ...cliRelativePath.split("/"));
  let commandTargetMatches = null;
  if (commandPath && commandInGlobalBin && platform !== "win32") {
    commandTargetMatches = safeSameRealPath(commandPath, expectedEntrypoint, platform);
  }

  let state = "not_installed";
  let reason = "registration_missing";
  if (layoutReadback === "unresolvable") {
    state = "unrecognized";
    reason = "bun_layout_unresolvable";
  } else if (registration.state === "foreign") {
    state = "foreign";
    reason = "registration_foreign_root";
  } else if (registration.state === "unsafe") {
    state = "unrecognized";
    reason = "registration_unrecognized";
  } else if (commandPath && !commandInGlobalBin) {
    state = "foreign";
    reason = "path_shadowed_foreign";
  } else if (registration.state === "absent" && commandPath) {
    state = "unrecognized";
    reason = "bin_orphaned";
  } else if (registration.state === "owned" && !globalBinOnPath) {
    state = "not_on_path";
    reason = "global_bin_not_on_path";
  } else if (registration.state === "owned" && !commandPath) {
    state = "unrecognized";
    reason = "bin_missing";
  } else if (registration.state === "owned" && commandTargetMatches === false) {
    state = "unrecognized";
    reason = "bin_target_mismatch";
  } else if (registration.state === "owned" && commandPath && commandInGlobalBin) {
    state = "installed";
    reason = "identity_not_checked";
  }

  let observedIdentity = null;
  let identityError = null;
  if (state === "installed" && probeIdentity) {
    const probe = runProcess(commandPath, ["cli", "identity", "--json"], {
      cwd: homeDirectory,
      environment: bunEnvironment,
    });
    if (probe.status === 0) {
      try {
        const parsed = JSON.parse(probe.stdout);
        if (isValidLazurioCliIdentity(parsed)) observedIdentity = parsed;
        else identityError = "identity_invalid";
      } catch {
        identityError = "identity_invalid_json";
      }
    } else {
      identityError = "identity_command_failed";
    }
    if (
      observedIdentity
      && observedIdentity.root_id === expectedIdentity.root_id
      && observedIdentity.install_generation === expectedIdentity.install_generation
    ) {
      state = "current";
      reason = "owned_identity_matches";
    } else {
      state = "unrecognized";
      reason = identityError ?? "identity_mismatch";
    }
  }

  return Object.freeze({
    schema_version: LAZURIO_CLI_INSTALLATION_SCHEMA,
    action: "status",
    state,
    reason,
    expected: expectedIdentity,
    observed: observedIdentity,
    command: Object.freeze({
      path: commandPath,
      in_bun_global_bin: commandInGlobalBin,
      target_matches: commandTargetMatches,
    }),
    bun: Object.freeze({
      executable: bunExecutable,
      global_bin: layout.global_bin,
      global_bin_on_path: globalBinOnPath,
      layout: layoutReadback,
    }),
    registration: Object.freeze({
      state: registration.state,
      path: layout.registration_path,
    }),
  });
}

export function installLazurioCli(options = {}) {
  const before = inspectLazurioCliInstallation(options);
  assertInstallMayProceed(before);
  if (before.state === "current") return installationAction(before, "install", false);
  if (!before.bun.global_bin_on_path) {
    throw new LazurioCliInstallError(
      "global_bin_not_on_path",
      `Bun global bin není v PATH: ${before.bun.global_bin}. Dokonči standardní Bun instalaci a spusť příkaz znovu.`,
    );
  }

  const canonicalRoot = assertInstallableLazurioRoot(options.root);
  const layout = resolveBunGlobalLayout({
    environment: options.environment,
    homeDirectory: options.homeDirectory,
  });
  const environment = bunGlobalEnvironment(options.environment ?? process.env, layout);
  const runProcess = options.runProcess ?? runProcessSync;
  const link = runProcess(
    options.bunExecutable ?? process.execPath,
    ["link", "--cwd", canonicalRoot],
    { cwd: canonicalRoot, environment },
  );
  if (link.status !== 0) {
    throw new LazurioCliInstallError(
      "bun_link_failed",
      `Bun nedokázal Lazurio CLI zaregistrovat: ${processFailure(link)}`,
    );
  }

  const after = inspectLazurioCliInstallation({ ...options, environment });
  if (after.state !== "current") {
    if (before.registration.state === "absent" && after.registration.state === "owned") {
      const rollback = runProcess(
        options.bunExecutable ?? process.execPath,
        ["unlink", "--cwd", canonicalRoot],
        { cwd: canonicalRoot, environment },
      );
      if (rollback.status !== 0) {
        throw new LazurioCliInstallError(
          "install_verification_failed_rollback_failed",
          `Bun link nelze ověřit (${after.reason}) a rollback selhal: ${processFailure(rollback)}`,
        );
      }
    }
    throw new LazurioCliInstallError(
      "install_verification_failed",
      `Bun link proběhl, ale direct Lazurio CLI nelze ověřit (${after.reason}).`,
    );
  }
  return installationAction(after, "install", true);
}

export function uninstallLazurioCli(options = {}) {
  const before = inspectLazurioCliInstallation(options);
  if (before.registration.state === "foreign") {
    throw new LazurioCliInstallError(
      "registration_foreign_root",
      "Bun registrace jména lazurio patří jinému rootu; cizí instalaci neodstraňuji.",
    );
  }
  if (before.registration.state === "unsafe") {
    throw new LazurioCliInstallError(
      "registration_unrecognized",
      "Bun registrace jména lazurio nemá bezpečně rozpoznatelný typ; nic neodstraňuji.",
    );
  }
  if (before.registration.state === "absent") {
    return installationAction(before, "uninstall", false);
  }

  const canonicalRoot = assertInstallableLazurioRoot(options.root);
  const layout = resolveBunGlobalLayout({
    environment: options.environment,
    homeDirectory: options.homeDirectory,
  });
  const environment = bunGlobalEnvironment(options.environment ?? process.env, layout);
  const runProcess = options.runProcess ?? runProcessSync;
  const unlink = runProcess(
    options.bunExecutable ?? process.execPath,
    ["unlink", "--cwd", canonicalRoot],
    { cwd: canonicalRoot, environment },
  );
  if (unlink.status !== 0) {
    throw new LazurioCliInstallError(
      "bun_unlink_failed",
      `Bun nedokázal Lazurio CLI odregistrovat: ${processFailure(unlink)}`,
    );
  }
  const after = inspectLazurioCliInstallation({
    ...options,
    environment,
    probeIdentity: false,
  });
  if (after.registration.state === "owned" || after.reason === "bin_orphaned") {
    throw new LazurioCliInstallError(
      "uninstall_verification_failed",
      "Bun unlink skončil bez chyby, ale owned registrace stále existuje.",
    );
  }
  return installationAction(after, "uninstall", true);
}

export function renderHumanCliIdentity(identity) {
  return [
    "Lazurio CLI identity",
    `Root ID: ${identity.root_id}`,
    `Install generation: ${identity.install_generation}`,
  ].join("\n");
}

export function renderHumanCliInstallation(report) {
  const heading = report.action === "status"
    ? "Lazurio CLI"
    : report.action === "install"
      ? "Lazurio CLI instalace"
      : "Lazurio CLI odinstalace";
  const state = {
    current: "připravené",
    installed: "nainstalované, identity neověřena",
    not_installed: "není nainstalované",
    not_on_path: "registrace existuje, ale Bun bin není v PATH",
    foreign: "jméno lazurio patří jiné instalaci",
    unrecognized: "instalaci nelze bezpečně rozpoznat",
  }[report.state] ?? report.state;
  const lines = [
    `${heading}: ${state}`,
    `Bun bin: ${report.bun.global_bin}${report.bun.global_bin_on_path ? "" : " (není v PATH)"}`,
  ];
  if (report.command.path) lines.push(`Příkaz: ${report.command.path}`);
  if (report.changed === false && report.action !== "status") lines.push("Beze změny.");
  return lines.join("\n");
}

export function assertInstallableLazurioRoot(root) {
  const canonicalRoot = canonicalizeInstallRoot(root);
  assertPhysicalFile(join(canonicalRoot, "package.json"), "Lazurio package manifest");
  assertPhysicalFile(join(canonicalRoot, ...cliRelativePath.split("/")), "Lazurio CLI entrypoint");
  assertPhysicalFile(join(canonicalRoot, "launchpad.gen3.json"), "Lazurio source root marker");
  if (existsSync(join(canonicalRoot, "lazurio.resident.json"))) {
    throw new LazurioCliInstallError(
      "resident_activation_required",
      "Immutable Resident CLI se aktivuje updater transakcí, ne source PATH instalací.",
    );
  }
  const packageManifest = JSON.parse(readFileSync(join(canonicalRoot, "package.json"), "utf8"));
  if (
    packageManifest.name !== packageName
    || packageManifest.bin?.[packageName] !== cliRelativePath
    || Object.keys(packageManifest.bin ?? {}).length !== 1
  ) {
    throw new LazurioCliInstallError(
      "invalid_package_contract",
      "Lazurio root musí deklarovat package name lazurio a jediný bin lazurio/cli.mjs.",
    );
  }
  assertNotLinkedWorktree(canonicalRoot);
  return canonicalRoot;
}

function canonicalizeInstallRoot(root) {
  if (typeof root !== "string" || root === "" || root.includes("\n") || root.includes("\r")) {
    throw new LazurioCliInstallError("invalid_root", "Lazurio root musí být platná cesta bez nového řádku.");
  }
  try {
    return realpathSync(resolve(root));
  } catch {
    throw new LazurioCliInstallError("invalid_root", `Lazurio root neexistuje: ${resolve(root)}`);
  }
}

function assertNotLinkedWorktree(root) {
  const marker = join(root, ".git");
  if (!existsSync(marker)) return;
  const markerStat = lstatSync(marker);
  if (markerStat.isSymbolicLink()) {
    throw new LazurioCliInstallError("unsafe_git_marker", "Git metadata rootu nesmí být symlink.");
  }
  if (markerStat.isDirectory()) return;
  if (!markerStat.isFile()) {
    throw new LazurioCliInstallError("unsafe_git_marker", "Git metadata rootu mají nepodporovaný typ.");
  }
  const line = readFileSync(marker, "utf8").split(/\r?\n/u, 1)[0];
  if (!line.startsWith("gitdir: ")) {
    throw new LazurioCliInstallError("unsafe_git_marker", "Git metadata marker rootu je neplatný.");
  }
  const rawGitDirectory = line.slice("gitdir: ".length);
  const gitDirectory = isAbsolute(rawGitDirectory)
    ? rawGitDirectory
    : resolve(root, rawGitDirectory);
  if (!existsSync(gitDirectory) || !lstatSync(gitDirectory).isDirectory()) {
    throw new LazurioCliInstallError("unsafe_git_marker", "Git metadata adresář rootu není dostupný.");
  }
  if (existsSync(join(gitDirectory, "commondir"))) {
    throw new LazurioCliInstallError(
      "linked_worktree_forbidden",
      "Instalace CLI z linked worktree je zakázaná; použij primární Lazurio checkout.",
    );
  }
}

function assertPhysicalFile(path, label) {
  if (!existsSync(path)) {
    throw new LazurioCliInstallError("incomplete_root", `${label} chybí: ${path}`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new LazurioCliInstallError("unsafe_root_file", `${label} musí být fyzický soubor: ${path}`);
  }
}

function configuredAbsolutePath(value, fallback, name) {
  const candidate = typeof value === "string" && value !== "" ? value : fallback;
  if (!isAbsolute(candidate) || candidate.includes("\n") || candidate.includes("\r")) {
    throw new LazurioCliInstallError(
      "bun_layout_unresolvable",
      `${name} musí být absolutní cesta bez nového řádku.`,
    );
  }
  return resolve(candidate);
}

function bunGlobalEnvironment(environment, layout) {
  return {
    ...environment,
    BUN_INSTALL: layout.install_root,
    BUN_INSTALL_GLOBAL_DIR: layout.global_directory,
    BUN_INSTALL_BIN: layout.global_bin,
  };
}

function inspectRegistration(path, canonicalRoot, platform) {
  if (!existsSync(path)) return { state: "absent" };
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { state: "unsafe" };
  }
  if (!stat.isSymbolicLink()) return { state: "unsafe" };
  try {
    return safeSameRealPath(path, canonicalRoot, platform)
      ? { state: "owned" }
      : { state: "foreign" };
  } catch {
    return { state: "unsafe" };
  }
}

function inspectBunGlobalBin({
  bunExecutable,
  canonicalRoot,
  environment,
  expectedGlobalBin,
  globalDirectory,
  runProcess,
  platform,
}) {
  const readback = runProcess(bunExecutable, ["pm", "bin", "-g"], {
    cwd: canonicalRoot,
    environment,
  });
  if (readback.status === 0) {
    const lines = readback.stdout.trim().split(/\r?\n/u).filter(Boolean);
    if (lines.length !== 1 || !isAbsolute(lines[0])) return "unresolvable";
    return samePath(lines[0], expectedGlobalBin, platform) ? "verified" : "unresolvable";
  }
  return existsSync(join(globalDirectory, "package.json")) ? "unresolvable" : "uninitialized";
}

function assertInstallMayProceed(report) {
  if (report.registration.state === "foreign") {
    throw new LazurioCliInstallError(
      "registration_foreign_root",
      "Bun registrace jména lazurio patří jinému rootu; cizí instalaci nepřepisuji.",
    );
  }
  if (report.registration.state === "unsafe") {
    throw new LazurioCliInstallError(
      "registration_unrecognized",
      "Bun registrace jména lazurio nemá bezpečně rozpoznatelný typ; nic nepřepisuji.",
    );
  }
  if (report.reason === "bun_layout_unresolvable") {
    throw new LazurioCliInstallError(
      "bun_layout_unresolvable",
      "Exact running Bun nepotvrdil očekávaný global bin; nic nepřepisuji.",
    );
  }
  if (report.reason === "path_shadowed_foreign") {
    throw new LazurioCliInstallError(
      "path_shadowed_foreign",
      `PATH už obsahuje jiný příkaz lazurio: ${report.command.path}. Nic nepřepisuji.`,
    );
  }
  if (report.reason === "bin_orphaned" || report.reason === "bin_target_mismatch") {
    throw new LazurioCliInstallError(
      report.reason,
      "Bun bin lazurio není bezpečně svázaný s jeho registrací; nic nepřepisuji.",
    );
  }
}

function installationAction(report, action, changed) {
  return Object.freeze({ ...report, action, changed });
}

function processFailure(result) {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.status ?? "unknown"}`;
}

function runProcessSync(command, args, { cwd, environment }) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}

function findPathCommand(command, { environment, platform, cwd }) {
  const pathValue = environmentPathValue(environment, platform);
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
      .map((extension) => extension.toLowerCase())
    : [""];
  for (const rawDirectory of pathValue.split(pathDelimiter)) {
    const unquoted = rawDirectory.replace(/^"|"$/gu, "");
    if (!unquoted) continue;
    const directory = isAbsolute(unquoted) ? unquoted : resolve(cwd, unquoted);
    const candidates = platform === "win32"
      ? extensions.map((extension) => join(directory, `${command}${extension}`))
      : [join(directory, command)];
    for (const candidate of candidates) {
      try {
        const stat = lstatSync(candidate);
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return resolve(candidate);
      } catch {
        // Continue through PATH just like a shell resolver.
      }
    }
  }
  return null;
}

function environmentPathValue(environment, platform) {
  if (platform !== "win32") return environment.PATH ?? "";
  const entry = Object.entries(environment).find(([name]) => name.toLowerCase() === "path");
  return entry?.[1] ?? "";
}

function pathContainsDirectory(pathValue = "", expectedDirectory, platform) {
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  return pathValue.split(pathDelimiter).some((rawDirectory) => {
    const unquoted = rawDirectory.replace(/^"|"$/gu, "");
    if (!unquoted || !isAbsolute(unquoted)) return false;
    return samePath(unquoted, expectedDirectory, platform);
  });
}

function safeSameRealPath(left, right, platform) {
  return samePath(realpathSync(left), realpathSync(right), platform);
}

function samePath(left, right, platform) {
  const normalizedLeft = normalizeComparablePath(left, platform);
  const normalizedRight = normalizeComparablePath(right, platform);
  return normalizedLeft === normalizedRight;
}

function normalizeComparablePath(path, platform) {
  const normalized = resolve(path).replace(/[\\/]+$/u, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
