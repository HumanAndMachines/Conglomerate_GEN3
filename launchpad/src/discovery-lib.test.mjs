import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { discoverLaunchpadApps, organizationRelativePathIssue } from "./discovery-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("discovery načte read-only plugin metadata", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
      summary: "Read-only metadata pro Launchpad.",
      metadata: [
        {
          label: "Source of truth",
          value: "Git filesystem database",
        },
      ],
      links: [
        {
          label: "Manuál",
          kind: "manual",
          path: "modules/demo/app/v1/README.md",
        },
      ],
      sections: [
        {
          title: "Poznámka",
          body: "Plugin nespouští kód.",
        },
      ],
    },
  });
  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps[0].plugin).toMatchObject({
    schema_version: "companyascode.launchpad_plugin.v1",
    title: "Demo kontext",
    path: "organizations/TestCompany/modules/demo/app/v1/launchpad.plugin.json",
  });
  expect(apps[0].cwd).toBe("organizations/TestCompany/modules/demo/app/v1");
  expect(apps[0].plugin.links[0].path).toBe("modules/demo/app/v1/README.md");
});

test("discovery přenese builder metadata icon/description/group z manifestu", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
    appOverrides: {
      icon: "control",
      description: "Denní přehled a spuštění firemních aplikací.",
      group: "Denní práce",
    },
  });
  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(apps[0].icon).toBe("control");
  expect(apps[0].description).toBe("Denní přehled a spuštění firemních aplikací.");
  expect(apps[0].group).toBe("Denní práce");
});

test("discovery bez builder metadata dá null fallback bez failure", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps[0].icon).toBeNull();
  expect(apps[0].description).toBeNull();
  expect(apps[0].group).toBeNull();
});

test("discovery je warning-first u vadného builder metadata, appka zůstává validní", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
    appOverrides: {
      description: "x".repeat(500),
      group: "   ",
    },
  });
  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  // Appka zůstává v apps (ne v invalid_apps) — warning-first.
  expect(apps).toHaveLength(1);
  // Prázdný group spadne na null; příliš dlouhý description dostane varování.
  expect(apps[0].group).toBeNull();
  expect(warnings.some((warning) => warning.includes("description") && warning.includes("builder metadata"))).toBe(true);
  expect(warnings.some((warning) => warning.includes("group") && warning.includes("builder metadata"))).toBe(true);
});

test("discovery přenese production_url (PROD run) z manifestu", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
    appOverrides: { production_url: "https://deals.omegaco.com" },
  });
  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(apps[0].production_url).toBe("https://deals.omegaco.com");
});

test("discovery bez production_url dá null (honest disabled PROD stub)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps[0].production_url).toBeNull();
});

test("discovery je warning-first u nevalidní production_url, appka zůstává validní", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
    appOverrides: { production_url: "deals.omegaco.com" },
  });
  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps).toHaveLength(1);
  expect(apps[0].production_url).toBeNull();
  expect(warnings.some((warning) => warning.includes("production_url") && warning.includes("builder metadata"))).toBe(true);
});

test("discovery fail-closed na malformed production_url (review P1 2026-07-16)", async () => {
  for (const value of ["https://", "http://[", "https:// user", "https://?x"]) {
    const root = await createCompaniesWorkspaceFixture({
      plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
      appOverrides: { production_url: value },
    });
    const { apps, failures } = await discoverLaunchpadApps(root);
    expect(failures).toEqual([]);
    expect(apps[0].production_url).toBeNull();
  }
});

test("discovery přeskočí adresář bez company.gen3.json bez failure (scan-first)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  // Holý adresář bez markeru (rozdělaný checkout, pracovní složka) není
  // Organizace → skenem se přeskočí, nikdy jako failure (decision 0042).
  await mkdir(join(root, "organizations", "JustAFolder"), { recursive: true });
  await writeFile(join(root, "organizations", "JustAFolder", "note.md"), "# nic", "utf8");

  const { apps, organizations, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(apps).toHaveLength(1);
  expect(organizations.map((organization) => organization.slug)).toEqual(["test-company"]);
});

test("discovery podporuje Mission Control data-repo cutover bez root task ledgerů", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  for (const ledger of ["TODO.tasks.json", "DONE.tasks.json", "ISSUES.open.json"]) {
    await rm(join(root, "organizations", "TestCompany", ledger), { force: true });
  }

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps).toHaveLength(1);
});

