import { existsSync } from "fs";
import { win32 } from "path";

export const GIT_LOCAL_TIMEOUT_MS = 10_000;
export const GIT_FETCH_TIMEOUT_MS = 20_000;
export const GIT_COMMAND_CONCURRENCY = 4;
export const GIT_FETCH_CONCURRENCY = 4;

let cachedGitExecutablePromise = null;
let cachedGitExecutableSync;
let hasCachedGitExecutableSync = false;

export async function resolveGitExecutable(options = {}) {
  const useCache = Object.keys(options).length === 0;
  if (useCache && cachedGitExecutablePromise) return cachedGitExecutablePromise;

  const resolution = resolveGitExecutableUncached(options);
  if (useCache) cachedGitExecutablePromise = resolution;
  return resolution;
}

async function resolveGitExecutableUncached({
  platform = process.platform,
  env = processEnv(),
  pathExists = existsSync,
  probe = probeGitExecutable,
} = {}) {
  for (const candidate of orderedGitExecutableCandidates({ platform, env, pathExists })) {
    if (await probe(candidate)) return candidate;
  }
  return null;
}

export function resolveGitExecutableSync(options = {}) {
  const useCache = Object.keys(options).length === 0;
  if (useCache && hasCachedGitExecutableSync) return cachedGitExecutableSync;

  const resolved = resolveGitExecutableSyncUncached(options);
  if (useCache) {
    cachedGitExecutableSync = resolved;
    hasCachedGitExecutableSync = true;
  }
  return resolved;
}

function resolveGitExecutableSyncUncached({
  platform = process.platform,
  env = processEnv(),
  pathExists = existsSync,
  probe = probeGitExecutableSync,
} = {}) {
  for (const candidate of orderedGitExecutableCandidates({ platform, env, pathExists })) {
    if (probe(candidate)) return candidate;
  }
  return null;
}

export async function runGit(args, { cwd, timeoutMs = GIT_LOCAL_TIMEOUT_MS, env = {} } = {}) {
  if (!cwd) throw new Error("runGit requires cwd");
  const executable = await resolveGitExecutable();
  if (!executable) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      error: "Git executable was not found.",
    };
  }
  return runCommand([executable, ...args], {
    cwd,
    timeoutMs,
    env,
  });
}

export function safeGitRemoteEnv(platform = process.platform) {
  const common = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    NO_PROXY: "*",
    no_proxy: "*",
    SSH_ASKPASS_REQUIRE: "never",
    // Launchpad spouští Git nad explicitním cwd. Kontext zděděný například
    // z hooku nesmí přesměrovat child proces do jiného repozitáře.
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_DIR: undefined,
    GIT_EXEC_PATH: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_PREFIX: undefined,
    GIT_PROXY_COMMAND: undefined,
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_SSH_VARIANT: undefined,
    GIT_WORK_TREE: undefined,
  };
  if (platform === "win32") {
    return {
      ...common,
      // Undefined values explicitly remove inherited POSIX-only helpers in
      // commandEnvironment() before Bun receives the environment.
      GIT_ASKPASS: undefined,
      SSH_ASKPASS: undefined,
    };
  }
  return {
    ...common,
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
}

export function safeGitCommandEnv(platform = process.platform, base = processEnv()) {
  return commandEnvironment(base, safeGitRemoteEnv(platform));
}

