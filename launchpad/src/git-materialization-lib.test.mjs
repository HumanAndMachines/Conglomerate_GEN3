import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./git-lib.mjs";
import {
  generatedResiduePathAllowed,
  isGeneratedOnlyMigrationResidue,
  materializeRepoCheckout,
} from "./git-materialization-lib.mjs";
import { buildGitInventory } from "./git-inventory-lib.mjs";
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

test("quarantines generated-only in-tree residue before materializing a standalone checkout", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "design-system.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "design-system"), { remotePath: remote });
  const target = join(organizationRoot, "design-system");
  const cachedPackage = join(target, "app", "node_modules", "fixture", "package.json");
  await mkdir(join(target, "app", "node_modules", "fixture"), { recursive: true });
  await writeFile(cachedPackage, '{"name":"fixture"}\n');
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "design-system",
        space: "root",
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::design-system");
  const recoveryStateRoot = join(root, "recovery-state");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: { recoveryStateRoot },
  });

  expect(result).toMatchObject({
    ok: true,
    outcome: "materialized",
    branch: "main",
    remote,
  });
  expect(result.residue_recovery_path).toStartWith(recoveryStateRoot);
  expect(await readFile(join(target, "README.md"), "utf8")).toContain("# main");
  expect(await readFile(join(result.residue_recovery_path, "app", "node_modules", "fixture", "package.json"), "utf8"))
    .toBe('{"name":"fixture"}\n');
});

test("generated residue policy is cross-platform and rejects ambiguous output roots", () => {
  for (const generatedRoot of [
    "node_modules",
    ".astro",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".vite",
    ".cache",
    ".turbo",
  ]) {
    expect(generatedResiduePathAllowed(`app/${generatedRoot}/cache.bin`)).toBe(true);
    expect(generatedResiduePathAllowed(`app\\${generatedRoot}\\cache.bin`)).toBe(true);
  }
  expect(generatedResiduePathAllowed("app/build/.next/cache.bin")).toBe(false);
  expect(generatedResiduePathAllowed("app\\dist\\.astro\\cache.bin")).toBe(false);
  expect(generatedResiduePathAllowed("out/.vite/cache.bin")).toBe(false);
  expect(generatedResiduePathAllowed("package.json")).toBe(false);
});

test("accepts an empty high-confidence cache but rejects an arbitrary empty directory", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const cacheTarget = join(root, "empty-cache-target");
  const authoredTarget = join(root, "empty-authored-target");
  await mkdir(join(cacheTarget, "app", ".vite"), { recursive: true });
  await mkdir(join(authoredTarget, "config"), { recursive: true });

  expect(await isGeneratedOnlyMigrationResidue(cacheTarget)).toBe(true);
  expect(await isGeneratedOnlyMigrationResidue(authoredTarget)).toBe(false);
});

test("preserves an in-tree target containing authored or ambiguous output data", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "mission-control.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "mission-control"), { remotePath: remote });
  const target = join(organizationRoot, "mission-control");
  const authored = join(target, "build", ".next", "deployment.json");
  await mkdir(join(target, "build", ".next"), { recursive: true });
  await writeFile(authored, '{"owner":"organization"}\n');
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "mission-control",
        space: "root",
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::mission-control");

  const result = await materializeRepoCheckout({ companiesRoot: root, repo });

  expect(result).toMatchObject({
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_exists",
  });
  expect(result.message).toContain("uživatelská data");
  expect(await readFile(authored, "utf8")).toBe('{"owner":"organization"}\n');
});

test("does not quarantine generated residue until manifest source access is proven", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const target = join(organizationRoot, "design-system");
  const cached = join(target, ".astro", "cache.json");
  await mkdir(join(target, ".astro"), { recursive: true });
  await writeFile(cached, "{}\n");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "design-system",
        space: "root",
        git: { url: join(root, "remotes", "missing.git"), branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::design-system");
  const recoveryStateRoot = join(root, "recovery-state");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: { recoveryStateRoot },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "missing_access",
    code: "materialization_source_unavailable",
  });
  expect(await readFile(cached, "utf8")).toBe("{}\n");
  expect(existsSync(recoveryStateRoot)).toBe(false);
});

test("restores generated residue when clone fails after quarantine", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "design-system.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "design-system"), { remotePath: remote });
  const target = join(organizationRoot, "design-system");
  const cached = join(target, "app", ".vite", "cache.json");
  await mkdir(join(target, "app", ".vite"), { recursive: true });
  await writeFile(cached, "{}\n");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "design-system",
        space: "root",
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::design-system");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      recoveryStateRoot: join(root, "recovery-state"),
      run: async (args, options) => (
        args[0] === "clone"
          ? { ok: false, stdout: "", stderr: "simulated clone failure" }
          : runGit(args, options)
      ),
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_clone_failed",
    residue_restored: true,
  });
  expect(await readFile(cached, "utf8")).toBe("{}\n");
  expect(existsSync(join(result.recovery_path, "failed-clone"))).toBe(true);
});

test("restores generated residue when clone verification fails", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "design-system.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "design-system"), { remotePath: remote });
  const target = join(organizationRoot, "design-system");
  const cached = join(target, ".astro", "cache.json");
  await mkdir(join(target, ".astro"), { recursive: true });
  await writeFile(cached, "{}\n");
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "design-system",
        space: "root",
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::design-system");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      recoveryStateRoot: join(root, "recovery-state"),
      run: async (args, options) => (
        args[0] === "clone"
          ? { ok: true, stdout: "", stderr: "" }
          : runGit(args, options)
      ),
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_verification_failed",
    residue_restored: true,
  });
  expect(await readFile(cached, "utf8")).toBe("{}\n");
  expect(existsSync(join(result.recovery_path, "failed-clone"))).toBe(true);
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
  const workspaceEntries = existsSync(join(organizationRoot, "workspace"))
    ? await readdir(join(organizationRoot, "workspace"))
    : [];
  expect(workspaceEntries.some((entry) => entry.includes(".materialize-"))).toBe(false);
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

test("does not overwrite a target claimed by a concurrent materialization", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "shared.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "shared"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/shared",
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::shared");
  const target = join(organizationRoot, "workspace", "shared");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      makeDirectory: async (path, options) => {
        if (path === target && !options?.recursive) {
          await mkdir(path);
          await writeFile(join(path, "owned-by-other-update"), "keep\n");
          const error = new Error("target already claimed");
          error.code = "EEXIST";
          throw error;
        }
        return mkdir(path, options);
      },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_exists",
  });
  expect(await readFile(join(target, "owned-by-other-update"), "utf8")).toBe("keep\n");
});

test("leaves a claimed target visible when clone fails", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "broken-clone.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "broken-clone"), { remotePath: remote });
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      {
        path: "workspace/broken-clone",
        git: { url: remote, branch: "main" },
      },
    ],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === "BetaCo::broken-clone");
  const target = join(organizationRoot, "workspace", "broken-clone");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo,
    deps: {
      run: async (args, options) => (
        args[0] === "clone"
          ? { ok: false, stdout: "", stderr: "simulated clone failure" }
          : runGit(args, options)
      ),
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_clone_failed",
  });
  expect(existsSync(target)).toBe(true);
  expect(await readdir(target)).toEqual([]);
});

async function prepareOrganizationRoot(organizationRoot) {
  await writeFile(
    join(organizationRoot, ".gitignore"),
    "/workspace/*/\n/design-system/\n/mission-control/\n",
  );
  await initGitRepo(organizationRoot);
}
