import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { buildDoctorReportFromAppsResponse, buildEnvironmentChecks, buildLaunchpadAppsResponse, buildLaunchpadDoctorReport, runtimeAppStatus, updateChannelCheck } from "./diagnostics-lib.mjs";
import { createLaunchpadGitFixture, initGitRepo, runGit } from "./git-fixture-helpers.test.mjs";
import { buildGitInventory } from "./git-inventory-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("update.channel check je read-only anti-stuck guard kanálu", async () => {
  const base = await mkdtemp(join(tmpdir(), "update-channel-check-"));
  tempRoots.push(base);
  const repo = join(base, "root");
  const remote = join(base, "remote.git");
  await initGitRepo(repo, { remotePath: remote });
  await writeFile(join(repo, ".gitignore"), "launchpad.gen3.local.json\n");
  runGit(["add", ".gitignore"], repo);
  runGit(["commit", "-m", "ExampleOrg root"], repo);
  runGit(["push", "origin", "main"], repo);

  // Default stable kanál bez release tagu = viditelný warn, ne tichý stav.
  const noTag = updateChannelCheck(repo);
  expect(noTag.id).toBe("update.channel");
  expect(noTag.status).toBe("warn");
  expect(noTag.message).toContain("release tag");

  // Nevalidní hodnota kanálu = warn s vysvětlením, platí stable.
  await writeJson(join(repo, "launchpad.gen3.local.json"), { update_channel: "beta" });
  const invalid = updateChannelCheck(repo);
  expect(invalid.status).toBe("warn");
  expect(invalid.message).toContain("Neplatný update_channel");

  // Platný nightly kanál na origin/main = ok.
  await writeJson(join(repo, "launchpad.gen3.local.json"), { update_channel: "nightly" });
  const nightly = updateChannelCheck(repo);
  expect(nightly.status).toBe("ok");
  expect(nightly.message).toContain("nightly");

  // Stable s release tagem na HEAD = ok a jmenuje tag.
  runGit(["tag", "v0.1.0"], repo);
  await writeJson(join(repo, "launchpad.gen3.local.json"), { update_channel: "stable" });
  const stable = updateChannelCheck(repo);
  expect(stable.status).toBe("ok");
  expect(stable.message).toContain("v0.1.0");

  // Mimo main = warn s odkazem na worktree disciplínu.
  runGit(["checkout", "-b", "feature/apply"], repo);
  const wrongBranch = updateChannelCheck(repo);
  expect(wrongBranch.status).toBe("warn");
  expect(wrongBranch.message).toContain("main");
});

test("Doctor warns for reclaimable module occupancy but fails legacy foreign ports", () => {
  expect(runtimeAppStatus({
    dependencies: { state: "needs_install" },
    runtime: { owner: "foreign-port", status: "unhealthy" },
  })).toBe("fail");
  const modulePath = "organizations/TestCompany/workspace/demo/lazurio.module.json";
  const moduleApp = {
    dependencies: { state: "stale_lockfile" },
    runtime: {
      owner: "unknown-port",
      status: "unhealthy",
      port_owner: { pid: 42123 },
    },
    runtime_contract: { schema_version: "lazurio.runtime.v1" },
    module_contract: { schema_version: "lazurio.module.v1", module_path: modulePath },
    entrypoint_listener: {
      allocation: "static",
      port: 24101,
      claim: { mode: "exclusive" },
      module_lease: { source: modulePath },
    },
  };
  expect(runtimeAppStatus(moduleApp)).toBe("warn");
  expect(runtimeAppStatus({
    ...moduleApp,
    runtime: {
      owner: "foreign-port",
      status: "unhealthy",
      port_owner: { pid: 42124 },
    },
  })).toBe("warn");
  expect(runtimeAppStatus({
    ...moduleApp,
    runtime: { owner: "unknown-port", status: "unhealthy", port_owner: null },
  })).toBe("fail");
  expect(runtimeAppStatus({
    ...moduleApp,
    dependencies: { state: "unknown_package_manager" },
  })).toBe("fail");
});

test("first-paint apps response can skip the global Git census", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    gitStatusService: {
      readStatuses() {
        throw new Error("Git census must not run during first paint");
      },
    },
    includeGit: false,
  });

  expect(response.apps.every((app) => app.git === undefined)).toBe(true);
  expect(response.warnings.some((warning) => warning.startsWith("git:"))).toBe(false);
});

test("apps response materializes HTTPS endpoints from the module-owned lease", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "SecureCo_GEN3");
  const appRoot = join(companyRoot, "workspace", "secure", "app", "v1");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "SecureCo", display_name: "Secure Co", github_org: "SecureCo" },
    teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "SecureCo",
    github_org: "SecureCo",
    module_slots: [{
      path: "workspace/secure",
      teams: ["workspace"],
      git: { url: "git@github.com:SecureCo/secure.git", branch: "main" },
    }],
  });
  await writeJson(join(appRoot, "package.json"), {
    name: "@secureco/secure",
    private: true,
    scripts: { dev: "bun server.mjs" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: "secureco-secure",
        title: "Secure",
        company: "SecureCo",
        module: "secure",
        surface: "internal",
        dev_script: "dev",
        tags: ["secure"],
        listeners: [{
          id: "web",
          role: "entrypoint",
          lease: "main",
          protocol: "https",
          health: { kind: "http", path: "/health" },
        }],
      },
    },
  });
  await writeJson(join(root, "lazurio.port-registry.json"), {
    schema_version: "lazurio.port_registry.v1",
    allocation_strategy: "organization-blocks",
    organization_blocks: [{ company: "SecureCo", start: 5400, end: 5499 }],
  });
  await writeJson(join(companyRoot, "workspace", "secure", "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "secure",
    company: "SecureCo",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 5450 }],
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
    includeGit: false,
  });
  expect(response.apps[0]).toMatchObject({
    url: "https://127.0.0.1:5450",
    health_url: "https://127.0.0.1:5450/health",
  });
  expect(response.port_registry_issues).toEqual([]);
  const report = buildDoctorReportFromAppsResponse(response);
  const check = report.checks.find((item) => item.id === "launchpad.port_ownership");
  expect(check?.status).toBe("ok");
});

