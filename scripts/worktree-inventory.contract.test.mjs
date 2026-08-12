import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditRepository,
  resolveAuthorityRoot,
  resolveAuthorityPlanPath,
} from "../.agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs";

const cleanupPaths = [];
setDefaultTimeout(process.platform === "win32" ? 45_000 : 20_000);
const auditScript = join(
  import.meta.dir,
  "..",
  ".agents",
  "skills",
  "worktree-development-discipline",
  "scripts",
  "worktree-inventory.mjs",
);
const validPlanContents = `schema_version: companiesascode.mission_control.plan.v2
id: mcplan-cac-0007
dev_code: CAC-0007
title: "Worktree contract fixture"
status: in_progress
owner: founder
priority: high
priority_rank: 1
created_at: 2026-07-18
updated_at: 2026-07-18
context: "Validate exact worktree ownership."
current_problem: "Ownership must fail closed."
target_state: "Only canonical worktrees pass."
scope:
  in:
    - "Validate the fixture."
  out:
    - "No production mutation."
acceptance_criteria:
  - "Canonical plan validation passes."
validation:
  - "Run the contract test."
`;
const fixturePlanSchema = {
  type: "object",
  required: [
    "schema_version",
    "id",
    "dev_code",
    "title",
    "status",
    "owner",
    "priority",
    "priority_rank",
    "created_at",
    "updated_at",
    "context",
    "current_problem",
    "target_state",
    "scope",
    "acceptance_criteria",
    "validation",
  ],
  properties: {
    schema_version: { const: "companiesascode.mission_control.plan.v2" },
    id: { type: "string", pattern: "^mcplan-[a-z]{2,6}-[0-9]{4}$" },
    dev_code: { type: "string", pattern: "^[A-Z]{2,6}-[0-9]{4}$" },
  },
};
const fixtureSemanticValidator = `import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
function planSources(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && /\\.ya?ml$/.test(entry.name)) files.push(readFileSync(target, "utf8"));
    }
  };
  walk(join(root, "data", "mission-control", "plans"));
  return files;
}
export function validateMissionControlData(root) {
  return planSources(root).some((source) => source.includes('title: "Semantically invalid"'))
    ? ["semantic fixture rejection"]
    : [];
}
`;

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

test.each([
  "mission-control/plans/2026/08/DEV-6439-runtime.yaml",
  "data/mission-control/plans/2026/08/DEV-6439-runtime.yaml",
])("bridges legacy sidecar plan locator %s to repository-db", async (planLocator) => {
  const authorityRoot = await mkdtemp(join(tmpdir(), "worktree authority "));
  cleanupPaths.push(authorityRoot);
  const canonicalPlan = join(
    authorityRoot,
    "mission-control",
    "db",
    "data",
    "mission-control",
    "plans",
    "2026",
    "08",
    "DEV-6439-runtime.yaml",
  );
  await mkdir(join(canonicalPlan, ".."), { recursive: true });
  await writeFile(canonicalPlan, validPlanContents.replaceAll("CAC-0007", "DEV-6439"));

  expect(resolveAuthorityPlanPath("/unused", planLocator, authorityRoot)).toBe(canonicalPlan);
});

test("repository-db plan wins when a stale legacy plan still exists", async () => {
  const authorityRoot = await mkdtemp(join(tmpdir(), "worktree authority precedence "));
  cleanupPaths.push(authorityRoot);
  const locator = "mission-control/plans/2026/08/DEV-6439-runtime.yaml";
  const legacyPlan = join(authorityRoot, ...locator.split("/"));
  const canonicalPlan = join(
    authorityRoot,
    "mission-control",
    "db",
    "data",
    "mission-control",
    "plans",
    "2026",
    "08",
    "DEV-6439-runtime.yaml",
  );
  await mkdir(join(legacyPlan, ".."), { recursive: true });
  await mkdir(join(canonicalPlan, ".."), { recursive: true });
  await writeFile(legacyPlan, "dev_code: DEV-6439\nstatus: archived\n");
  await writeFile(canonicalPlan, validPlanContents.replaceAll("CAC-0007", "DEV-6439"));

  expect(resolveAuthorityPlanPath("/unused", locator, authorityRoot)).toBe(canonicalPlan);
});