test("legacy registry klíče se ignorují s jedním deprecation warningem, ne failure (scan-first)", async () => {
  const root = await createGenerationMountFixture();
  // Stale lokální kopie sdíleného configu ještě nese registry klíče, včetně
  // Organizace, která na disku VŮBEC není namountovaná.
  const config = await Bun.file(join(root, "launchpad.gen3.json")).json();
  config.organizations = [
    { slug: "GhostOrg", display_name: "Ghost", path: "organizations/GhostOrg_GEN3" },
  ];
  config.templates = [
    { slug: "mission-control-template", template_type: "module", path: "templates/x/MissionControlTemplate" },
  ];
  await writeJson(join(root, "launchpad.gen3.json"), config);

  const { organizations, failures, warnings } = await discoverLaunchpadApps(root);

  // Registry se ignoruje: chybějící mount NIKDY není failure a duch z registru se neobjeví.
  expect(failures).toEqual([]);
  expect(organizations.some((organization) => organization.slug === "GhostOrg")).toBe(false);
  // Jen jeden deprecation warning zmíní zastaralé klíče.
  const deprecation = warnings.filter((warning) => warning.includes("zastaralé registry klíče"));
  expect(deprecation).toHaveLength(1);
  expect(deprecation[0]).toContain("organizations");
  expect(deprecation[0]).toContain("templates");
  // Skutečné Organizace se dál objeví skenem disku.
  expect(organizations.some((organization) => organization.slug === "DemoCo")).toBe(true);
});

test("discovery podporuje _GEN3 mount cesty při čisté interní identitě Organizace", async () => {
  const root = await createGenerationMountFixture();
  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => [app.company, app.organization_path, app.package_path])).toEqual([
    [
      "BetaCo",
      "organizations/BetaCo_GEN3",
      "organizations/BetaCo_GEN3/mission-control/app/v2/package.json",
    ],
    [
      "DemoCo",
      "organizations/DemoCo_GEN3",
      "organizations/DemoCo_GEN3/mission-control/app/v1/package.json",
    ],
  ]);
});

test("proper-case company je přesná identita, ale app id musí zůstat lowercase", async () => {
  const root = await createGenerationMountFixture();
  const packagePath = join(
    root,
    "organizations",
    "BetaCo_GEN3",
    "mission-control",
    "app",
    "v2",
    "package.json",
  );
  const packageJson = await Bun.file(packagePath).json();
  packageJson.companyascode.app.id = "BetaCo-mission-control-v2";
  await writeJson(packagePath, packageJson);

  const { apps, invalid_apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => [app.id, app.company])).toEqual([
    ["democo-mission-control-v1", "DemoCo"],
  ]);
  expect(invalid_apps).toHaveLength(1);
  expect(invalid_apps[0]).toMatchObject({
    id: "BetaCo-mission-control-v2",
    company: "BetaCo",
    manifest_state: "invalid_manifest",
  });
  expect(invalid_apps[0].manifest_issues.join("\n")).toContain(
    "companyascode.app.id neodpovídá patternu ^[a-z0-9][a-z0-9-]*$",
  );
});

test("discovery načte root shared Guide local surface jako Launchpad app", async () => {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-shared-guide-"));
  tempRoots.push(root);
  const guideAppRoot = join(root, "guide", "app", "v1");
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(root, "organizations"), { recursive: true });
  await mkdir(guideAppRoot, { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "conglomerate",
      display_name: "Conglomerate",
      root_role: "launchpad-root",
    },
    local_surfaces: [
      {
        path: "guide",
        kind: "shared-guide",
        authority: "read-only-view",
      },
    ],
  });
  await writeJson(join(guideAppRoot, "package.json"), {
    name: "conglomerate-guide-v1",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "conglomerate-guide-v1",
        title: "Guide GEN3",
        company: "conglomerate",
        module: "guide",
        surface: "manual",
        port: 5281,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["guide", "onboarding", "first-client"],
      },
    },
  });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => [app.id, app.company, app.organization_path, app.package_path])).toContainEqual([
    "conglomerate-guide-v1",
    "conglomerate",
    "guide",
    "guide/app/v1/package.json",
  ]);
});

test("discovery automaticky načte lokálně naklonovanou Organization bez registry entry", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OmegaCo_GEN3",
    company: "OmegaCo",
    appDir: "mission-control/app/v3",
    appId: "omegaco-mission-control-v3",
    port: 5293,
  });

  const { apps, failures, organizations } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(organizations.map((organization) => [
    organization.slug,
    organization.path,
    organization.discovery_source,
  ])).toContainEqual([
    "OmegaCo",
    "organizations/OmegaCo_GEN3",
    "filesystem",
  ]);
  expect(apps.map((app) => [app.company, app.organization_path, app.package_path])).toContainEqual([
    "OmegaCo",
    "organizations/OmegaCo_GEN3",
    "organizations/OmegaCo_GEN3/mission-control/app/v3/package.json",
  ]);
});

test("discovery ignoruje organization-local worktree checkouty", async () => {
  const root = await createGenerationMountFixture();
  const worktreeAppRoot = join(
    root,
    "organizations",
    "BetaCo_GEN3",
    ".worktrees",
    "DEV-0028-invoices-deals-link",
    "mission-control",
    "app",
    "v2",
  );
  await mkdir(worktreeAppRoot, { recursive: true });
  await writeJson(join(worktreeAppRoot, "package.json"), {
    name: "betaco-mission-control-v2-worktree-copy",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "betaco-mission-control-v2",
        title: "Mission Control",
        company: "BetaCo",
        module: "mission-control",
        surface: "internal",
        port: 5392,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["mission-control"],
      },
    },
  });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => app.package_path)).toEqual([
    "organizations/BetaCo_GEN3/mission-control/app/v2/package.json",
    "organizations/DemoCo_GEN3/mission-control/app/v1/package.json",
  ]);
});

