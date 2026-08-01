import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateOwnedWorktreeBranch,
  rollbackCreatedWorktree,
  writeSidecarAtomically,
} from "./worktree-create-lib.mjs";

const cleanupPaths = [];
const scriptPath = join(import.meta.dir, "worktree-create.mjs");

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

test("failed sidecar write cleans its partial staging file without publishing a sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktree-create-sidecar-"));
  cleanupPaths.push(root);
  const sidecarPath = join(root, "CAC-0007-fixture.worktree.json");
  const stagingPath = join(root, ".CAC-0007-fixture.worktree.json.fixture.tmp");

  await expect(writeSidecarAtomically({
    sidecarPath,
    contents: "{\"schema_version\":\"partial\"}\n",
    createId: () => "fixture",
    write: async (path) => {
      await writeFile(path, "{\"schema_version\":", "utf8");
      throw new Error("simulated disk-full after partial write");
    },
  })).rejects.toThrow("simulated disk-full after partial write");

  expect(existsSync(sidecarPath)).toBe(false);
  expect(existsSync(stagingPath)).toBe(false);

  await writeSidecarAtomically({
    sidecarPath,
    contents: "{\"schema_version\":\"complete\"}\n",
    createId: () => "retry",
  });
  expect(existsSync(sidecarPath)).toBe(true);
});

test("allocation při selhání ownership markeru zachová branch pro vědomý recovery handoff", () => {
  const branch = "agent/CAC-0008-fixture";
  const branchHead = "0123456789012345678901234567890123456789";
  const state = { branch: false };
  const calls = [];
  const result = allocateOwnedWorktreeBranch({
    primaryRoot: "/repo",
    branch,
    baseRef: "origin/main",
    createId: () => "test-token",
    git: (_cwd, args) => {
      calls.push(args);
      if (args[0] === "branch") {
        state.branch = true;
        return { status: 0, stdout: "" };
      }
      if (args[0] === "rev-parse") return { status: state.branch ? 0 : 1, stdout: state.branch ? branchHead : "" };
      if (args[0] === "config") return { status: 1, stderr: "simulated config lock failure" };
      if (args[0] === "update-ref" && args[1] === "-d") {
        if (args[3] === branchHead) state.branch = false;
        return { status: 0, stdout: "" };
      }
      return { status: 0, stdout: "" };
    },
  });

  expect(result.ok).toBe(false);
  expect(result.message).toContain("vědomý recovery handoff");
  expect(result.message).toContain(branchHead);
  expect(state.branch).toBe(true);
  expect(calls.some((args) => args[0] === "update-ref" && args[1] === "-d")).toBe(false);
});

test("rollback odstraní jen prokázaný worktree a branch ponechá pro recovery", () => {
  const state = { branch: true, registeredWorktree: true, worktreePath: true };
  const primaryRoot = "/repo";
  const worktreePath = "/repo/.worktrees/root/CAC-0008-fixture";
  const branch = "agent/CAC-0008-fixture";
  const ownerMarker = "worktree-create:test-token";
  const branchHead = "0123456789012345678901234567890123456789";
  const calls = [];
  const git = (_cwd, args) => {
    calls.push(args);
    if (args[0] === "worktree" && args[1] === "remove") state.worktreePath = false;
    if (args[0] === "update-ref" && args[1] === "-d") state.branch = false;
    if (args[0] === "worktree" && args[1] === "list") {
      return { status: 0, stdout: state.registeredWorktree && state.worktreePath ? `worktree ${worktreePath}\nbranch refs/heads/${branch}\n` : "" };
    }
    if (args[0] === "config" && args.includes("--get")) return { status: 0, stdout: ownerMarker };
    if (args[0] === "rev-parse") return { status: state.branch ? 0 : 1, stdout: state.branch ? branchHead : "" };
    return { status: 0, stdout: "" };
  };

  const report = rollbackCreatedWorktree({
    git,
    primaryRoot,
    worktreePath,
    branch,
    ownerMarker,
    branchHead,
    pathExists: () => state.worktreePath,
  });

  expect(report).toContain("owned worktree vrácen");
  expect(report).toContain("vědomý recovery handoff");
  expect(calls.some((args) => args[0] === "update-ref" && args[1] === "-d")).toBe(false);
  expect(state).toEqual({ branch: true, registeredWorktree: true, worktreePath: false });
});

