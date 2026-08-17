import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  buildGitApiResponse,
  buildPlansResponse,
  buildPullAllResponse,
  buildRepoChangesResponse,
  buildRepoPullResponse,
  buildWorktreesResponse,
} from "./git-api-lib.mjs";
import { buildLaunchpadAppsResponse } from "./diagnostics-lib.mjs";
import {
  createLaunchpadGitFixture,
  createPackageApp,
  initGitRepo,
  normalizeLineEndings,
  runGit,
  setModuleRepository,
  setOrganizationRepository,
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

test("pull response fast-forwards only clean expected-branch repositories", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  const remotePath = join(root, "remotes", "deals.git");
  await initGitRepo(dealsRepo, { remotePath });
  await setModuleRepository({
    root,
    orgPath: "organizations/BetaCo_GEN3",
    module: "deals",
    repo: remotePath,
  });
  const contributor = join(root, "tmp", "deals-contributor");
  await mkdir(join(root, "tmp"), { recursive: true });
  runGit(["clone", remotePath, contributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  runGit(["config", "user.email", "fixture@example.com"], contributor);
  runGit(["config", "user.name", "Fixture"], contributor);
  await writeFile(join(contributor, "remote.md"), "remote change\n");
  runGit(["add", "remote.md"], contributor);
  runGit(["commit", "-m", "remote change"], contributor);
  runGit(["push", "origin", "main"], contributor);

  const response = await buildRepoPullResponse({ companiesRoot: root, repoKey: "BetaCo::deals" });

  expect(response.repo_key).toBe("BetaCo::deals");
  expect(response.pulled).toBe(true);
  expect(response.before.status).toBe("pull_available");
  expect(response.after.status).toBe("up_to_date");
  expect(response.after.head.short_sha).not.toBe(response.before.head.short_sha);
});

test("individual pull also allows an Organization root repo", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const remotePath = join(root, "remotes", "organization-root-single.git");
  await initGitRepo(orgRoot, { remotePath });
  await setOrganizationRepository({
    root,
    orgPath: "organizations/BetaCo_GEN3",
    repo: remotePath,
  });
  await writeFile(join(orgRoot, ".git", "info", "exclude"), "*\n");
  const contributor = join(root, "tmp", "organization-root-single-contributor");
  await mkdir(join(root, "tmp"), { recursive: true });
  runGit(["clone", remotePath, contributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  runGit(["config", "user.email", "fixture@example.com"], contributor);
  runGit(["config", "user.name", "Fixture"], contributor);
  await writeFile(join(contributor, "root-update.md"), "root update\n");
  runGit(["add", "root-update.md"], contributor);
  runGit(["commit", "-m", "root update"], contributor);
  runGit(["push", "origin", "main"], contributor);

  const response = await buildRepoPullResponse({ companiesRoot: root, repoKey: "BetaCo::root" });

  expect(response.pulled).toBe(true);
  expect(response.repo_key).toBe("BetaCo::root");
  expect(normalizeLineEndings(await readFile(join(orgRoot, "root-update.md"), "utf8"))).toBe("root update\n");
});

test("pull response refuses dirty repositories instead of hiding local draft work", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  const remotePath = join(root, "remotes", "dirty-deals.git");
  await initGitRepo(dealsRepo, { remotePath });
  await setModuleRepository({
    root,
    orgPath: "organizations/BetaCo_GEN3",
    module: "deals",
    repo: remotePath,
  });
  await writeFile(join(dealsRepo, "draft.md"), "local draft\n");

  try {
    await buildRepoPullResponse({ companiesRoot: root, repoKey: "BetaCo::deals" });
    throw new Error("expected pull to be refused");
  } catch (error) {
    expect(error.status).toBe(409);
    expect(error.code).toBe("pull_not_safe");
    expect(error.message).toContain("rozepsaná práce");
  }
});

test("pull response refuses productionspace repos even when a fast-forward pull is available", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "OmegaCo_GEN3");
  await writeJson(join(orgRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    github_org: "OmegaCo",
    module_slots: [
      {
        path: "productionspace/firmware",
        category: "firmware",
        repo: "git@github.com:OmegaCo/firmware.git",
        branch: "main",
      },
    ],
  });
  const firmwareRepo = join(orgRoot, "productionspace", "firmware");
  const remotePath = join(root, "remotes", "firmware.git");
  await initGitRepo(firmwareRepo, { remotePath });
  const contributor = join(root, "tmp", "firmware-contributor");
  await mkdir(join(root, "tmp"), { recursive: true });
  runGit(["clone", remotePath, contributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  runGit(["config", "user.email", "fixture@example.com"], contributor);
  runGit(["config", "user.name", "Fixture"], contributor);
  await writeFile(join(contributor, "remote-firmware.md"), "remote productionspace change\n");
  runGit(["add", "remote-firmware.md"], contributor);
  runGit(["commit", "-m", "remote productionspace change"], contributor);
  runGit(["push", "origin", "main"], contributor);

  try {
    await buildRepoPullResponse({ companiesRoot: root, repoKey: "OmegaCo::firmware" });
    throw new Error("expected productionspace pull to be refused");
  } catch (error) {
    expect(error.status).toBe(403);
    expect(error.code).toBe("pull_scope_forbidden");
    expect(error.message).toContain("productionspace");
  }
});

test("pull response allows org root-space slots (CAC-0083): mission-control-like repa jdou stáhnout ff-only", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const infraRepo = join(root, "organizations", "OmegaCo_GEN3", "infra");
  const remotePath = join(root, "remotes", "infra.git");
  await initGitRepo(infraRepo, { remotePath });
  await setModuleRepository({
    root,
    orgPath: "organizations/OmegaCo_GEN3",
    module: "infra",
    repo: remotePath,
  });
  const contributor = join(root, "tmp", "infra-contributor");
  await mkdir(join(root, "tmp"), { recursive: true });
  runGit(["clone", remotePath, contributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  runGit(["config", "user.email", "fixture@example.com"], contributor);
  runGit(["config", "user.name", "Fixture"], contributor);
  await writeFile(join(contributor, "remote-infra.md"), "remote root-slot change\n");
  runGit(["add", "remote-infra.md"], contributor);
  runGit(["commit", "-m", "remote root-slot change"], contributor);
  runGit(["push", "origin", "main"], contributor);

  const payload = await buildRepoPullResponse({ companiesRoot: root, repoKey: "OmegaCo::infra" });
  expect(payload.pulled).toBe(true);
  expect(payload.action).toBe("pull_ff_only");
  expect(runGit(["log", "-1", "--format=%s"], infraRepo)).toBe("remote root-slot change");
});

test("pull all updates Organization roots and workspace modules, using autostash where safe", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const orgRemote = join(root, "remotes", "organization-root.git");
  const dealsRepo = join(orgRoot, "workspace", "deals");
  const dealsRemote = join(root, "remotes", "deals-bulk.git");
  await initGitRepo(orgRoot, { remotePath: orgRemote });
  await initGitRepo(dealsRepo, { remotePath: dealsRemote });
  await setOrganizationRepository({
    root,
    orgPath: "organizations/BetaCo_GEN3",
    repo: orgRemote,
  });
  await setModuleRepository({
    root,
    orgPath: "organizations/BetaCo_GEN3",
    module: "deals",
    repo: dealsRemote,
  });
  await writeFile(join(orgRoot, ".git", "info", "exclude"), "workspace/\n");
  await writeFile(join(orgRoot, "manual", "README.md"), "# Manual\n");
  await writeFile(join(orgRoot, "company", "colleagues", "README.md"), "# Colleagues\n");
  runGit([
    "add",
    "company.gen3.json",
    "modules.manifest.json",
    "TODO.tasks.json",
    "DONE.tasks.json",
    "ISSUES.open.json",
    "manual/README.md",
    "company/colleagues/README.md",
  ], orgRoot);
  runGit(["commit", "-m", "track organization manifests"], orgRoot);
  runGit(["push", "origin", "main"], orgRoot);

  const orgContributor = join(root, "tmp", "org-contributor");
  const dealsContributor = join(root, "tmp", "deals-bulk-contributor");
  await mkdir(join(root, "tmp"), { recursive: true });
  for (const [remote, contributor, filename] of [
    [orgRemote, orgContributor, "remote-root.md"],
    [dealsRemote, dealsContributor, "remote-deals.md"],
  ]) {
    runGit(["clone", remote, contributor], root);
    runGit(["checkout", "-B", "main", "origin/main"], contributor);
    runGit(["config", "user.email", "fixture@example.com"], contributor);
    runGit(["config", "user.name", "Fixture"], contributor);
    await writeFile(join(contributor, filename), "remote change\n");
    runGit(["add", filename], contributor);
    runGit(["commit", "-m", filename], contributor);
    runGit(["push", "origin", "main"], contributor);
  }
  await writeFile(join(orgRoot, "local-root-draft.md"), "preserve me\n");

  const response = await buildPullAllResponse({ companiesRoot: root });
  const rootResult = response.results.find((result) => result.repo_key === "BetaCo::root");
  const dealsResult = response.results.find((result) => result.repo_key === "BetaCo::deals");

  expect(rootResult.outcome).toBe("autostash_pulled");
  expect(response.results.map((result) => [result.repo_key, result.outcome]))
    .toContainEqual(["BetaCo::deals", "pulled"]);
  expect(dealsResult.outcome).toBe("pulled");
  expect(response.summary.updated_count).toBe(2);
  expect(response.summary.autostash_count).toBe(1);
  expect(normalizeLineEndings(await readFile(join(orgRoot, "local-root-draft.md"), "utf8"))).toBe("preserve me\n");
  expect(normalizeLineEndings(await readFile(join(orgRoot, "remote-root.md"), "utf8"))).toBe("remote change\n");
  expect(normalizeLineEndings(await readFile(join(dealsRepo, "remote-deals.md"), "utf8"))).toBe("remote change\n");
}, 60_000);

test("pull all can stay inside the Organization selected in Launchpad", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);

  const response = await buildPullAllResponse({ companiesRoot: root, organization: "BetaCo" });

  expect(response.organization).toBe("BetaCo");
  expect(response.results.length).toBeGreaterThan(0);
  expect(response.results.every((result) => result.organization === "BetaCo")).toBe(true);
  expect(response.results.some((result) => result.organization === "OmegaCo")).toBe(false);
});

