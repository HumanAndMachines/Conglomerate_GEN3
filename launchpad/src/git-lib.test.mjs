import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import {
  GIT_COMMAND_CONCURRENCY,
  GIT_LOCAL_TIMEOUT_MS,
  gitExecutableCandidates,
  gitTimeoutKillCommand,
  mapWithConcurrency,
  resolveGitExecutable,
  resolveGitExecutableSync,
  runGit,
  safeGitCommandEnv,
  safeGitMaterializationEnv,
  safeGitRemoteArgs,
  safeGitRemoteEnv,
  safeGitRuntimeArgs,
} from "./git-lib.mjs";
import { initGitRepo } from "./git-fixture-helpers.test.mjs";

test("mapWithConcurrency never runs more than the requested number of workers", async () => {
  let active = 0;
  let maxActive = 0;
  const output = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 10;
  });

  expect(output).toEqual([10, 20, 30, 40, 50]);
  expect(maxActive).toBeLessThanOrEqual(2);
});

test("runGit returns stdout and protects remote probes from interactive credential prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-runner-"));
  await initGitRepo(root);

  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    env: {
      Git_Dir: join(root, "missing-ambient.git"),
      git_work_tree: join(root, "missing-ambient-worktree"),
    },
  });

  expect(result.ok).toBe(true);
  expect(result.stdout).toBe("main");
  expect(safeGitRemoteEnv("linux")).toMatchObject({
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  });
  expect(safeGitMaterializationEnv("linux")).toMatchObject({
    GIT_CONFIG_GLOBAL: "",
    GIT_CONFIG_NOSYSTEM: "1",
  });
});

test.if(process.platform !== "win32")("runGit never executes a fake Git executable from ambient PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-path-marker-"));
  try {
    const fakeBin = join(root, "fake-bin");
    const marker = join(root, "fake-git-ran");
    const fakeGit = join(fakeBin, "git");
    mkdirSync(fakeBin);
    writeFileSync(fakeGit, `#!/bin/sh\nprintf fake-git > ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(fakeGit, 0o755);

    const moduleUrl = new URL("./git-lib.mjs", import.meta.url).href;
    const program = `import(${JSON.stringify(moduleUrl)}).then(async ({ runGit }) => {
      const result = await runGit(["--version"], { cwd: process.cwd() });
      process.exit(result.ok ? 0 : 1);
    })`;
    const result = spawnSync(process.execPath, ["--eval", program], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows remote Git environment never contains a POSIX askpass executable", () => {
  const env = safeGitRemoteEnv("win32");

  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(env.GCM_INTERACTIVE).toBe("never");
  expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
  expect(env.GIT_ASKPASS).toBeUndefined();
  expect(env.SSH_ASKPASS).toBeUndefined();
  expect(JSON.stringify(env)).not.toContain("/bin/false");
  expect(safeGitCommandEnv("win32", {
    GIT_ASKPASS: "/bin/false",
    Git_AskPass: "C:\\malicious\\askpass.exe",
    git_config_count: "1",
    Git_Config_Key_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: "malicious-command",
    Git_Config_Global: "C:\\malicious\\global-config",
    git_config_nosystem: "1",
    Git_Config_Parameters: "'core.hooksPath=C:\\malicious\\hooks'",
    GIT_CONFIG_SYSTEM: "C:\\malicious\\system-config",
    Git_Dir: "C:\\stale-context\\.git",
    git_exec_path: "C:\\malicious\\exec-path",
    GIT_PROXY_COMMAND: "C:\\malicious\\proxy.exe",
    Git_Ssh: "C:\\malicious\\ssh.exe",
    git_ssh_command: "C:\\malicious\\ssh-command.exe",
    GIT_SSH_VARIANT: "simple",
    git_implicit_work_tree: "1",
    git_internal_super_prefix: "C:\\stale-context\\super",
    Git_Shallow_File: "C:\\stale-context\\shallow",
    git_work_tree: "C:\\stale-context",
    SSH_ASKPASS: "/bin/false",
    ssh_askpass: "C:\\malicious\\ssh-askpass.exe",
    HOME: "C:\\Users\\builder",
    PATH: "C:\\Windows\\System32",
  })).toEqual({
    HOME: "C:\\Users\\builder",
    PATH: "C:\\Windows\\System32",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    no_proxy: "*",
    SSH_ASKPASS_REQUIRE: "never",
  });
  expect(safeGitMaterializationEnv("win32", { PATH: "C:\\Windows\\System32" })).toMatchObject({
    GIT_CONFIG_GLOBAL: "",
    GIT_CONFIG_NOSYSTEM: "1",
  });
});

test.if(process.platform !== "win32")("safe remote environment bypasses URL-specific checkout-local HTTP proxies", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-url-proxy-"));
  const marker = join(root, "proxy-contacted");
  const proxy = createServer((socket) => {
    writeFileSync(marker, "proxy contacted\n");
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise((resolveListen) => proxy.listen(0, "127.0.0.1", resolveListen));
  const port = proxy.address().port;

  try {
    await initGitRepo(root);
    const fixtureGit = await import("./git-fixture-helpers.test.mjs");
    fixtureGit.runGit(["config", "http.https://example.invalid.proxy", `http://127.0.0.1:${port}`], root);

    const result = await runGit(
      safeGitRemoteArgs(["ls-remote", "https://example.invalid/repo.git"]),
      { cwd: root, timeoutMs: 5_000, env: safeGitRemoteEnv() },
    );

    expect(result.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
  } finally {
    await new Promise((resolveClose) => proxy.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime and remote Git argument policy neutralizes checkout-local execution paths", () => {
  expect(safeGitRuntimeArgs(["status", "--porcelain=v1"], "linux")).toEqual([
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.useBuiltinFSMonitor=false",
    "status", "--porcelain=v1",
  ]);
  expect(safeGitRuntimeArgs(["status", "--porcelain=v1"], "win32")).toEqual([
    "-c", "core.hooksPath=NUL",
    "-c", "core.fsmonitor=false",
    "-c", "core.useBuiltinFSMonitor=false",
    "status", "--porcelain=v1",
  ]);
  expect(safeGitRemoteArgs(["fetch", "--all", "--prune"], "linux")).toEqual([
    "-c", "core.sshCommand=",
    "-c", "core.askPass=",
    "-c", "credential.helper=",
    "-c", "credential.interactive=false",
    "-c", "http.proxy=",
    "-c", "protocol.git.allow=never",
    "-c", "protocol.ext.allow=never",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.useBuiltinFSMonitor=false",
    "fetch", "--all", "--prune",
  ]);
});

test("Git resolver ignores a Git executable discovered through ambient PATH", async () => {
  const fakePathGit = "/tmp/ambient-bin/git";
  const trusted = "/usr/bin/git";
  const probes = [];

  const resolved = await resolveGitExecutable({
    platform: "darwin",
    env: {},
    which: () => fakePathGit,
    pathExists: (candidate) => candidate === trusted,
    probe: async (candidate) => {
      probes.push(candidate);
      return candidate === trusted;
    },
  });

  expect(resolved).toBe(trusted);
  expect(probes).toEqual([trusted]);
});

test("Windows Git resolver falls back to standard Git for Windows locations", async () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\builder\\AppData\\Local",
  };
  const candidates = gitExecutableCandidates({ platform: "win32", env });

  expect(candidates).toContain("C:\\Program Files\\Git\\cmd\\git.exe");
  expect(candidates).toContain("C:\\Users\\builder\\AppData\\Local\\Programs\\Git\\cmd\\git.exe");

  const expected = candidates.at(-1);
  const resolved = await resolveGitExecutable({
    platform: "win32",
    env,
    which: () => null,
    pathExists: (candidate) => candidate === expected,
    probe: async (candidate) => candidate === expected,
  });
  expect(resolved).toBe(expected);
});

