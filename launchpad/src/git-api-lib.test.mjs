import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  buildGitApiResponse,
  buildPlansResponse,
  buildRepoChangesResponse,
  buildWorktreesResponse,
} from "./git-api-lib.mjs";
import { buildLaunchpadAppsResponse } from "./diagnostics-lib.mjs";
import {
  createLaunchpadGitFixture,
  createPackageApp,
  initGitRepo,
  writeJson,
} from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("git API response combines manifest inventory, repo statuses, worktrees and plan ownership", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  await initGitRepo(dealsRepo);
  await writeFile(join(dealsRepo, "draft.md"), "local draft\n");
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const planPath = join(orgRoot, "mission-control", "plans", "2026", "07", "DEV-6327-deals-git-status.yaml");
  await mkdir(join(orgRoot, ".worktrees", "workspace", "deals"), { recursive: true });
  await writeFile(planPath, "dev_code: DEV-6327\ntitle: Deals Git status badges\nstatus: in_progress\nlinks:\n  - path: workspace/deals\n");
  await initGitRepo(join(orgRoot, ".worktrees", "workspace", "deals", "DEV-6327-deals-git-status"), {
    branch: "DEV-6327-deals-git-status",
  });
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "DEV-6327-deals-git-status.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    module_path: "workspace/deals",
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

  const response = await buildGitApiResponse({ companiesRoot: root });
  const deals = response.repos.find((repo) => repo.key === "BetaCo::deals");

  expect(response.schema_version).toBe("companiesascode.launchpad.git.v1");
  expect(response.summary.repo_count).toBeGreaterThanOrEqual(1);
  expect(response.summary.worktree_count).toBe(1);
  expect(deals).toMatchObject({
    status: "draft_changes",
    severity: "warn",
    counts: { changed_files: 1, untracked_files: 1 },
    worktrees: ["DEV-6327-deals-git-status"],
    mission_control_ownership: {
      required: true,
      owner_plan_code: "DEV-6327",
      orphan: false,
    },
  });
});

test("worktree projection preserves visible Team-scoped modules and root repositories", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const betaRoot = join(root, "organizations", "BetaCo_GEN3");
  const betaManifestPath = join(betaRoot, "modules.manifest.json");
  const betaManifest = JSON.parse(await readFile(betaManifestPath, "utf8"));
  const deals = betaManifest.module_slots.find((slot) => slot.path === "workspace/deals");
  deals.teams = ["sales"];
  await writeJson(betaManifestPath, betaManifest);
  await initGitRepo(join(betaRoot, "workspace", "deals"));
  await createOwnedWorktreeFixture({
    root,
    organization: "BetaCo",
    organizationPath: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    modulePath: "workspace/deals",
    repoKind: "module",
    slug: "team-review",
    planCode: "DEV-7001",
  });

  const omegaRoot = join(root, "organizations", "OmegaCo_GEN3");
  await initGitRepo(join(omegaRoot, "infra"));
  await createOwnedWorktreeFixture({
    root,
    organization: "OmegaCo",
    organizationPath: "organizations/OmegaCo_GEN3",
    workspace: "root",
    module: "infra",
    modulePath: "infra",
    repoKind: "root_repo",
    slug: "infra-review",
    planCode: "DEV-7002",
  });

  const [betaResponse, omegaResponse, betaWorktrees, omegaWorktrees] = await Promise.all([
    buildGitApiResponse({ companiesRoot: root, organization: "BetaCo" }),
    buildGitApiResponse({ companiesRoot: root, organization: "OmegaCo" }),
    buildWorktreesResponse({ companiesRoot: root, organization: "BetaCo", module: "deals" }),
    buildWorktreesResponse({ companiesRoot: root, organization: "OmegaCo", module: "infra" }),
  ]);

  expect(betaResponse.repos.find((repo) => repo.key === "BetaCo::deals")).toMatchObject({
    workspace: "sales",
    worktrees: ["team-review"],
  });
  expect(omegaResponse.repos.find((repo) => repo.key === "OmegaCo::infra")).toMatchObject({
    workspace: null,
    worktrees: ["infra-review"],
  });
  expect(betaWorktrees.worktrees.map((worktree) => worktree.slug)).toEqual(["team-review"]);
  expect(omegaWorktrees.worktrees.map((worktree) => worktree.slug)).toEqual(["infra-review"]);
});

