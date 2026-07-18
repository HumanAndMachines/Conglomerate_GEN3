import { afterAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { dirname, join } from "path";
import { buildWorktreeIndex } from "./worktree-lib.mjs";
import { createWorktreeFromPlan, publishWorktreeDraft, WorktreeActionError } from "./worktree-actions-lib.mjs";
import { createLaunchpadGitFixture, initGitRepo, runGit } from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("guarded create makes a canonical Mission-Control-owned worktree with sidecar metadata", async () => {
  const { root, orgRoot, dealsRepo } = await setupDealsRepoWithPlan();

  const created = await createWorktreeFromPlan({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
  });

  expect(created).toMatchObject({
    schema_version: "companiesascode.launchpad.worktree_action.v1",
    action: "create_worktree",
    repo_key: "BetaCo::deals",
    worktree: {
      slug: "CAC-0042-deals-publish",
      path: "organizations/BetaCo_GEN3/.worktrees/workspace/deals/CAC-0042-deals-publish",
      sidecar_path: "organizations/BetaCo_GEN3/.worktrees/workspace/deals/CAC-0042-deals-publish.worktree.json",
      branch: "CAC-0042-deals-publish",
      ownership_status: "owned",
      owner_plan: {
        code: "CAC-0042",
        title: "Deals publish assistant",
      },
    },
  });

  const worktreePath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish");
  expect(runGit(["branch", "--show-current"], worktreePath)).toBe("CAC-0042-deals-publish");

  const sidecar = JSON.parse(await readFile(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"), "utf8"));
  expect(sidecar).toMatchObject({
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    module_path: "modules/deals",
    repo_kind: "module",
    base_branch: "main",
    branch: "CAC-0042-deals-publish",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-deals-publish",
    created_by: "test-agent",
    status: "active",
  });

  const index = await buildWorktreeIndex({ companiesRoot: root, organization: "BetaCo", module: "deals" });
  expect(index.worktrees.find((worktree) => worktree.slug === "CAC-0042-deals-publish")).toMatchObject({
    ownership_status: "owned",
    status: "active",
  });

  expect(runGit(["status", "--porcelain=v1"], dealsRepo)).toBe("");
});

test("guarded create writes a sidecar satisfying every worktree.schema.json required field and enum", async () => {
  const { root, orgRoot } = await setupDealsRepoWithPlan();

  await createWorktreeFromPlan({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
  });

  const schema = JSON.parse(await readFile(join(import.meta.dir, "..", "schemas", "worktree.schema.json"), "utf8"));
  const sidecar = JSON.parse(
    await readFile(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"), "utf8"),
  );

  const missingRequired = schema.required.filter((field) => !(field in sidecar));
  expect(missingRequired).toEqual([]);
  expect(sidecar.schema_version).toBe(schema.properties.schema_version.const);
  expect(schema.properties.repo_kind.enum).toContain(sidecar.repo_kind);
  expect(schema.properties.status.enum).toContain(sidecar.status);
  expect(sidecar.mission_control_plan_code).toMatch(new RegExp(schema.properties.mission_control_plan_code.pattern));
});

test("guarded create accepts the canonical nested Mission Control v3 data path and keeps it exact in the sidecar", async () => {
  const nestedPlanPath = "mission-control/db/data/mission-control/plans/2026/07/CAC-0042-deals-publish.yaml";
  const { root, orgRoot } = await setupDealsRepoWithPlan({ planRelativePath: nestedPlanPath });

  const created = await createWorktreeFromPlan({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    planPath: nestedPlanPath,
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
  });

  expect(created.worktree).toMatchObject({
    ownership_status: "owned",
    owner_plan: {
      code: "CAC-0042",
      path: nestedPlanPath,
    },
  });
  const sidecar = JSON.parse(
    await readFile(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"), "utf8"),
  );
  expect(sidecar.mission_control_plan_path).toBe(nestedPlanPath);
});

test("guarded create rejects a non-exact plan path alias before creating a worktree", async () => {
  const { root, orgRoot } = await setupDealsRepoWithPlan();

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/../07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      createdBy: "test-agent",
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "invalid_plan_path",
    status: 400,
  });

  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"))).toBe(false);
});

test("guarded create odmítne Windows drive-qualified planPath", async () => {
  const { root, orgRoot } = await setupDealsRepoWithPlan();

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "D:mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      createdBy: "test-agent",
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "unsafe_path",
    status: 400,
  });

  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"))).toBe(false);
});

test("guarded create refuses dirty main checkout and leaves no worktree behind", async () => {
  const { root, orgRoot, dealsRepo } = await setupDealsRepoWithPlan();
  await writeFile(join(dealsRepo, "draft.md"), "dirty main draft\n");

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      createdBy: "test-agent",
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "repo_not_clean",
    status: 409,
  });

  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"))).toBe(false);
});

