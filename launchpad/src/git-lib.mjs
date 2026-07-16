export const GIT_LOCAL_TIMEOUT_MS = 8_000;
export const GIT_FETCH_TIMEOUT_MS = 20_000;
export const GIT_COMMAND_CONCURRENCY = 6;
export const GIT_FETCH_CONCURRENCY = 4;

export async function resolveGitExecutable() {
  const result = await runCommand(["git", "--version"], {
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return result.ok ? "git" : null;
}

export async function runGit(args, { cwd, timeoutMs = GIT_LOCAL_TIMEOUT_MS, env = {} } = {}) {
  if (!cwd) throw new Error("runGit requires cwd");
  return runCommand(["git", ...args], {
    cwd,
    timeoutMs,
    env,
  });
}

export function safeGitRemoteEnv() {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
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
  let process;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    process?.kill();
  }, timeoutMs);
  try {
    process = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...processEnv(),
        ...env,
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      streamText(process.stdout),
      streamText(process.stderr),
      process.exited,
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

function processEnv() {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

async function streamText(stream) {
  if (!stream) return "";
  return new Response(stream).text();
}
