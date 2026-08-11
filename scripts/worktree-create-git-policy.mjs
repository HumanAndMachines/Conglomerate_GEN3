import { safeGitCommandEnv } from "../lazurio/core/git-lib.mjs";

export const CHECKOUT_TRANSPORT_OVERRIDE_PATTERN = "^(url\\..*\\.insteadof|http(\\..*)?\\.proxy|credential(\\..*)?\\.helper|remote\\.origin\\.proxy|core\\.(gitproxy|sshcommand))$";

function nullDevice(platform) {
  return platform === "win32" ? "NUL" : "/dev/null";
}

function windowsSystemRoot(base) {
  const candidate = String(base.SystemRoot ?? base.SYSTEMROOT ?? "C:\\Windows").replaceAll("\\", "/");
  if (!/^[A-Za-z]:\/(?:[^/]+\/?)*$/.test(candidate) || candidate.split("/").some((segment) => segment === "." || segment === "..")) {
    return "C:/Windows";
  }
  return candidate.replace(/\/+$/, "");
}

function trustedSshExecutable(platform, base) {
  return platform === "win32"
    ? `${windowsSystemRoot(base)}/System32/OpenSSH/ssh.exe`
    : "/usr/bin/ssh";
}

export function safeWorktreeGitEnvironment(platform = process.platform, base = process.env) {
  // Odstraň checkout-context a command-injection Git proměnné, ale zachovej
  // běžné per-user credential helpers, SSH agent/config a enterprise proxy.
  // Nebezpečné checkout-local transport keys se kontrolují explicitně zvlášť.
  return safeGitCommandEnv(platform, base);
}

export function safeWorktreeGitConfig(platform = process.platform, base = process.env) {
  return [
    "-c", `core.hooksPath=${nullDevice(platform)}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.sshCommand=${trustedSshExecutable(platform, base)}`,
    "-c", "core.gitProxy=",
    "-c", "protocol.ext.allow=never",
  ];
}

export const SAFE_WORKTREE_GIT_CONFIG = safeWorktreeGitConfig();
