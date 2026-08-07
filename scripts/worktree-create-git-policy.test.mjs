import { expect, test } from "bun:test";
import {
  CHECKOUT_TRANSPORT_OVERRIDE_PATTERN,
  safeWorktreeGitConfig,
  safeWorktreeGitEnvironment,
} from "./worktree-create-git-policy.mjs";

test.each([
  ["url.file:///tmp/remote.insteadof", true],
  ["http.proxy", true],
  ["http.https://github.com.proxy", true],
  ["credential.helper", true],
  ["credential.https://github.com.helper", true],
  ["remote.origin.proxy", true],
  ["core.gitproxy", true],
  ["core.sshcommand", true],
  ["user.email", false],
  ["remote.origin.url", false],
])("checkout-local transport key %s blocked=%s", (key, blocked) => {
  expect(new RegExp(CHECKOUT_TRANSPORT_OVERRIDE_PATTERN).test(key)).toBe(blocked);
});

test.each([
  ["darwin", "/dev/null"],
  ["linux", "/dev/null"],
  ["win32", "NUL"],
])("Git safety config keeps executable/config protections on %s", (platform, nullDevice) => {
  const config = safeWorktreeGitConfig(platform);
  expect(config).toContain(`core.hooksPath=${nullDevice}`);
  expect(config).toContain("core.fsmonitor=false");
  expect(config).toContain("protocol.ext.allow=never");
  expect(config.some((value) => value.startsWith("core.sshCommand="))).toBe(true);
  expect(config).toContain("core.gitProxy=");
  expect(config.some((value) => value.startsWith("credential.helper="))).toBe(false);
  expect(config.some((value) => value.startsWith("http.proxy="))).toBe(false);
});

test("Windows trusted SSH executable follows only a valid SystemRoot", () => {
  expect(safeWorktreeGitConfig("win32", { SystemRoot: "D:\\Windows" })).toContain(
    "core.sshCommand=D:/Windows/System32/OpenSSH/ssh.exe",
  );
  expect(safeWorktreeGitConfig("win32", { SystemRoot: "D:\\Windows\\..\\attacker" })).toContain(
    "core.sshCommand=C:/Windows/System32/OpenSSH/ssh.exe",
  );
});

test("Git environment preserves credentials/proxy inputs but strips command injection context", () => {
  const environment = safeWorktreeGitEnvironment("linux", {
    HOME: "/home/builder",
    HTTPS_PROXY: "http://proxy.example:8080",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GIT_SSH_COMMAND: "/tmp/attacker",
    GIT_PROXY_COMMAND: "/tmp/proxy-attacker",
    GIT_DIR: "/tmp/foreign.git",
  });

  expect(environment.HOME).toBe("/home/builder");
  expect(environment.HTTPS_PROXY).toBe("http://proxy.example:8080");
  expect(environment.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
  expect(environment.GIT_SSH_COMMAND).toBeUndefined();
  expect(environment.GIT_PROXY_COMMAND).toBeUndefined();
  expect(environment.GIT_DIR).toBeUndefined();
  expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
});
