import { afterAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, rm, symlink, writeFile, readFile } from "fs/promises";
import { basename, dirname, join } from "path";
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
    environment: { CODEX_THREAD_ID: "019f8950-test-thread" },
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
  expect(existsSync(join(orgRoot, ".worktrees", ".worktree-create.lock"))).toBe(false);

  const sidecar = JSON.parse(await readFile(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"), "utf8"));
  expect(sidecar).toMatchObject({
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    module_path: "workspace/deals",
    repo_kind: "module",
    base_branch: "main",
    branch: "CAC-0042-deals-publish",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-deals-publish",
    created_by: "test-agent",
    conversation_origin: {
      surface: "codex",
      agent_label: "test-agent",
      thread_id: "019f8950-test-thread",
      thread_locator_status: "captured",
      local_only: true,
    },
    recovery_handoff: {
      state: "in_progress",
      blocker: null,
    },
    status: "active",
  });
  expect(sidecar.conversation_origin.captured_at).toBe(sidecar.created_at);
  expect(sidecar.recovery_handoff.updated_at).toBe(sidecar.created_at);

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
    environment: {},
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
  expect(sidecar.conversation_origin).toMatchObject({
    surface: "launchpad",
    agent_label: "test-agent",
    thread_id: null,
    thread_locator_status: "unavailable",
    local_only: true,
  });
  expect(sidecar.recovery_handoff).toMatchObject({
    state: "in_progress",
    blocker: null,
  });
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

test("guarded create serializes with the canonical Organization create lock", async () => {
  const { root, orgRoot, dealsRepo } = await setupDealsRepoWithPlan();
  const lockPath = join(orgRoot, ".worktrees", ".worktree-create.lock");
  await mkdir(lockPath, { recursive: true });

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
    code: "worktree_create_in_progress",
    status: 409,
  });

  expect(existsSync(lockPath)).toBe(true);
  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"))).toBe(false);
  expect(runGit(["branch", "--list", "CAC-0042-deals-publish"], dealsRepo)).toBe("");
});

test("guarded create removes the failed worktree and reuses its owned branch on retry", async () => {
  const { root, orgRoot, dealsRepo } = await setupDealsRepoWithPlan();

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      createdBy: "test-agent",
      sidecarWriter: async () => { throw new Error("simulated sidecar failure"); },
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "worktree_create_rolled_back",
    status: 500,
  });

  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"))).toBe(false);
  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"))).toBe(false);
  expect(runGit(["branch", "--list", "CAC-0042-deals-publish"], dealsRepo)).toContain("CAC-0042-deals-publish");
  expect(runGit(["config", "--local", "--get", "branch.CAC-0042-deals-publish.description"], dealsRepo))
    .toMatch(/^launchpad-worktree-create:/);
  expect(existsSync(join(orgRoot, ".worktrees", ".worktree-create.lock"))).toBe(false);

  const retry = await createWorktreeFromPlan({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
  });
  expect(retry).toMatchObject({ action: "create_worktree" });
  expect(runGit(
    ["branch", "--show-current"],
    join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"),
  )).toBe("CAC-0042-deals-publish");
});

test("guarded create preserves artefacts when the branch ownership marker changes before rollback", async () => {
  const { root, orgRoot, dealsRepo } = await setupDealsRepoWithPlan();

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      createdBy: "test-agent",
      sidecarWriter: async () => {
        runGit(["config", "--local", "branch.CAC-0042-deals-publish.description", "foreign-owner"], dealsRepo);
        throw new Error("simulated writer failure after ownership change");
      },
    }),
  ).rejects.toMatchObject({ code: "worktree_create_rolled_back", status: 500 });

  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"))).toBe(true);
  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"))).toBe(false);
  expect(runGit(["branch", "--list", "CAC-0042-deals-publish"], dealsRepo)).toContain("CAC-0042-deals-publish");
  expect(existsSync(join(orgRoot, ".worktrees", ".worktree-create.lock"))).toBe(false);
});

