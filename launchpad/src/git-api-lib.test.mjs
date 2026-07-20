import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import {
  buildGitApiResponse,
  buildPullAllResponse,
  buildRepoChangesResponse,
  buildRepoPublishIntentResponse,
  buildRepoPublishResponse,
  buildRepoPullResponse,
  createGitPublishAuthorizationStore,
  remoteIdentityForPublish,
} from "./git-api-lib.mjs";
import { buildLaunchpadAppsResponse } from "./diagnostics-lib.mjs";
import {
  createLaunchpadGitFixture,
  createPackageApp,
  initGitRepo,
  normalizeLineEndings,
  runGit,
  writeJson,
} from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function declareDealsRemote(root, remotePath) {
  const manifestPath = join(root, "organizations", "BetaCo_GEN3", "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const deals = manifest.module_slots.find((slot) => slot.path === "workspace/deals");
  deals.git = { url: remotePath, branch: "main" };
  delete deals.repo;
  await writeJson(manifestPath, manifest);
}

test("publish remote identity accepts GitHub forms but rejects lookalike hosts", () => {
  const cwd = "/tmp/example";
  expect(remoteIdentityForPublish("Owner/Repo", cwd)).toBe("raw:Owner/Repo");
  expect(remoteIdentityForPublish("Owner/Repo", cwd, { allowGithubShorthand: true })).toBe("github:owner/repo");
  expect(remoteIdentityForPublish("git@github.com:Owner/Repo.git", cwd)).toBe("github:owner/repo");
  expect(remoteIdentityForPublish("https://github.com/Owner/Repo.git", cwd)).toBe("github:owner/repo");
  expect(remoteIdentityForPublish("https://attacker.example/github.com/Owner/Repo.git", cwd)).not.toBe("github:owner/repo");
});

test("publish intent refuses a workspace symlink targeting productionspace", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const firmwareRepo = join(orgRoot, "productionspace", "firmware");
  const remotePath = join(root, "remotes", "firmware.git");
  await initGitRepo(firmwareRepo, { remotePath });
  await mkdir(join(orgRoot, "workspace"), { recursive: true });
  await symlink(firmwareRepo, join(orgRoot, "workspace", "firmware-link"), "junction");
  const manifestPath = join(orgRoot, "modules.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.module_slots.push({
    path: "workspace/firmware-link",
    workspace: "workspace",
    category: "firmware",
    git: { url: remotePath, branch: "main" },
  });
  await writeJson(manifestPath, manifest);
  await writeFile(join(firmwareRepo, "release.md"), "must stay local\n");
  runGit(["add", "release.md"], firmwareRepo);
  runGit(["commit", "-m", "Neodesílat productionspace"], firmwareRepo);

  try {
    await buildRepoPublishIntentResponse({
      companiesRoot: root,
      repoKey: "BetaCo::firmware-link",
      authorizationStore: createGitPublishAuthorizationStore(),
    });
    throw new Error("expected productionspace symlink publish to be refused");
  } catch (error) {
    expect(error.status).toBe(403);
    expect(error.code).toBe("publish_scope_forbidden");
  }
});

test("publish authorization is short-lived and one-use", () => {
  let now = 1_000;
  const store = createGitPublishAuthorizationStore({ ttlMs: 50, now: () => now });
  const first = store.issue({ intentHash: "intent-1", repoKey: "BetaCo::deals", expectedSha: "a".repeat(40) });
  expect(store.consume({
    token: first.token,
    intentHash: "intent-1",
    repoKey: "BetaCo::deals",
    expectedSha: "a".repeat(40),
  })).toMatchObject({ intentHash: "intent-1" });
  expect(() => store.consume({
    token: first.token,
    intentHash: "intent-1",
    repoKey: "BetaCo::deals",
    expectedSha: "a".repeat(40),
  })).toThrow();

  const expired = store.issue({ intentHash: "intent-2", repoKey: "BetaCo::deals", expectedSha: "b".repeat(40) });
  now += 51;
  expect(() => store.consume({
    token: expired.token,
    intentHash: "intent-2",
    repoKey: "BetaCo::deals",
    expectedSha: "b".repeat(40),
  })).toThrow();
});