// Checkout-local .git/config is input, not executable policy. These command
// line overrides protect every local Git operation before it reads a hook or
// file-monitor path selected by that checkout.
export function safeGitRuntimeArgs(args, platform = process.platform) {
  const hooksPath = platform === "win32" ? "NUL" : "/dev/null";
  return [
    "-c", `core.hooksPath=${hooksPath}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.useBuiltinFSMonitor=false",
    ...args,
  ];
}

// Remote commands add transport guards. core.gitProxy is multi-valued and a
// command-line empty value cannot override a checkout-local generic proxy;
// deny git:// before Git reaches that proxy instead.
export function safeGitRemoteArgs(args, platform = process.platform) {
  return [
    "-c", "core.sshCommand=",
    "-c", "core.askPass=",
    "-c", "credential.helper=",
    "-c", "credential.interactive=false",
    "-c", "http.proxy=",
    "-c", "protocol.git.allow=never",
    "-c", "protocol.ext.allow=never",
    ...safeGitRuntimeArgs(args, platform),
  ];
}

// Manifest materialization consumes configuration-controlled remote data and
// must not read any user, global or system Git configuration.
export function safeGitMaterializationEnv(platform = process.platform, base = processEnv()) {
  const overrides = {
    ...safeGitRemoteEnv(platform),
    GIT_CONFIG_GLOBAL: "",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const environment = commandEnvironment(base, overrides);
  // runCommand() merges this environment with the live process environment.
  // Preserve explicit removals so a second merge cannot resurrect GIT_SSH*,
  // stale repository context or askpass helpers from the parent process.
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) environment[key] = undefined;
  }
  return environment;
}

export function gitExecutableCandidates({ platform = process.platform, env = processEnv() } = {}) {
  if (platform !== "win32") {
    return ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git", "/bin/git"];
  }
  const roots = [
    env.ProgramW6432,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(
      win32.join(root, "Git", "cmd", "git.exe"),
      win32.join(root, "Git", "bin", "git.exe"),
    );
  }
  if (env.LOCALAPPDATA) {
    candidates.push(win32.join(env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"));
  }
  return [...new Set(candidates.filter(isDriveQualifiedWindowsPath))];
}

function isDriveQualifiedWindowsPath(candidate) {
  return /^[A-Za-z]:\\/.test(candidate);
}

export function resetGitExecutableCacheForTests() {
  cachedGitExecutablePromise = null;
  cachedGitExecutableSync = undefined;
  hasCachedGitExecutableSync = false;
}

export async function mapWithConcurrency(items, limit, fn) {
  const output = new Array(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

async function runCommand(command, { cwd, timeoutMs, env = {} } = {}) {
  let child;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (!child) return;
    if (globalThis.process.platform === "win32" && Number.isInteger(child.pid)) {
      try {
        const killed = Bun.spawnSync(gitTimeoutKillCommand(child.pid), {
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
          timeout: 5_000,
        });
        if (killed.exitCode === 0) return;
      } catch {}
    }
    try {
      child.kill("SIGKILL");
    } catch {}
  }, timeoutMs);
  try {
    child = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: commandEnvironment(processEnv(), env),
      windowsHide: true,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      streamText(child.stdout),
      streamText(child.stderr),
      child.exited,
    ]);
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      timedOut,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      timedOut,
      stdout: "",
      stderr: "",
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function gitTimeoutKillCommand(pid, env = processEnv()) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid Windows process id: ${pid}`);
  const executable = env.SystemRoot
    ? win32.join(env.SystemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
  return [executable, "/PID", String(pid), "/T", "/F"];
}

function processEnv() {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

function commandEnvironment(base, overrides) {
  const merged = {};
  for (const [key, value] of Object.entries(base)) {
    if (!unsafeAmbientGitEnvironmentKey(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    const normalizedKey = key.toUpperCase();
    for (const existingKey of Object.keys(merged)) {
      if (existingKey.toUpperCase() === normalizedKey) delete merged[existingKey];
    }
    if (unsafeAmbientGitEnvironmentKey(key)) {
      if (safeAmbientGitOverride(normalizedKey, value)) merged[normalizedKey] = value;
      continue;
    }
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

function safeAmbientGitOverride(key, value) {
  if (["GIT_ASKPASS", "SSH_ASKPASS"].includes(key)) return value === "/bin/false";
  if (key === "GIT_CONFIG_NOSYSTEM") return value === "1";
  if (key === "GIT_CONFIG_GLOBAL") return value === "";
  return false;
}

function unsafeAmbientGitEnvironmentKey(key) {
  const normalizedKey = key.toUpperCase();
  return (
    [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_ALLOW_PROTOCOL",
      "GIT_ASKPASS",
      "GIT_CEILING_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_CONFIG",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_SYSTEM",
      "GIT_DIR",
      "GIT_GRAFT_FILE",
      "GIT_IMPLICIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_INTERNAL_SUPER_PREFIX",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OBJECT_DIRECTORY",
      "GIT_PREFIX",
      "GIT_PROTOCOL_FROM_USER",
      "GIT_REPLACE_REF_BASE",
      "GIT_SHALLOW_FILE",
      "GIT_WORK_TREE",
      "SSH_ASKPASS",
    ].includes(normalizedKey) ||
    normalizedKey === "GIT_CONFIG_COUNT" ||
    normalizedKey.startsWith("GIT_CONFIG_KEY_") ||
    normalizedKey.startsWith("GIT_CONFIG_VALUE_")
  );
}

function orderedGitExecutableCandidates({ platform, env, pathExists }) {
  return [...new Set(gitExecutableCandidates({ platform, env })
    .filter((candidate) => pathExists(candidate)))];
}

async function probeGitExecutable(executable) {
  const result = await runCommand([executable, "--version"], {
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return result.ok;
}

function probeGitExecutableSync(executable) {
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
      env: safeGitCommandEnv(),
      windowsHide: true,
      timeout: GIT_LOCAL_TIMEOUT_MS,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function streamText(stream) {
  if (!stream) return "";
  return new Response(stream).text();
}