test("worktree projection resolves basename collisions before applying protected visibility", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const manifestPath = join(orgRoot, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.module_slots.push(
    {
      path: "workspace/shared-name",
      slug: "visible-shared",
      teams: ["sales"],
      repo: "git@github.com:BetaCo/shared-name.git",
      branch: "main",
    },
    {
      path: "modules/shared-name",
      slug: "hidden-shared",
      teams: ["knowledge"],
      default_access: "restricted",
      required_roles: ["knowledge"],
      repo: "git@github.com:BetaCo/shared-name.git",
      branch: "main",
    },
  );
  await writeJson(manifestPath, manifest);

  const worktreeRoot = join(orgRoot, ".worktrees", "workspace", "shared-name");
  await initGitRepo(join(worktreeRoot, "protected-review"), { branch: "protected-review" });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "DEV-7003-protected.yaml"),
    "dev_code: DEV-7003\ntitle: Protected basename collision\nstatus: in_progress\ncontext: This protected plan merely mentions workspace/shared-name and visible-shared.\nlinks:\n  - path: modules/shared-name\n",
  );
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "DEV-7004-visible.yaml"),
    "dev_code: DEV-7004\ntitle: Visible basename collision\nstatus: ready\nlinks:\n  - path: workspace/shared-name\n",
  );
  await writeJson(join(worktreeRoot, "protected-review.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "knowledge",
    // Adversarial identity conflict: the stable ID names the visible slot,
    // while the canonical path and owner plan belong to the protected slot.
    module: "visible-shared",
    module_path: "modules/shared-name",
    repo_kind: "module",
    base_branch: "main",
    branch: "protected-review",
    mission_control_plan_code: "DEV-7003",
    mission_control_plan_path: "mission-control/plans/2026/07/DEV-7003-protected.yaml",
    created_at: new Date().toISOString(),
    created_by: "fixture-agent",
    status: "active",
  });

  const response = await buildGitApiResponse({ companiesRoot: root, organization: "BetaCo" });
  expect(response.repos.some((repo) => repo.key === "BetaCo::visible-shared")).toBe(true);
  expect(response.repos.some((repo) => repo.key === "BetaCo::hidden-shared")).toBe(false);
  expect(response.worktrees).toEqual([]);
  expect(response.summary.worktree_count).toBe(0);
  expect(JSON.stringify(response)).not.toContain("protected-review");

  const worktrees = await buildWorktreesResponse({
    companiesRoot: root,
    organization: "BetaCo",
    module: "shared-name",
  });
  expect(worktrees.worktrees).toEqual([]);
  expect(JSON.stringify(worktrees)).not.toContain("protected-review");

  const [organizationPlans, ambiguousPlans, visiblePlans, hiddenPlans] = await Promise.all([
    buildPlansResponse({ companiesRoot: root, organization: "BetaCo" }),
    buildPlansResponse({ companiesRoot: root, organization: "BetaCo", module: "shared-name" }),
    buildPlansResponse({ companiesRoot: root, organization: "BetaCo", module: "visible-shared" }),
    buildPlansResponse({ companiesRoot: root, organization: "BetaCo", module: "hidden-shared" }),
  ]);
  expect(organizationPlans.plans.map((plan) => plan.code)).toEqual(["DEV-7004"]);
  expect(JSON.stringify(organizationPlans)).not.toContain("DEV-7003");
  expect(ambiguousPlans.plans).toEqual([]);
  expect(JSON.stringify(ambiguousPlans)).not.toContain("DEV-7003");
  expect(visiblePlans.plans.map((plan) => plan.code)).toEqual(["DEV-7004"]);
  expect(visiblePlans.plans[0].module_match).toBe("direct");
  expect(JSON.stringify(visiblePlans)).not.toContain("DEV-7003");
  expect(JSON.stringify(visiblePlans)).not.toContain("Protected basename collision");
  expect(hiddenPlans.plans).toEqual([]);
});