test("rollback nikdy nemaže branch ani při shodném ownership markeru a headu", () => {
  const branch = "agent/CAC-0008-fixture";
  const branchHead = "0123456789012345678901234567890123456789";
  const calls = [];
  const report = rollbackCreatedWorktree({
    git: (_cwd, args) => {
      calls.push(args);
      if (args[0] === "config" && args.includes("--get")) return { status: 0, stdout: "worktree-create:owned" };
      if (args[0] === "rev-parse") return { status: 0, stdout: branchHead };
      if (args[0] === "worktree" && args[1] === "list") return { status: 0, stdout: `worktree /repo/.worktrees/root/CAC-0008-fixture\nbranch refs/heads/${branch}\n` };
      if (args[0] === "worktree" && args[1] === "remove") return { status: 0, stdout: "" };
      if (args[0] === "update-ref" && args[1] === "-d") return { status: 1, stderr: "cannot lock ref: reference changed" };
      return { status: 0, stdout: "" };
    },
    primaryRoot: "/repo",
    worktreePath: "/repo/.worktrees/root/CAC-0008-fixture",
    branch,
    ownerMarker: "worktree-create:owned",
    branchHead,
    pathExists: () => false,
  });

  expect(report).toContain("vědomý recovery handoff");
  expect(calls.some((args) => args[0] === "update-ref" && args[1] === "-d")).toBe(false);
});

