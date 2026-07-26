import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { win32 } from "node:path";
import {
  gitTimeoutKillCommand,
  resolveGitExecutable,
  safeGitMaterializationEnv,
} from "./git-lib.mjs";

const POSIX_HELPER_PATH = fileURLToPath(
  new URL("./git-materialization-posix.pl", import.meta.url),
);
const WINDOWS_HELPER_PATH = fileURLToPath(
  new URL("./git-materialization-windows.ps1", import.meta.url),
);

export async function runAnchoredMaterialization({
  organizationRoot,
  organizationIdentity,
  slotSegments,
  remote,
  branch,
  timeoutMs = 120_000,
  testHook = null,
  platform = process.platform,
  environment = process.env,
  pathExists = existsSync,
  spawn = Bun.spawn,
} = {}) {
  const gitExecutable = await resolveGitExecutable();
  if (!gitExecutable) {
    return unavailable("Git executable není dostupný; target nebyl vytvořen.");
  }

  const helper = resolveHelper({
    platform,
    environment,
    pathExists,
  });
  if (!helper) {
    return unavailable(
      "Platforma nemá schválený no-follow directory-handle helper; materializace skončila před vytvořením targetu.",
    );
  }

  const config = {
    organizationRoot,
    organizationIdentity,
    slotSegments,
    remote,
    branch,
    gitExecutable,
    testHook,
  };
  let child;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!child) return;
    terminateProcessTree({ child, platform, environment });
  }, timeoutMs);

  try {
    child = spawn(helper.command, {
      cwd: organizationRoot,
      stdin: new Blob([JSON.stringify(config)]),
      stdout: "pipe",
      stderr: "pipe",
      env: safeGitMaterializationEnv(platform, environment),
      windowsHide: true,
      detached: platform !== "win32",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) {
      return {
        ok: false,
        outcome: "failed",
        code: "materialization_anchor_timeout",
        message: "Ukotvený checkout překročil časový limit; target zůstal beze smazání pro ruční kontrolu.",
      };
    }
    const result = parseHelperResult(stdout);
    if (!result || (result.ok && exitCode !== 0)) {
      return {
        ok: false,
        outcome: "failed",
        code: "materialization_anchor_failed",
        message: "Ukotvený platformní helper nevrátil ověřitelný výsledek; target zůstal beze smazání.",
        helperExitCode: exitCode,
        helperError: boundedError(stderr),
      };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      outcome: "failed",
      code: "materialization_anchor_failed",
      message: "Ukotvený platformní helper se nepodařilo spustit; target nebyl vědomě uklízen.",
      helperError: boundedError(error?.message),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveHelper({
  platform = process.platform,
  environment = process.env,
  pathExists = existsSync,
} = {}) {
  if (platform === "win32") {
    const systemRoot = environment.SystemRoot || environment.SYSTEMROOT;
    if (!systemRoot || !pathExists(WINDOWS_HELPER_PATH)) return null;
    const powershell = win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (!pathExists(powershell)) return null;
    return {
      command: [
        powershell,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        WINDOWS_HELPER_PATH,
      ],
    };
  }
  if (platform === "darwin" || platform === "linux") {
    const perl = ["/usr/bin/perl", "/bin/perl"].find((candidate) => pathExists(candidate));
    if (!perl || !pathExists(POSIX_HELPER_PATH)) return null;
    return { command: [perl, POSIX_HELPER_PATH] };
  }
  return null;
}

function parseHelperResult(stdout) {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed !== "object"
      || parsed === null
      || typeof parsed.ok !== "boolean"
      || typeof parsed.outcome !== "string"
      || typeof parsed.code === "undefined"
      || typeof parsed.message !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function terminateProcessTree({ child, platform, environment }) {
  if (platform === "win32" && Number.isInteger(child.pid)) {
    try {
      Bun.spawnSync(gitTimeoutKillCommand(child.pid, environment), {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
      return;
    } catch {}
  }
  if (platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {}
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

function unavailable(message) {
  return {
    ok: false,
    outcome: "failed",
    code: "materialization_anchor_unavailable",
    message,
  };
}

function boundedError(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : null;
}
