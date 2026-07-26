import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { materializeRepoCheckout } from "./git-materialization-lib.mjs";
import { runAnchoredMaterialization } from "./git-materialization-helper-lib.mjs";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import { runGit } from "./git-lib.mjs";
import {
  createLaunchpadGitFixture,
  initGitRepo,
  writeJson,
} from "./git-fixture-helpers.test.mjs";

const tempRoots = [];
const materializationTest = process.platform === "win32" ? test : test.skip;

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

materializationTest("materializes an active manifest slot on its exact repository and branch", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/lazurio",
        teams: ["lazurio"],
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::lazurio");

  const result = await materializeRepoCheckout({ companiesRoot: root, repo });

  expect(result).toMatchObject({
    ok: true,
    outcome: "materialized",
    branch: "main",
    remote,
  });
  expect(result.head).toMatch(/^[0-9a-f]{40}$/);
  expect(await readFile(join(organizationRoot, "workspace", "lazurio", "README.md"), "utf8"))
    .toContain("# main");
});

materializationTest("treats an inaccessible manifest repository as missing_access and leaves no partial checkout", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const target = join(organizationRoot, "workspace", "private-module");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/private-module",
        git: { url: join(root, "remotes", "not-accessible.git"), branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::private-module");

  const result = await materializeRepoCheckout({ companiesRoot: root, repo });

  expect(result).toMatchObject({
    ok: false,
    outcome: "missing_access",
    code: "materialization_source_unavailable",
  });
  expect(existsSync(target)).toBe(false);
});

materializationTest("materialization ignores Organization-local core.sshCommand", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const marker = join(root, "local-ssh-command-ran");
  const helper = join(root, "local-ssh-command.sh");
  const target = join(organizationRoot, "workspace", "private-module");
  await writeFile(helper, `#!/bin/sh\nprintf attacker > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(helper, 0o755);
  await runGit(["config", "core.sshCommand", helper], { cwd: organizationRoot });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [{
      path: "workspace/private-module",
      git: { url: "ssh://git@127.0.0.1:1/nope", branch: "main" },
    }],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::private-module");

  const result = await materializeRepoCheckout({ companiesRoot: root, repo });

  expect(result).toMatchObject({
    ok: false,
    outcome: "missing_access",
    code: "materialization_source_unavailable",
  });
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(target)).toBe(false);
});

materializationTest("materialization removes inherited GIT_SSH_COMMAND", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const marker = join(root, "inherited-ssh-command-ran");
  const helper = join(root, "inherited-ssh-command.sh");
  const target = join(organizationRoot, "workspace", "private-module");
  await writeFile(helper, `#!/bin/sh\nprintf attacker > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(helper, 0o755);
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [{
      path: "workspace/private-module",
      git: { url: "ssh://git@127.0.0.1:1/nope", branch: "main" },
    }],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::private-module");
  const previous = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = helper;
  try {
    const result = await materializeRepoCheckout({ companiesRoot: root, repo });
    expect(result).toMatchObject({
      ok: false,
      outcome: "missing_access",
      code: "materialization_source_unavailable",
    });
  } finally {
    if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previous;
  }

  expect(existsSync(marker)).toBe(false);
  expect(existsSync(target)).toBe(false);
});

materializationTest("materialization removes inherited GIT_SSH", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const marker = join(root, "inherited-ssh-ran");
  const helper = join(root, "inherited-ssh.sh");
  const target = join(organizationRoot, "workspace", "private-module");
  await writeFile(helper, `#!/bin/sh\nprintf attacker > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(helper, 0o755);
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [{
      path: "workspace/private-module",
      git: { url: "ssh://git@127.0.0.1:1/nope", branch: "main" },
    }],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::private-module");
  const previous = process.env.GIT_SSH;
  process.env.GIT_SSH = helper;
  try {
    const result = await materializeRepoCheckout({ companiesRoot: root, repo });
    expect(result).toMatchObject({
      ok: false,
      outcome: "missing_access",
      code: "materialization_source_unavailable",
    });
  } finally {
    if (previous === undefined) delete process.env.GIT_SSH;
    else process.env.GIT_SSH = previous;
  }

  expect(existsSync(marker)).toBe(false);
  expect(existsSync(target)).toBe(false);
});

materializationTest("materialization ignores HOME global hooks", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const target = join(organizationRoot, "workspace", "private-module");
  const home = join(root, "hostile-home");
  const hooks = join(home, "hooks");
  const marker = join(root, "global-hook-ran");
  await prepareOrganizationRoot(organizationRoot);
  await mkdir(hooks, { recursive: true });
  const hook = join(hooks, "post-checkout");
  await writeFile(hook, `#!/bin/sh\nprintf global-hook > ${JSON.stringify(marker)}\n`);
  await chmod(hook, 0o755);
  await writeFile(join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
  const remote = join(root, "remotes", "private-module.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "private-module"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [{ path: "workspace/private-module", git: { url: remote, branch: "main" } }],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::private-module");
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await materializeRepoCheckout({ companiesRoot: root, repo });
    expect(result).toMatchObject({ ok: true, outcome: "materialized" });
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(target)).toBe(true);
});

