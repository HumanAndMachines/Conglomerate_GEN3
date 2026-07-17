import { expect, test } from "bun:test";
import { mkdtemp } from "fs/promises";
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
  safeGitRemoteEnv,
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
    Git_Config_Parameters: "'core.hooksPath=C:\\malicious\\hooks'",
    Git_Dir: "C:\\stale-context\\.git",
    git_implicit_work_tree: "1",
    Git_Shallow_File: "C:\\stale-context\\shallow",
    git_work_tree: "C:\\stale-context",
    SSH_ASKPASS: "/bin/false",
    ssh_askpass: "C:\\malicious\\ssh-askpass.exe",
    PATH: "C:\\Windows\\System32",
  })).toEqual({
    PATH: "C:\\Windows\\System32",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
  });
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

test("Git resolver přeskočí nefunkční WindowsApps alias a ověří skutečný Git for Windows", async () => {
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
  expect(probes).toEqual([broken, working]);
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