test("guarded create never follows a symlink swapped in before rollback", async () => {
  const { root, orgRoot, dealsRepo } = await setupDealsRepoWithPlan();
  const foreignPath = join(root, "foreign-sentinel");
  await mkdir(foreignPath, { recursive: true });
  await writeFile(join(foreignPath, "keep.txt"), "foreign\n", "utf8");
  const worktreePath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish");

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      sidecarWriter: async () => {
        await rm(worktreePath, { recursive: true, force: true });
        await symlink(foreignPath, worktreePath);
        throw new Error("simulated post-add sidecar failure");
      },
    }),
  ).rejects.toMatchObject({ code: "worktree_create_rolled_back" });

  expect(await readFile(join(foreignPath, "keep.txt"), "utf8")).toBe("foreign\n");
  expect(existsSync(worktreePath)).toBe(true);
  expect(runGit(["branch", "--list", "CAC-0042-deals-publish"], dealsRepo)).toContain("CAC-0042-deals-publish");
});

test("guarded create preserves published sidecar when index lookup fails", async () => {
  const { root, orgRoot, dealsRepo } = await setupDealsRepoWithPlan();

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      createdBy: "test-agent",
      worktreeFinder: async () => { throw new Error("simulated index lookup failure"); },
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "worktree_created_index_pending",
    status: 202,
  });

  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"))).toBe(true);
  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"))).toBe(true);
  expect(runGit(["branch", "--list", "CAC-0042-deals-publish"], dealsRepo)).toContain("CAC-0042-deals-publish");
  expect(existsSync(join(orgRoot, ".worktrees", ".worktree-create.lock"))).toBe(false);
});

test("guarded create never deletes a sidecar replaced after publication", async () => {
  const { root, orgRoot } = await setupDealsRepoWithPlan();
  const sidecarPath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json");

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      worktreeFinder: async () => {
        await rm(sidecarPath, { force: true });
        await writeFile(sidecarPath, "foreign sidecar\n", "utf8");
        throw new Error("simulated index failure after sidecar replacement");
      },
    }),
  ).rejects.toMatchObject({ code: "worktree_created_index_pending", status: 202 });

  expect(await readFile(sidecarPath, "utf8")).toBe("foreign sidecar\n");
});

test("guarded create preserves published sidecar and staging file when staging cleanup fails", async () => {
  const { root, orgRoot, dealsRepo } = await setupDealsRepoWithPlan();
  let stagingPath = null;

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      createdBy: "test-agent",
      sidecarWriter: async ({ sidecarPath, contents }) => {
        stagingPath = `${sidecarPath}.staging`;
        await writeFile(sidecarPath, contents);
        await writeFile(stagingPath, contents);
        return { stagingPath, stagingCleanupError: new Error("simulated staging cleanup failure") };
      },
    }),
  ).rejects.toMatchObject({ code: "worktree_created_index_pending", status: 202 });

  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"))).toBe(true);
  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"))).toBe(true);
  expect(existsSync(stagingPath)).toBe(true);
  expect(runGit(["branch", "--list", "CAC-0042-deals-publish"], dealsRepo)).toContain("CAC-0042-deals-publish");
  expect(existsSync(join(orgRoot, ".worktrees", ".worktree-create.lock"))).toBe(false);
});

test("guarded create leaves failed atomic staging file for conscious cleanup", async () => {
  const { root, orgRoot, dealsRepo } = await setupDealsRepoWithPlan();
  const finalPath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json");
  const stagingPath = join(dirname(finalPath), `.${basename(finalPath)}.atomic-failure.tmp`);

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
      createdBy: "test-agent",
      sidecarWriter: async ({ contents }) => {
        await writeFile(stagingPath, contents);
        const error = new Error("simulated atomic publish failure");
        error.stagingPath = stagingPath;
        error.stagingCleanupError = new Error("simulated first cleanup failure");
        throw error;
      },
    }),
  ).rejects.toMatchObject({ code: "worktree_create_rolled_back", status: 500 });

  expect(existsSync(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish"))).toBe(false);
  expect(existsSync(finalPath)).toBe(false);
  expect(existsSync(stagingPath)).toBe(true);
  expect(runGit(["branch", "--list", "CAC-0042-deals-publish"], dealsRepo)).toContain("CAC-0042-deals-publish");
  expect(existsSync(join(orgRoot, ".worktrees", ".worktree-create.lock"))).toBe(false);
});

