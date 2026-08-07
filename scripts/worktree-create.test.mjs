import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateOwnedWorktreeBranch,
  rollbackCreatedWorktree,
  writeSidecarAtomically,
} from "./worktree-create-lib.mjs";

const cleanupPaths = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

test("failed sidecar write removes only its staging file and permits a clean retry", async () => {
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

test("allocation failure before ownership marker leaves the new branch for explicit recovery", () => {
  const branchHead = "0123456789012345678901234567890123456789";
  const state = { branch: false };
  const result = allocateOwnedWorktreeBranch({
    primaryRoot: "/repo",
    branch: "agent/CAC-0008-fixture",
    baseRef: "origin/main",
    createId: () => "test-token",
    git: (_cwd, args) => {
      if (args[0] === "branch") {
        state.branch = true;
        return { status: 0, stdout: "" };
      }
      if (args[0] === "rev-parse") {
        return { status: state.branch ? 0 : 1, stdout: state.branch ? branchHead : "" };
      }
      if (args[0] === "config") return { status: 1, stderr: "simulated config lock failure" };
      return { status: 0, stdout: "" };
    },
  });

  expect(result).toMatchObject({ ok: false });
  expect(result.message).toContain("vědomý recovery handoff");
  expect(state.branch).toBe(true);
});

const primaryRoot = "/repo";
const branch = "agent/CAC-0008-fixture";
const branchHead = "0123456789012345678901234567890123456789";
const worktreePath = "/repo/.worktrees/root/CAC-0008-fixture";
const ownerMarker = "worktree-create:owned";

test.each([
  {
    name: "worktree add failed before registration",
    worktreeCreated: false,
    initial: { branch: true, registered: false, path: false, marker: ownerMarker },
    expectBranch: false,
    expectPath: false,
    phrase: "owned branch",
  },
  {
    name: "Windows leaves the directory after successful git removal",
    worktreeCreated: true,
    initial: { branch: true, registered: true, path: true, marker: ownerMarker },
    expectBranch: false,
    expectPath: false,
    phrase: "owned worktree vrácen",
  },
  {
    name: "ownership marker changed",
    worktreeCreated: true,
    initial: { branch: true, registered: true, path: true, marker: "foreign" },
    expectBranch: true,
    expectPath: true,
    phrase: "ownership marker nesedí",
  },
  {
    name: "branch is registered in another linked worktree",
    worktreeCreated: false,
    initial: { branch: true, registered: true, path: false, marker: ownerMarker },
    expectBranch: true,
    expectPath: false,
    phrase: "stále ji používá linked worktree",
  },
])("rollback table: $name", ({ worktreeCreated, initial, expectBranch, expectPath, phrase }) => {
  const state = { ...initial };
  const calls = [];
  const git = (_cwd, args) => {
    calls.push(args);
    if (args[0] === "config" && args.includes("--get")) {
      return { status: 0, stdout: state.marker };
    }
    if (args[0] === "config" && args.includes("--unset-all")) {
      const exactValue = args.at(-1);
      if (state.marker !== exactValue) return { status: 5, stdout: "" };
      state.marker = null;
      return { status: 0, stdout: "" };
    }
    if (args[0] === "rev-parse") {
      return { status: state.branch ? 0 : 1, stdout: state.branch ? branchHead : "" };
    }
    if (args[0] === "worktree" && args[1] === "list") {
      return {
        status: 0,
        stdout: state.registered
          ? `worktree ${worktreePath}\nbranch refs/heads/${branch}\n`
          : "",
      };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      state.registered = false;
      return { status: 0, stdout: "" };
    }
    if (args[0] === "worktree" && args[1] === "prune") return { status: 0, stdout: "" };
    if (args[0] === "update-ref" && args[1] === "-d") {
      if (args[3] === branchHead) state.branch = false;
      return { status: 0, stdout: "" };
    }
    return { status: 0, stdout: "" };
  };

  const report = rollbackCreatedWorktree({
    git,
    primaryRoot,
    worktreePath,
    canonicalWorktreePath: worktreePath,
    worktreeCreated,
    branch,
    ownerMarker,
    branchHead,
    pathExists: () => state.path,
    platform: "win32",
    removeDirectory: () => { state.path = false; },
    canonicalizePath: (path) => path,
  });

  expect(report).toContain(phrase);
  expect(state.branch).toBe(expectBranch);
  expect(state.path).toBe(expectPath);
  if (!expectBranch) {
    expect(calls).toContainEqual(["update-ref", "-d", `refs/heads/${branch}`, branchHead]);
    expect(calls).toContainEqual([
      "config",
      "--local",
      "--fixed-value",
      "--unset-all",
      `branch.${branch}.description`,
      ownerMarker,
    ]);
  }
});

test("marker cleanup cannot remove a replacement written after the ownership read", () => {
  const state = {
    branch: true,
    marker: ownerMarker,
    markerReads: 0,
  };
  const calls = [];
  const git = (_cwd, args) => {
    calls.push(args);
    if (args[0] === "config" && args.includes("--get")) {
      state.markerReads += 1;
      const observed = state.marker;
      if (state.markerReads === 3) state.marker = "replacement-owner";
      return { status: 0, stdout: observed };
    }
    if (args[0] === "config" && args.includes("--unset-all")) {
      const exactValue = args.at(-1);
      if (state.marker !== exactValue) return { status: 5, stdout: "" };
      state.marker = null;
      return { status: 0, stdout: "" };
    }
    if (args[0] === "rev-parse") {
      return { status: state.branch ? 0 : 1, stdout: state.branch ? branchHead : "" };
    }
    if (args[0] === "worktree" && args[1] === "list") return { status: 0, stdout: "" };
    if (args[0] === "update-ref" && args[1] === "-d") {
      state.branch = false;
      return { status: 0, stdout: "" };
    }
    return { status: 0, stdout: "" };
  };

  const report = rollbackCreatedWorktree({
    git,
    primaryRoot,
    worktreePath,
    worktreeCreated: false,
    branch,
    ownerMarker,
    branchHead,
    pathExists: () => false,
  });

  expect(report).toContain("owned branch");
  expect(state.branch).toBe(false);
  expect(state.marker).toBe("replacement-owner");
  expect(calls).toContainEqual([
    "config",
    "--local",
    "--fixed-value",
    "--unset-all",
    `branch.${branch}.description`,
    ownerMarker,
  ]);
});

test("rollback never removes a symlinked or noncanonical worktree path", () => {
  const calls = [];
  const report = rollbackCreatedWorktree({
    git: (_cwd, args) => {
      calls.push(args);
      if (args[0] === "config" && args.includes("--get")) return { status: 0, stdout: ownerMarker };
      if (args[0] === "rev-parse") return { status: 0, stdout: branchHead };
      return { status: 0, stdout: "" };
    },
    primaryRoot,
    worktreePath,
    canonicalWorktreePath: "/foreign/CAC-0008-fixture",
    branch,
    ownerMarker,
    branchHead,
    pathExists: () => true,
  });

  expect(report).toContain("není přesný kanonický child");
  expect(calls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
  expect(calls.some((args) => args[0] === "update-ref")).toBe(false);
});

test("Windows rollback canonicalizes Git forward slashes before exact path comparison", () => {
  const windowsRoot = "D:\\repo";
  const windowsPath = "D:\\repo\\.worktrees\\root\\CAC-0008-fixture";
  let registered = true;
  let pathPresent = true;
  let branchPresent = true;
  const git = (_cwd, args) => {
    if (args[0] === "config" && args.includes("--get")) return { status: 0, stdout: ownerMarker };
    if (args[0] === "config" && args.includes("--unset-all")) return { status: 0, stdout: "" };
    if (args[0] === "rev-parse") {
      return { status: branchPresent ? 0 : 1, stdout: branchPresent ? branchHead : "" };
    }
    if (args[0] === "worktree" && args[1] === "list") {
      return {
        status: 0,
        stdout: registered
          ? `worktree D:/repo/.worktrees/root/CAC-0008-fixture\0HEAD ${branchHead}\0branch refs/heads/${branch}\0\0`
          : "",
      };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      registered = false;
      return { status: 0, stdout: "" };
    }
    if (args[0] === "update-ref") {
      branchPresent = false;
      return { status: 0, stdout: "" };
    }
    return { status: 0, stdout: "" };
  };

  const report = rollbackCreatedWorktree({
    git,
    primaryRoot: windowsRoot,
    worktreePath: windowsPath,
    canonicalWorktreePath: windowsPath,
    branch,
    ownerMarker,
    branchHead,
    pathExists: () => pathPresent,
    platform: "win32",
    canonicalizePath: (path) => path.replaceAll("/", "\\"),
    removeDirectory: () => { pathPresent = false; },
  });

  expect(report).toContain("owned worktree vrácen");
  expect(pathPresent).toBe(false);
  expect(branchPresent).toBe(false);
});