test("discovery ignoruje skryté nekanonické workspace checkouty, takže nemohou vyhrát duplicitní app id", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  const companyRoot = join(root, "organizations", "TestCompany");
  const canonicalAppRoot = join(companyRoot, "workspace", "warehouse", "app", "v1");
  const hiddenAppRoot = join(companyRoot, "workspace", ".warehouse-pr41-buddy-review", "app", "v1");
  const packageJson = {
    name: "test-company-warehouse-v1",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-warehouse-v1",
        title: "Warehouse v1",
        company: "test-company",
        module: "warehouse",
        surface: "internal",
        port: 4361,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["warehouse"],
      },
    },
  };
  await mkdir(canonicalAppRoot, { recursive: true });
  await mkdir(hiddenAppRoot, { recursive: true });
  await writeJson(join(canonicalAppRoot, "package.json"), packageJson);
  await writeJson(join(hiddenAppRoot, "package.json"), packageJson);

  const { apps, invalid_apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(invalid_apps).toEqual([]);
  expect(apps.find((app) => app.id === "test-company-warehouse-v1")?.package_path).toBe(
    "organizations/TestCompany/workspace/warehouse/app/v1/package.json",
  );
  expect(apps.some((app) => app.package_path.includes(".warehouse-pr41-buddy-review"))).toBe(false);
});

test("discovery izoluje nevalidní app manifest jako invalid_apps záznam (decision 0043)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  const staleAppRoot = join(root, "organizations", "TestCompany", "modules", "stale", "app", "v1");
  await mkdir(staleAppRoot, { recursive: true });
  await writeJson(join(staleAppRoot, "package.json"), {
    name: "stale-app",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "stale-app-v1",
        title: "Stale app",
        company: "workspace",
        module: "stale",
        surface: "internal",
        port: 4243,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["stale"],
      },
    },
  });

  const { apps, invalid_apps, failures, warnings } = await discoverLaunchpadApps(root);

  // Nevalidní manifest nesmí být root failure — izoluje jen dotčenou appku.
  expect(failures).toEqual([]);
  expect(warnings.some((warning) => warning.includes("invalid app manifest"))).toBe(true);
  expect(warnings.some((warning) => warning.includes("companyascode.app.company musí být test-company"))).toBe(true);
  expect(apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(invalid_apps).toHaveLength(1);
  expect(invalid_apps[0]).toMatchObject({
    id: "stale-app-v1",
    company: "test-company",
    manifest_state: "invalid_manifest",
    package_path: "organizations/TestCompany/modules/stale/app/v1/package.json",
  });
  expect(invalid_apps[0].manifest_issues.length).toBeGreaterThan(0);
});

test("deklarovaný port overlap zachová obě auto-discovered Organizace", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OmegaCo_GEN3",
    company: "OmegaCo",
    appDir: "mission-control/app/v3",
    appId: "omegaco-mission-control-v3",
    port: 5392, // stejný stabilní port jako BetaCo mission-control v2 z registry
  });
  await writeGenerationOrg({
    root,
    path: "organizations/Zeta_GEN3",
    company: "Zeta",
    appDir: "mission-control/app/v1",
    appId: "zeta-mission-control-v1",
    port: 5393,
  });

  const { apps, failures, organizations, port_overlaps: portOverlaps } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(
    organizations.some(
      (organization) => organization.slug === "OmegaCo" && organization.discovery_source === "filesystem",
    ),
  ).toBe(true);
  expect(apps.map((app) => app.id)).toContain("omegaco-mission-control-v3");
  const overlap = portOverlaps.find((item) => item.port === 5392);
  expect(overlap?.owners.map((owner) => owner.app_id).sort()).toEqual([
    "betaco-mission-control-v2",
    "omegaco-mission-control-v3",
  ]);
  expect(overlap?.owners.map((owner) => owner.package_path)).toContain(
    "organizations/OmegaCo_GEN3/mission-control/app/v3/package.json",
  );
  expect(portOverlaps.some((item) => item.port === 5393)).toBe(false);
  expect(apps.find((app) => app.id === "omegaco-mission-control-v3")?.shared_port_owners).toHaveLength(2);
});

test("duplicitní app id izoluje druhý manifest, první zůstává platný (decision 0043)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  const dupAppRoot = join(root, "organizations", "TestCompany", "modules", "dup", "app", "v1");
  await mkdir(dupAppRoot, { recursive: true });
  await writeJson(join(dupAppRoot, "package.json"), {
    name: "dup-app",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-demo-v1", // koliduje s modules/demo
        title: "Duplicate id app",
        company: "test-company",
        module: "dup",
        surface: "internal",
        port: 4360,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["dup"],
      },
    },
  });

  const { apps, invalid_apps, failures, warnings } = await discoverLaunchpadApps(root);

  // Kolize id nesmí shodit root (decision 0043) — druhý manifest se izoluje.
  expect(failures).toEqual([]);
  expect(apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
  expect(apps[0].package_path).toBe("organizations/TestCompany/modules/demo/app/v1/package.json");
  expect(invalid_apps).toHaveLength(1);
  expect(invalid_apps[0].package_path).toBe("organizations/TestCompany/modules/dup/app/v1/package.json");
  expect(invalid_apps[0].manifest_issues[0]).toContain("koliduje");
  // Response nikdy nenese dvě položky se stejným id.
  expect(invalid_apps[0].id).toBe("invalid-manifest:organizations/TestCompany/modules/dup/app/v1/package.json");
  expect(warnings.some((warning) => warning.includes("koliduje"))).toBe(true);
});

