import { safeGitCommandEnv } from "../launchpad/src/git-lib.mjs";

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

function trustedSshCommand(platform, base) {
  if (platform === "win32") {
    return `${windowsSystemRoot(base)}/System32/OpenSSH/ssh.exe -F NUL -o ProxyCommand=none`;
  }
  return "/usr/bin/ssh -F /dev/null -o ProxyCommand=none";
}

function emptyHome(platform) {
  return platform === "win32" ? "C:/__hermes-empty-home__" : "/nonexistent";
}

export function safeWorktreeGitEnvironment(platform = process.platform, base = process.env) {
  const isolatedHome = emptyHome(platform);
  return {
    ...safeGitCommandEnv(platform, base),
    // Globální Git/XDG config i ~/.ssh config nesmí měnit runtime transport.
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    HOMEDRIVE: platform === "win32" ? "C:" : "",
    HOMEPATH: platform === "win32" ? "/__hermes-empty-home__" : "",
    XDG_CONFIG_HOME: isolatedHome,
    XDG_CONFIG_DIRS: isolatedHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice(platform),
    NO_PROXY: "*",
    no_proxy: "*",
  };
}

export function safeWorktreeGitConfig(platform = process.platform, base = process.env) {
  return [
    "-c", `core.hooksPath=${nullDevice(platform)}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.sshCommand=${trustedSshCommand(platform, base)}`,
    "-c", "core.gitProxy=",
    "-c", "credential.helper=",
    "-c", "http.proxy=",
    "-c", "protocol.ext.allow=never",
  ];
}

export const SAFE_WORKTREE_GIT_CONFIG = safeWorktreeGitConfig();
