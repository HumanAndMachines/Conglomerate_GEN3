import { expect, test } from "bun:test";
import {
  appBaseTitle,
  appVersionLabel,
  computeSpaceHeroState,
  familyTitle,
  filterApps,
  groupAppFamilies,
  groupFamiliesByWorkspace,
  matchesQuery,
  offersMoreThanLocalRun,
  productionUrl,
  replacePersonalspaceResponse,
  reconcileSelectedAppId,
  runtimeStagesForApp,
  summarizeOrganizationSpaceHealth,
  variantMenuLabel,
  variantTag,
} from "../public/app-state.js";

const apps = [
  app("democo-app-1", "DemoCo", "ready"),
  app("omegaco-app-1", "OmegaCo", "stale_lockfile"),
  app("omegaco-app-2", "OmegaCo", "ready"),
  app("betaco-app-1", "BetaCo", "needs_install"),
];

test("Launchpad selection follows the active Organization filter", () => {
  const filters = baseFilters({ company: "OmegaCo" });

  expect(filterApps(apps, filters).map((item) => item.id)).toEqual(["omegaco-app-1", "omegaco-app-2"]);
  expect(reconcileSelectedAppId(apps, filters, "democo-app-1")).toBe("omegaco-app-1");
  expect(reconcileSelectedAppId(apps, filters, "omegaco-app-2")).toBe("omegaco-app-2");
});

test("Launchpad selection becomes empty when no filtered app is visible", () => {
  expect(reconcileSelectedAppId(apps, baseFilters({ company: "MissingCo" }), "democo-app-1")).toBe(null);
});

test("partial-failure Personalspace odpověď odstraní revokovaný prostor i soukromá Buddy data", () => {
  const profile = { display_name: "Ownerka", email: "owner@example.com" };
  const previous = {
    ok: true,
    profile,
    spaces: [{
      dir_name: "revoked_GEN3",
      display_name: "Ownerka",
      buddy: { recurring_tasks: [{ id: "private-task", title: "PRIVATE-TASK" }] },
      apps: [{ id: "personal--revoked_GEN3--notes" }],
    }],
  };
  const incoming = {
    ok: false,
    profile: null,
    spaces: [],
    failures: ["jiná nevalidní montáž"],
  };

  expect(replacePersonalspaceResponse(previous, incoming)).toBe(incoming);
  expect(JSON.stringify(replacePersonalspaceResponse(previous, incoming))).not.toContain("PRIVATE-TASK");
  expect(JSON.stringify(replacePersonalspaceResponse(previous, incoming))).not.toContain("personal--revoked_GEN3--notes");
});

test("Launchpad search query narrows apps by title, id, company, module and tags", () => {
  expect(filterApps(apps, baseFilters({ query: "betaco" })).map((item) => item.id)).toEqual(["betaco-app-1"]);
  expect(filterApps(apps, baseFilters({ query: "omegaco-app-2" })).map((item) => item.id)).toEqual(["omegaco-app-2"]);
  expect(filterApps(apps, baseFilters({ query: "" })).length).toBe(apps.length);
  expect(filterApps(apps, baseFilters({ query: "nothing-matches" })).length).toBe(0);

  expect(matchesQuery(apps[0], "DEMO")).toBe(true);
  expect(matchesQuery(apps[0], "  ")).toBe(true);
  expect(matchesQuery(apps[0], "omegaco")).toBe(false);
});

test("runtime filtr a kontrolní toggle jsou nezávislé osy a skládají průnik", () => {
  const runningAttention = app("running-attention", "OmegaCo", "stale_lockfile");
  runningAttention.runtime_status = "healthy";
  const runningClean = app("running-clean", "OmegaCo", "ready");
  runningClean.runtime_status = "healthy";
  const stoppedAttention = app("stopped-attention", "OmegaCo", "missing_access");

  const candidates = [runningAttention, runningClean, stoppedAttention];
  expect(filterApps(candidates, baseFilters({ status: "healthy" })).map((item) => item.id)).toEqual([
    "running-attention",
    "running-clean",
  ]);
  expect(filterApps(candidates, baseFilters({ attentionOnly: true })).map((item) => item.id)).toEqual([
    "running-attention",
    "stopped-attention",
  ]);
  expect(filterApps(candidates, baseFilters({ status: "healthy", attentionOnly: true })).map((item) => item.id)).toEqual([
    "running-attention",
  ]);
});