test("apps diagnostics render structured Git warnings as human text", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const worktreeRoot = join(orgRoot, ".worktrees", "workspace", "deals");
  const worktree = join(worktreeRoot, "legacy-warning");
  await initGitRepo(worktree, { branch: "legacy-warning" });
  await writeJson(join(worktreeRoot, "legacy-warning.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    workspace: "workspace",
    module: "deals",
    branch: "legacy-warning",
    mission_control_plan_code: "DEV-6327",
    mission_control_plan_path: "mission-control/plans/2026/07/DEV-6327-deals-git-status.yaml",
    owner: "legacy-agent",
    status: "active",
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  expect(response.warnings.some((warning) => warning.includes("[object Object]"))).toBe(false);
  expect(response.warnings.some((warning) => warning.includes("Nekanonické pole owner"))).toBe(true);
});

test("git API can limit polling work to the selected organization", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  await initGitRepo(join(root, "organizations", "BetaCo_GEN3"));
  await initGitRepo(join(root, "organizations", "BetaCo_GEN3", "workspace", "deals"));

  const response = await buildGitApiResponse({ companiesRoot: root, organization: "BetaCo" });

  expect(response.repos.length).toBeGreaterThan(0);
  expect(response.repos.every((repo) => repo.organization === "BetaCo")).toBe(true);
  expect(response.repos.some((repo) => repo.organization === "OmegaCo")).toBe(false);
});

test("git API hides protected repos until their checkout exists on this machine", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const omegaManifestPath = join(root, "organizations", "OmegaCo_GEN3", "modules.manifest.json");
  const betaManifestPath = join(root, "organizations", "BetaCo_GEN3", "modules.manifest.json");
  const omegaManifest = JSON.parse(await readFile(omegaManifestPath, "utf8"));
  const betaManifest = JSON.parse(await readFile(betaManifestPath, "utf8"));
  const infra = omegaManifest.module_slots.find((slot) => slot.path === "infra");
  infra.default_access = "restricted";
  infra.required_roles = ["engineering"];
  const future = omegaManifest.module_slots.find((slot) => slot.path === "workspace/future-module");
  future.default_access = "private";
  const knowledgebase = betaManifest.module_slots.find(
    (slot) => slot.path === "workspace/knowledgebase",
  );
  knowledgebase.default_access = "role_based";
  knowledgebase.required_roles = ["knowledge"];
  await writeJson(omegaManifestPath, omegaManifest);
  await writeJson(betaManifestPath, betaManifest);

  const protectedWorktreeRoot = join(
    root,
    "organizations",
    "BetaCo_GEN3",
    ".worktrees",
    "workspace",
    "knowledgebase",
  );
  await initGitRepo(join(protectedWorktreeRoot, "protected-review"), {
    branch: "protected-review",
  });
  await writeJson(join(protectedWorktreeRoot, "protected-review.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "knowledgebase",
    module_path: "workspace/knowledgebase",
    repo_kind: "module",
    base_branch: "main",
    branch: "protected-review",
    mission_control_plan_code: "DEV-9999",
    mission_control_plan_path: "mission-control/plans/2026/07/DEV-9999-protected.yaml",
    created_at: new Date().toISOString(),
    created_by: "fixture-agent",
    status: "active",
  });
  await writeFile(
    join(root, "organizations", "BetaCo_GEN3", "mission-control", "plans", "2026", "07", "DEV-9999-protected.yaml"),
    "dev_code: DEV-9999\ntitle: Protected worktree\nstatus: in_progress\nlinks:\n  - path: workspace/knowledgebase\n",
  );

  const before = await buildGitApiResponse({ companiesRoot: root });
  expect(before.repos.some((repo) => repo.key === "OmegaCo::infra")).toBe(false);
  expect(before.repos.some((repo) => repo.key === "BetaCo::knowledgebase")).toBe(false);
  expect(before.planned.some((repo) => repo.key === "OmegaCo::future-module")).toBe(false);
  expect(JSON.stringify(before)).not.toContain("workspace/knowledgebase");
  expect(before.worktrees).toEqual([]);
  expect(before.summary.worktree_count).toBe(0);

  const protectedWorktrees = await buildWorktreesResponse({
    companiesRoot: root,
    organization: "BetaCo",
    module: "knowledgebase",
  });
  expect(protectedWorktrees.worktrees).toEqual([]);
  expect(protectedWorktrees.warnings).toEqual([]);
  expect(JSON.stringify(protectedWorktrees)).not.toContain("protected-review");

  const protectedPlans = await buildPlansResponse({
    companiesRoot: root,
    organization: "BetaCo",
    module: "knowledgebase",
  });
  expect(protectedPlans.plans).toEqual([]);

  try {
    await buildRepoChangesResponse({ companiesRoot: root, repoKey: "BetaCo::knowledgebase" });
    throw new Error("Protected changes response unexpectedly succeeded.");
  } catch (error) {
    expect(error).toMatchObject({ status: 404, code: "repo_not_found" });
  }

  await initGitRepo(join(root, "organizations", "OmegaCo_GEN3", "infra"));
  const after = await buildGitApiResponse({ companiesRoot: root });
  expect(after.repos.find((repo) => repo.key === "OmegaCo::infra")).toMatchObject({
    status: "up_to_date",
    repo_path: "organizations/OmegaCo_GEN3/infra",
  });
});

