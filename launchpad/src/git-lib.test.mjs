import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
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
  safeGitMaterializationConfig,
  safeGitMaterializationEnv,
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

test.skipIf(process.platform === "win32")("fresh Git runner ignores an executable injected through PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-path-takeover-"));
  const fakeBin = join(root, "bin");
  const fakeGit = join(fakeBin, "git");
  const marker = join(root, "fake-git-ran");
  const childScript = join(root, "run-git.mjs");
  try {
    await Bun.write(fakeGit, `#!/bin/sh\n: > "$FAKE_GIT_MARKER"\nprintf 'git version fake\\n'\n`);
    await chmod(fakeGit, 0o755);
    await writeFile(childScript, `
      import { runGit } from ${JSON.stringify(new URL("./git-lib.mjs", import.meta.url).href)};
      const result = await runGit(["--version"], { cwd: process.cwd() });
      process.stdout.write(JSON.stringify(result));
      if (!result.ok) process.exit(1);
    `);

    const childEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_GIT_MARKER: marker,
    };
    delete childEnv.COMPANIESASCODE_GIT_EXECUTABLE;
    const child = Bun.spawnSync([process.execPath, childScript], {
      cwd: root,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = JSON.parse(child.stdout.toString());

    expect(child.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.stdout).not.toContain("fake");
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("POSIX Git timeout kills descendants that keep command pipes open", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-timeout-"));
  const childPidPath = join(root, "child.pid");
  let childPid = null;
  try {
    await initGitRepo(root);
    const startedAt = Date.now();
    const result = await runGit([
      "-c",
      "alias.hold=!sh -c 'sleep 60 & echo $! > \"$1\"; wait' _",
      "hold",
      childPidPath,
    ], {
      cwd: root,
      timeoutMs: 250,
    });
    childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(await processIsGone(childPid)).toBe(true);
  } finally {
    if (Number.isInteger(childPid) && !(await processIsGone(childPid))) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32" || !Bun.which("perl"))("Git timeout bounds pipe drain even when a descendant escapes the process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-drain-timeout-"));
  const childPidPath = join(root, "escaped-child.pid");
  let childPid = null;
  try {
    await initGitRepo(root);
    const startedAt = Date.now();
    const result = await runGit([
      "-c",
      "alias.escape=!perl -MPOSIX=setsid -e 'setsid(); open(my $fh, q(>), $ARGV[0]) or die $!; print {$fh} qq($$\\n); close $fh; sleep 60'",
      "escape",
      childPidPath,
    ], {
      cwd: root,
      timeoutMs: 250,
    });
    childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(await processIsGone(childPid)).toBe(false);
  } finally {
    if (Number.isInteger(childPid) && !(await processIsGone(childPid))) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function processIsGone(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

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
    git_implicit_work_tree: "1",
    git_internal_super_prefix: "C:\\stale-context\\super",
    Git_Shallow_File: "C:\\stale-context\\shallow",
    git_work_tree: "C:\\stale-context",
    GIT_EXEC_PATH: "C:\\malicious\\git-exec-path",
    GIT_PROXY_COMMAND: "C:\\malicious\\proxy-wrapper.exe",
    GIT_SSH_COMMAND: "C:\\malicious\\ssh-wrapper.exe",
    git_ssh_command: "C:\\malicious\\ssh-wrapper-lower.exe",
    SSH_ASKPASS: "/bin/false",
    ssh_askpass: "C:\\malicious\\ssh-askpass.exe",
    HOME: "C:\\Users\\builder",
    PATH: "C:\\Windows\\System32",
  })).toEqual({
    HOME: "C:\\Users\\builder",
    PATH: "C:\\Windows\\System32",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
  });
});

test("materialization Git ignores user config and pins command-capable settings", () => {
  const environment = safeGitMaterializationEnv("linux", {
    HOME: "/tmp/poisoned-home",
    XDG_CONFIG_HOME: "/tmp/poisoned-xdg",
    USERPROFILE: "C:\\poisoned-user",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.gitProxy",
    GIT_CONFIG_VALUE_0: "/tmp/poison-helper",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  });
  const config = safeGitMaterializationConfig("linux");

  expect(environment.HOME).toBeUndefined();
  expect(environment.XDG_CONFIG_HOME).toBeUndefined();
  expect(environment.USERPROFILE).toBeUndefined();
  expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(environment.GIT_CONFIG_COUNT).toBe("0");
  expect(environment.GIT_CONFIG_KEY_0).toBeUndefined();
  expect(environment.GIT_CONFIG_VALUE_0).toBeUndefined();
  expect(environment.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
  expect(config).toContain("core.hooksPath=/dev/null");
  expect(config).toContain("core.sshCommand=/usr/bin/ssh");
  expect(config).toContain("core.gitProxy=");
  expect(config).toContain("protocol.ext.allow=never");
  expect(safeGitMaterializationConfig("win32", { SystemRoot: "D:\\Windows" }))
    .toContain("core.sshCommand=D:/Windows/System32/OpenSSH/ssh.exe");
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
    pathExists: (candidate) => candidate === expected,
    probe: async (candidate) => candidate === expected,
  });
  expect(resolved).toBe(expected);
});

test("Git resolver accepts only an absolute configured override", async () => {
  const configured = "/nix/store/example-git/bin/git";
  const resolved = await resolveGitExecutable({
    platform: "linux",
    env: { COMPANIESASCODE_GIT_EXECUTABLE: configured },
    pathExists: (candidate) => candidate === configured,
    probe: async (candidate) => candidate === configured,
  });
  const relative = await resolveGitExecutable({
    platform: "linux",
    env: { COMPANIESASCODE_GIT_EXECUTABLE: "custom/bin/git" },
    pathExists: () => true,
    probe: async (candidate) => candidate === "custom/bin/git",
  });

  expect(resolved).toBe(configured);
  expect(relative).toBeNull();
});

test("Git resolver continues after an existing candidate fails its version probe", async () => {
  const broken = "/usr/bin/git";
  const working = "/usr/local/bin/git";
  const asyncProbes = [];
  const syncProbes = [];
  const options = {
    platform: "linux",
    env: {},
    pathExists: (candidate) => candidate === broken || candidate === working,
  };

  const asyncResolved = await resolveGitExecutable({
    ...options,
    probe: async (candidate) => {
      asyncProbes.push(candidate);
      return candidate === working;
    },
  });
  const syncResolved = resolveGitExecutableSync({
    ...options,
    probe: (candidate) => {
      syncProbes.push(candidate);
      return candidate === working;
    },
  });

  expect(asyncResolved).toBe(working);
  expect(syncResolved).toBe(working);
  expect(asyncProbes).toEqual([broken, working]);
  expect(syncProbes).toEqual([broken, working]);
});

test("Git resolver ignoruje PATH alias a ověří skutečný Git for Windows", async () => {
  const working = "C:\\Program Files\\Git\\cmd\\git.exe";
  const probes = [];
  const options = {
    platform: "win32",
    env: {
      ProgramFiles: "C:\\Program Files",
      PATH: "C:\\Users\\builder\\AppData\\Local\\Microsoft\\WindowsApps",
    },
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
