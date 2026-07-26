import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { materializeRepoCheckout } from "./git-materialization-lib.mjs";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import { runGit } from "./git-lib.mjs";
import {
  createLaunchpadGitFixture,
  initGitRepo,
  writeJson,
} from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("materializes an active manifest slot on its exact repository and branch", async () => {
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

test("treats an inaccessible manifest repository as missing_access and leaves no partial checkout", async () => {
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

test("never replaces a target directory created concurrently after preflight", async () => {
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
      claimDirectory: async (path) => {
        await mkdir(path);
        await writeFile(join(path, "concurrent-owner.txt"), "preserve me\n");
        return mkdir(path);
      },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_appeared",
  });
  expect(await readFile(join(target, "concurrent-owner.txt"), "utf8")).toBe("preserve me\n");
  expect(existsSync(join(target, ".git"))).toBe(false);
});

test("ownership pin prevents non-destructive target substitution while Git runs", async () => {
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
  let substitutionWasBlocked = false;

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      run: async (args, options) => {
        if (args[0] === "fetch") {
          try {
            await rmdir(target);
          } catch {
            substitutionWasBlocked = true;
          }
        }
        return runGit(args, options);
      },
    },
  });

  expect(result).toMatchObject({ ok: true, outcome: "materialized" });
  expect(substitutionWasBlocked).toBe(true);
  expect(existsSync(join(target, ".git"))).toBe(true);
});

test("refuses a parent replaced by a directory link after preflight and never cleans the external target", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const targetParent = join(organizationRoot, "workspace");
  const target = join(targetParent, "lazurio");
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

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      claimDirectory: async (path) => {
        await rmdir(targetParent);
        await mkdir(externalParent);
        await symlink(externalParent, targetParent, process.platform === "win32" ? "junction" : "dir");
        return mkdir(path);
      },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_path_forbidden",
  });
  expect(existsSync(externalTarget)).toBe(true);
  expect(existsSync(join(externalTarget, ".git"))).toBe(false);
  expect(existsSync(target)).toBe(true);
});

test("failed materialization never recursively cleans a parent substituted by another process", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const targetParent = join(organizationRoot, "workspace");
  const target = join(targetParent, "lazurio");
  const externalParent = join(root, "external-workspace");
  const externalTarget = join(externalParent, "lazurio");
  const externalEvidence = join(externalTarget, "external-owner.txt");
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  await mkdir(externalTarget, { recursive: true });
  await writeFile(externalEvidence, "must survive cleanup\n");
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
      run: async (args, options) => {
        if (args[0] !== "fetch") return runGit(args, options);
        // Simulate a same-user destructive process after the ownership pin:
        // it removes the claimed checkout, redirects the parent, then the Git
        // operation fails. The materializer must never recursively clean the
        // now redirected pathname.
        await rm(target, { recursive: true, force: true });
        await rmdir(targetParent);
        await symlink(externalParent, targetParent, process.platform === "win32" ? "junction" : "dir");
        return { ok: false, stdout: "", stderr: "simulated fetch failure" };
      },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_incomplete",
  });
  expect(await readFile(externalEvidence, "utf8")).toBe("must survive cleanup\n");
  expect(existsSync(target)).toBe(true);
});

test("keeps an owned partial checkout for inspection instead of recursively deleting it", async () => {
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
      run: async (args, options) => {
        if (args[0] === "fetch") {
          return { ok: false, stdout: "", stderr: "simulated fetch failure" };
        }
        return runGit(args, options);
      },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_incomplete",
  });
  expect(existsSync(join(target, ".git"))).toBe(true);
});

test("refuses a target that does not exactly match the manifest inventory boundary", async () => {
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