test("One module = one tile: versions AND named sub-apps collapse by company+module", () => {
  const apps = [
    { id: "inv-v1", company: "OmegaCo", module: "invoices", title: "Invoices v1", runtime_status: "healthy", host: "127.0.0.1", port: 5294 },
    { id: "inv-v2", company: "OmegaCo", module: "invoices", title: "Invoices v2", runtime_status: "stopped", host: "127.0.0.1", port: 5295 },
    { id: "content-catalog", company: "BetaCo", module: "content", title: "Content catalog", runtime_status: "healthy" },
    { id: "content-editor", company: "BetaCo", module: "content", title: "Content editor", runtime_status: "healthy" },
    { id: "mc-v3", company: "OmegaCo", module: "mission-control", title: "Mission Control v3", runtime_status: "healthy" },
  ];
  const families = groupAppFamilies(apps);

  // 5 apps → 3 module tiles (invoices, content, mission-control).
  expect(families.length).toBe(3);

  // Invoices versions collapse; default = newest (v2); tile title "Invoices".
  const invoices = families.find((family) => family.module === "invoices");
  expect(invoices.members.map((member) => member.id)).toEqual(["inv-v2", "inv-v1"]);
  expect(invoices.primary.id).toBe("inv-v2");
  expect(familyTitle(invoices.members)).toBe("Invoices");
  expect(variantTag(invoices.primary, "Invoices")).toBe("v2");
  expect(variantMenuLabel(invoices.members[1], "Invoices")).toBe("v1");

  // Content catalog + editor are ONE module "Content" with two named variants.
  const content = families.find((family) => family.module === "content");
  expect(content.members.length).toBe(2);
  expect(familyTitle(content.members)).toBe("Content");
  expect(variantTag(content.primary, "Content")).toBe("Catalog");
  const editor = content.members.find((member) => member.id === "content-editor");
  expect(variantMenuLabel(editor, "Content")).toBe("Editor");

  // A lone versioned app keeps its version tag but has no extra variants.
  const mission = families.find((family) => family.module === "mission-control");
  expect(mission.members.length).toBe(1);
  expect(familyTitle(mission.members)).toBe("Mission Control");
  expect(variantTag(mission.primary, "Mission Control")).toBe("v3");

  // A plain single app (no version, name == module) gets no distinguishing tag.
  expect(variantTag({ title: "Guide GEN3", module: "guide" }, "Guide GEN3")).toBe("");
  expect(appBaseTitle(apps[2])).toBe("Content catalog");
  expect(appVersionLabel(apps[2])).toBe("");
});

test("Module tiles split across the workspaces they belong to, preserving order", () => {
  const apps = [
    { id: "kb", company: "AlfaCo", module: "knowledgebase", title: "Knowledgebase", workspace: "workspace" },
    { id: "mela", company: "AlfaCo", module: "sidebrand", title: "SideBrand", workspace: "sidebrand" },
    { id: "ds", company: "AlfaCo", module: "design-system", title: "Design system", workspace: "sidebrand" },
    { id: "content", company: "AlfaCo", module: "content", title: "Content", workspace: "workspace" },
  ];
  const sections = groupFamiliesByWorkspace(groupAppFamilies(apps));

  expect(sections.map((section) => section.workspace)).toEqual(["workspace", "sidebrand"]);
  expect(sections[0].families.map((family) => family.module)).toEqual(["knowledgebase", "content"]);
  expect(sections[1].families.map((family) => family.module)).toEqual(["sidebrand", "design-system"]);

  // Apps without an explicit workspace fall into the default "workspace".
  const fallback = groupFamiliesByWorkspace(groupAppFamilies([{ id: "x", company: "A", module: "m", title: "X" }]));
  expect(fallback).toEqual([{ workspace: "workspace", families: fallback[0].families }]);
  expect(fallback[0].workspace).toBe("workspace");

  const root = groupFamiliesByWorkspace(groupAppFamilies([
    { id: "mc", company: "A", module: "mission-control", title: "Mission Control", workspace: null },
  ]));
  expect(root).toEqual([{ workspace: null, families: root[0].families }]);
});