test("publish authorization store evicts abandoned entries at its bound", () => {
  const store = createGitPublishAuthorizationStore({ maxEntries: 2 });
  const first = store.issue({ intentHash: "intent-1", repoKey: "BetaCo::deals", expectedSha: "a".repeat(40) });
  store.issue({ intentHash: "intent-2", repoKey: "BetaCo::deals", expectedSha: "b".repeat(40) });
  store.issue({ intentHash: "intent-3", repoKey: "BetaCo::deals", expectedSha: "c".repeat(40) });
  expect(() => store.consume({
    token: first.token,
    intentHash: "intent-1",
    repoKey: "BetaCo::deals",
    expectedSha: "a".repeat(40),
  })).toThrow();
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
  await initGitRepo(dealsRepo, { remotePath: join(root, "remotes", "dirty-deals.git") });
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

test("publish response pushes an existing commit without changing the working files", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  const remotePath = join(root, "remotes", "publish-deals.git");
  await initGitRepo(dealsRepo, { remotePath });
  await declareDealsRemote(root, remotePath);
  await writeFile(join(dealsRepo, "saved.md"), "saved change\n");
  runGit(["add", "saved.md"], dealsRepo);
  runGit(["commit", "-m", "Uložená změna"], dealsRepo);
  const expectedSha = runGit(["rev-parse", "HEAD"], dealsRepo);
  const authorizationStore = createGitPublishAuthorizationStore();

  try {
    await buildRepoPublishResponse({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      expectedSha,
      authorizationStore,
    });
    throw new Error("expected publish without reviewed authorization to be refused");
  } catch (error) {
    expect(error.status).toBe(409);
    expect(error.code).toBe("publish_authorization_invalid");
  }
  expect(() => runGit(["--git-dir", remotePath, "show", "main:saved.md"], root)).toThrow();

  const review = await buildRepoPublishIntentResponse({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    authorizationStore,
  });
  expect(review.intent).toMatchObject({
    expected_sha: expectedSha,
    commits: [{ sha: expectedSha, subject: "Uložená změna" }],
    changes: [{ status: "A", paths: ["saved.md"] }],
  });
  const pushed = await buildRepoPublishResponse({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    expectedSha,
    intentHash: review.intent_hash,
    authorizationToken: review.authorization_token,
    authorizationStore,
  });

  expect(pushed).toMatchObject({
    action: "push",
    committed: false,
    pushed: true,
    after: { status: "up_to_date" },
  });
  expect(runGit(["--git-dir", remotePath, "show", "main:saved.md"], root)).toBe("saved change");
});

test("publish response refuses uncommitted draft files", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  const remotePath = join(root, "remotes", "draft-publish-deals.git");
  await initGitRepo(dealsRepo, { remotePath });
  await declareDealsRemote(root, remotePath);
  await writeFile(join(dealsRepo, "draft.md"), "must stay local\n");
  const authorizationStore = createGitPublishAuthorizationStore();

  try {
    await buildRepoPublishIntentResponse({ companiesRoot: root, repoKey: "BetaCo::deals", authorizationStore });
    throw new Error("expected draft publish to be refused");
  } catch (error) {
    expect(error.status).toBe(409);
    expect(error.code).toBe("publish_not_safe");
  }

  expect(() => runGit(["--git-dir", remotePath, "show", "main:draft.md"], root)).toThrow();
});

test("publish response refuses a detached HEAD draft", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  const remotePath = join(root, "remotes", "detached-publish-deals.git");
  await initGitRepo(dealsRepo, { remotePath });
  await declareDealsRemote(root, remotePath);
  runGit(["checkout", "--detach"], dealsRepo);
  await writeFile(join(dealsRepo, "detached-draft.md"), "must stay local\n");
  const authorizationStore = createGitPublishAuthorizationStore();

  try {
    await buildRepoPublishIntentResponse({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      authorizationStore,
    });
    throw new Error("expected detached HEAD publish to be refused");
  } catch (error) {
    expect(error.status).toBe(409);
    expect(error.code).toBe("publish_remote_unverified");
  }

  expect(() => runGit(["--git-dir", remotePath, "show", "main:detached-draft.md"], root)).toThrow();
});

test("publish response refuses an origin that differs from the declared repository", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "workspace", "deals");
  const actualRemote = join(root, "remotes", "unexpected-origin.git");
  const declaredRemote = join(root, "remotes", "declared-origin.git");
  await initGitRepo(dealsRepo, { remotePath: actualRemote });
  await declareDealsRemote(root, declaredRemote);
  await writeFile(join(dealsRepo, "saved.md"), "must not push\n");
  runGit(["add", "saved.md"], dealsRepo);
  runGit(["commit", "-m", "Neodesílat jinam"], dealsRepo);
  const authorizationStore = createGitPublishAuthorizationStore();

  try {
    await buildRepoPublishIntentResponse({ companiesRoot: root, repoKey: "BetaCo::deals", authorizationStore });
    throw new Error("expected unexpected origin publish to be refused");
  } catch (error) {
    expect(error.status).toBe(409);
    expect(error.code).toBe("publish_remote_unverified");
  }

  expect(() => runGit(["--git-dir", actualRemote, "show", "main:saved.md"], root)).toThrow();
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

test("pull all updates Organization roots and workspace modules, using autostash where safe", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const orgRemote = join(root, "remotes", "organization-root.git");
  const dealsRepo = join(orgRoot, "workspace", "deals");
  const dealsRemote = join(root, "remotes", "deals-bulk.git");
  await initGitRepo(orgRoot, { remotePath: orgRemote });
  await initGitRepo(dealsRepo, { remotePath: dealsRemote });
  await writeFile(join(orgRoot, ".git", "info", "exclude"), "workspace/\n");

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

  expect(response.summary.updated_count).toBe(2);
  expect(response.summary.autostash_count).toBe(1);
  expect(rootResult.outcome).toBe("autostash_pulled");
  expect(dealsResult.outcome).toBe("pulled");
  expect(normalizeLineEndings(await readFile(join(orgRoot, "local-root-draft.md"), "utf8"))).toBe("preserve me\n");
  expect(normalizeLineEndings(await readFile(join(orgRoot, "remote-root.md"), "utf8"))).toBe("remote change\n");
  expect(normalizeLineEndings(await readFile(join(dealsRepo, "remote-deals.md"), "utf8"))).toBe("remote change\n");
}, 15_000);

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