test("obsahová chyba pluginu izoluje appku, read-only violace zůstává hard failure (decision 0043)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "", // prázdný title = kvalita manifestu, ne security
    },
  });

  const { apps, invalid_apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps).toHaveLength(0);
  expect(invalid_apps).toHaveLength(1);
  expect(invalid_apps[0].manifest_issues.some((issue) => issue.includes("title"))).toBe(true);
});

test("Synchronizovat flow: nový lokální mount se objeví bez editace root manifestu (decision 0042)", async () => {
  const root = await createGenerationMountFixture();

  const before = await discoverLaunchpadApps(root);
  expect(before.organizations.some((organization) => organization.slug === "OmegaCo")).toBe(false);

  // Simulace „GitHub přístup → git clone / doctor sync" nového mountu:
  await writeGenerationOrg({
    root,
    path: "organizations/OmegaCo_GEN3",
    company: "OmegaCo",
    appDir: "mission-control/app/v3",
    appId: "omegaco-mission-control-v3",
    port: 5293,
  });

  // „Synchronizovat" = nový průchod discovery bez restartu a bez root editace.
  const after = await discoverLaunchpadApps(root);
  expect(after.failures).toEqual([]);
  expect(after.organizations.some(
    (organization) => organization.slug === "OmegaCo" && organization.discovery_source === "filesystem",
  )).toBe(true);
  expect(after.apps.some((app) => app.id === "omegaco-mission-control-v3")).toBe(true);
});

test("discovery nenačítá productionspace app manifesty jako lifecycle aplikace", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
  });
  const productionAppRoot = join(root, "organizations", "TestCompany", "productionspace", "critical", "app", "v1");
  await mkdir(productionAppRoot, { recursive: true });
  await writeJson(join(productionAppRoot, "package.json"), {
    name: "production-critical-app",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-production-critical-v1",
        title: "Critical production app",
        company: "test-company",
        module: "critical",
        surface: "productionspace",
        port: 4244,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["productionspace"],
      },
    },
  });

  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(warnings).toEqual([]);
  expect(apps.map((app) => app.id)).toEqual(["test-company-demo-v1"]);
});

test("discovery odmítne plugin s akčním polem", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Nebezpečný plugin",
      actions: [
        {
          label: "Run",
          command: "bun run write",
        },
      ],
    },
  });
  const { failures } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("actions není povolené pole"))).toBe(true);
});

test("discovery odmítne Windows drive-qualified plugin cestu mimo Organization boundary", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: {
      schema_version: "companyascode.launchpad_plugin.v1",
      title: "Demo kontext",
    },
    appOverrides: {
      plugin: "D:outside.json",
    },
  });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(apps).toEqual([]);
  expect(failures.some((failure) => failure.includes("D:outside.json") && failure.includes("uvnitř"))).toBe(true);
});

test("template mount (organization_kind=template) je validovaný, ale mimo organizations, apps i counts", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "OrganizationTemplate",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5999,
    organizationKind: "template",
  });

  const { apps, organizations, template_mounts, template_apps, failures } = await discoverLaunchpadApps(root);

  // Template mount se nepočítá mezi Organizace ani nespouští appky.
  expect(failures).toEqual([]);
  expect(organizations.some((organization) => organization.slug === "OrganizationTemplate")).toBe(false);
  expect(apps.some((app) => app.organization_path === "organizations/OrganizationTemplate_GEN3")).toBe(false);
  // Je ale validovaný a viditelný v oddělených template polích.
  expect(template_mounts.map((mount) => [mount.slug, mount.path, mount.organization_kind])).toContainEqual([
    "OrganizationTemplate",
    "organizations/OrganizationTemplate_GEN3",
    "template",
  ]);
  expect(template_apps.map((app) => [app.id, app.organization_path, app.manifest_state, app.organization_kind])).toContainEqual([
    "organizationtemplate-mission-control-v1",
    "organizations/OrganizationTemplate_GEN3",
    "template",
    "template",
  ]);
});

test("mount bez markeru zůstává běžná Organizace i s jménem OrganizationTemplate (zpětná kompatibilita)", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate",
    company: "OrganizationTemplate",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5998,
  });

  const { apps, organizations, template_mounts, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  // Chybějící organization_kind = organization: dřívější hardcoded filtr na jméno je pryč.
  expect(organizations.some((organization) => organization.slug === "OrganizationTemplate")).toBe(true);
  expect(apps.some((app) => app.id === "organizationtemplate-mission-control-v1")).toBe(true);
  expect(template_mounts).toEqual([]);
});