test("Doctor treats central registry violations as hard errors", () => {
  const report = buildDoctorReportFromAppsResponse({
    launchpad_root: { display_name: "Test root" },
    root: "/tmp/test-root",
    failures: [],
    warnings: [],
    apps: [],
    organizations: [],
    port_registry_issues: ["module/lazurio.module.json: lease main port 5600 leží mimo block 5400-5499"],
  });
  const check = report.checks.find((item) => item.id === "launchpad.port_ownership");
  expect(check?.status).toBe("fail");
  expect(check?.details.join("\n")).toContain("mimo block");
});

test("Doctor reportuje deklarovaný port overlap jako hard failure", () => {
  const report = buildDoctorReportFromAppsResponse({
    launchpad_root: { display_name: "Test root" },
    root: "/tmp/test-root",
    failures: [],
    warnings: [],
    apps: [],
    organizations: [],
    port_overlaps: [{
      host: "127.0.0.1",
      port: 5392,
      classification: "declared-conflict",
      conflict: true,
      owners: [
        { app_id: "alpha-app", listener_id: "web", package_path: "organizations/Alpha/workspace/app/package.json" },
        { app_id: "beta-app", listener_id: "web", package_path: "organizations/Beta/workspace/app/package.json" },
      ],
    }],
  });
  const check = report.checks.find((item) => item.id === "launchpad.port_ownership");

  expect(check?.status).toBe("fail");
  expect(check?.message).toContain("1 kolizní listener");
  expect(check?.message).toContain("deklarace musí být opravena");
  expect(check?.details).toEqual([
    "127.0.0.1:5392 [declared-conflict]: alpha-app#web (organizations/Alpha/workspace/app/package.json), beta-app#web (organizations/Beta/workspace/app/package.json)",
  ]);
});

test("Doctor accepts one shared module-version lease", () => {
  const report = buildDoctorReportFromAppsResponse({
    launchpad_root: {}, root: "/tmp/test-root", failures: [], warnings: [], apps: [], organizations: [],
    port_overlaps: [{
      host: "127.0.0.1",
      port: 5287,
      classification: "module-version-lease",
      conflict: false,
      module_lease: "one/design-system#entrypoint",
      owners: [
        { app_id: "one-design-system", listener_id: "web", package_path: "organizations/One/package.json" },
        { app_id: "two-design-system", listener_id: "web", package_path: "organizations/Two/package.json" },
      ],
    }],
  });
  const check = report.checks.find((item) => item.id === "launchpad.port_ownership");
  expect(check?.status).toBe("ok");
  expect(check?.message).toContain("module-version lease");
});

test("doctor report obsahuje platform, git a gitignore checks", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  expect(checks.get("platform.bun")?.status).toBe("ok");
  expect(checks.get("platform.git")?.status).toBe("ok");
  expect(checks.get("git.root")?.status).toBe("ok");
  expect(checks.get("git.worktree")?.status).toBe("ok");
  expect(checks.get("gitignore.protection")?.status).toBe("ok");
  expect(checks.get("launchpad.discovery")?.status).toBe("ok");
});

test("Doctor launchpad.discovery failuje na Organization cross-file identitě", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "BrokenIdentity_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: {
      slug: "BrokenIdentity",
      display_name: "Broken Identity",
      github_org: "CorrectGithubOrg",
    },
    teams: [{ slug: "workspace", display_name: "Hlavní Team", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OtherIdentity",
    github_org: "WrongGithubOrg",
    module_slots: [],
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const discoveryCheck = report.checks.find((check) => check.id === "launchpad.discovery");

  expect(discoveryCheck?.status).toBe("fail");
  expect(discoveryCheck?.details.some((detail) => detail.includes("company.slug") && detail.includes("OtherIdentity"))).toBe(true);
  expect(discoveryCheck?.details.some((detail) => detail.includes("company.github_org") && detail.includes("WrongGithubOrg"))).toBe(true);
});