test("worktree create i publish odmítnou repo checkout přes symlink nebo Windows junction mimo Organizaci", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const externalRepo = join(root, "external-repositories", "deals");
  const remotePath = join(root, "remotes", "escaped-deals.git");
  await initGitRepo(externalRepo, { remotePath });
  await mkdir(join(orgRoot, "workspace"), { recursive: true });
  await symlink(
    externalRepo,
    join(orgRoot, "workspace", "deals"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const planPath = join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-deals-publish.yaml");
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(
    planPath,
    "dev_code: CAC-0042\ntitle: Escaped repo\nstatus: in_progress\n",
  );

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-deals-publish",
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "repo_not_found",
    status: 404,
  });
  await expect(
    publishWorktreeDraft({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      slug: "CAC-0042-deals-publish",
      commitMessage: "Publikovat escaped draft",
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "repo_not_found",
    status: 404,
  });
  expect(runGit(["branch", "--list", "CAC-0042-deals-publish"], externalRepo)).toBe("");
});

test("worktree create i publish odmítnou symlink nebo Windows junction v Organization .worktrees boundary", async () => {
  const { root, orgRoot } = await setupDealsRepoWithPlan();
  const externalWorktreesRoot = join(root, "external-worktrees");
  const publishSlug = "CAC-0042-publish-escaped";
  const externalWorktree = join(
    externalWorktreesRoot,
    "workspace",
    "deals",
    publishSlug,
  );
  const externalRemote = join(root, "remotes", "escaped-worktree.git");
  await initGitRepo(externalWorktree, {
    branch: publishSlug,
    remotePath: externalRemote,
  });
  await writeFile(join(externalWorktree, "draft.md"), "nesmí se commitnout\n");
  await writeFile(
    join(externalWorktreesRoot, "workspace", "deals", `${publishSlug}.worktree.json`),
    `${JSON.stringify({
      schema_version: "companiesascode.worktree.v1",
      organization: "BetaCo",
      organization_path: "organizations/BetaCo_GEN3",
      workspace: "workspace",
      module: "deals",
      module_path: "modules/deals",
      repo_kind: "module",
      base_branch: "main",
      branch: publishSlug,
      mission_control_plan_code: "CAC-0042",
      mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      worktree_path: `.worktrees/workspace/deals/${publishSlug}`,
      created_at: new Date().toISOString(),
      created_by: "test-agent",
      status: "active",
    }, null, 2)}\n`,
  );
  await symlink(
    externalWorktreesRoot,
    join(orgRoot, ".worktrees"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const beforeHead = runGit(["rev-parse", "HEAD"], externalWorktree);
  const beforeRemote = runGit(
    ["--git-dir", externalRemote, "rev-parse", `refs/heads/${publishSlug}`],
    root,
  );

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-create-escaped",
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "worktree_path_escape",
    status: 403,
  });
  await expect(
    publishWorktreeDraft({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      slug: publishSlug,
      commitMessage: "Publikovat escaped worktree",
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "worktree_not_found",
    status: 404,
  });

  expect(existsSync(join(externalWorktreesRoot, "workspace", "deals", "CAC-0042-create-escaped"))).toBe(false);
  expect(runGit(["rev-parse", "HEAD"], externalWorktree)).toBe(beforeHead);
  expect(runGit(["status", "--porcelain=v1"], externalWorktree)).toBe("?? draft.md");
  expect(
    runGit(
      ["--git-dir", externalRemote, "rev-parse", `refs/heads/${publishSlug}`],
      root,
    ),
  ).toBe(beforeRemote);
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
  expect(sidecar.recovery_handoff).toMatchObject({
    state: "ready_for_pr",
    blocker: null,
  });
  expect(sidecar.recovery_handoff.summary).toContain(published.commit.sha);
});

test("guarded create rejects contradictory conversation locator metadata", async () => {
  const { root } = await setupDealsRepoWithPlan();

  await expect(
    createWorktreeFromPlan({
      companiesRoot: root,
      repoKey: "BetaCo::deals",
      planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
      branch: "CAC-0042-invalid-thread-origin",
      createdBy: "test-agent",
      conversationOrigin: {
        surface: "codex",
        agent_label: "test-agent",
        thread_id: null,
        thread_locator_status: "captured",
      },
      environment: {},
    }),
  ).rejects.toMatchObject({
    name: "WorktreeActionError",
    code: "invalid_conversation_origin",
    status: 400,
  });
});

test("explicit non-captured conversation status suppresses an ambient session ID", async () => {
  const { root, orgRoot } = await setupDealsRepoWithPlan();

  await createWorktreeFromPlan({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-no-thread-capture",
    createdBy: "cleanup-automation",
    conversationOrigin: {
      surface: "automation",
      agent_label: "Night cleanup",
      thread_id: null,
      thread_locator_status: "not_applicable",
    },
    environment: { CODEX_THREAD_ID: "must-not-leak-into-sidecar" },
  });

  const sidecar = JSON.parse(
    await readFile(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-no-thread-capture.worktree.json"), "utf8"),
  );
  expect(sidecar.conversation_origin).toMatchObject({
    surface: "automation",
    agent_label: "Night cleanup",
    thread_id: null,
    thread_locator_status: "not_applicable",
    local_only: true,
  });
});

async function setupDealsRepoWithPlan({
  planRelativePath = "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
} = {}) {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const dealsRepo = join(orgRoot, "workspace", "deals");
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
      "  - path: workspace/deals",
      "",
    ].join("\n"),
  );
  return { root, orgRoot, dealsRepo, remotePath };
}