test("Windows Git resolver refuses relative and current-volume rooted known-folder roots before probing", async () => {
  const probes = [];
  const options = {
    platform: "win32",
    env: { ProgramFiles: "\\\\Users\\attacker\\controlled-root", LOCALAPPDATA: "also-relative" },
    pathExists: () => true,
  };

  const asyncResolved = await resolveGitExecutable({
    ...options,
    probe: async (candidate) => {
      probes.push(candidate);
      return true;
    },
  });
  const syncResolved = resolveGitExecutableSync({
    ...options,
    probe: (candidate) => {
      probes.push(candidate);
      return true;
    },
  });

  expect(gitExecutableCandidates(options)).toEqual([]);
  expect(asyncResolved).toBeNull();
  expect(syncResolved).toBeNull();
  expect(probes).toEqual([]);
});

test("Git resolver ignores WindowsApps PATH alias and verifies only installed Git for Windows", async () => {
  const broken = "C:\\Users\\builder\\AppData\\Local\\Microsoft\\WindowsApps\\git.exe";
  const working = "C:\\Program Files\\Git\\cmd\\git.exe";
  const probes = [];
  const options = {
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    which: () => broken,
    pathExists: (candidate) => candidate === working,
  };

  const asyncResolved = await resolveGitExecutable({
    ...options,
    probe: async (candidate) => {
      probes.push(candidate);
      return candidate === working;
    },
  });
  const syncResolved = resolveGitExecutableSync({
    ...options,
    probe: (candidate) => candidate === working,
  });

  expect(asyncResolved).toBe(working);
  expect(syncResolved).toBe(working);
  expect(probes).toEqual([working]);
});

test("local Git probes use the Windows-proven timeout and bounded concurrency", () => {
  expect(GIT_LOCAL_TIMEOUT_MS).toBe(10_000);
  expect(GIT_COMMAND_CONCURRENCY).toBe(4);
  expect(gitTimeoutKillCommand(123, { SystemRoot: "C:\\Windows" })).toEqual([
    "C:\\Windows\\System32\\taskkill.exe",
    "/PID",
    "123",
    "/T",
    "/F",
  ]);
});