test("Doctor failuje, když manifestovaný modul kanonicky uniká do jiné Organization", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "EscapingOrg_GEN3");
  const foreignPath = join(root, "organizations", "ForeignOrg_GEN3", "workspace", "shared");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(foreignPath, { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "EscapingOrg", display_name: "Escaping Org", github_org: "EscapingOrg" },
    teams: [{ slug: "workspace", display_name: "Hlavní Team", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "EscapingOrg",
    github_org: "EscapingOrg",
    module_slots: [
      { path: "../ForeignOrg_GEN3/workspace/shared", teams: ["workspace"], git: { url: "git@github.com:ForeignOrg/shared.git" } },
    ],
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const discoveryCheck = report.checks.find((check) => check.id === "launchpad.discovery");

  expect(discoveryCheck?.status).toBe("fail");
  expect(discoveryCheck?.details.some((detail) => detail.includes("uniká mimo Organization root"))).toBe(true);
}, 10_000);

test("template mounty nejsou kontrolované Organization-private gitignore probami", async () => {
  const root = await createTemplateMountFixture();
  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  expect(checks.get("gitignore.protection")?.status).toBe("ok");
});

test("marker template mounty drží stejný Git mount gate jako Organizace", async () => {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-template-git-mount-"));
  tempRoots.push(root);
  run(["git", "init"], root);
  // Marker template mount, který neexistuje jako Git checkout, musí git.mounts propadnout —
  // stejné gate jako u firmy, i když se nepočítá do organizations.
  const checks = buildEnvironmentChecks({
    companiesRoot: root,
    companies: [],
    templateMounts: [
      { slug: "OrganizationTemplate", path: "organizations/OrganizationTemplate_GEN3", status: "mounted", organization_kind: "template" },
    ],
  });
  const mountsCheck = checks.find((check) => check.id === "git.mounts");

  expect(mountsCheck.status).toBe("fail");
  expect(
    mountsCheck.details.some(
      (detail) => detail.includes("organizations/OrganizationTemplate_GEN3") && detail.includes("organization template"),
    ),
  ).toBe(true);
});

test("planned marker template mount se v git.mounts přeskočí jako planned Organizace", async () => {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-template-planned-"));
  tempRoots.push(root);
  run(["git", "init"], root);
  // Planned template slot ještě nemá mount (decision 0024) → git.mounts ho nesmí kontrolovat.
  const checks = buildEnvironmentChecks({
    companiesRoot: root,
    companies: [],
    templateMounts: [
      { slug: "OrganizationTemplate", path: "organizations/OrganizationTemplate_GEN3", status: "planned", organization_kind: "template" },
    ],
  });
  const mountsCheck = checks.find((check) => check.id === "git.mounts");

  expect(mountsCheck.status).toBe("ok");
});

test("apps response exposes manifest-only workspace modules and productionspace systems", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo" },
    workspaces: [
      { slug: "workspace", display_name: "OmegaCo Workspace", path: "workspace" },
      { slug: "productionspace", display_name: "OmegaCo Productionspace", path: "productionspace" },
    ],
    productionspace: {
      status: "candidate-boundary",
    },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    module_slots: [
      {
        path: "modules/knowledgebase",
        workspace: "workspace",
        category: "knowledge",
        default_access: "role_based",
        repo: "git@github.com:OmegaCo/knowledgebase.git",
        branch: "main",
      },
      {
        path: "modules/invoices",
        workspace: "workspace",
        category: "business",
        launchpad_port: 5308,
      },
      {
        path: "productionspace/monorepo",
        workspace: "productionspace",
        classification: "productionspace-candidate",
        category: "engineering",
        default_access: "role_based",
        required_roles: ["engineering"],
        repo: "git@github.com:OmegaCo/monorepo.git",
        branch: "main",
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  expect(org?.workspaces[0]).toMatchObject({
    slug: "workspace",
    modules: [
      {
        slug: "knowledgebase",
        path: "modules/knowledgebase",
        category: "knowledge",
        default_access: "role_based",
        // repo je deklarované, checkout chybí → missing_access (decision 0042)
        status: "missing_access",
        readiness: { severity: "blocking", reason: "access_entitlement_unknown" },
      },
      {
        slug: "invoices",
        path: "modules/invoices",
        category: "business",
        launchpad_port: 5308,
        // slot bez repo deklarace → planned_slot (decision 0042)
        status: "planned_slot",
      },
    ],
  });
  expect(org?.productionspace).toMatchObject({
    slug: "productionspace",
    display_name: "OmegaCo Productionspace",
    status: "candidate-boundary",
    systems: [
      {
        slug: "monorepo",
        path: "productionspace/monorepo",
        category: "engineering",
        status: "missing_access",
        readiness: { severity: "blocking", reason: "access_entitlement_unknown" },
      },
    ],
  });
  // productionspace ve workspaces[] a workspace:"productionspace" hodnoty jsou
  // 0041 konflikty — hlásí je doctor jako warn, ne failure.
  expect(org?.workspace_conformance_issues?.some((issue) => issue.includes("workspaces[] obsahuje productionspace"))).toBe(true);
  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  expect(declarationCheck?.status).toBe("fail");
  expect(declarationCheck?.details.some((detail) => detail.includes("decision 0041"))).toBe(true);
});

test("case-preserving productionspace mount uses explicit lowercase ID and fails closed without it", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "HumanAndMachine-ai_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: {
      slug: "HumanAndMachine-ai",
      display_name: "Human and Machine",
      github_org: "HumanAndMachine-ai",
    },
    productionspace: { status: "active" },
  });
  const manifestPath = join(companyRoot, "modules.manifest.json");
  const manifest = {
    company: "HumanAndMachine-ai",
    github_org: "HumanAndMachine-ai",
    module_slots: [{
      slug: "buddy-gen2",
      name: "Buddy runtime",
      path: "productionspace/Buddy_GEN2",
      space: "productionspace",
      git: { url: "git@github.com:HumanAndMachine-ai/Buddy_GEN2.git", branch: "main" },
    }],
  };
  await writeJson(manifestPath, manifest);

  const valid = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  expect(valid.organizations[0]?.productionspace?.systems[0]).toMatchObject({
    slug: "buddy-gen2",
    name: "Buddy runtime",
    path: "productionspace/Buddy_GEN2",
  });

  delete manifest.module_slots[0].slug;
  await writeJson(manifestPath, manifest);
  const invalidCompanyConfig = await Bun.file(join(companyRoot, "company.gen3.json")).json();
  invalidCompanyConfig.modules = [{
    slug: "buddy-gen2",
    path: "productionspace/Buddy_GEN2",
    space: "productionspace",
  }];
  await writeJson(join(companyRoot, "company.gen3.json"), invalidCompanyConfig);
  const invalid = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  expect(invalid.organizations[0]?.productionspace?.systems ?? []).toEqual([]);
  expect(invalid.failures.join("\n")).toContain("explicitní stabilní lowercase slug");
});

test("apps read model omits only cross-file ambiguous repository identities", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "ProjectionCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "ProjectionCo", display_name: "Projection Co", github_org: "ProjectionCo" },
    teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
    modules: [
      { slug: "shared", path: "workspace/bar", teams: ["workspace"] },
      { slug: "healthy-config", path: "workspace/healthy-config", teams: ["workspace"] },
    ],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "ProjectionCo",
    github_org: "ProjectionCo",
    module_slots: [
      { slug: "shared", path: "workspace/foo", teams: ["workspace"] },
      { slug: "healthy-manifest", path: "workspace/healthy-manifest", teams: ["workspace"] },
    ],
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const modules = response.organizations[0]?.teams[0]?.modules ?? [];

  expect(modules.map((module) => module.slug).sort()).toEqual([
    "healthy-config",
    "healthy-manifest",
  ]);
  expect(response.failures.join("\n")).toContain('repository slug "shared"');
});

test("apps read model rejects live casing drift and treats productionspace candidates as ordering only", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "CandidateCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(join(companyRoot, "workspace", "Dashboard"), { recursive: true });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "CandidateCo", display_name: "Candidate Co", github_org: "CandidateCo" },
    teams: [{ slug: "workspace", display_name: "Workspace", default: true }],
    productionspace: {
      status: "active",
      candidate_modules: ["productionspace/dashboard", "productionspace/Buddy_GEN2"],
    },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "CandidateCo",
    github_org: "CandidateCo",
    module_slots: [
      { slug: "dashboard-workspace", path: "workspace/dashboard", teams: ["workspace"] },
      { slug: "dashboard", path: "productionspace/Dashboard", space: "productionspace" },
    ],
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const organization = response.organizations[0];

  expect(organization?.teams[0]?.modules ?? []).toEqual([]);
  expect(organization?.productionspace?.systems.map((system) => system.slug)).toEqual(["dashboard"]);
  expect(organization?.workspace_conformance_issues.join("\n")).toContain(
    'productionspace candidate "productionspace/dashboard" neodpovídá přesnému psaní',
  );
  expect(organization?.workspace_conformance_issues.join("\n")).toContain(
    'productionspace candidate "productionspace/Buddy_GEN2" nemá odpovídající deklarovaný',
  );
});