test("changes response exposes filenames and porcelain status without file contents", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  await initGitRepo(dealsRepo);
  await writeFile(join(dealsRepo, "secret-looking.md"), "token = not returned by the API\n");

  const response = await buildRepoChangesResponse({ companiesRoot: root, repoKey: "BetaCo::deals" });

  expect(response.repo_key).toBe("BetaCo::deals");
  expect(response.changes).toEqual([
    expect.objectContaining({ path: "secret-looking.md", porcelain: "??" }),
  ]);
  expect(JSON.stringify(response)).not.toContain("not returned by the API");
});

test("/api/apps app objects include compact git summary for their module", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  await initGitRepo(dealsRepo);
  await writeFile(join(dealsRepo, "draft.md"), "local draft\n");
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const planPath = join(orgRoot, "mission-control", "plans", "2026", "07", "DEV-6327-deals-git-status.yaml");
  await mkdir(join(orgRoot, ".worktrees", "workspace", "deals"), { recursive: true });
  await writeFile(planPath, "dev_code: DEV-6327\ntitle: Deals Git status badges\nstatus: in_progress\nlinks:\n  - path: workspace/deals\n");
  await initGitRepo(join(orgRoot, ".worktrees", "workspace", "deals", "DEV-6327-deals-git-status"), {
    branch: "DEV-6327-deals-git-status",
  });
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "DEV-6327-deals-git-status.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    module_path: "workspace/deals",
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
  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/workspace/deals/app/v1",
    app: {
      id: "deals-v1",
      title: "Deals",
      company: "BetaCo",
      module: "deals",
      port: 5310,
    },
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  expect(response.apps[0].git).toMatchObject({
    repo_key: "BetaCo::deals",
    status: "draft_changes",
    severity: "warn",
    changedFiles: 2,
    activeWorktreeCount: 1,
    missionControlOwnership: {
      required: true,
      ownerPlanCode: "DEV-6327",
      ownerPlanTitle: "Deals Git status badges",
      orphan: false,
    },
  });
  expect(response.apps[0].git.worktrees[0]).toMatchObject({
    slug: "DEV-6327-deals-git-status",
    branch: "DEV-6327-deals-git-status",
    ownershipStatus: "owned",
    status: "active",
    ownerPlan: {
      code: "DEV-6327",
      title: "Deals Git status badges",
    },
  });
});

async function createOwnedWorktreeFixture({
  root,
  organization,
  organizationPath,
  workspace,
  module,
  modulePath,
  repoKind,
  slug,
  planCode,
}) {
  const organizationRoot = join(root, organizationPath);
  const planRelativePath = `mission-control/plans/2026/07/${planCode}-${slug}.yaml`;
  const worktreeRelativePath = `.worktrees/${workspace}/${module}/${slug}`;
  await writeFile(
    join(organizationRoot, planRelativePath),
    `dev_code: ${planCode}\ntitle: ${slug}\nstatus: in_progress\nlinks:\n  - path: ${modulePath}\n`,
  );
  await initGitRepo(join(organizationRoot, worktreeRelativePath), { branch: slug });
  await writeJson(join(organizationRoot, `.worktrees/${workspace}/${module}/${slug}.worktree.json`), {
    schema_version: "companiesascode.worktree.v1",
    organization,
    organization_path: organizationPath,
    workspace,
    module,
    module_path: modulePath,
    repo_kind: repoKind,
    base_branch: "main",
    branch: slug,
    mission_control_plan_code: planCode,
    mission_control_plan_path: planRelativePath,
    worktree_path: worktreeRelativePath,
    created_at: new Date().toISOString(),
    created_by: "fixture-agent",
    status: "active",
  });
}