test.each([
  "mission-control/./plans/2026/08/DEV-6439-runtime.yaml",
  "mission-control/plans/../plans/2026/08/DEV-6439-runtime.yaml",
  "data/mission-control/plans/../../mission-control/plans/2026/08/DEV-6439-runtime.yaml",
])("rejects traversal-bearing legacy sidecar locator %s", async (planLocator) => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    sidecarOverrides: { mission_control_plan_path: planLocator },
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: false,
    sidecar_error: "Mission Control plan is outside the HumanAndMachine-ai authority",
  });
});

test("ignores environment overrides and keeps one local authority", () => {
  expect(resolveAuthorityRoot("/workspace/Conglomerate", {
    LAZURIO_MISSION_CONTROL_ROOT: "/fixtures/HumanAndMachine-ai_GEN3",
    HUMANANDMACHINES_ROOT: "/retired/HumanAndMachines",
  })).toBe("/workspace/Conglomerate/organizations/HumanAndMachine-ai_GEN3");
});

test("legacy sidecar locator fails toward repository-db when only a retired plan exists", async () => {
  const authorityRoot = await mkdtemp(join(tmpdir(), "worktree authority retired "));
  cleanupPaths.push(authorityRoot);
  const locator = "mission-control/plans/2026/08/DEV-6439-runtime.yaml";
  const legacyPlan = join(authorityRoot, ...locator.split("/"));
  const canonicalPlan = join(
    authorityRoot,
    "mission-control",
    "db",
    "data",
    "mission-control",
    "plans",
    "2026",
    "08",
    "DEV-6439-runtime.yaml",
  );
  await mkdir(join(legacyPlan, ".."), { recursive: true });
  await writeFile(legacyPlan, validPlanContents.replaceAll("CAC-0007", "DEV-6439"));

  expect(resolveAuthorityPlanPath("/unused", locator, authorityRoot)).toBe(canonicalPlan);
});

test("rejects a repository-db plans root redirected to retired legacy plans", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
  });
  const canonicalPlansRoot = join(
    fixture.authorityRoot,
    "mission-control",
    "db",
    "data",
    "mission-control",
    "plans",
  );
  const legacyPlansRoot = join(fixture.authorityRoot, "mission-control", "plans");
  const legacyPlan = join(legacyPlansRoot, "2026", "07", "CAC-0007-contract.yaml");
  await mkdir(join(legacyPlan, ".."), { recursive: true });
  await writeFile(legacyPlan, validPlanContents);
  await rm(canonicalPlansRoot, { recursive: true });
  await symlink(
    legacyPlansRoot,
    canonicalPlansRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: false,
    sidecar_error: expect.stringContaining(
      "canonical repository-db plan root resolves through a redirected path",
    ),
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

test("fails closed when a matching plan code has a non-canonical schema", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    planContents: validPlanContents.replace(
      "companiesascode.mission_control.plan.v2",
      "not-a-mission-control-plan",
    ),
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: false,
    sidecar_error: expect.stringContaining(
      "Mission Control plan schema validation failed",
    ),
  });
});

test("fails closed when canonical semantic plan validation rejects a schema-valid plan", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    planContents: validPlanContents.replace(
      'title: "Worktree contract fixture"',
      'title: "Semantically invalid"',
    ),
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: false,
    sidecar_error: expect.stringContaining(
      "Mission Control repository-db semantic validation failed",
    ),
  });
});

test("fails closed when selected plan id does not match dev_code", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    planContents: validPlanContents.replace(
      "id: mcplan-cac-0007",
      "id: mcplan-cac-9999",
    ),
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    sidecar_valid: false,
    sidecar_error: "Mission Control plan id must match dev_code",
  });
});