test("pull all does not expose an unmaterialized protected repo when sync cannot access it", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = join(root, "organizations", "BetaCo_GEN3", "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const knowledgebase = manifest.module_slots.find(
    (slot) => slot.path === "workspace/knowledgebase",
  );
  knowledgebase.default_access = "restricted";
  knowledgebase.required_roles = ["knowledge"];
  await writeJson(manifestPath, manifest);

  const response = await buildPullAllResponse({ companiesRoot: root, organization: "BetaCo" });

  expect(response.results.some((result) => result.repo_key === "BetaCo::knowledgebase")).toBe(false);
  expect(JSON.stringify(response)).not.toContain("knowledgebase");
});

test("pull all reloads a freshly pulled Organization manifest and materializes its new module in one action", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const omegaRoot = join(root, "organizations", "OmegaCo_GEN3");
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  await writeJson(join(omegaRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    organization_kind: "template",
    company: { slug: "OmegaCo", display_name: "OmegaCo template", github_org: "OmegaCo" },
  });
  await writeJson(join(orgRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [],
  });
  await writeFile(join(orgRoot, ".gitignore"), "/workspace/*/\n");

  const orgRemote = join(root, "remotes", "beta-organization-root.git");
  await initGitRepo(orgRoot, { remotePath: orgRemote });
  await setOrganizationRepository({
    root,
    orgPath: "organizations/BetaCo_GEN3",
    repo: orgRemote,
  });
  runGit(["add", "."], orgRoot);
  runGit(["commit", "-m", "organization baseline"], orgRoot);
  runGit(["push", "origin", "main"], orgRoot);

  const moduleRemote = join(root, "remotes", "lazurio-module.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio-module"), { remotePath: moduleRemote });

  const contributor = join(root, "tmp", "beta-org-contributor");
  await mkdir(join(root, "tmp"), { recursive: true });
  runGit(["clone", orgRemote, contributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  runGit(["config", "user.email", "fixture@example.com"], contributor);
  runGit(["config", "user.name", "Fixture"], contributor);
  await writeJson(join(contributor, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/lazurio",
        teams: ["lazurio"],
        default_access: "restricted",
        required_roles: ["builder"],
        git: { url: moduleRemote, branch: "main" },
      },
      {
        path: "workspace/future-lazurio",
        teams: ["lazurio"],
        status: "planned_slot",
      },
    ],
  });
  runGit(["add", "modules.manifest.json"], contributor);
  runGit(["commit", "-m", "declare Lazurio modules"], contributor);
  runGit(["push", "origin", "main"], contributor);

  const response = await buildPullAllResponse({ companiesRoot: root });

  expect(response.summary).toMatchObject({
    updated_count: 1,
    materialized_count: 1,
    missing_access_count: 0,
    failed_count: 0,
  });
  expect(response.results.find((result) => result.repo_key === "BetaCo::lazurio"))
    .toMatchObject({ outcome: "materialized", branch: "main" });
  expect(response.results.some((result) => result.repo_key === "BetaCo::future-lazurio")).toBe(false);
  expect(normalizeLineEndings(await readFile(join(orgRoot, "workspace", "lazurio", "README.md"), "utf8")))
    .toBe("# main\n");
  const projected = await buildGitApiResponse({ companiesRoot: root, organization: "BetaCo" });
  expect(projected.repos.some((repo) => repo.key === "BetaCo::lazurio")).toBe(true);
}, 20_000);

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