test("worktree create i publish fail-closed odmítnou productionspace repo", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "OmegaCo_GEN3");
  const manifestPath = join(orgRoot, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.module_slots.push({
    path: "productionspace/firmware",
    space: "productionspace",
    category: "firmware",
    repo: "git@github.com:OmegaCo/firmware.git",
    branch: "main",
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await initGitRepo(join(orgRoot, "productionspace", "firmware"));

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "OmegaCo::firmware",
      planPath: "mission-control/plans/2026/07/CAC-0042-firmware.yaml",
      branch: "CAC-0042-firmware",
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "productionspace_read_only",
    status: 403,
  });

  await expect(
    publishWorktreeDraft({
      companiesRoot: root,
      repoKey: "OmegaCo::firmware",
      slug: "CAC-0042-firmware",
      commitMessage: "Publikovat firmware draft",
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "productionspace_read_only",
    status: 403,
  });

  expect(existsSync(join(orgRoot, ".worktrees", "productionspace", "firmware"))).toBe(false);
});

test("publish assistant commits local draft and pushes branch without opening PR", async () => {
  const { root, orgRoot, remotePath } = await setupDealsRepoWithPlan();
  const created = await createWorktreeFromPlan({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
  });
  const worktreePath = join(root, created.worktree.path);
  await writeFile(join(worktreePath, "draft.md"), "publish me\n");

  const published = await publishWorktreeDraft({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    slug: "CAC-0042-deals-publish",
    commitMessage: "feat: publish deals draft",
    publisher: "test-agent",
  });

  expect(published).toMatchObject({
    schema_version: "companiesascode.launchpad.worktree_action.v1",
    action: "publish_worktree",
    repo_key: "BetaCo::deals",
    branch: "CAC-0042-deals-publish",
    pushed: true,
    pr_opened: false,
  });
  expect(published.commit.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(runGit(["status", "--porcelain=v1"], worktreePath)).toBe("");

  const remoteRef = runGit(["--git-dir", remotePath, "rev-parse", "refs/heads/CAC-0042-deals-publish"], root);
  expect(remoteRef).toBe(published.commit.sha);

  const sidecar = JSON.parse(await readFile(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"), "utf8"));
  expect(sidecar).toMatchObject({
    branch: "CAC-0042-deals-publish",
    pr_url: null,
    status: "active",
  });
  expect(sidecar.last_published_by).toBe("test-agent");
  expect(sidecar.last_published_commit).toBe(published.commit.sha);
});

async function setupDealsRepoWithPlan({
  planRelativePath = "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
} = {}) {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const dealsRepo = join(orgRoot, "modules", "deals");
  const remotePath = join(root, "remotes", "deals.git");
  await initGitRepo(dealsRepo, { remotePath });
  const absolutePlanPath = join(orgRoot, planRelativePath);
  await mkdir(dirname(absolutePlanPath), { recursive: true });
  await writeFile(
    absolutePlanPath,
    [
      "dev_code: CAC-0042",
      "title: Deals publish assistant",
      "status: in_progress",
      "links:",
      "  - path: modules/deals",
      "",
    ].join("\n"),
  );
  return { root, orgRoot, dealsRepo, remotePath };
}