test("template appky smějí sdílet deklarovaný port bez root failure", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "OrganizationTemplate",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5297,
    organizationKind: "template",
  });
  // Druhá template appka deklaruje stejný stabilní port jako první.
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "OrganizationTemplate",
    appDir: "warehouse/app/v1",
    appId: "organizationtemplate-warehouse-v1",
    port: 5297,
    organizationKind: "template",
  });

  const { apps, template_apps, failures, warnings } = await discoverLaunchpadApps(root);

  // Deklarovaný překryv není nevalidní manifest ani warning; template appky
  // jsou stejně jako reálné app surfaces validované bez globální port mapy.
  expect(failures).toEqual([]);
  expect(apps.length).toBeGreaterThan(0);
  expect(warnings.some((warning) => warning.includes("template port"))).toBe(false);
  expect(template_apps.filter((app) => app.port === 5297)).toHaveLength(2);
  expect(template_apps.every((app) => app.manifest_state === "template")).toBe(true);
});

test("template mount s placeholder slugem se objeví, slug se bere z adresáře mountu", async () => {
  const root = await createGenerationMountFixture();
  // Reálný OrganizationTemplate má v company.gen3.json placeholder slug; marker
  // organization_kind=template ho přesto zpřístupní (slug spadne na jméno adresáře).
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "vyplnit-company-slug",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5990,
    organizationKind: "template",
  });

  const { organizations, template_mounts, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  // Placeholder slug se nikdy neobjeví jako reálná Organizace…
  expect(organizations.some((organization) => organization.slug === "vyplnit-company-slug")).toBe(false);
  // …ale jako template mount se stabilním slugem odvozeným z adresáře.
  expect(template_mounts.map((mount) => [mount.slug, mount.path, mount.organization_kind])).toContainEqual([
    "OrganizationTemplate",
    "organizations/OrganizationTemplate_GEN3",
    "template",
  ]);
});

test("module šablony se objeví informačně skenem templates/*/*, chybějící = prázdný seznam bez failure", async () => {
  const root = await createGenerationMountFixture();
  await mkdir(join(root, "templates", "TemplatesBetaCo", "MissionControlTemplate"), { recursive: true });
  await mkdir(join(root, "templates", "TemplatesBetaCo", "KnowledgebaseTemplate"), { recursive: true });

  const { module_templates, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(module_templates.map((template) => [template.slug, template.path])).toEqual([
    ["KnowledgebaseTemplate", "templates/TemplatesBetaCo/KnowledgebaseTemplate"],
    ["MissionControlTemplate", "templates/TemplatesBetaCo/MissionControlTemplate"],
  ]);
});

test("vadný template package.json je izolovaný — discovery reálných firem přežije", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "OrganizationTemplate",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5995,
    organizationKind: "template",
  });
  // Rozbij template package.json po vygenerování validní struktury.
  await writeFile(
    join(root, "organizations", "OrganizationTemplate_GEN3", "mission-control", "app", "v1", "package.json"),
    "{ not valid json",
    "utf8",
  );

  const { apps, template_apps, failures, warnings } = await discoverLaunchpadApps(root);

  // Selhání template package.json se nikdy nepromítne do global failures.
  expect(failures).toEqual([]);
  expect(apps.length).toBeGreaterThan(0);
  expect(warnings.some((warning) => warning.includes("template package.json nejde přečíst"))).toBe(true);
  expect(template_apps.some((app) => app.manifest_state === "invalid_manifest")).toBe(true);
});

test("per-machine local_surfaces se načtou z launchpad.gen3.local.json", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const localGuideRoot = join(root, "local-guide");
  await mkdir(localGuideRoot, { recursive: true });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    local_surfaces: [
      {
        path: "local-guide",
        kind: "shared-guide",
        authority: "local-machine",
      },
    ],
  });
  await writeJson(join(localGuideRoot, "package.json"), {
    name: "local-machine-guide",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "local-machine-guide",
        title: "Local Machine Guide",
        company: "test-companies",
        module: "local-guide",
        surface: "manual",
        port: 5299,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["guide", "local"],
      },
    },
  });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => app.id)).toContain("local-machine-guide");
});

test("planned sloty se čtou z per-machine launchpad.gen3.local.json, namountovaný slug vyhrává (scan-first)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    planned_organizations: [
      { slug: "future-org", display_name: "Future Org", git_url: "git@github.com:example/FutureOrg_GEN3.git" },
      { slug: "test-company", display_name: "Duplikát mountnuté" },
      { slug: "<organization-slug>" },
    ],
  });

  const { apps, organizations, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  const planned = organizations.find((organization) => organization.slug === "future-org");
  expect(planned).toMatchObject({ status: "planned", discovery_source: "local_override", path: null });
  // Namountovaná Organizace se stejným slugem vyhrává nad planned slotem.
  const mounted = organizations.filter((organization) => organization.slug === "test-company");
  expect(mounted).toHaveLength(1);
  expect(mounted[0].status).toBe("mounted");
  // Placeholder řádek z .example se tiše přeskočí; planned slot nemá spustitelné appky.
  expect(organizations.some((organization) => organization.slug.includes("<"))).toBe(false);
  expect(apps).toHaveLength(1);
});