test("Organization-root a Team app stejného modulu zůstávají v oddělených sekcích", () => {
  const families = groupAppFamilies([
    {
      id: "root-mc",
      company: "AlfaCo",
      module: "mission-control",
      title: "Mission Control v3",
      workspace: null,
    },
    {
      id: "team-mc",
      company: "AlfaCo",
      module: "mission-control",
      title: "Mission Control helper",
      workspace: "workspace",
    },
  ]);
  const sections = groupFamiliesByWorkspace(families);

  expect(families).toHaveLength(2);
  expect(sections.map((section) => section.workspace)).toEqual([null, "workspace"]);
  expect(sections[0].families[0].members.map((app) => app.id)).toEqual(["root-mc"]);
  expect(sections[1].families[0].members.map((app) => app.id)).toEqual(["team-mc"]);
});

test("hero agreguje appky i manifestované sloty aktivní Organizace", () => {
  const organization = {
    slug: "OmegaCo",
    workspace_conformance_issues: [],
    workspaces: [{
      slug: "workspace",
      modules: [
        { path: "workspace/required", status: "missing_access", default_access: "expected", readiness: { severity: "blocking" } },
        { path: "workspace/finance", status: "missing_access", default_access: "restricted", readiness: { severity: "neutral" } },
        { path: "workspace/future", status: "planned_slot", default_access: "role_based", readiness: { severity: "neutral" } },
      ],
    }],
    productionspace: { systems: [] },
  };
  const health = summarizeOrganizationSpaceHealth({
    organization,
    apps: [
      app("omegaco-ready", "OmegaCo", "ready"),
      app("omegaco-invalid", "OmegaCo", "invalid_manifest"),
      app("other-invalid", "Other", "invalid_manifest"),
    ],
  });

  expect(health.blockers).toBe(2);
  expect(health.expected_restrictions).toBe(1);
  expect(health.blocking_slots.map((slot) => slot.path)).toEqual(["workspace/required"]);
  expect(computeSpaceHeroState(health)).toMatchObject({
    tone: "danger",
    title: "Prostor vyžaduje nastavení · 2 blokátory",
  });
});

test("očekávané role/ACL omezení samo nepotlačí zelený prostorový stav", () => {
  const health = summarizeOrganizationSpaceHealth({
    organization: {
      slug: "BetaCo",
      workspaces: [{
        slug: "workspace",
        modules: [{
          path: "workspace/invoices",
          status: "missing_access",
          default_access: "restricted",
          readiness: { severity: "neutral", reason: "expected_access_boundary" },
        }],
      }],
    },
    apps: [app("betaco-ready", "BetaCo", "ready")],
  });

  expect(health).toMatchObject({ blockers: 0, warnings: 0, expected_restrictions: 1 });
  expect(computeSpaceHeroState(health)).toMatchObject({ tone: "ok", title: "Prostor je připravený" });
});

test("hard failure aktivního osobního prostoru zůstane blokátorem", () => {
  const health = summarizeOrganizationSpaceHealth({
    apps: [],
    spaceFailures: ["personal.gen3.json není validní"],
    extraWarnings: 1,
  });

  expect(health).toMatchObject({ blockers: 1, warnings: 1 });
  expect(computeSpaceHeroState(health)).toMatchObject({
    tone: "danger",
    title: "Prostor vyžaduje nastavení · 1 blokátor",
  });
});

