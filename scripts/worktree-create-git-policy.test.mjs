import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWorktreeGitConfig } from "./worktree-create-git-policy.mjs";

const cleanupPaths = [];
const scriptPath = join(import.meta.dir, "worktree-create.mjs");

test("Windows SSH policy follows the actual SystemRoot", () => {
  expect(safeWorktreeGitConfig("win32", { SystemRoot: "D:\\Windows" })).toContain(
    "core.sshCommand=D:/Windows/System32/OpenSSH/ssh.exe -F NUL -o ProxyCommand=none",
  );
  expect(safeWorktreeGitConfig("win32", { SystemRoot: "D:\\Windows\\..\\attacker" })).toContain(
    "core.sshCommand=C:/Windows/System32/OpenSSH/ssh.exe -F NUL -o ProxyCommand=none",
  );
});

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

test("worktree creator rejects checkout-local URL rewrites before remote fetch", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree-create-remote-policy-"));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Conglomerate_GEN3");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const rewrittenRemote = join(sandbox, "rewritten.git");
  const realGit = Bun.which("git");
  expect(realGit).toBeTruthy();

  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(rewrittenRemote, { recursive: true }),
    mkdir(join(authorityRoot, "mission-control", "plans", "2026", "08"), { recursive: true }),
  ]);
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n");
  await writeFile(
    join(authorityRoot, "mission-control", "plans", "2026", "08", "CAC-0010-remote-policy.yaml"),
    "dev_code: CAC-0010\ntitle: Fixture\n",
  );
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.test"],
    ["config", "user.name", "Worktree Create Test"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ]) {
    const setup = Bun.spawnSync([realGit, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    expect(setup.exitCode).toBe(0);
  }
  const remoteInit = Bun.spawnSync([realGit, "init", "--bare"], {
    cwd: rewrittenRemote,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(remoteInit.exitCode).toBe(0);
  const push = Bun.spawnSync([realGit, "push", rewrittenRemote, "main:main"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(push.exitCode).toBe(0);
  for (const args of [
    ["remote", "add", "origin", "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
    ["config", "extensions.worktreeConfig", "true"],
    ["config", "--worktree", `url.file://${rewrittenRemote}.insteadOf`, "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
  ]) {
    const setup = Bun.spawnSync([realGit, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    expect(setup.exitCode).toBe(0);
  }

  const result = Bun.spawnSync([
    process.execPath,
    scriptPath,
    "--plan",
    "CAC-0010",
    "--branch",
    "agent/CAC-0010-remote-policy",
  ], {
    cwd: root,
    env: { ...process.env, HUMANANDMACHINES_ROOT: authorityRoot },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("transportní konfigurace");
  const branch = Bun.spawnSync([realGit, "show-ref", "--verify", "--quiet", "refs/heads/agent/CAC-0010-remote-policy"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(branch.exitCode).not.toBe(0);
  expect(existsSync(join(root, ".worktrees", ".worktree-create.lock"))).toBe(false);
});

test("worktree creator rejects a local Git proxy command before remote fetch", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree-create-git-proxy-"));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Conglomerate_GEN3");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const markerPath = join(sandbox, "proxy-ran");
  const proxyPath = join(sandbox, "malicious-git-proxy");
  const realGit = Bun.which("git");
  expect(realGit).toBeTruthy();

  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(join(authorityRoot, "mission-control", "plans", "2026", "08"), { recursive: true }),
  ]);
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n");
  await writeFile(join(root, "README.md"), "fixture\n");
  await writeFile(
    join(authorityRoot, "mission-control", "plans", "2026", "08", "CAC-0011-git-proxy.yaml"),
    "dev_code: CAC-0011\ntitle: Fixture\n",
  );
  await writeFile(proxyPath, "#!/bin/sh\nprintf proxy > \"$MARKER_PATH\"\nexit 1\n");
  await chmod(proxyPath, 0o755);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.test"],
    ["config", "user.name", "Worktree Create Test"],
    ["add", "."],
    ["commit", "-m", "fixture"],
    ["remote", "add", "origin", "git://github.com/HumanAndMachines/Conglomerate_GEN3.git"],
    ["config", "core.gitProxy", proxyPath],
  ]) {
    const setup = Bun.spawnSync([realGit, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true });
    expect(setup.exitCode).toBe(0);
  }

  const result = Bun.spawnSync([process.execPath, scriptPath, "--plan", "CAC-0011"], {
    cwd: root,
    env: { ...process.env, HUMANANDMACHINES_ROOT: authorityRoot, MARKER_PATH: markerPath },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("transportní konfigurace");
  expect(existsSync(markerPath)).toBe(false);
});

test("worktree creator refuses an existing create lock without deleting it", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree-create-lock-"));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Conglomerate_GEN3");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const lockPath = join(root, ".worktrees", ".worktree-create.lock");
  const realGit = Bun.which("git");
  expect(realGit).toBeTruthy();

  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(join(authorityRoot, "mission-control", "plans", "2026", "08"), { recursive: true }),
  ]);
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n");
  await writeFile(join(root, "README.md"), "fixture\n");
  await writeFile(
    join(authorityRoot, "mission-control", "plans", "2026", "08", "CAC-0012-lock.yaml"),
    "dev_code: CAC-0012\ntitle: Fixture\n",
  );
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.test"],
    ["config", "user.name", "Worktree Create Test"],
    ["add", "."],
    ["commit", "-m", "fixture"],
    ["remote", "add", "origin", "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
  ]) {
    const setup = Bun.spawnSync([realGit, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true });
    expect(setup.exitCode).toBe(0);
  }
  await mkdir(lockPath, { recursive: true });

  const result = Bun.spawnSync([process.execPath, scriptPath, "--plan", "CAC-0012", "--dry-run"], {
    cwd: root,
    env: { ...process.env, HUMANANDMACHINES_ROOT: authorityRoot },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("jiná worktree create operace");
  expect(existsSync(lockPath)).toBe(true);
});