test("nečitelný company.gen3.json marker přítomného mountu je hard failure, ne tichý skip (scan-first)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  // Marker existuje, ale je to rozbitý JSON — mount nesmí zmizet z discovery.
  await writeFile(join(root, "organizations", "TestCompany", "company.gen3.json"), "{ rozbité", "utf8");

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("company.gen3.json nejde přečíst"))).toBe(true);
  expect(apps).toEqual([]);
});

test("namountovaná Organizace bez povinné GEN3 struktury je hard failure a její balíčky se neprocházejí (scan-first)", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  // Mount existuje (company.gen3.json marker), ale povinná hranice je rozbitá.
  await rm(join(root, "organizations", "TestCompany", "modules.manifest.json"));
  await rm(join(root, "organizations", "TestCompany", "company", "colleagues"), { recursive: true });

  const { apps, failures } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("chybí modules.manifest.json"))).toBe(true);
  expect(failures.some((failure) => failure.includes("chybí company/colleagues"))).toBe(true);
  // Appka z nezvalidované hranice se nesmí stát spustitelnou.
  expect(apps).toEqual([]);
});

test("Organization cross-file gate failuje identity/Team/Git, ale modules/* hlásí jako incremental warning", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const companyRoot = join(root, "organizations", "TestCompany");
  const companyConfig = await Bun.file(join(companyRoot, "company.gen3.json")).json();
  companyConfig.company.github_org = "CorrectGithubOrg";
  companyConfig.teams = [{ slug: "workspace", display_name: "Hlavní Team", default: true }];
  await writeJson(join(companyRoot, "company.gen3.json"), companyConfig);
  await mkdir(join(companyRoot, "workspace", "no-git"), { recursive: true });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "WrongCompany",
    github_org: "WrongGithubOrg",
    module_slots: [
      {
        path: "modules/demo",
        teams: ["missing-team"],
        git: { url: "git@github.com:vyplnit-github-org/demo.git", branch: "main" },
      },
      {
        path: "workspace/no-git",
        teams: ["workspace"],
      },
    ],
  });

  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("company.slug") && failure.includes("WrongCompany"))).toBe(true);
  expect(failures.some((failure) => failure.includes("company.github_org") && failure.includes("WrongGithubOrg"))).toBe(true);
  expect(warnings.some((warning) => warning.includes('path "modules/demo"') && warning.includes("deprecated modules/*"))).toBe(true);
  expect(failures.some((failure) => failure.includes('neexistující Team "missing-team"'))).toBe(true);
  expect(failures.some((failure) => failure.includes('aktivní modul "modules/demo"') && failure.includes("git URL"))).toBe(true);
  expect(failures.some((failure) => failure.includes('aktivní modul "workspace/no-git"') && failure.includes("git URL"))).toBe(true);
  // Mount s rozbitým Organization kontraktem nesmí dodat spustitelnou appku.
  expect(apps).toEqual([]);
});

test("legacy modules/* mount zůstane během incremental rollout načtený s warningem", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const companyRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      {
        path: "modules/demo",
        git: { url: "git@github.com:TestCompany/demo.git", branch: "main" },
      },
    ],
  });

  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => app.id)).toContain("test-company-demo-v1");
  expect(warnings.some((warning) => warning.includes('path "modules/demo"') && warning.includes("incremental rollout"))).toBe(true);
});

test("case-only Organization identity drift je incremental warning, ne mount blocker", async () => {
  const root = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const companyRoot = join(root, "organizations", "TestCompany");
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "TEST-COMPANY",
    github_org: "testcompany",
    module_slots: [],
  });

  const { apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(apps.map((app) => app.id)).toContain("test-company-demo-v1");
  expect(warnings.filter((warning) => warning.includes("canonical casing")).length).toBe(2);
});

test("Organization cross-file identity gate failuje i při chybějícím poli na kterékoli straně", async () => {
  const missingManifestRoot = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const missingManifestCompanyRoot = join(missingManifestRoot, "organizations", "TestCompany");
  const manifest = await Bun.file(join(missingManifestCompanyRoot, "modules.manifest.json")).json();
  delete manifest.company;
  await writeJson(join(missingManifestCompanyRoot, "modules.manifest.json"), manifest);

  const missingManifestResult = await discoverLaunchpadApps(missingManifestRoot);
  expect(
    missingManifestResult.failures.some(
      (failure) => failure.includes("modules.manifest.json company") && failure.includes("povinné"),
    ),
  ).toBe(true);
  expect(missingManifestResult.apps).toEqual([]);

  const missingCompanyRoot = await createCompaniesWorkspaceFixture({
    plugin: { schema_version: "companyascode.launchpad_plugin.v1", title: "Demo kontext" },
  });
  const missingCompanyConfigRoot = join(missingCompanyRoot, "organizations", "TestCompany");
  const companyConfig = await Bun.file(join(missingCompanyConfigRoot, "company.gen3.json")).json();
  delete companyConfig.company.github_org;
  await writeJson(join(missingCompanyConfigRoot, "company.gen3.json"), companyConfig);

  const missingCompanyResult = await discoverLaunchpadApps(missingCompanyRoot);
  expect(
    missingCompanyResult.failures.some(
      (failure) => failure.includes("company.gen3.json company.github_org") && failure.includes("povinné"),
    ),
  ).toBe(true);
  expect(missingCompanyResult.apps).toEqual([]);
});