test("Doctor blokuje konfliktní space, ale productionspace zůstane read-only", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await mkdir(join(companyRoot, "productionspace"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo" },
    workspaces: [
      {
        slug: "workspace",
        display_name: "OmegaCo Workspace",
        default: true,
      },
    ],
    productionspace: { status: "active" },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    module_slots: [
      {
        path: "productionspace/",
        space: "workspace",
        category: "boundary",
        default_access: "restricted",
        required_roles: ["engineering"],
        git: {
          url: "git@github.com:OmegaCo/productionspace.git",
          branch: "main",
        },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  expect(org?.workspaces.flatMap((workspace) => workspace.modules)).toEqual([]);
  expect(org?.productionspace.systems).toEqual([]);

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(declarationCheck?.status).toBe("fail");
  expect(declarationCheck?.details.join("\n")).toContain(
    "slot productionspace je Organization kontejner, ne repozitářový slot",
  );
});

test("Doctor drží missing_access bez autoritativního ACL důkazu fail-closed", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "AccessCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "test-companies", display_name: "Test Companies", root_role: "companies-root" },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "AccessCo", display_name: "Access Co" },
    workspaces: [{ slug: "workspace", display_name: "Workspace", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "AccessCo",
    module_slots: [
      {
        path: "workspace/restricted",
        category: "finance",
        default_access: "restricted",
        required_roles: ["finance"],
        git: { url: "git@github.com:AccessCo/restricted.git", branch: "main" },
      },
      {
        path: "workspace/required",
        category: "knowledge",
        default_access: "expected",
        required_roles: ["*"],
        git: { url: "git@github.com:AccessCo/required.git", branch: "main" },
      },
      {
        path: "workspace/future",
        category: "planning",
        default_access: "role_based",
        required_roles: ["builder"],
      },
      {
        path: "workspace/unknown",
        category: "finance",
        default_access: "role_based",
        required_roles: ["finance"],
        git: { url: "git@github.com:AccessCo/unknown.git", branch: "main" },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const slots = response.organizations[0].workspaces[0].modules;
  expect(slots.find((slot) => slot.slug === "restricted")?.readiness).toMatchObject({
    severity: "blocking",
    reason: "access_entitlement_unknown",
  });
  expect(slots.find((slot) => slot.slug === "required")?.readiness).toMatchObject({
    severity: "blocking",
    reason: "unexpected_missing_access",
  });
  expect(slots.find((slot) => slot.slug === "future")?.readiness).toMatchObject({
    severity: "neutral",
    reason: "planned",
  });
  expect(slots.find((slot) => slot.slug === "unknown")?.readiness).toMatchObject({
    severity: "blocking",
    reason: "access_entitlement_unknown",
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  expect(declarationCheck?.status).toBe("fail");
  expect(declarationCheck?.message).toContain("3 blokátory");
  expect(declarationCheck?.details.join("\n")).toContain("workspace/required");
  expect(declarationCheck?.details.join("\n")).toContain("workspace/unknown");
  expect(declarationCheck?.details.join("\n")).toContain("workspace/restricted");
});

test("Doctor neutralizuje role-based missing_access jen s principal-scoped lokální rolí", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "AccessCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "test-companies", display_name: "Test Companies", root_role: "companies-root" },
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "exampleuser",
    organization_roles: { AccessCo: ["sales"] },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "AccessCo", display_name: "Access Co" },
    workspaces: [{ slug: "workspace", display_name: "Workspace", default: true }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "AccessCo",
    module_slots: [
      {
        path: "workspace/finance",
        category: "finance",
        default_access: "restricted",
        required_roles: ["finance"],
        git: { url: "git@github.com:AccessCo/finance.git", branch: "main" },
      },
      {
        path: "workspace/sales",
        category: "sales",
        default_access: "role_based",
        required_roles: ["sales"],
        git: { url: "git@github.com:AccessCo/sales.git", branch: "main" },
      },
      {
        path: "workspace/everyone",
        category: "knowledge",
        default_access: "role_based",
        required_roles: ["*"],
        git: { url: "git@github.com:AccessCo/everyone.git", branch: "main" },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const slots = response.organizations[0].workspaces[0].modules;
  expect(slots.find((slot) => slot.slug === "finance")?.readiness).toMatchObject({
    severity: "neutral",
    reason: "role_not_entitled",
  });
  expect(slots.find((slot) => slot.slug === "sales")?.readiness.severity).toBe("blocking");
  expect(slots.find((slot) => slot.slug === "everyone")?.readiness.severity).toBe("blocking");
});

test("Mission Control app/code a data jsou root sloty mimo Team dlaždice", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo" },
    workspaces: [{ slug: "workspace", display_name: "OmegaCo Workspace", default: true }],
    layers: [{ path: "mission-control", kind: "root-docs", ownership: "manual" }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "OmegaCo",
    module_slots: [
      // Physical root placement is sufficient; manifest need not repeat space.
      { path: "mission-control", git: { url: "git@github.com:OmegaCo/mission-control.git", branch: "main" } },
      { path: "mission-control/db", space: "root", category: "planning-data", git: { url: "git@github.com:OmegaCo/mission-control-data.git", branch: "v3" } },
      { path: "workspace/wiki", space: "workspace", workspace: "workspace" },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const missionControlApp = join(companyRoot, "mission-control", "app", "v3");
  await mkdir(missionControlApp, { recursive: true });
  await writeJson(join(missionControlApp, "package.json"), {
    name: "omegaco-mission-control-v3",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "omegaco-mission-control-v3",
        title: "Mission Control",
        company: "OmegaCo",
        module: "mission-control",
        surface: "internal",
        port: 5293,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["mission-control"],
      },
    },
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  const tilePaths = (org?.workspaces ?? []).flatMap((workspace) => workspace.modules.map((module) => module.path));
  expect(org?.organization_modules.map((module) => module.path)).toEqual(["mission-control"]);
  const missionControl = org?.module_declarations.find(
    (slot) => slot.path === "mission-control",
  );
  const missionControlData = org?.module_declarations.find(
    (slot) => slot.path === "mission-control/db",
  );

  expect(tilePaths).toEqual(["workspace/wiki"]);
  expect(tilePaths).not.toContain("mission-control");
  expect(tilePaths).not.toContain("mission-control/db");
  expect(missionControl).toMatchObject({
    space: "root",
    workspace: null,
    status: "available",
  });
  expect(missionControlData).toMatchObject({
    space: "root",
    workspace: null,
    status: "missing_access",
  });
  expect(org?.space_readiness?.blocking_slots.map((slot) => slot.path)).toEqual([
    "mission-control/db",
  ]);
  expect(
    response.apps.find((app) => app.id === "omegaco-mission-control-v3"),
  ).toMatchObject({ space: "root", teams: [], workspace: null });
  expect(org?.team_access).toMatchObject({
    authority: "github",
    status: "not_evaluated",
    memberships: [],
  });
  expect(JSON.stringify(org)).not.toContain("module_declarations");

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  expect(declarationCheck?.status).toBe("fail");
  expect(declarationCheck?.details.join("\n")).toContain("mission-control/db");
});

test("AVALTAR-like standalone Mission Control repository-db zůstává jen v diagnostice", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "AVALTAR-HAM_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "AVALTAR-HAM", display_name: "AVALTAR" },
    workspaces: [{ slug: "workspace", display_name: "Workspace", default: true }],
    layers: [{ path: "mission-control", kind: "root-docs", ownership: "manual" }],
    modules: [{ path: "workspace/knowledgebase", teams: ["workspace"] }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "AVALTAR-HAM",
    module_slots: [
      {
        path: "mission-control/db",
        slug: "mission-control-data",
        category: "planning-data",
        default_access: "expected",
        required_roles: ["*"],
        source_of_truth: "repository-db:v3",
        space: "root",
        status: "planned_slot",
      },
      {
        path: "workspace/knowledgebase",
        space: "workspace",
        teams: ["workspace"],
        source_of_truth: "repository-db:v3",
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const missionControlApp = join(companyRoot, "mission-control", "app", "v3");
  await mkdir(missionControlApp, { recursive: true });
  await writeJson(join(missionControlApp, "package.json"), {
    name: "avaltar-mission-control-v3",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "avaltar-mission-control-v3",
        title: "Mission Control",
        company: "AVALTAR-HAM",
        module: "mission-control",
        surface: "internal",
        port: 5293,
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: ["mission-control"],
      },
    },
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const org = response.organizations.find((item) => item.slug === "AVALTAR-HAM");
  const workspaceModules = (org?.workspaces ?? []).flatMap((workspace) => workspace.modules);
  const dataDeclaration = org?.module_declarations.find(
    (slot) => slot.path === "mission-control/db",
  );

  expect(workspaceModules.map((module) => module.path)).toEqual(["workspace/knowledgebase"]);
  expect(workspaceModules).toHaveLength(1);
  expect(dataDeclaration).toMatchObject({
    path: "mission-control/db",
    ui_exposure: "diagnostics-only",
    status: "planned_slot",
  });
  expect(response.apps.map((app) => app.id)).toContain("avaltar-mission-control-v3");

  const gitInventory = await buildGitInventory({ companiesRoot: root });
  expect(gitInventory.planned).toContainEqual(
    expect.objectContaining({
      organization: "AVALTAR-HAM",
      slot_path: "mission-control/db",
    }),
  );

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(declarationCheck?.details.join("\n")).toContain("mission-control/db");
});

test("root Design System zůstává mimo výchozí Team a Doctor hlídá jeho checkout", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo" },
    workspaces: [{ slug: "workspace", display_name: "OmegaCo Workspace", default: true }],
    layers: [{ path: "design-system", kind: "design-system", ownership: "manual" }],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    module_slots: [
      {
        path: "design-system",
        space: "root",
        category: "brand",
        default_access: "expected",
        required_roles: ["*"],
        git: {
          url: "git@github.com:OmegaCo/design-system.git",
          branch: "main",
        },
      },
      { path: "workspace/wiki", space: "workspace", workspace: "workspace" },
      { path: "workspace/", space: "workspace", workspace: "workspace" },
      { path: "design-system/theme", space: "workspace", workspace: "brand" },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  const workspacePaths = (org?.workspaces ?? []).flatMap((workspace) =>
    workspace.modules.map((module) => module.path),
  );
  const designSystem = org?.module_declarations.find(
    (slot) => slot.path === "design-system",
  );

  expect(workspacePaths).toEqual(["workspace/wiki"]);
  expect(
    org?.module_declarations.some((slot) =>
      ["workspace", "design-system/theme"].includes(slot.path),
    ),
  ).toBe(false);
  expect(designSystem).toMatchObject({
    path: "design-system",
    space: "root",
    workspace: null,
    status: "missing_access",
    readiness: {
      severity: "blocking",
      reason: "unexpected_missing_access",
    },
  });
  expect(org?.space_readiness?.blocking_slots).toContainEqual(
    expect.objectContaining({ path: "design-system" }),
  );

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(declarationCheck?.status).toBe("fail");
  const details = declarationCheck?.details.join("\n") ?? "";
  expect(details).toContain("design-system");
  expect(details).toContain(
    "slot workspace je Organization kontejner, ne repozitářový slot",
  );
  expect(details).toContain(
    "slot design-system/theme je uvnitř rezervované Organization root boundary",
  );
});

test("Doctor vynucuje root slot contract a Mission Control app/data pár", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo" },
    workspaces: [{ slug: "workspace", display_name: "OmegaCo Workspace", default: true }],
    layers: [
      { path: "design-system", kind: "design-system", ownership: "manual" },
      { path: "infra", kind: "infra", ownership: "manual" },
      { path: "mission-control/", kind: "root-docs", ownership: "manual" },
    ],
    modules: [
      {
        slug: "infra",
        path: "infra",
        repo: "git@github.com:OmegaCo/infra.git",
        category: "engineering",
        source_of_truth: "git-native",
        access: { default: "expected", roles: ["*"] },
      },
    ],
  });
  const manifestPath = join(companyRoot, "modules.manifest.json");
  await writeJson(manifestPath, {
    organization_generation: "gen3",
    module_slots: [
      // Nevalidní legacy deklarace: Doctor ji bezpečně zobrazí v rootu, ale
      // blokuje ji kvůli chybějícímu explicitnímu scope a checkout údajům.
      { path: "design-system", space: "workspace", workspace: "brand" },
      {
        path: "./mission-control",
        space: "root",
        repo: "git@github.com:WrongOrg/wrong-mission-control.git",
        branch: "legacy",
        git: {
          url: "git@github.com:OmegaCo/mission-control.git",
          branch: "main",
        },
      },
      { path: "workspace/wiki", space: "workspace", workspace: "workspace" },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const org = response.organizations.find((item) => item.slug === "OmegaCo");
  const workspacePaths = (org?.workspaces ?? []).flatMap((workspace) =>
    workspace.modules.map((module) => module.path),
  );
  const designSystem = org?.module_declarations.find(
    (slot) => slot.path === "design-system",
  );

  expect(workspacePaths).toEqual(["workspace/wiki"]);
  expect(designSystem).toMatchObject({
    space: "root",
    workspace: null,
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  const details = declarationCheck?.details.join("\n") ?? "";
  expect(declarationCheck?.status).toBe("fail");
  expect(details).toContain('design-system musí explicitně deklarovat space: "root"');
  expect(details).toContain(
    "design-system nesmí deklarovat Team/Workspace membership (workspace)",
  );
  expect(details).toContain("design-system musí deklarovat git.url a git.branch");
  expect(details).toContain(
    'root slot path "./mission-control" není kanonický; použij "mission-control"',
  );
  expect(details).toContain(
    "mission-control nesmí deklarovat legacy checkout souřadnice (repo, branch)",
  );
  expect(details).toContain(
    'root layer path "mission-control/" není kanonický; použij "mission-control"',
  );
  expect(details).toContain("chybí mission-control/db");
  expect(details).toContain(
    "company.gen3.json: root slot infra nesmí být v modules[]",
  );
  expect(details).toContain(
    "company.gen3.json: root vrstva infra nemá odpovídající modules.manifest.json slot",
  );

  const manifest = await Bun.file(manifestPath).json();
  manifest.module_slots.splice(2, 0, {
    path: "mission-control//db",
    space: "root",
    teams: ["workspace"],
    git: {
      url: "git@github.com:OmegaCo/mission-control-data.git",
      branch: "main",
    },
  });
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const reportWithData = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const dataDeclarationCheck = reportWithData.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  const dataDetails = dataDeclarationCheck?.details.join("\n") ?? "";
  expect(dataDeclarationCheck?.status).toBe("fail");
  expect(dataDetails).toContain(
    "mission-control/db nesmí deklarovat Team/Workspace membership (teams)",
  );
  expect(dataDetails).toContain(
    'root slot path "mission-control//db" není kanonický; použij "mission-control/db"',
  );
  expect(dataDetails).toContain(
    'mission-control/db musí používat větev "v3", deklarována je "main"',
  );
  expect(dataDetails).not.toContain("chybí mission-control/db");

  const companyConfig = await Bun.file(join(companyRoot, "company.gen3.json")).json();
  companyConfig.layers = companyConfig.layers.filter(
    (layer) => layer.path !== "design-system",
  );
  await writeJson(join(companyRoot, "company.gen3.json"), companyConfig);
  const reportWithoutDesignLayer = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const missingLayerCheck = reportWithoutDesignLayer.checks.find(
    (check) => check.id === "launchpad.workspace_declarations",
  );
  expect(missingLayerCheck?.details.join("\n")).toContain(
    "modules.manifest.json: root slot design-system nemá odpovídající company.gen3.json vrstvu",
  );
});

test("planned root slot nemá git a smí zůstat planned jen dokud není materializovaný", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "OmegaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "OmegaCo", display_name: "OmegaCo" },
    workspaces: [{ slug: "workspace", display_name: "OmegaCo Workspace", default: true }],
    layers: [{ path: "design-system", kind: "design-system", ownership: "manual" }],
  });
  const manifestPath = join(companyRoot, "modules.manifest.json");
  const manifest = {
    organization_generation: "gen3",
    module_slots: [
      {
        path: "design-system",
        space: "root",
        status: "planned_slot",
      },
    ],
  };
  await writeJson(manifestPath, manifest);
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});

  const doctor = async () => {
    const report = await buildLaunchpadDoctorReport({
      companiesRoot: root,
      launchpadRoot: join(root, "launchpad"),
      runtimeManager: { appsWithRuntime: async (apps) => apps },
    });
    return report.checks.find(
      (check) => check.id === "launchpad.workspace_declarations",
    );
  };

  const plannedCheck = await doctor();
  expect(plannedCheck?.status).toBe("ok");

  manifest.module_slots[0].git = {
    url: "git@github.com:OmegaCo/design-system.git",
    branch: "main",
  };
  await writeJson(manifestPath, manifest);
  const partialCoordinatesCheck = await doctor();
  expect(partialCoordinatesCheck?.status).toBe("fail");
  expect(partialCoordinatesCheck?.details.join("\n")).toContain(
    "planned root slot design-system nesmí deklarovat git",
  );

  await mkdir(join(companyRoot, "design-system"), { recursive: true });
  const materializedWithCoordinatesCheck = await doctor();
  expect(materializedWithCoordinatesCheck?.status).toBe("fail");
  expect(materializedWithCoordinatesCheck?.details.join("\n")).toContain(
    'materializovaný root slot design-system nesmí zůstat status: "planned_slot"',
  );
  expect(materializedWithCoordinatesCheck?.details.join("\n")).not.toContain(
    "planned root slot design-system nesmí deklarovat git",
  );

  delete manifest.module_slots[0].git;
  await writeJson(manifestPath, manifest);
  const materializedWithoutCoordinatesCheck = await doctor();
  expect(materializedWithoutCoordinatesCheck?.status).toBe("fail");
  expect(materializedWithoutCoordinatesCheck?.details.join("\n")).toContain(
    'materializovaný root slot design-system nesmí zůstat status: "planned_slot"',
  );
});

test("app sekci určí fyzická cesta, manifest doplní N:M Team intent a sdílený modul může být jednou v Organizaci", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "AlfaCo_GEN3");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "AlfaCo", display_name: "AlfaCo" },
    workspaces: [
      { slug: "workspace", display_name: "AlfaCo Workspace", default: true },
      { slug: "sidebrand", display_name: "SideBrand" },
    ],
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "AlfaCo",
    module_slots: [
      {
        path: "workspace/sidebrand-shop",
        teams: ["sidebrand", "workspace"],
        git: { url: "git@github.com:AlfaCo/sidebrand-shop.git", branch: "main" },
      },
      {
        path: "workspace/wiki",
        git: { url: "git@github.com:AlfaCo/wiki.git", branch: "main" },
      },
      {
        path: "workspace/knowledgebase",
        name: "AlfaCo Knowledgebase",
        teams: ["workspace", "sidebrand"],
        launchpad_section: "organization",
        git: { url: "git@github.com:AlfaCo/knowledgebase.git", branch: "main" },
      },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const shopApp = join(companyRoot, "workspace", "sidebrand-shop", "app", "v1");
  const wikiApp = join(companyRoot, "workspace", "wiki", "app", "v1");
  const knowledgebaseApp = join(companyRoot, "workspace", "knowledgebase", "app", "v1");
  for (const [dir, id, port] of [
    [shopApp, "sidebrand-shop-v1", 5511],
    [wikiApp, "alfaco-wiki-v1", 5512],
    [knowledgebaseApp, "alfaco-knowledgebase-v1", 5513],
  ]) {
    await mkdir(dir, { recursive: true });
    await writeJson(join(dir, "package.json"), {
      name: id,
      private: true,
      type: "module",
      scripts: { dev: "bun server.mjs" },
      companyascode: {
        app: {
          schema_version: "companyascode.launchpad_app.v1",
          id,
          title: id,
          company: "AlfaCo",
          surface: "internal",
          port,
          host: "127.0.0.1",
          health_path: "/",
          dev_script: "dev",
          tags: ["test"],
        },
      },
    });
  }

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  const placementByAppId = new Map(response.apps.map((app) => [app.id, app]));
  expect(placementByAppId.get("sidebrand-shop-v1")).toMatchObject({
    space: "workspace",
    teams: ["sidebrand", "workspace"],
    workspace: "sidebrand",
  });
  // Chybějící Team deklarace = default Team se slugem "workspace"; fyzická
  // sekce zůstává Workspace v obou případech.
  expect(placementByAppId.get("alfaco-wiki-v1")).toMatchObject({
    space: "workspace",
    teams: ["workspace"],
    workspace: "workspace",
  });
  expect(placementByAppId.get("alfaco-knowledgebase-v1")).toMatchObject({
    space: "root",
    teams: [],
    workspace: null,
  });
  const teams = new Map(response.organizations[0].teams.map((team) => [team.slug, team]));
  expect(teams.get("sidebrand")?.modules.map((module) => module.slug)).toContain("sidebrand-shop");
  expect(teams.get("workspace")?.modules.map((module) => module.slug)).toContain("sidebrand-shop");
  expect(teams.get("sidebrand")?.modules.map((module) => module.slug)).not.toContain("knowledgebase");
  expect(teams.get("workspace")?.modules.map((module) => module.slug)).not.toContain("knowledgebase");
  expect(response.organizations[0].organization_modules).toContainEqual(
    expect.objectContaining({
      slug: "knowledgebase",
      name: "AlfaCo Knowledgebase",
      path: "workspace/knowledgebase",
      space: "workspace",
      launchpad_section: "organization",
    }),
  );
  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const declarationCheck = report.checks.find((check) => check.id === "launchpad.workspace_declarations");
  expect(declarationCheck?.status).toBe("ok");
});

test("invalid_manifest appka je viditelná v apps response a doctor ji hlásí jako warn (decision 0043)", async () => {
  const root = await createCompaniesWorkspaceFixture();
  const companyRoot = join(root, "organizations", "BrokenCo");
  await mkdir(join(companyRoot, "manual"), { recursive: true });
  await mkdir(join(companyRoot, "company", "colleagues"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(companyRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug: "BrokenCo", display_name: "Broken Co" },
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    company: "BrokenCo",
    module_slots: [],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const goodApp = join(companyRoot, "modules", "good", "app", "v1");
  const brokenApp = join(companyRoot, "modules", "broken", "app", "v1");
  await mkdir(goodApp, { recursive: true });
  await mkdir(brokenApp, { recursive: true });
  await writeJson(join(goodApp, "package.json"), {
    name: "good-app",
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "brokenco-good-v1",
        title: "Good v1",
        company: "BrokenCo",
        surface: "internal",
        port: 5601,
        host: "127.0.0.1",
        health_path: "/",
        dev_script: "dev",
        tags: ["test"],
      },
    },
  });
  await writeJson(join(brokenApp, "package.json"), {
    name: "broken-app",
    private: true,
    type: "module",
    scripts: {},
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        id: "brokenco-broken-v1",
        title: "Broken v1",
        company: "BrokenCo",
        surface: "internal",
        port: 99, // mimo povolený rozsah
        host: "127.0.0.1",
        health_path: "bez-lomitka",
        dev_script: "dev",
        tags: ["test"],
      },
    },
  });

  const response = await buildLaunchpadAppsResponse({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });

  expect(response.ok).toBe(true);
  expect(response.summary.failure_count).toBe(0);
  expect(response.summary.app_count).toBe(1);
  expect(response.summary.invalid_app_count).toBe(1);
  const broken = response.apps.find((app) => app.id === "brokenco-broken-v1");
  expect(broken).toMatchObject({
    manifest_state: "invalid_manifest",
    dependency_status: "invalid_manifest",
    runtime_status: "stopped",
  });
  expect(broken.dependencies.can_start).toBe(false);

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  // Nevalidní manifest smí discovery check jen degradovat na warn, ne fail…
  const discoveryCheck = report.checks.find((check) => check.id === "launchpad.discovery");
  expect(discoveryCheck?.status).toBe("warn");
  // …a runtime diagnostika běží dál pro všechny appky včetně té nevalidní.
  const appCheck = report.checks.find((check) => check.id === "launchpad.runtime.brokenco-broken-v1");
  expect(appCheck?.status).toBe("warn");
  const goodCheck = report.checks.find((check) => check.id === "launchpad.runtime.brokenco-good-v1");
  expect(goodCheck).toBeDefined();
});

test("CAC-0042: doctor reportuje worktree inventory, contract violations a cleanup candidates", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  await mkdir(join(orgRoot, ".claude", "worktrees", "legacy-agent"), { recursive: true });

  const activePath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-active");
  const stalePath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-stale");
  const orphanPath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-orphan");
  const missingPlanPath = join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-missing-plan");
  await initGitRepo(activePath, { branch: "CAC-0042-doctor-active" });
  await initGitRepo(stalePath, { branch: "CAC-0042-doctor-stale" });
  await initGitRepo(orphanPath, { branch: "CAC-0042-doctor-orphan" });
  await initGitRepo(missingPlanPath, { branch: "CAC-0042-doctor-missing-plan" });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-doctor-active.yaml"),
    "dev_code: CAC-0042\ntitle: Doctor active worktree\nstatus: in_progress\n",
  );
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-doctor-stale.yaml"),
    "dev_code: CAC-0042\ntitle: Doctor stale worktree\nstatus: in_progress\n",
  );
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-active.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    branch: "CAC-0042-doctor-active",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-doctor-active.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-doctor-active",
    created_at: new Date().toISOString(),
    created_by: "examplebuddy-buddy",
    status: "active",
  });
  await mkdir(join(activePath, "app", "v1"), { recursive: true });
  await writeJson(join(activePath, "app", "v1", "package.json"), {
    private: true,
    packageManager: "bun@1.3.14",
    dependencies: { demo: "1.0.0" },
  });
  await writeFile(join(activePath, "app", "v1", "bun.lock"), "", "utf8");
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-stale.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    branch: "CAC-0042-doctor-stale",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-doctor-stale.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-doctor-stale",
    created_at: "2000-01-01T00:00:00.000Z",
    created_by: "examplebuddy-buddy",
    status: "active",
  });
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", "CAC-0042-doctor-missing-plan.worktree.json"), {
    schema_version: "companiesascode.worktree.v1",
    branch: "CAC-0042-doctor-missing-plan",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-doctor-missing-plan.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-doctor-missing-plan",
    created_at: new Date().toISOString(),
    created_by: "examplebuddy-buddy",
    status: "active",
  });

  const report = await buildLaunchpadDoctorReport({
    companiesRoot: root,
    launchpadRoot: join(root, "launchpad"),
    runtimeManager: { appsWithRuntime: async (apps) => apps },
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  expect(checks.get("git.worktrees.inventory")?.status).toBe("ok");
  expect(checks.get("git.worktrees.inventory")?.message).toContain("4 worktrees");
  expect(checks.get("git.worktrees.inventory")?.details).toEqual(expect.arrayContaining([
    "owned: 2",
    "orphan_missing_plan: 1",
    "orphan_missing_file: 1",
    "stale: 1",
  ]));
  expect(checks.get("git.worktrees.contract")?.status).toBe("warn");
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain(".claude/worktrees");
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain("CAC-0042-doctor-orphan");
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain("CAC-0042-doctor-missing-plan");
  expect(checks.get("git.worktrees.contract")?.details.join("\n")).toContain("cleanup_candidate: CAC-0042-doctor-stale");
  expect(checks.get("git.worktrees.dependencies")?.status).toBe("warn");
  expect(checks.get("git.worktrees.dependencies")?.details).toEqual(expect.arrayContaining([
    "checked_packages: 1",
    "needs_install: 1",
  ]));
  expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("CAC-0042-doctor-active/app/v1");
  expect(checks.get("git.worktrees.dependencies")?.details.join("\n")).toContain("bun install");
});