materializationTest("materialization disables a post-checkout hook planted after Git init", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const target = join(organizationRoot, "workspace", "private-module");
  const marker = join(target, "post-checkout-ran");
  const readyPath = join(root, "after-git-init.ready");
  const proceedPath = join(root, "after-git-init.proceed");
  const remote = join(root, "remotes", "private-module.git");
  await prepareOrganizationRoot(organizationRoot);
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "private-module"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [{ path: "workspace/private-module", git: { url: remote, branch: "main" } }],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::private-module");

  const materialization = materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      anchorTestHook: {
        phase: "after_git_init",
        readyPath,
        proceedPath,
      },
    },
  });
  await waitForPath(readyPath);
  const hook = join(target, ".git", "hooks", "post-checkout");
  await writeFile(hook, "#!/bin/sh\nprintf planted > post-checkout-ran\n");
  await chmod(hook, 0o755);
  await writeFile(proceedPath, "continue\n");
  const result = await materialization;

  expect(result).toMatchObject({ ok: true, outcome: "materialized" });
  expect(existsSync(marker)).toBe(false);
});

materializationTest("rejects a post-anchor target replacement without running pathname Git verification", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const target = join(organizationRoot, "workspace", "lazurio");
  const movedTarget = join(root, "anchored-target");
  const remote = join(root, "remotes", "lazurio.git");
  await prepareOrganizationRoot(organizationRoot);
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [{ path: "workspace/lazurio", git: { url: remote, branch: "main" } }],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::lazurio");
  let postAnchorGitCalls = 0;
  let anchored = false;
  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      run: async (args, options) => {
        if (anchored) postAnchorGitCalls += 1;
        return runGit(args, options);
      },
      materializeAnchored: async () => {
        await mkdir(target, { recursive: true });
        const original = await lstat(target, { bigint: true });
        await rename(target, movedTarget);
        await mkdir(target);
        anchored = true;
        return {
          ok: true,
          outcome: "materialized",
          anchor: { device: original.dev.toString(), inode: original.ino.toString() },
        };
      },
    },
  });
  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_path_forbidden",
  });
  expect(postAnchorGitCalls).toBe(0);
  expect(existsSync(movedTarget)).toBe(true);
});

materializationTest("refuses an Organization root substituted after validation before it can create an external checkout", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const movedOrganizationRoot = join(root, "moved-BetaCo_GEN3");
  const externalOrganizationRoot = join(root, "external-organization-root");
  const externalTarget = join(externalOrganizationRoot, "workspace", "lazurio");
  await prepareOrganizationRoot(organizationRoot);
  await mkdir(externalOrganizationRoot, { recursive: true });
  await prepareOrganizationRoot(externalOrganizationRoot);
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [{
      path: "workspace/lazurio",
      teams: ["lazurio"],
      git: { url: remote, branch: "main" },
    }],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::lazurio");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      materializeAnchored: async (options) => {
        await rename(organizationRoot, movedOrganizationRoot);
        await rename(externalOrganizationRoot, organizationRoot);
        return runAnchoredMaterialization(options);
      },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_path_forbidden",
  });
  expect(existsSync(externalTarget)).toBe(false);
});

materializationTest("never replaces a target directory created concurrently after preflight", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const target = join(organizationRoot, "workspace", "lazurio");
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/lazurio",
        teams: ["lazurio"],
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::lazurio");

  const readyPath = join(root, "before-claim.ready");
  const proceedPath = join(root, "before-claim.proceed");
  const materialization = materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      anchorTestHook: {
        phase: "before_claim",
        readyPath,
        proceedPath,
      },
    },
  });
  await waitForPath(readyPath);
  await mkdir(target);
  await writeFile(join(target, "concurrent-owner.txt"), "preserve me\n");
  await writeFile(proceedPath, "continue\n");
  const result = await materialization;

  expect(result).toMatchObject({
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_appeared",
  });
  expect(await readFile(join(target, "concurrent-owner.txt"), "utf8")).toBe("preserve me\n");
  expect(existsSync(join(target, ".git"))).toBe(false);
});

