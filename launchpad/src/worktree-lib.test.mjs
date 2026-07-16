import { afterAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { buildWorktreeIndex, detectNonCanonicalSidecarFields } from "./worktree-lib.mjs";
import { createLaunchpadGitFixture, initGitRepo, writeJson } from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("worktree scanner resolves canonical sidecar metadata to an owning Mission Control plan", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const worktreePath = join(orgRoot, ".worktrees", "workspace", "deals", "DEV-6327-deals-git-status");
  const planPath = join(orgRoot, "mission-control", "plans", "2026", "07", "DEV-6327-deals-git-status.yaml");
  await initGitRepo(worktreePath, { branch: "DEV-6327-deals-git-status" });
  await writeFile(
    planPath,
    "dev_code: DEV-6327\ntitle: Deals Git status badges\nstatus: in_progress\n",
  );
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "DEV-6327-deals-git-status.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    module_path: "modules/deals",
    repo_kind: "module",
    base_branch: "main",
    branch: "DEV-6327-deals-git-status",
    mission_control_plan_code: "DEV-6327",
    mission_control_plan_path: "mission-control/plans/2026/07/DEV-6327-deals-git-status.yaml",
    worktree_path: ".worktrees/workspace/deals/DEV-6327-deals-git-status",
    created_at: new Date().toISOString(),
    created_by: "examplebuddy-buddy",
    status: "active",
  });

  const index = await buildWorktreeIndex({ companiesRoot: root });
  const owned = index.worktrees.find((worktree) => worktree.plan_code === "DEV-6327");

  expect(owned).toMatchObject({
    organization: "BetaCo",
    workspace: "workspace",
    module: "deals",
    ownership_status: "owned",
    status: "active",
    owner_plan: {
      code: "DEV-6327",
      title: "Deals Git status badges",
      status: "in_progress",
    },
  });
});

test("detectNonCanonicalSidecarFields flags legacy alias keys but stays quiet for canonical sidecars", () => {
  expect(
    detectNonCanonicalSidecarFields({
      plan_code: "CAC-0042",
      owner: "examplebuddy-buddy",
      repo_kind: "root",
      status: "in_review",
    }),
  ).toEqual([
    expect.stringContaining("plan_code"),
    expect.stringContaining("owner"),
    expect.stringContaining("root"),
    expect.stringContaining("in_review"),
  ]);

  expect(
    detectNonCanonicalSidecarFields({
      mission_control_plan_code: "CAC-0042",
      created_by: "ultracode-opus",
      repo_kind: "root_repo",
      status: "merged_cleanup_needed",
    }),
  ).toEqual([]);
});

test("worktree index surfaces schema-shape warnings for non-canonical sidecar fields without blocking ownership", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const worktreePath = join(orgRoot, ".worktrees", "workspace", "deals", "DEV-6328-deals-owner-alias");
  const planPath = join(orgRoot, "mission-control", "plans", "2026", "07", "DEV-6328-deals-owner-alias.yaml");
  await initGitRepo(worktreePath, { branch: "DEV-6328-deals-owner-alias" });
  await writeFile(planPath, "dev_code: DEV-6328\ntitle: Owner alias\nstatus: in_progress\n");
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "DEV-6328-deals-owner-alias.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    module_path: "modules/deals",
    repo_kind: "module",
    base_branch: "main",
    branch: "DEV-6328-deals-owner-alias",
    mission_control_plan_code: "DEV-6328",
    mission_control_plan_path: "mission-control/plans/2026/07/DEV-6328-deals-owner-alias.yaml",
    worktree_path: ".worktrees/workspace/deals/DEV-6328-deals-owner-alias",
    created_at: new Date().toISOString(),
    owner: "examplebuddy-buddy",
    status: "active",
  });

  const index = await buildWorktreeIndex({ companiesRoot: root });
  const owned = index.worktrees.find((worktree) => worktree.plan_code === "DEV-6328");
  expect(owned.ownership_status).toBe("owned");
  expect(
    index.warnings.some(
      (warning) => warning.slug === "DEV-6328-deals-owner-alias" && /owner/.test(warning.message),
    ),
  ).toBe(true);
});

test("worktree scanner flags canonical folders without resolvable plan ownership as orphans", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const orphanPath = join(orgRoot, ".worktrees", "workspace", "deals", "DEV-9999-orphan");
  await initGitRepo(orphanPath, { branch: "DEV-9999-orphan" });

  const index = await buildWorktreeIndex({ companiesRoot: root });
  const orphan = index.worktrees.find((worktree) => worktree.slug === "DEV-9999-orphan");

  expect(orphan).toMatchObject({
    organization: "BetaCo",
    module: "deals",
    ownership_status: "orphan_missing_plan",
    status: "orphan_missing_plan",
  });
});

test("worktree scanner reports legacy worktree locations as invalid contract violations", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(orgRoot, ".claude", "worktrees", "old-agent-work"), { recursive: true });
  await mkdir(join(orgRoot, ".worktrees", "modules", "studio", "DEV-1234-old-layout"), { recursive: true });

  const index = await buildWorktreeIndex({ companiesRoot: root });

  expect(index.invalid_locations.map((item) => item.path)).toEqual(
    expect.arrayContaining([
      "organizations/OmegaCo_GEN3/.claude/worktrees",
      "organizations/OmegaCo_GEN3/.worktrees/modules",
    ]),
  );
});

test("worktree stale heuristic does not mark old dirty drafts as stale", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const worktreePath = join(orgRoot, ".worktrees", "workspace", "deals", "DEV-7000-old-draft");
  const planPath = join(orgRoot, "mission-control", "plans", "2026", "07", "DEV-7000-old-draft.yaml");
  await initGitRepo(worktreePath, { branch: "DEV-7000-old-draft" });
  await writeFile(join(worktreePath, "draft.md"), "dirty work should not be stale\n");
  await writeFile(planPath, "dev_code: DEV-7000\ntitle: Old dirty draft\nstatus: in_progress\n");
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "DEV-7000-old-draft.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    module_path: "modules/deals",
    repo_kind: "module",
    base_branch: "main",
    branch: "DEV-7000-old-draft",
    mission_control_plan_code: "DEV-7000",
    mission_control_plan_path: "mission-control/plans/2026/07/DEV-7000-old-draft.yaml",
    worktree_path: ".worktrees/workspace/deals/DEV-7000-old-draft",
    created_at: "2026-06-01T00:00:00.000Z",
    created_by: "examplebuddy-buddy",
    status: "active",
  });

  const index = await buildWorktreeIndex({ companiesRoot: root });
  const draft = index.worktrees.find((worktree) => worktree.plan_code === "DEV-7000");

  expect(draft).toMatchObject({
    ownership_status: "owned",
    status: "active",
  });
});