test("hero započítá i blokující vnořený slot z Doctor agregace", () => {
  const health = summarizeOrganizationSpaceHealth({
    organization: {
      slug: "OmegaCo",
      workspaces: [{ slug: "workspace", modules: [] }],
      space_readiness: {
        blocking_slots: [{ path: "mission-control/db", reason: "unexpected_missing_access" }],
      },
    },
    apps: [],
  });

  expect(health.blockers).toBe(1);
  expect(health.blocking_slots).toEqual([{ path: "mission-control/db", reason: "unexpected_missing_access" }]);
  expect(computeSpaceHeroState(health).tone).toBe("danger");
});

test("nezdravý runtime je prostorový blokátor i s ready dependencies", () => {
  const unhealthy = app("broken-runtime", "OmegaCo", "ready");
  unhealthy.runtime_status = "unhealthy";
  const health = summarizeOrganizationSpaceHealth({
    organization: { slug: "OmegaCo", workspaces: [] },
    apps: [unhealthy],
  });

  expect(health).toMatchObject({ blockers: 1, warnings: 0 });
  expect(computeSpaceHeroState(health).tone).toBe("danger");
});

test("startující nebo neznámý runtime drží prostor ve warning stavu", () => {
  for (const runtimeStatus of ["starting", "unknown"]) {
    const transient = app(`runtime-${runtimeStatus}`, "OmegaCo", "ready");
    transient.runtime_status = runtimeStatus;
    const health = summarizeOrganizationSpaceHealth({
      organization: { slug: "OmegaCo", workspaces: [] },
      apps: [transient],
    });

    expect(health).toMatchObject({ blockers: 0, warnings: 1 });
    expect(computeSpaceHeroState(health).tone).toBe("warn");
  }
});

test("runtime stages: one module offers PROD / MAIN / DEV remote / DEV local in order", () => {
  const stages = runtimeStagesForApp(app("omegaco-deals", "OmegaCo", "ready"), { openable: true });
  expect(stages.map((stage) => stage.stage)).toEqual(["prod", "main", "dev_remote", "dev_local"]);
  expect(stages.map((stage) => stage.label)).toEqual(["PROD", "MAIN", "DEV remote", "DEV local"]);
});

test("runtime stages: PROD is a real link only when a production URL is declared", () => {
  const withProd = runtimeStagesForApp(
    { ...app("omegaco-deals", "OmegaCo", "ready"), production_url: "https://deals.omegaco.com" },
    { openable: true },
  );
  const prod = withProd.find((stage) => stage.stage === "prod");
  expect(prod.available).toBe(true);
  expect(prod.action).toBe("open_url");
  expect(prod.url).toBe("https://deals.omegaco.com");
  expect(prod.reason).toBeNull();

  const withoutProd = runtimeStagesForApp(app("omegaco-deals", "OmegaCo", "ready"), { openable: true });
  const stub = withoutProd.find((stage) => stage.stage === "prod");
  expect(stub.available).toBe(false);
  expect(stub.action).toBeNull();
  expect(stub.url).toBeNull();
  expect(stub.reason).toContain("Produkce");
});

test("runtime stages: a non-http production URL falls back to the disabled PROD stub", () => {
  expect(productionUrl({ production_url: "deals.omegaco.com" })).toBeNull();
  expect(productionUrl({ production_url: "  https://deals.omegaco.com  " })).toBe("https://deals.omegaco.com");
  const stages = runtimeStagesForApp({ ...app("x", "OmegaCo", "ready"), production_url: "ftp://nope" }, { openable: true });
  expect(stages.find((stage) => stage.stage === "prod").available).toBe(false);
});