test("template placeholder varianty jsou incremental warning, ne runtime blocker", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/OrganizationTemplate_GEN3",
    company: "vyplnit-company-slug",
    appDir: "mission-control/app/v1",
    appId: "organizationtemplate-mission-control-v1",
    port: 5991,
    organizationKind: "template",
  });
  const templateRoot = join(root, "organizations", "OrganizationTemplate_GEN3");
  const companyConfig = await Bun.file(join(templateRoot, "company.gen3.json")).json();
  companyConfig.company.github_org = "vyplnit-github-org";
  await writeJson(join(templateRoot, "company.gen3.json"), companyConfig);
  await writeJson(join(templateRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "<VYPLNIT_COMPANY_NAME>",
    github_org: "<VYPLNIT_GITHUB_ORG>",
    module_slots: [
      {
        path: "modules/knowledgebase",
        status: "planned_slot",
        teams: ["workspace"],
      },
    ],
  });

  const { template_apps, failures, warnings } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("OrganizationTemplate_GEN3") && failure.includes("company.slug"))).toBe(false);
  expect(warnings.some((warning) => warning.includes("OrganizationTemplate_GEN3") && warning.includes("company.slug"))).toBe(true);
  expect(failures.some((failure) => failure.includes("OrganizationTemplate_GEN3") && failure.includes("company.github_org"))).toBe(false);
  expect(warnings.some((warning) => warning.includes("OrganizationTemplate_GEN3") && warning.includes("company.github_org"))).toBe(true);
  expect(
    warnings.some(
      (warning) =>
        warning.includes("OrganizationTemplate_GEN3") &&
        warning.includes('path "modules/knowledgebase"') &&
        warning.includes("deprecated modules/*"),
    ),
  ).toBe(true);
  expect(template_apps.some((app) => app.organization_path === "organizations/OrganizationTemplate_GEN3")).toBe(true);
});

test("placeholder Organization identita bez markeru template je hard failure", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/Scaffold_GEN3",
    company: "vyplnit-company-slug",
    appDir: "mission-control/app/v1",
    appId: "scaffold-mission-control-v1",
    port: 5992,
  });

  const { organizations, failures } = await discoverLaunchpadApps(root);

  expect(failures.some((failure) => failure.includes("Scaffold_GEN3") && failure.includes("povolená jen") && failure.includes("organization_kind"))).toBe(true);
  expect(organizations.some((organization) => organization.path === "organizations/Scaffold_GEN3")).toBe(false);
});

test("placeholder company.github_org bez markeru template je hard failure", async () => {
  const root = await createGenerationMountFixture();
  await writeGenerationOrg({
    root,
    path: "organizations/Scaffold_GEN3",
    company: "Scaffold",
    appDir: "mission-control/app/v1",
    appId: "scaffold-mission-control-v1",
    port: 5992,
  });
  const companyRoot = join(root, "organizations", "Scaffold_GEN3");
  const companyConfig = await Bun.file(join(companyRoot, "company.gen3.json")).json();
  companyConfig.company.github_org = "vyplnit-github-org";
  await writeJson(join(companyRoot, "company.gen3.json"), companyConfig);

  const { organizations, failures } = await discoverLaunchpadApps(root);

  expect(
    failures.some(
      (failure) =>
        failure.includes("Scaffold_GEN3") &&
        failure.includes("company.github_org") &&
        failure.includes("organization_kind"),
    ),
  ).toBe(true);
  expect(organizations.some((organization) => organization.path === "organizations/Scaffold_GEN3")).toBe(false);
});

test("opravený OrganizationTemplate placeholder kontrakt projde bez false failure", async () => {
  const root = await createGenerationMountFixture();
  const templateRoot = join(root, "organizations", "OrganizationTemplate_GEN3");
  await mkdir(join(templateRoot, "manual"), { recursive: true });
  await mkdir(join(templateRoot, "company", "colleagues"), { recursive: true });
  await mkdir(join(templateRoot, "workspace"), { recursive: true });
  // Infra je v template jen plánovaný scaffold. Jeho existence proto nesmí
  // aktivovat materialized-active Git URL gate.
  await mkdir(join(templateRoot, "infra"), { recursive: true });
  await writeJson(join(templateRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    organization_kind: "template",
    company: {
      slug: "vyplnit-company-slug",
      display_name: "<VYPLNIT_COMPANY_NAME>",
      github_org: "vyplnit-github-org",
    },
    teams: [
      { slug: "workspace", display_name: "<VYPLNIT_DEFAULT_TEAM_NAME>", default: true },
    ],
  });
  await writeJson(join(templateRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "vyplnit-company-slug",
    github_org: "vyplnit-github-org",
    workspace_path: "workspace",
    teams: [
      { slug: "workspace", display_name: "<VYPLNIT_DEFAULT_TEAM_NAME>", default: true },
    ],
    module_slots: [
      {
        path: "workspace/knowledgebase",
        teams: ["workspace"],
        git: { url: "git@github.com:vyplnit-github-org/knowledgebase.git", branch: "main" },
      },
      {
        path: "infra",
        status: "planned_slot",
        git: { url: "git@github.com:vyplnit-github-org/infra.git", branch: "main" },
      },
    ],
  });

  const { template_mounts, failures } = await discoverLaunchpadApps(root);

  expect(failures).toEqual([]);
  expect(template_mounts.some((mount) => mount.path === "organizations/OrganizationTemplate_GEN3")).toBe(true);
});