async function createCompaniesWorkspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-diagnostics-"));
  tempRoots.push(root);
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(root, "organizations"), { recursive: true });
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeJson(join(root, "lazurio.port-registry.json"), {
    schema_version: "lazurio.port_registry.v1",
    allocation_strategy: "organization-blocks",
    organization_blocks: [
      { company: "test-company", start: 24000, end: 24099 },
    ],
  });
  await writeFile(
    join(root, ".gitignore"),
    [
      "launchpad/runtime/",
      "launchpad/logs/",
      "logs/",
      "",
    ].join("\n"),
    "utf8",
  );
  run(["git", "init"], root);
  run(["git", "add", "."], root);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], root);
  return root;
}

async function createTemplateMountFixture() {
  const root = await mkdtemp(join(tmpdir(), "companiesascode-template-mount-"));
  const templateCheckout = await mkdtemp(join(tmpdir(), "mission-control-template-checkout-"));
  tempRoots.push(root, templateCheckout);
  const templatePath = join(root, "templates", "TemplatesBetaCo", "MissionControlTemplate");
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(root, "organizations"), { recursive: true });
  await mkdir(join(root, "templates", "TemplatesBetaCo"), { recursive: true });
  await writeFile(join(templateCheckout, "README.md"), "# MissionControlTemplate\n", "utf8");
  run(["git", "init"], templateCheckout);
  run(["git", "add", "."], templateCheckout);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "template init"], templateCheckout);
  await symlink(templateCheckout, templatePath, process.platform === "win32" ? "junction" : "dir");
  // Scan-first: module šablony jsou informační sken templates/*/*, ne registry.
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: {
      slug: "test-companies",
      display_name: "Test Companies",
      root_role: "companies-root",
    },
  });
  await writeFile(
    join(root, ".gitignore"),
    [
      "launchpad/runtime/",
      "launchpad/logs/",
      "logs/",
      "templates/TemplatesBetaCo/",
      "",
    ].join("\n"),
    "utf8",
  );
  run(["git", "init"], root);
  run(["git", "add", ".gitignore", "launchpad.gen3.json"], root);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], root);
  return root;
}

async function writeJson(path, data) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function run(command, cwd) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}
