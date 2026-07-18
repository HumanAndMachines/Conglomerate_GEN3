import { afterAll, expect, test } from "bun:test";
import { mkdir, rename, rm, symlink } from "fs/promises";
import { join } from "path";
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
    space: "root",
    workspace: null,
    module: "infra",
    repo_kind: "root_repo",
    repo_path: "organizations/OmegaCo_GEN3/infra",
  });
  expect(repos.has("BetaCo::brainstorm")).toBe(false);
  expect(inventory.planned.map((slot) => `${slot.organization}::${slot.module}`)).toContain("BetaCo::brainstorm");
});

test("inventory odmítne existující root, workspace i productionspace checkout přes symlink nebo Windows junction mimo Organizaci", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "productionspace/firmware",
    space: "productionspace",
    category: "firmware",
    repo: "git@github.com:OmegaCo/firmware.git",
    branch: "main",
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const externalRoot = join(root, "external-repositories");
  await Promise.all([
    mkdir(join(externalRoot, "infra"), { recursive: true }),
    mkdir(join(externalRoot, "studio"), { recursive: true }),
    mkdir(join(externalRoot, "firmware"), { recursive: true }),
    mkdir(join(organizationRoot, "workspace"), { recursive: true }),
    mkdir(join(organizationRoot, "productionspace"), { recursive: true }),
  ]);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await Promise.all([
    symlink(join(externalRoot, "infra"), join(organizationRoot, "infra"), linkType),
    symlink(join(externalRoot, "studio"), join(organizationRoot, "workspace", "studio"), linkType),
    symlink(join(externalRoot, "firmware"), join(organizationRoot, "productionspace", "firmware"), linkType),
  ]);

  const inventory = await buildGitInventory({ companiesRoot: root });

  expect(inventory.repos.some((repo) => repo.key === "OmegaCo::root")).toBe(true);
  for (const repoKey of ["OmegaCo::infra", "OmegaCo::studio", "OmegaCo::firmware"]) {
    expect(inventory.repos.some((repo) => repo.key === repoKey)).toBe(false);
  }
  expect(inventory.warnings.filter((warning) => warning.includes("symlink/junction"))).toHaveLength(3);
});

test("inventory odmítne Organization mount přes symlink nebo Windows junction mimo Conglomerate root", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "OmegaCo_GEN3");
  const externalRoot = join(root, "..", `escaped-organization-${process.pid}-${Date.now()}`);
  tempRoots.push(externalRoot);
  await rename(organizationRoot, externalRoot);
  await symlink(
    externalRoot,
    organizationRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  const inventory = await buildGitInventory({
    companiesRoot: root,
    organizations: [{
      slug: "OmegaCo",
      display_name: "OmegaCo GEN3",
      path: "organizations/OmegaCo_GEN3",
      default_branch: "main",
    }],
  });

  expect(inventory.repos.some((repo) => repo.organization === "OmegaCo")).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    "mount vynechán z git inventáře — kanonická cesta se přes symlink/junction dostává mimo Conglomerate root",
  );
});

test("inventory odmítne Organization mount aliasovaný přes symlink nebo Windows junction na sourozeneckou Organizaci", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const aliasPath = join(root, "organizations", "AliasCo_GEN3");
  await symlink(
    join(root, "organizations", "BetaCo_GEN3"),
    aliasPath,
    process.platform === "win32" ? "junction" : "dir",
  );

  const inventory = await buildGitInventory({
    companiesRoot: root,
    organizations: [{
      slug: "AliasCo",
      display_name: "AliasCo GEN3",
      path: "organizations/AliasCo_GEN3",
      default_branch: "main",
    }],
  });

  expect(inventory.repos.some((repo) => repo.organization === "AliasCo")).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    "organizations/AliasCo_GEN3: mount vynechán z git inventáře",
  );
});

test("reserved Organization root path cannot masquerade as a Team module", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "design-system",
    space: "workspace",
    workspace: "brand",
    category: "brand",
    git: { url: "git@github.com:OmegaCo/brand-design-system.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  expect(
    inventory.repos.some(
      (repo) =>
        repo.organization === "OmegaCo" && repo.slot_path === "design-system",
    ),
  ).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    'root slot design-system vynechán z git/worktree inventáře — musí explicitně deklarovat space: "root"',
  );
});