test("rollback bez ownership důkazu nemaže cizí worktree ani branch", () => {
  const calls = [];
  const report = rollbackCreatedWorktree({
    git: (_cwd, args) => {
      calls.push(args);
      return { status: 0, stdout: args[0] === "worktree" && args[1] === "list" ? "worktree /repo/.worktrees/root/CAC-0008-fixture\n" : "" };
    },
    primaryRoot: "/repo",
    worktreePath: "/repo/.worktrees/root/CAC-0008-fixture",
    branch: "agent/CAC-0008-fixture",
    pathExists: () => true,
  });

  expect(report).toContain("worktree ani branch se nemažou: chybí ownership důkaz");
  expect(calls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
  expect(calls.some((args) => args[0] === "update-ref" && args[1] === "-d")).toBe(false);
});

test("rollback při změně ownership markeru nemaže cizí artefakty", () => {
  const calls = [];
  const report = rollbackCreatedWorktree({
    git: (_cwd, args) => {
      calls.push(args);
      if (args[0] === "config" && args.includes("--get")) return { status: 0, stdout: "foreign-owner" };
      if (args[0] === "rev-parse") return { status: 0, stdout: "0123456789012345678901234567890123456789" };
      return { status: 0, stdout: "" };
    },
    primaryRoot: "/repo",
    worktreePath: "/repo/.worktrees/root/CAC-0008-fixture",
    branch: "agent/CAC-0008-fixture",
    ownerMarker: "worktree-create:owned",
    branchHead: "0123456789012345678901234567890123456789",
    pathExists: () => true,
  });

  expect(report).toContain("worktree ani branch se nemažou: ownership marker nesedí");
  expect(calls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
  expect(calls.some((args) => args[0] === "update-ref" && args[1] === "-d")).toBe(false);
});

test("rollback odmítne symlinkovou nebo neověřenou worktree cestu i s platným branch markerem", () => {
  const calls = [];
  const report = rollbackCreatedWorktree({
    git: (_cwd, args) => {
      calls.push(args);
      if (args[0] === "config" && args.includes("--get")) return { status: 0, stdout: "worktree-create:owned" };
      if (args[0] === "rev-parse") return { status: 0, stdout: "0123456789012345678901234567890123456789" };
      return { status: 0, stdout: "" };
    },
    primaryRoot: "/repo",
    worktreePath: "/repo/.worktrees/root/CAC-0008-fixture",
    canonicalWorktreePath: null,
    branch: "agent/CAC-0008-fixture",
    ownerMarker: "worktree-create:owned",
    branchHead: "0123456789012345678901234567890123456789",
    pathExists: () => true,
  });

  expect(report).toContain("worktree cesta není ověřený běžný adresář");
  expect(calls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
  expect(calls.some((args) => args[0] === "update-ref" && args[1] === "-d")).toBe(false);
});

test("rollback odmítne registrovaný worktree se stejnou cestou, ale jinou branchí", () => {
  const calls = [];
  const report = rollbackCreatedWorktree({
    git: (_cwd, args) => {
      calls.push(args);
      if (args[0] === "config" && args.includes("--get")) return { status: 0, stdout: "worktree-create:owned" };
      if (args[0] === "rev-parse") return { status: 0, stdout: "0123456789012345678901234567890123456789" };
      if (args[0] === "worktree" && args[1] === "list") {
        return { status: 0, stdout: "worktree /repo/.worktrees/root/CAC-0008-fixture\nbranch refs/heads/foreign/CAC-0008-fixture\n" };
      }
      return { status: 0, stdout: "" };
    },
    primaryRoot: "/repo",
    worktreePath: "/repo/.worktrees/root/CAC-0008-fixture",
    branch: "agent/CAC-0008-fixture",
    ownerMarker: "worktree-create:owned",
    branchHead: "0123456789012345678901234567890123456789",
    pathExists: () => true,
  });

  expect(report).toContain("exact cesta není registrovaný owned worktree");
  expect(calls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
  expect(calls.some((args) => args[0] === "update-ref" && args[1] === "-d")).toBe(false);
});

const testOnPosix = process.platform === "win32" ? test.skip : test;

testOnPosix("worktree creator never resolves Git from caller-controlled PATH", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree-create-git-"));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Conglomerate_GEN3");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const fakeBin = join(sandbox, "fake-bin");
  const markerPath = join(sandbox, "fake-git-ran");
  const realGit = Bun.which("git");
  expect(realGit).toBeTruthy();

  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(join(authorityRoot, "mission-control", "plans", "2026", "08"), { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
  ]);
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n");
  await writeFile(
    join(authorityRoot, "mission-control", "plans", "2026", "08", "CAC-0007-fixture.yaml"),
    "dev_code: CAC-0007\ntitle: Fixture\n",
  );
  await writeFile(join(root, "README.md"), "fixture\n");
  await writeFile(join(fakeBin, "git"), `#!/bin/sh\nprintf fake > "$MARKER_PATH"\nexec "$REAL_GIT" "$@"\n`);
  await chmod(join(fakeBin, "git"), 0o755);

  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.test"],
    ["config", "user.name", "Worktree Create Test"],
    ["add", "."],
    ["commit", "-m", "fixture"],
    ["remote", "add", "origin", "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
  ]) {
    const result = Bun.spawnSync([realGit, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    expect(result.exitCode).toBe(0);
  }

  const result = Bun.spawnSync([
    process.execPath,
    scriptPath,
    "--plan",
    "CAC-0007",
    "--dry-run",
  ], {
    cwd: root,
    env: {
      ...process.env,
      HUMANANDMACHINES_ROOT: authorityRoot,
      MARKER_PATH: markerPath,
      REAL_GIT: realGit,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  expect({
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
  }).toMatchObject({ exitCode: 0 });
  expect(existsSync(markerPath)).toBe(false);
});

test("worktree creator accepts a schema-valid six-letter plan code", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree-create-plan-code-"));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Conglomerate_GEN3");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const realGit = Bun.which("git");
  expect(realGit).toBeTruthy();

  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(join(authorityRoot, "mission-control", "plans", "2026", "08"), { recursive: true }),
  ]);
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n");
  await writeFile(join(root, "README.md"), "fixture\n");
  await writeFile(
    join(authorityRoot, "mission-control", "plans", "2026", "08", "CACDEF-0001-fixture.yaml"),
    "dev_code: CACDEF-0001\ntitle: Fixture\n",
  );
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.test"],
    ["config", "user.name", "Worktree Create Test"],
    ["add", "."],
    ["commit", "-m", "fixture"],
    ["remote", "add", "origin", "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
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
    "CACDEF-0001",
    "--dry-run",
  ], {
    cwd: root,
    env: { ...process.env, HUMANANDMACHINES_ROOT: authorityRoot },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  expect(result.exitCode).toBe(0);
});

testOnPosix("worktree creator refuses a transport rewrite before hooks or SSH commands can run", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree-create-git-settings-"));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Conglomerate_GEN3");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const remote = join(sandbox, "remote.git");
  const markerPath = join(sandbox, "unexpected-execution");
  const maliciousSsh = join(sandbox, "malicious-ssh");
  const hooksPath = join(sandbox, "malicious-hooks");
  const realGit = Bun.which("git");
  expect(realGit).toBeTruthy();

  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(remote, { recursive: true }),
    mkdir(hooksPath, { recursive: true }),
    mkdir(join(authorityRoot, "mission-control", "plans", "2026", "08"), { recursive: true }),
  ]);
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n");
  await writeFile(join(root, "README.md"), "fixture\n");
  await writeFile(
    join(authorityRoot, "mission-control", "plans", "2026", "08", "CAC-0007-fixture.yaml"),
    "dev_code: CAC-0007\ntitle: Fixture\n",
  );
  await writeFile(maliciousSsh, "#!/bin/sh\nprintf ssh > \"$MARKER_PATH\"\nexit 1\n");
  await writeFile(join(hooksPath, "post-checkout"), "#!/bin/sh\nprintf hook > \"$MARKER_PATH\"\n");
  await Promise.all([
    chmod(maliciousSsh, 0o755),
    chmod(join(hooksPath, "post-checkout"), 0o755),
  ]);

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
    cwd: remote,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(remoteInit.exitCode).toBe(0);
  const push = Bun.spawnSync([realGit, "push", remote, "main:main"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(push.exitCode).toBe(0);
  for (const args of [
    ["remote", "add", "origin", "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
    ["config", `url.file://${remote}.insteadOf`, "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
    ["config", "core.sshCommand", maliciousSsh],
    ["config", "core.hooksPath", hooksPath],
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
    "CAC-0007",
    "--branch",
    "agent/CAC-0007-security",
  ], {
    cwd: root,
    env: {
      ...process.env,
      HUMANANDMACHINES_ROOT: authorityRoot,
      MARKER_PATH: markerPath,
      GIT_SSH_COMMAND: maliciousSsh,
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("transportní konfigurace");
  expect(existsSync(markerPath)).toBe(false);
  expect(existsSync(join(root, ".worktrees", "root", "CAC-0007-fixture.worktree.json"))).toBe(false);
});

testOnPosix("worktree creator refuses a rewrite before any branch allocation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree-create-checkout-failure-"));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Conglomerate_GEN3");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const remote = join(sandbox, "remote.git");
  const realGit = Bun.which("git");
  expect(realGit).toBeTruthy();

  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(remote, { recursive: true }),
    mkdir(join(authorityRoot, "mission-control", "plans", "2026", "08"), { recursive: true }),
  ]);
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n");
  await writeFile(join(root, "payload.bin"), "x".repeat(4096));
  await writeFile(
    join(authorityRoot, "mission-control", "plans", "2026", "08", "CAC-0008-checkout-failure.yaml"),
    "dev_code: CAC-0008\ntitle: Fixture\n",
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
    cwd: remote,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(remoteInit.exitCode).toBe(0);
  const push = Bun.spawnSync([realGit, "push", remote, "main:main"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(push.exitCode).toBe(0);
  for (const args of [
    ["remote", "add", "origin", "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
    ["config", `url.file://${remote}.insteadOf`, "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
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
    "/bin/sh",
    "-c",
    "ulimit -f 1; exec \"$BUN_BINARY\" \"$SCRIPT_PATH\" --plan CAC-0008 --branch agent/CAC-0008-checkout-failure",
  ], {
    cwd: root,
    env: {
      ...process.env,
      BUN_BINARY: process.execPath,
      SCRIPT_PATH: scriptPath,
      HUMANANDMACHINES_ROOT: authorityRoot,
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("transportní konfigurace");
  expect(existsSync(join(root, ".worktrees", "root", "CAC-0008-checkout-failure"))).toBe(false);
  expect(existsSync(join(root, ".worktrees", "root", "CAC-0008-checkout-failure.worktree.json"))).toBe(false);
  const branch = Bun.spawnSync([realGit, "show-ref", "--verify", "--quiet", "refs/heads/agent/CAC-0008-checkout-failure"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(branch.exitCode).not.toBe(0);
});

testOnPosix("worktree creator leaves no artifact when the transport guard rejects a rewrite", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree-create-sidecar-retry-"));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Conglomerate_GEN3");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const remote = join(sandbox, "remote.git");
  const realGit = Bun.which("git");
  expect(realGit).toBeTruthy();

  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(remote, { recursive: true }),
    mkdir(join(authorityRoot, "mission-control", "plans", "2026", "08"), { recursive: true }),
  ]);
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n");
  await writeFile(
    join(authorityRoot, "mission-control", "plans", "2026", "08", "CAC-0009-sidecar-retry.yaml"),
    "dev_code: CAC-0009\ntitle: Fixture\n",
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
    cwd: remote,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(remoteInit.exitCode).toBe(0);
  const push = Bun.spawnSync([realGit, "push", remote, "main:main"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(push.exitCode).toBe(0);
  for (const args of [
    ["remote", "add", "origin", "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
    ["config", `url.file://${remote}.insteadOf`, "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
  ]) {
    const setup = Bun.spawnSync([realGit, ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    expect(setup.exitCode).toBe(0);
  }

  const args = ["--plan", "CAC-0009", "--branch", "agent/CAC-0009-sidecar-retry"];
  const failing = Bun.spawnSync([
    "/bin/sh",
    "-c",
    "ulimit -f 1; exec \"$BUN_BINARY\" \"$SCRIPT_PATH\" \"$@\"",
    "worktree-create-test",
    ...args,
  ], {
    cwd: root,
    env: {
      ...process.env,
      BUN_BINARY: process.execPath,
      SCRIPT_PATH: scriptPath,
      HUMANANDMACHINES_ROOT: authorityRoot,
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(failing.exitCode).toBe(1);
  expect(existsSync(join(root, ".worktrees", "root", "CAC-0009-sidecar-retry"))).toBe(false);
  expect(existsSync(join(root, ".worktrees", "root", "CAC-0009-sidecar-retry.worktree.json"))).toBe(false);

  const retry = Bun.spawnSync([process.execPath, scriptPath, ...args], {
    cwd: root,
    env: { ...process.env, HUMANANDMACHINES_ROOT: authorityRoot },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(retry.exitCode).toBe(1);
  expect(new TextDecoder().decode(retry.stderr)).toContain("transportní konfigurace");
  expect(existsSync(join(root, ".worktrees", "root", "CAC-0009-sidecar-retry.worktree.json"))).toBe(false);
});