test("Organization path gate rejects POSIX, drive, UNC and mixed-separator escapes but allows a future child", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  for (const path of [
    "../ForeignOrg/workspace/shared",
    "workspace\\..\\ForeignOrg\\shared",
    "/tmp/foreign",
    "C:\\ForeignOrg\\shared",
    "C:ForeignOrg\\shared",
    "\\\\server\\share\\module",
    " workspace/demo",
  ]) {
    expect(organizationRelativePathIssue({ organizationRoot, path })).toContain("uniká mimo Organization root");
  }
  expect(organizationRelativePathIssue({ organizationRoot, path: "workspace/future-module" })).toBeNull();
  expect(organizationRelativePathIssue({ organizationRoot, path: "workspace\\future-mixed" })).toBeNull();
});

test("Organization module paths fail closed on traversal and canonical symlink escapes", async () => {
  const root = await createCompaniesWorkspaceFixture({});
  const organizationRoot = join(root, "organizations", "TestCompany");
  const foreignRoot = join(root, "organizations", "ForeignOrg", "workspace", "shared");
  await mkdir(foreignRoot, { recursive: true });
  await mkdir(join(organizationRoot, "workspace"), { recursive: true });
  await symlink(foreignRoot, join(organizationRoot, "workspace", "foreign-link"));
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [
      { path: "../ForeignOrg/workspace/shared", git: { url: "git@github.com:ForeignOrg/shared.git" } },
      { path: "workspace/foreign-link", git: { url: "git@github.com:ForeignOrg/shared.git" } },
    ],
  });

  const result = await discoverLaunchpadApps(root);

  expect(result.failures.filter((failure) => failure.includes("uniká mimo Organization root"))).toHaveLength(2);
});

async function createCompaniesWorkspaceFixture({ plugin, appOverrides = {} }) {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-discovery-"));
  tempRoots.push(root);
  const companyRoot = join(root, "organizations", "TestCompany");
  const appRoot = join(companyRoot, "modules", "demo", "app", "v1");
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(appRoot, { recursive: true });

  // Scan-first (decision 0042): sdílený launchpad.gen3.json nese jen generický
  // kontrakt; Organizace se zjišťují skenem organizations/*/company.gen3.json.
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "test-company", display_name: "Test Company", github_org: "TestCompany" },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "test-company",
    github_org: "TestCompany",
    module_slots: [],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  await writeJson(join(appRoot, "package.json"), {
    name: "test-company-demo-v1",
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "test-company-demo-v1",
        title: "Demo v1",
        company: "test-company",
        module: "demo",
        surface: "internal",
        port: 4242,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        plugin: "./launchpad.plugin.json",
        tags: ["test"],
        ...appOverrides,
      },
    },
  });
  await writeJson(join(appRoot, "launchpad.plugin.json"), plugin);
  return root;
}


async function createGenerationMountFixture() {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-gen3-mounts-"));
  tempRoots.push(root);
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  // Scan-first: root nese jen generický kontrakt, Organizace jsou na disku.
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "conglomerate",
      display_name: "Conglomerate",
      root_role: "launchpad-root",
    },
  });
  await writeGenerationOrg({
    root,
    path: "organizations/BetaCo_GEN3",
    company: "BetaCo",
    appDir: "mission-control/app/v2",
    appId: "betaco-mission-control-v2",
    port: 5392,
  });
  await writeGenerationOrg({
    root,
    path: "organizations/DemoCo_GEN3",
    company: "DemoCo",
    appDir: "mission-control/app/v1",
    appId: "democo-mission-control-v1",
    port: 5693,
  });
  return root;
}

async function writeGenerationOrg({ root, path, company, appDir, appId, port, organizationKind }) {
  const companyRoot = join(root, path);
  const appRoot = join(companyRoot, appDir);
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    ...(organizationKind ? { organization_kind: organizationKind } : {}),
    company: { slug: company, display_name: company, github_org: company },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company,
    github_org: company,
    module_slots: [],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  await writeJson(join(appRoot, "package.json"), {
    name: `${appId.toLowerCase()}-fixture`,
    private: true,
    type: "module",
    scripts: {
      dev: "bun server.mjs",
    },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: appId,
        title: "Mission Control",
        company,
        module: "mission-control",
        surface: "internal",
        port,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["mission-control"],
      },
    },
  });
}

async function writeJson(path, data) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
