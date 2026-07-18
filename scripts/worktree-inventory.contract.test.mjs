import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditRepository,
} from "../.agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs";

const cleanupPaths = [];
const auditScript = join(
  import.meta.dir,
  "..",
  ".agents",
  "skills",
  "worktree-development-discipline",
  "scripts",
  "worktree-inventory.mjs",
);

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

test("accepts an authority-backed exact Mission Control plan", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: true,
    sidecar_error: null,
  });
});

test("fails closed when the owning Mission Control plan is malformed", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    planContents: "dev_code: [CAC-0007\n",
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: false,
    sidecar_error: expect.stringContaining("cannot parse Mission Control plan"),
  });
  expect(report.violations.join("\n")).toContain(
    "canonical worktree has invalid sidecar",
  );
});

test("fails closed when the owning plan dev_code does not match the sidecar", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    planContents: "dev_code: CAC-9999\n",
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: false,
    sidecar_error: "Mission Control plan dev_code does not match sidecar",
  });
  expect(report.violations.join("\n")).toContain(
    "canonical worktree has invalid sidecar",
  );
});

test("verifies live remote preservation in a SHA-256 repository", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    objectFormat: "sha256",
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    remote_branch_exists: true,
    remote_head: expect.stringMatching(/^[0-9a-f]{64}$/),
    remote_head_matches: true,
    remote_verified: true,
    remote_preserved: true,
    remote_error: null,
  });
});

test("fails closed when the authority exists but the exact plan is missing", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: false,
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: false,
    sidecar_error: "Mission Control plan does not exist",
  });
  expect(report.violations.join("\n")).toContain(
    "canonical worktree has invalid sidecar",
  );
});

test("fails worktrees:check when the HumanAndMachines authority is unavailable", async () => {
  const fixture = await createFixture({
    authorityAvailable: false,
    planAvailable: false,
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: false,
    sidecar_error: expect.stringContaining("authority checkout is unavailable"),
    sidecar_advisories: [
      expect.stringContaining("plan ownership was not verified"),
    ],
  });

  const result = Bun.spawnSync([
    process.execPath,
    auditScript,
    "--check",
    "--json",
    "--root",
    fixture.root,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: sanitizedEnv(),
    windowsHide: true,
  });
  expect(result.exitCode).toBe(1);
  const cliReport = JSON.parse(result.stdout.toString());
  expect(canonicalWorktree(cliReport).sidecar_valid).toBe(false);
  expect(cliReport.violations.join("\n")).toContain(
    "canonical worktree has invalid sidecar",
  );
});

test("keeps an incomplete global leftover scan advisory-only", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
    orphanGlobalEntryBudget: 0,
  });
  expect(report.orphan_scan_complete).toBe(true);
  expect(report.global_orphan_scan_complete).toBe(false);
  expect(canonicalWorktree(report).sidecar_valid).toBe(true);
  expect(report.violations.join("\n")).not.toContain(
    "bounded orphan scan did not complete",
  );
});

test("fails closed when the live remote branch was deleted behind a stale tracking ref", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
  });
  git(fixture.remote, ["update-ref", "-d", `refs/heads/${fixture.branch}`]);

  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    remote_branch_exists: false,
    remote_head: null,
    remote_head_matches: false,
    remote_verified: true,
    remote_preserved: false,
    remote_error: "live remote branch does not exist",
  });
  expect(report.violations.join("\n")).toContain(
    "canonical worktree remote state is unknown",
  );
});

test("fails closed when the live remote branch advanced without a local fetch", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
  });
  const localHead = gitOutput(fixture.canonical, ["rev-parse", "HEAD"]);
  const tree = gitOutput(fixture.canonical, ["rev-parse", "HEAD^{tree}"]);
  const remoteHead = gitOutput(fixture.canonical, [
    "commit-tree",
    tree,
    "-p",
    localHead,
    "-m",
    "remote-only advance",
  ]);
  git(fixture.canonical, [
    "push",
    fixture.remote,
    `${remoteHead}:refs/heads/${fixture.branch}`,
  ]);

  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    remote_branch_exists: true,
    remote_head: remoteHead,
    remote_head_matches: false,
    remote_verified: true,
    remote_preserved: false,
    remote_error: "live remote HEAD differs from local HEAD",
  });
  expect(report.violations.join("\n")).toContain(
    "canonical worktree remote state is unknown",
  );
});

async function createFixture({
  authorityAvailable,
  planAvailable,
  planContents = "dev_code: CAC-0007\n",
  objectFormat = "sha1",
}) {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree contract "));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Dashboard");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const remote = join(sandbox, "remote.git");
  const planRelativePath =
    "mission-control/plans/2026/07/CAC-0007-contract.yaml";
  const planPath = join(authorityRoot, ...planRelativePath.split("/"));

  await mkdir(root);
  await mkdir(remote);
  if (authorityAvailable) {
    await mkdir(join(authorityRoot, "mission-control", "plans", "2026", "07"), {
      recursive: true,
    });
  }
  if (planAvailable) {
    await writeFile(planPath, planContents);
  }

  const objectFormatArgs = objectFormat === "sha1"
    ? []
    : [`--object-format=${objectFormat}`];
  git(root, ["init", ...objectFormatArgs, "-b", "main"]);
  git(remote, ["init", ...objectFormatArgs, "--bare"]);
  git(root, ["config", "user.email", "audit@example.test"]);
  git(root, ["config", "user.name", "Worktree Audit"]);
  await writeFile(join(root, "README.md"), "fixture\n");
  await writeFile(join(root, ".gitignore"), ".worktrees/\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-u", "origin", "main"]);

  const basename = "CAC-0007-contract";
  const canonical = join(root, ".worktrees", "root", basename);
  git(root, ["worktree", "add", "-b", `codex/${basename}`, canonical, "main"]);
  git(canonical, ["push", "-u", "origin", `codex/${basename}`]);
  await writeFile(
    join(root, ".worktrees", "root", `${basename}.worktree.json`),
    `${JSON.stringify({
      schema_version: "companiesascode.worktree.v1",
      organization: "HumanAndMachines",
      organization_path: ".",
      workspace: "root",
      module: "Dashboard",
      module_path: ".",
      repo_kind: "root_repo",
      base_branch: "main",
      branch: `codex/${basename}`,
      mission_control_plan_code: "CAC-0007",
      mission_control_plan_path: planRelativePath,
      worktree_path: `.worktrees/root/${basename}`,
      created_at: "2026-07-18T00:00:00Z",
      created_by: "contract-test",
      last_touched: "2026-07-18T00:00:00Z",
      status: "active",
      pr_url: null,
      purpose: "Fail-closed ownership contract fixture.",
      cleanup_rule: "Remove after the test.",
    }, null, 2)}\n`,
  );

  return {
    root,
    authorityRoot,
    remote,
    canonical,
    branch: `codex/${basename}`,
  };
}

function canonicalWorktree(report) {
  return report.worktrees.find((item) => item.path_class === "canonical");
}

function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_WORK_TREE",
    "HUMANANDMACHINES_ROOT",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
  });
  return env;
}

function git(cwd, args) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: sanitizedEnv(),
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
}

function gitOutput(cwd, args) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: sanitizedEnv(),
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}