test("Organization kontejnery a descendants rezervovaných root slotů nevstoupí do inventáře", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  const invalidPaths = [
    "workspace/",
    "modules",
    "productionspace",
    "design-system/theme",
    "infra/state",
    "mission-control/cache",
    "mission-control/db/archive",
    "../Victim_GEN3",
    "/tmp/evil",
    "workspace/deep/repo",
    "workspace\\evil",
  ];
  for (const path of invalidPaths) {
    manifest.module_slots.push({
      path,
      space: "workspace",
      workspace: "workspace",
      category: "invalid-boundary",
      git: { url: `git@github.com:OmegaCo/${path.replaceAll("/", "-")}.git`, branch: "main" },
    });
  }
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const inventoriedPaths = [
    ...inventory.repos.map((repo) => repo.slot_path),
    ...inventory.planned.map((slot) => slot.slot_path),
  ];
  for (const path of ["workspace", "modules", "productionspace", ...invalidPaths.slice(3)]) {
    expect(inventoriedPaths).not.toContain(path);
  }
  expect(inventory.warnings.join("\n")).toContain(
    "Organization kontejner není repozitářový slot",
  );
  expect(inventory.warnings.join("\n")).toContain(
    "cesta je uvnitř rezervované Organization root boundary",
  );
  expect(inventory.warnings.join("\n")).toContain(
    "cesta není kanonická podporovaná Organization-relative repo boundary",
  );
  expect(
    inventory.repos.some((repo) =>
      repo.absolute_path.includes("Victim_GEN3"),
    ),
  ).toBe(false);
});

test("productionspace path cannot masquerade as an actionable Team module", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "productionspace/firmware",
    space: "workspace",
    category: "firmware",
    git: { url: "git@github.com:OmegaCo/firmware.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  const slot = inventory.repos.find(
    (repo) =>
      repo.organization === "OmegaCo" &&
      repo.slot_path === "productionspace/firmware",
  );

  expect(slot).toMatchObject({
    space: "productionspace",
    workspace: "productionspace",
    repo_kind: "productionspace",
  });

  manifest.module_slots.push({
    path: "productionspace/",
    space: "workspace",
    category: "boundary",
    git: { url: "git@github.com:OmegaCo/productionspace.git", branch: "main" },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const inventoryWithBoundary = await buildGitInventory({ companiesRoot: root });
  expect(
    inventoryWithBoundary.repos.find(
      (repo) =>
        repo.organization === "OmegaCo" && repo.slot_path === "productionspace",
    ),
  ).toBeUndefined();
  expect(inventoryWithBoundary.warnings.join("\n")).toContain(
    "slot productionspace/ vynechán z git/worktree inventáře — Organization kontejner není repozitářový slot",
  );
});

test("incomplete active root coordinates never enter actionable inventory", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "design-system",
    space: "root",
    category: "brand",
    git: {
      url: "git@github.com:OmegaCo/design-system.git",
    },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  expect(
    inventory.repos.some(
      (repo) =>
        repo.organization === "OmegaCo" && repo.slot_path === "design-system",
    ),
  ).toBe(false);
  expect(
    inventory.planned.some(
      (slot) =>
        slot.organization === "OmegaCo" && slot.slot_path === "design-system",
    ),
  ).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    "aktivní root slot musí mít úplné git.url i git.branch",
  );
});

test("root inventory rejects legacy aliases even beside canonical git coordinates", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const manifestPath = `${root}/organizations/OmegaCo_GEN3/modules.manifest.json`;
  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.push({
    path: "design-system",
    space: "root",
    category: "brand",
    repo: "git@github.com:WrongOrg/wrong-design-system.git",
    branch: "legacy",
    git: {
      url: "git@github.com:OmegaCo/design-system.git",
      branch: "main",
    },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = await buildGitInventory({ companiesRoot: root });
  expect(
    inventory.repos.some(
      (repo) =>
        repo.organization === "OmegaCo" && repo.slot_path === "design-system",
    ),
  ).toBe(false);
  expect(inventory.warnings.join("\n")).toContain(
    "root-neplatná pole (repo, branch)",
  );
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