materializationTest("anchored Git writes never follow a target pathname redirected to an external repository", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const target = join(organizationRoot, "workspace", "lazurio");
  const movedTarget = join(root, "moved-claimed-lazurio");
  const externalTarget = join(root, "external-existing-repo");
  const externalEvidence = join(externalTarget, "external-owner.txt");
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await initGitRepo(externalTarget);
  await writeFile(externalEvidence, "must not be modified\n");
  await runGit(["add", "external-owner.txt"], { cwd: externalTarget });
  await runGit(["commit", "-m", "external evidence"], { cwd: externalTarget });
  const externalHeadBefore = await runGit(["rev-parse", "HEAD"], { cwd: externalTarget });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/lazurio",
        teams: ["lazurio"],
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::lazurio");
  const readyPath = join(root, "after-target-anchor.ready");
  const proceedPath = join(root, "after-target-anchor.proceed");
  let substitutionWasBlocked = false;

  const materialization = materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      anchorTestHook: {
        phase: "after_target_anchor",
        readyPath,
        proceedPath,
      },
    },
  });
  await waitForPath(readyPath);
  try {
    await rename(target, movedTarget);
    await symlink(
      externalTarget,
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    substitutionWasBlocked = true;
  }
  await writeFile(proceedPath, "continue\n");
  const result = await materialization;

  if (substitutionWasBlocked) {
    expect(result).toMatchObject({ ok: true, outcome: "materialized" });
  } else {
    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      code: "materialization_path_forbidden",
    });
    expect(existsSync(join(movedTarget, ".git"))).toBe(true);
  }
  expect(await readFile(externalEvidence, "utf8")).toBe("must not be modified\n");
  const externalHeadAfter = await runGit(["rev-parse", "HEAD"], { cwd: externalTarget });
  const externalStatus = await runGit(["status", "--porcelain=v1"], { cwd: externalTarget });
  expect(externalHeadAfter.stdout).toBe(externalHeadBefore.stdout);
  expect(externalStatus.stdout).toBe("");
});

materializationTest("anchored parent mkdir never follows a pathname redirected before target claim", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const targetParent = join(organizationRoot, "workspace");
  const target = join(targetParent, "lazurio");
  const movedParent = join(root, "moved-workspace");
  const externalParent = join(root, "external-workspace");
  const externalTarget = join(externalParent, "lazurio");
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/lazurio",
        teams: ["lazurio"],
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::lazurio");
  const readyPath = join(root, "anchored-parent.ready");
  const proceedPath = join(root, "anchored-parent.proceed");
  let substitutionWasBlocked = false;

  const materialization = materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      anchorTestHook: {
        phase: "before_claim",
        readyPath,
        proceedPath,
      },
    },
  });
  await waitForPath(readyPath);
  await mkdir(externalParent);
  try {
    await rename(targetParent, movedParent);
    await symlink(
      externalParent,
      targetParent,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    substitutionWasBlocked = true;
  }
  await writeFile(proceedPath, "continue\n");
  const result = await materialization;

  if (substitutionWasBlocked) {
    expect(result).toMatchObject({ ok: true, outcome: "materialized" });
    expect(existsSync(join(target, ".git"))).toBe(true);
  } else {
    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      code: "materialization_path_forbidden",
    });
    expect(existsSync(join(movedParent, "lazurio", ".git"))).toBe(true);
  }
  expect(existsSync(externalTarget)).toBe(false);
});

materializationTest("failed anchored Git fetch leaves its owned partial checkout for inspection", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const target = join(organizationRoot, "workspace", "lazurio");
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/lazurio",
        teams: ["lazurio"],
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::lazurio");
  const readyPath = join(root, "before-failed-claim.ready");
  const proceedPath = join(root, "before-failed-claim.proceed");

  const materialization = materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      anchorTestHook: {
        phase: "before_claim",
        readyPath,
        proceedPath,
      },
    },
  });
  await waitForPath(readyPath);
  await rm(remote, { recursive: true, force: true });
  await writeFile(proceedPath, "continue\n");
  const result = await materialization;

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_incomplete",
  });
  expect(existsSync(join(target, ".git"))).toBe(true);
});

test("POSIX platform fails closed before creating the target without an atomic create-handle primitive", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const target = join(organizationRoot, "workspace", "lazurio");
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/lazurio",
        teams: ["lazurio"],
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::lazurio");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      platform: "darwin",
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_anchor_unavailable",
  });
  expect(existsSync(target)).toBe(false);
});

materializationTest("refuses a target that does not exactly match the manifest inventory boundary", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const outside = join(root, "outside");
  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo: {
      organization: "BetaCo",
      organization_path: "organizations/BetaCo_GEN3",
      repo_kind: "module",
      slot_path: "workspace/lazurio",
      absolute_path: outside,
      expected_branch: "main",
      repo: "git@github.com:BetaCo/lazurio.git",
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_path_forbidden",
  });
  expect(existsSync(outside)).toBe(false);
});

async function prepareOrganizationRoot(organizationRoot) {
  await writeFile(join(organizationRoot, ".gitignore"), "/workspace/*/\n");
  await initGitRepo(organizationRoot);
}

async function waitForPath(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await Bun.sleep(20);
  }
}
