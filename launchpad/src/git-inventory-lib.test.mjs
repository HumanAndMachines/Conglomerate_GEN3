import { afterAll, expect, test } from "bun:test";
import { rm } from "fs/promises";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import { createLaunchpadGitFixture } from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("inventory reads repo paths from Organization manifests and does not infer layout from filesystem", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const repos = new Map(inventory.repos.map((repo) => [repo.key, repo]));

  expect(repos.get("OmegaCo::studio")).toMatchObject({
    organization: "OmegaCo",
    workspace: "workspace",
    module: "studio",
    repo_kind: "module",
    repo_path: "organizations/OmegaCo_GEN3/workspace/studio",
    expected_branch: "main",
  });
  expect(repos.get("BetaCo::deals")).toMatchObject({
    organization: "BetaCo",
    workspace: "workspace",
    module: "deals",
    repo_kind: "module",
    repo_path: "organizations/BetaCo_GEN3/modules/deals",
    expected_branch: "main",
  });
  expect(repos.get("OmegaCo::infra")).toMatchObject({
    organization: "OmegaCo",
    module: "infra",
    repo_kind: "root_repo",
    repo_path: "organizations/OmegaCo_GEN3/infra",
  });
  expect(repos.has("BetaCo::brainstorm")).toBe(false);
  expect(inventory.planned.map((slot) => `${slot.organization}::${slot.module}`)).toContain("BetaCo::brainstorm");
});

test("template mount (organization_kind=template) je z git inventáře vyloučený (decision 0077)", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { mkdir, writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const templateRoot = join(root, "organizations", "OrganizationTemplate_GEN3");
  await mkdir(templateRoot, { recursive: true });
  await writeFile(
    join(templateRoot, "company.gen3.json"),
    JSON.stringify({ organization_generation: "gen3", organization_kind: "template", company: { slug: "<VYPLNIT_slug>" } }),
    "utf8",
  );

  const inventory = await buildGitInventory({ companiesRoot: root });

  // Template mount se nesmí stát akčním repozitářem na git/worktree plochách.
  expect(inventory.repos.some((repo) => repo.repo_path.includes("OrganizationTemplate_GEN3"))).toBe(false);
  expect(inventory.repos.some((repo) => repo.organization === "OrganizationTemplate")).toBe(false);
});

test("ne-template mount s placeholder slugem je z git inventáře vynechaný (zrcadlí discovery guard)", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { mkdir, writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const scaffoldRoot = join(root, "organizations", "ScaffoldOrg_GEN3");
  await mkdir(scaffoldRoot, { recursive: true });
  // Nedokončený scaffold: deklarovaný slug je placeholder a marker template chybí.
  await writeFile(
    join(scaffoldRoot, "company.gen3.json"),
    JSON.stringify({ organization_generation: "gen3", company: { slug: "<VYPLNIT_slug>" } }),
    "utf8",
  );

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.repo_path.includes("ScaffoldOrg_GEN3"))).toBe(false);
  expect(inventory.repos.some((repo) => repo.organization === "ScaffoldOrg")).toBe(false);
});

test("mount bez povinné GEN3 struktury je z git inventáře vynechaný s warningem (stejný gate jako discovery)", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { mkdir, writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const brokenRoot = join(root, "organizations", "BrokenOrg_GEN3");
  await mkdir(brokenRoot, { recursive: true });
  // Validní marker, ale chybí modules.manifest.json, manual i company/colleagues.
  await writeFile(
    join(brokenRoot, "company.gen3.json"),
    JSON.stringify({ organization_generation: "gen3", company: { slug: "BrokenOrg" } }),
    "utf8",
  );

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.organization === "BrokenOrg")).toBe(false);
  expect(inventory.warnings.some((warning) => warning.includes("BrokenOrg_GEN3") && warning.includes("chybí povinná GEN3 struktura"))).toBe(true);

  // Gate platí i pro explicitně předaný organizations argument (discovery výstup) —
  // explicitní vstup nesmí obejít strukturální validaci přítomného mountu.
  const explicitInventory = await buildGitInventory({
    companiesRoot: root,
    organizations: [
      { slug: "BrokenOrg", display_name: "Broken Org", path: "organizations/BrokenOrg_GEN3", default_branch: "main" },
    ],
  });
  expect(explicitInventory.repos.some((repo) => repo.organization === "BrokenOrg")).toBe(false);
  expect(explicitInventory.warnings.some((warning) => warning.includes("chybí povinná GEN3 struktura"))).toBe(true);
});

test("inventory includes Organization roots and warns about missing mounts instead of crashing", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);

  const inventory = await buildGitInventory({
    companiesRoot: root,
    organizations: [
      { slug: "MissingOrg", display_name: "Missing Org", path: "organizations/MissingOrg_GEN3", default_branch: "main" },
    ],
  });

  expect(inventory.repos).toContainEqual(
    expect.objectContaining({
      key: "MissingOrg::root",
      organization: "MissingOrg",
      repo_kind: "organization_root",
      repo_path: "organizations/MissingOrg_GEN3",
      expected_branch: "main",
    }),
  );
  expect(inventory.warnings.some((warning) => warning.includes("MissingOrg_GEN3"))).toBe(true);
});