test("publish preserves a captured conversation origin when the request carries none", async () => {
  const { root, orgRoot } = await setupDealsRepoWithPlan();
  const created = await createWorktreeFromPlan({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
    environment: { CLAUDE_SESSION_ID: "session-abc123" },
  });
  const sidecarPath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json");
  const captured = JSON.parse(await readFile(sidecarPath, "utf8")).conversation_origin;
  expect(captured).toMatchObject({
    thread_id: "session-abc123",
    thread_locator_status: "captured",
  });

  await writeFile(join(root, created.worktree.path, "draft.md"), "publish me\n");
  // Launchpad UI publish: žádný conversationOrigin v requestu a serverové
  // prostředí bez thread ID — původní recovery stopa musí přežít.
  await publishWorktreeDraft({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    slug: "CAC-0042-deals-publish",
    commitMessage: "feat: publish deals draft",
    publisher: "launchpad-builder",
    environment: {},
  });

  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  expect(sidecar.conversation_origin).toEqual(captured);
});

test("ambient server thread never replaces the worktree's captured origin", async () => {
  const { root, orgRoot } = await setupDealsRepoWithPlan();
  const created = await createWorktreeFromPlan({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
    environment: { CLAUDE_SESSION_ID: "session-abc123" },
  });
  await writeFile(join(root, created.worktree.path, "draft.md"), "publish me\n");

  // Launchpad server zdědil thread ID z úplně jiné session — nesmí přepsat
  // provenance worktree.
  await publishWorktreeDraft({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    slug: "CAC-0042-deals-publish",
    commitMessage: "feat: publish deals draft",
    publisher: "launchpad-builder",
    environment: { CODEX_THREAD_ID: "server-thread-999" },
  });

  const sidecar = JSON.parse(
    await readFile(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"), "utf8"),
  );
  expect(sidecar.conversation_origin).toMatchObject({
    thread_id: "session-abc123",
    thread_locator_status: "captured",
  });
});

test("explicit handover records the new owner conversation origin", async () => {
  const { root, orgRoot } = await setupDealsRepoWithPlan();
  const created = await createWorktreeFromPlan({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
    environment: { CLAUDE_SESSION_ID: "session-abc123" },
  });
  await writeFile(join(root, created.worktree.path, "draft.md"), "publish me\n");

  await publishWorktreeDraft({
    companiesRoot: root,
    repoKey: "BetaCo::deals",
    slug: "CAC-0042-deals-publish",
    commitMessage: "feat: publish deals draft",
    publisher: "codex-agent",
    conversationOrigin: { surface: "codex", agent_label: "codex-agent", thread_id: "thread-xyz789" },
    environment: {},
  });

  const sidecar = JSON.parse(
    await readFile(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-deals-publish.worktree.json"), "utf8"),
  );
  expect(sidecar.conversation_origin).toMatchObject({
    surface: "codex",
    thread_id: "thread-xyz789",
    thread_locator_status: "captured",
  });
});