test("runtime stages: malformed production URLs fail closed (review P1 2026-07-16)", () => {
  // Prefix-only checks let these through and unlocked a live PROD link.
  const adversarial = [
    "https://",           // no hostname
    "http://[",           // unparseable
    "https:// user",      // whitespace in authority
    "https://?x",         // query only, no hostname
    // ("https:///path" is NOT here: WHATWG parsing normalizes it to host "path",
    //  a well-formed URL — the guard is about unparseable/hostless values.)
    "javascript:alert(1)", // wrong scheme entirely
    "HTTPS://",           // case variant, still no hostname
  ];
  for (const value of adversarial) {
    expect(productionUrl({ production_url: value })).toBeNull();
    expect(offersMoreThanLocalRun({ ...app("x", "OmegaCo", "ready"), production_url: value })).toBe(false);
  }
  // Sanity: real URLs still pass (host present, http/https).
  expect(productionUrl({ production_url: "http://deals.omegaco.com" })).toBe("http://deals.omegaco.com");
  expect(productionUrl({ production_url: "https://deals.omegaco.com/app?x=1" })).toBe("https://deals.omegaco.com/app?x=1");
});

test("runtime stages: MAIN and DEV remote are honest tailnet stubs, never wired here", () => {
  const stages = runtimeStagesForApp(app("x", "OmegaCo", "ready"), { openable: true });
  const main = stages.find((stage) => stage.stage === "main");
  const devRemote = stages.find((stage) => stage.stage === "dev_remote");
  expect(main.available).toBe(false);
  expect(main.reason).toContain("tailnet");
  expect(devRemote.available).toBe(false);
  expect(devRemote.reason).toContain("tailnet");
});

test("runtime stages: DEV local mirrors the card's openable decision", () => {
  const openable = runtimeStagesForApp(app("x", "OmegaCo", "ready"), { openable: true });
  expect(openable.find((stage) => stage.stage === "dev_local").available).toBe(true);
  expect(openable.find((stage) => stage.stage === "dev_local").action).toBe("open_local");

  const readOnly = runtimeStagesForApp(app("x", "OmegaCo", "ready"), { openable: false });
  const local = readOnly.find((stage) => stage.stage === "dev_local");
  expect(local.available).toBe(false);
  expect(local.action).toBeNull();
  expect(local.reason).toContain("počítači");
});

test("progressive disclosure: the stage row is offered only beyond the DEV local default", () => {
  // Founder 2026-07-16: when DEV local is the only choice, hide the row — the
  // tile's one-click open IS the default. No production_url → no row.
  expect(offersMoreThanLocalRun(app("x", "OmegaCo", "ready"))).toBe(false);
  // An invalid production URL does not unlock the row either.
  expect(offersMoreThanLocalRun({ ...app("x", "OmegaCo", "ready"), production_url: "ftp://nope" })).toBe(false);
  expect(offersMoreThanLocalRun({ ...app("x", "OmegaCo", "ready"), production_url: "deals.omegaco.com" })).toBe(false);
  // A declared production_url means the module offers PROD → full row shows.
  expect(offersMoreThanLocalRun({ ...app("x", "OmegaCo", "ready"), production_url: "https://deals.omegaco.com" })).toBe(true);
  // No Workspace-Host (MAIN / DEV remote) capability data exists today, so
  // nothing else unlocks the row.
  expect(offersMoreThanLocalRun({ ...app("x", "OmegaCo", "ready"), runtime_status: "healthy" })).toBe(false);
});

test("runtime stages: local worktrees enrich the DEV remote honest note", () => {
  const none = runtimeStagesForApp(app("x", "OmegaCo", "ready"), { openable: true, worktreeCount: 0 });
  const some = runtimeStagesForApp(app("x", "OmegaCo", "ready"), { openable: true, worktreeCount: 2 });
  expect(some.find((stage) => stage.stage === "dev_remote").reason).toContain("DEV local");
  expect(none.find((stage) => stage.stage === "dev_remote").reason).not.toContain("DEV local");
});

function baseFilters(overrides = {}) {
  return {
    company: "all",
    surface: "all",
    tag: "all",
    status: "all",
    attentionOnly: false,
    ...overrides,
  };
}

function app(id, company, dependencyState) {
  return {
    id,
    company,
    surface: "internal",
    tags: ["test"],
    runtime_status: "stopped",
    dependencies: {
      state: dependencyState,
    },
  };
}