test("fails closed on root identity, scope and path mutations", async () => {
  const cases = [
    ["base_branch", "release"],
    ["organization", "OtherOrg"],
    ["organization_path", "../../OtherOrg"],
    ["organization_path", "/OtherOrg"],
    ["workspace", "productionspace"],
    ["module", "OtherModule"],
    ["module_path", "../../OtherModule"],
    ["module_path", "C:\\OtherModule"],
  ];
  for (const [field, value] of cases) {
    const fixture = await createFixture({
      authorityAvailable: true,
      planAvailable: true,
      sidecarOverrides: { [field]: value },
    });
    const report = await auditRepository(fixture.root, {
      authorityRoot: fixture.authorityRoot,
    });
    expect(canonicalWorktree(report)).toMatchObject({
      sidecar_valid: false,
      sidecar_error: `${field} does not match canonical repository identity`,
    });
    expect(report.violations.join("\n")).toContain(
      "canonical worktree has invalid sidecar",
    );
  }
});

test("fails closed when the owning plan dev_code does not match the sidecar", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    planContents: validPlanContents
      .replaceAll("CAC-0007", "CAC-9999")
      .replace("mcplan-cac-0007", "mcplan-cac-9999"),
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

test("accepts a pristine create-lane worktree before its first push", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    publishFeatureBranch: false,
  });
  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    lifecycle: "active",
    upstream: null,
    ahead: 0,
    behind: 0,
    fresh_unpublished: true,
    remote_verified: true,
    remote_preserved: true,
    remote_error: null,
  });
  expect(report.violations.join("\n")).not.toContain(
    "canonical worktree branch has no upstream",
  );
});

test("fails closed when an unpublished worktree has diverged from its base", async () => {
  const fixture = await createFixture({
    authorityAvailable: true,
    planAvailable: true,
    publishFeatureBranch: false,
  });
  await writeFile(join(fixture.canonical, "draft.txt"), "local-only\n");
  git(fixture.canonical, ["add", "draft.txt"]);
  git(fixture.canonical, ["commit", "-m", "local-only draft"]);

  const report = await auditRepository(fixture.root, {
    authorityRoot: fixture.authorityRoot,
  });
  expect(canonicalWorktree(report)).toMatchObject({
    lifecycle: "needs_attention",
    upstream: null,
    fresh_unpublished: false,
    remote_preserved: false,
  });
  expect(report.violations.join("\n")).toContain(
    "canonical worktree branch has no upstream",
  );
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
    sidecar_advisories: expect.arrayContaining([
      expect.stringContaining("plan ownership was not verified"),
    ]),
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
  planContents = validPlanContents,
  objectFormat = "sha1",
  sidecarOverrides = {},
  publishFeatureBranch = true,
}) {
  const sandbox = await mkdtemp(join(tmpdir(), "worktree contract "));
  cleanupPaths.push(sandbox);
  const root = join(sandbox, "Dashboard");
  const authorityRoot = join(sandbox, "HumanAndMachines");
  const remote = join(sandbox, "remotes", "HumanAndMachines", "Dashboard.git");
  const planRelativePath =
    "mission-control/plans/2026/07/CAC-0007-contract.yaml";
  const repositoryDbRoot = join(authorityRoot, "mission-control", "db");
  const planPath = join(
    repositoryDbRoot,
    "data",
    "mission-control",
    "plans",
    "2026",
    "07",
    "CAC-0007-contract.yaml",
  );
  const semanticValidatorPath = join(
    repositoryDbRoot,
    "scripts",
    "validate-mission-control-data.mjs",
  );

  await mkdir(root);
  await mkdir(remote, { recursive: true });
  if (authorityAvailable) {
    await mkdir(join(planPath, ".."), { recursive: true });
    await mkdir(join(repositoryDbRoot, "schemas"), { recursive: true });
    await mkdir(join(semanticValidatorPath, ".."), { recursive: true });
    await writeFile(
      join(repositoryDbRoot, "schemas", "mission-control-plan.schema.json"),
      `${JSON.stringify(fixturePlanSchema, null, 2)}\n`,
    );
    await writeFile(
      semanticValidatorPath,
      fixtureSemanticValidator,
    );
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
  if (publishFeatureBranch) {
    git(canonical, ["push", "-u", "origin", `codex/${basename}`]);
  }
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
      ...sidecarOverrides,
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
    "LAZURIO_MISSION_CONTROL_ROOT",
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
