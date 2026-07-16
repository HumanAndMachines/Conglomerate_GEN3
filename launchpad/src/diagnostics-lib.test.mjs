import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { buildEnvironmentChecks, buildLaunchpadAppsResponse, buildLaunchpadDoctorReport, runtimeAppStatus } from "./diagnostics-lib.mjs";
import { createLaunchpadGitFixture, initGitRepo } from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("Doctor drží foreign-port jako hard failure i při dependency warningu", () => {
  expect(runtimeAppStatus({
    dependencies: { state: "needs_install" },
    runtime: { owner: "foreign-port", status: "unhealthy" },
  })).toBe("fail");
  expect(runtimeAppStatus({
    dependencies: { state: "stale_lockfile" },
    runtime: { owner: "unknown-port", status: "unhealthy" },
  })).toBe("fail");
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

test("vnořený child slot (mission-control/db) není module dlaždice (technický data mount)", async () => {
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
  });
  await writeJson(join(companyRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    module_slots: [
      { path: "mission-control", git: { url: "git@github.com:OmegaCo/mission-control.git", branch: "main" } },
      { path: "mission-control/db", category: "planning-data", git: { url: "git@github.com:OmegaCo/mission-control-data.git", branch: "v3" } },
      { path: "workspace/wiki", workspace: "workspace" },
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
  const tilePaths = (org?.workspaces ?? []).flatMap((workspace) => workspace.modules.map((module) => module.path));
  // mission-control (app mount) je dlaždice; mission-control/db je technický
  // repository-db data checkout uvnitř app mountu — dlaždice být nesmí.
  expect(tilePaths).toContain("mission-control");
  expect(tilePaths).toContain("workspace/wiki");
  expect(tilePaths).not.toContain("mission-control/db");
  expect(org?.space_readiness?.blocking_slots.map((slot) => slot.path)).toContain("mission-control/db");
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

test("app workspace se čte z manifest deklarace, ne z filesystem cesty (decision 0041)", async () => {
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
    module_slots: [
      { path: "modules/sidebrand-shop", workspace: "sidebrand" },
      { path: "modules/wiki" },
    ],
  });
  await writeJson(join(companyRoot, "TODO.tasks.json"), {});
  await writeJson(join(companyRoot, "DONE.tasks.json"), {});
  await writeJson(join(companyRoot, "ISSUES.open.json"), {});
  const shopApp = join(companyRoot, "modules", "sidebrand-shop", "app", "v1");
  const wikiApp = join(companyRoot, "modules", "wiki", "app", "v1");
  for (const [dir, id, port] of [
    [shopApp, "sidebrand-shop-v1", 5511],
    [wikiApp, "alfaco-wiki-v1", 5512],
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

  const workspaceByAppId = new Map(response.apps.map((app) => [app.id, app.workspace]));
  // Deklarace v manifestu vyhrává; moduly jsou fyzicky v modules/ (plochý
  // layout), přesto se appka grupuje do deklarovaného Workspace.
  expect(workspaceByAppId.get("sidebrand-shop-v1")).toBe("sidebrand");
  // Chybějící deklarace = default Workspace se slugem "workspace".
  expect(workspaceByAppId.get("alfaco-wiki-v1")).toBe("workspace");
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
  await writeJson(join(companyRoot, "modules.manifest.json"), {});
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
        id: "broken-co-good-v1",
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
        id: "broken-co-broken-v1",
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
  const broken = response.apps.find((app) => app.id === "broken-co-broken-v1");
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
  const appCheck = report.checks.find((check) => check.id === "launchpad.runtime.broken-co-broken-v1");
  expect(appCheck?.status).toBe("warn");
  const goodCheck = report.checks.find((check) => check.id === "launchpad.runtime.broken-co-good-v1");
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
  await symlink(templateCheckout, templatePath);
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
