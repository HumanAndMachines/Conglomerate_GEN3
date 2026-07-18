export function filterApps(apps, filters) {
  return apps.filter((app) => {
    if (filters.company !== "all" && app.company !== filters.company) return false;
    if (filters.surface !== "all" && app.surface !== filters.surface) return false;
    if (filters.tag !== "all" && !(app.tags ?? []).includes(filters.tag)) return false;
    if (!matchesStatusFilter(app, filters.status)) return false;
    if (filters.attentionOnly && !isAttentionState(app)) return false;
    if (!matchesQuery(app, filters.query)) return false;
    return true;
  });
}

export function matchesQuery(app, query) {
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    app.title,
    app.id,
    app.company,
    app.company_display_name,
    app.module,
    ...(app.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function reconcileSelectedAppId(apps, filters, selectedAppId) {
  const visibleApps = filterApps(apps, filters);
  if (visibleApps.some((app) => app.id === selectedAppId)) return selectedAppId;
  return visibleApps[0]?.id ?? null;
}

export function replacePersonalspaceResponse(_previous, incoming) {
  // Úspěšná HTTP odpověď je autorita i tehdy, když payload nese ok:false kvůli
  // jedné nevalidní montáži. Dřívější prostory se nesmějí přimíchat zpět:
  // mohly být odebrané nebo mohl být zrušený jejich přístup. Poslední známý
  // stav zachovává pouze transportní chyba, při které se tato funkce nevolá.
  return incoming;
}

export function matchesStatusFilter(app, filter) {
  if (filter === "all") return true;
  return app.runtime_status === filter;
}

const BLOCKING_APP_STATES = new Set([
  "invalid_manifest",
  "missing_package",
  "unknown_package_manager",
  "missing_access",
  "restricted",
  "runtime_failed",
]);

export function summarizeOrganizationSpaceHealth({ apps = [], organization = null, spaceFailures = [], extraWarnings = 0 } = {}) {
  const spaceApps = organization?.slug
    ? apps.filter((app) => app.company === organization.slug)
    : apps;
  const slots = organization
    ? [
        ...(organization.workspaces ?? []).flatMap((workspace) => workspace.modules ?? []),
        ...(organization.productionspace?.systems ?? []),
      ]
    : [];
  const blockingApps = spaceApps.filter(
    (app) => BLOCKING_APP_STATES.has(app.dependencies?.state) || app.runtime_status === "unhealthy",
  );
  const blockingSlots = Array.isArray(organization?.space_readiness?.blocking_slots)
    ? organization.space_readiness.blocking_slots
    : slots.filter((slot) => slotReadinessSeverity(slot) === "blocking");
  const expectedRestrictions = slots.filter(
    (slot) => slot.status === "missing_access" && slotReadinessSeverity(slot) === "neutral",
  );
  const attentionApps = spaceApps.filter((app) => isAttentionState(app) && !blockingApps.includes(app));
  const conformanceWarnings = organization?.workspace_conformance_issues?.length ?? 0;

  return {
    blockers: spaceFailures.length + blockingApps.length + blockingSlots.length,
    warnings: attentionApps.length + conformanceWarnings + extraWarnings,
    attention: attentionApps.length,
    running: spaceApps.filter((app) => app.runtime_status === "healthy").length,
    expected_restrictions: expectedRestrictions.length,
    blocking_apps: blockingApps,
    blocking_slots: blockingSlots,
  };
}

export function computeSpaceHeroState(health) {
  if (health.blockers > 0) {
    return {
      tone: "danger",
      title: `Prostor vyžaduje nastavení · ${health.blockers} ${pluralBlocker(health.blockers)}`,
      cta: "Zobrazit problémy",
      action: "problems",
    };
  }
  if (health.warnings > 0) {
    return {
      tone: "warn",
      title: `Prostor chce pozornost · ${health.warnings} ${pluralAttention(health.warnings)}`,
      cta: "Projít ke kontrole",
      action: health.attention > 0 ? "attention" : "problems",
    };
  }
  return {
    tone: "ok",
    title: health.running > 0
      ? `Prostor je připravený · ${health.running} ${pluralRunningApp(health.running)} běží`
      : "Prostor je připravený",
    cta: "Obnovit stav",
    action: "reload",
  };
}

function slotReadinessSeverity(slot) {
  if (slot.readiness?.severity) return slot.readiness.severity;
  if (slot.status === "available" || slot.status === "planned_slot") return "neutral";
  if (slot.status === "missing_access") return "blocking";
  return "blocking";
}

function pluralBlocker(count) {
  if (count === 1) return "blokátor";
  if (count >= 2 && count <= 4) return "blokátory";
  return "blokátorů";
}

function pluralAttention(count) {
  return count === 1 ? "položka ke kontrole" : count >= 2 && count <= 4 ? "položky ke kontrole" : "položek ke kontrole";
}

function pluralRunningApp(count) {
  return count === 1 ? "aplikace" : count >= 2 && count <= 4 ? "aplikace" : "aplikací";
}

// ---- Module families --------------------------------------------------------
// One module = one tile. A module can expose several apps ("variants"):
//   - versions of one app, e.g. "Invoices v1" / "Invoices v2", or
//   - named sub-apps, e.g. "Content catalog" / "Content editor".
// They share company + module + Organization/Team section, so that is the
// grouping key. Scope is part of the key: a root app must never collapse with
// a Team app of the same module. The tile shows a default variant and the rest
// sit behind a "more" menu. The module display name and the per-variant tag are
// derived so versions read as "v2" and named sub-apps read as "Catalog" /
// "Editor".

function appTitleVersion(app) {
  const match = String(app.title ?? "").match(/\sv(\d+)$/i);
  return match ? Number(match[1]) : null;
}

export function appBaseTitle(app) {
  const title = String(app.title ?? "");
  return title.replace(/\s+v\d+$/i, "").trim() || title;
}

export function appVersionLabel(app) {
  const version = appTitleVersion(app);
  return version === null ? "" : `v${version}`;
}

function appFamilyKey(app) {
  const workspace = app && Object.hasOwn(app, "workspace")
    ? app.workspace
    : "workspace";
  const section = workspace === null ? "root" : `workspace:${workspace}`;
  return app.module
    ? `${app.company}::${section}::m:${app.module}`
    : `${app.company}::${section}::i:${app.id}`;
}

export function groupAppFamilies(apps) {
  const order = [];
  const map = new Map();
  for (const app of apps) {
    const key = appFamilyKey(app);
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key).push(app);
  }
  return order.map((key) => {
    // Highest version first → the default the tile represents and launches.
    // Equal versions keep discovery order (stable), so the first sub-app wins.
    const members = [...map.get(key)].sort((a, b) => (appTitleVersion(b) ?? -1) - (appTitleVersion(a) ?? -1));
    const primary = members[0];
    return { key, company: primary.company, module: primary.module ?? null, members, primary };
  });
}

// Human display name for the whole module tile — the longest shared word prefix
// of the members' titles (so "Content catalog"/"Content editor" → "Content"),
// falling back to a humanised module slug, then the single app's title.
export function familyTitle(members) {
  if (members.length === 1) return appBaseTitle(members[0]);
  const prefix = longestCommonWordPrefix(members.map(appBaseTitle));
  if (prefix) return prefix;
  return humanizeModuleSlug(members[0]?.module) || appBaseTitle(members[0]);
}

// Short tag distinguishing one variant inside its module, e.g. "v2", "Catalog",
// or "Editor v2". Empty when there is nothing to distinguish (single plain app).
export function variantTag(app, moduleName) {
  const namePart = capitalizeFirst(stripWordPrefix(appBaseTitle(app), moduleName));
  const versionPart = appVersionLabel(app);
  return [namePart, versionPart].filter(Boolean).join(" ");
}

// Full label for a variant in the menu — always non-empty.
export function variantMenuLabel(app, moduleName) {
  return variantTag(app, moduleName) || appBaseTitle(app);
}

// Groups module tiles by the workspace they belong to, preserving order. An
// organization may split its modules across several named workspaces. A missing
// field falls into the default "workspace"; explicit null stays a separate
// Organization-root section outside Team grouping.
export function groupFamiliesByWorkspace(families) {
  const order = [];
  const map = new Map();
  for (const family of families) {
    const slug = family.primary && Object.hasOwn(family.primary, "workspace")
      ? family.primary.workspace
      : "workspace";
    if (!map.has(slug)) {
      map.set(slug, []);
      order.push(slug);
    }
    map.get(slug).push(family);
  }
  return order.map((slug) => ({ workspace: slug, families: map.get(slug) }));
}

function longestCommonWordPrefix(titles) {
  if (titles.length === 0) return "";
  const wordLists = titles.map((title) => title.split(/\s+/));
  const first = wordLists[0];
  const prefix = [];
  for (let i = 0; i < first.length; i++) {
    if (wordLists.every((words) => words[i] === first[i])) prefix.push(first[i]);
    else break;
  }
  return prefix.join(" ");
}

function stripWordPrefix(title, prefix) {
  if (!prefix) return title;
  const lowerTitle = title.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerTitle === lowerPrefix) return "";
  if (lowerTitle.startsWith(`${lowerPrefix} `)) return title.slice(prefix.length).trim();
  return title;
}

function humanizeModuleSlug(slug) {
  if (!slug) return "";
  return String(slug).split("-").map((word, index) => (index === 0 ? capitalizeFirst(word) : word)).join(" ");
}

function capitalizeFirst(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

// ---- Runtime stages ---------------------------------------------------------
// Ratified model (founder 2026-07-15/16; cross-ref Dashboard spike SPEC §1):
// one module = one card everywhere; surfaces differ only in WHICH runs they
// offer. A module has up to four runs, and the Launchpad card offers all four:
//   - PROD       — deployed stable instance on a public domain (production_url).
//                  The Dashboard opens ONLY this; users reach it via the app's
//                  hosted MCP server (authorization boundary), never raw files.
//   - MAIN       — live state of the main branch on the org's Workspace Host.
//                  NEVER a public domain; opened over the tailnet. Not wired here.
//   - DEV remote — a branch checkout on the Workspace Host; tailnet. Not wired.
//   - DEV local  — a checkout on the builder's own machine; localhost. This is the
//                  existing one-click local run — the row REUSES it, it is not a
//                  second run path.
// Canonical names are the vocabulary; captions stay free of git jargon. Disabled
// runs always say WHY in plain language. `openable` mirrors the card's own
// non-readonly decision; `worktreeCount` only enriches honest copy.
export function productionUrl(app) {
  const value = app?.production_url;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // builder review P1 (2026-07-16): prefix check let malformed values through
  // ("https://", "http://[", "https:// user", "https://?x") and unlocked a live
  // PROD link. Fail-closed: must PARSE as a URL, protocol http/https only, and
  // carry a non-empty hostname. new URL also rejects embedded whitespace.
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return trimmed;
}

// Progressive disclosure (founder 2026-07-16): DEV local is the DEFAULT — the
// one-click tile open. The stage row appears ONLY when the module actually
// offers something beyond that default: a real PROD (declared production_url)
// or a known Workspace-Host run (MAIN / DEV remote). Today no data source
// declares a Workspace-Host capability (transport is [OPEN]), so that leg is
// honestly false — first-time users see zero extra buttons. Once a module
// crosses the threshold, the FULL four-run row shows (disabled runs dimmed
// with their plain-language why), so the vocabulary stays complete.
export function offersMoreThanLocalRun(app) {
  if (productionUrl(app)) return true;
  // Workspace-Host capability (MAIN / DEV remote) for this module/org: no
  // manifest or API field carries it yet → never true today. Extend this leg
  // when the tailnet transport lands.
  return false;
}

export function runtimeStagesForApp(app, { openable = false, worktreeCount = 0 } = {}) {
  const prodUrl = productionUrl(app);
  return [
    {
      stage: "prod",
      label: "PROD",
      caption: "Nasazená produkce",
      available: Boolean(prodUrl),
      url: prodUrl,
      action: prodUrl ? "open_url" : null,
      reason: prodUrl ? null : "Produkce zatím není nasazená — žádná veřejná adresa.",
    },
    {
      stage: "main",
      label: "MAIN",
      caption: "Hlavní větev · Workspace Host",
      available: false,
      url: null,
      action: null,
      reason: "Přes tailnet — spojení zatím není v Launchpadu propojené.",
    },
    {
      stage: "dev_remote",
      label: "DEV remote",
      caption: "Vývojová větev · Workspace Host",
      available: false,
      url: null,
      action: null,
      reason:
        worktreeCount > 0
          ? "Přes tailnet — plánované. Vzdálený vývojový běh zatím není propojený; rozdělanou práci teď spustíš v DEV local."
          : "Přes tailnet — plánované. Vzdálený vývojový běh zatím není propojený.",
    },
    {
      stage: "dev_local",
      label: "DEV local",
      caption: "Tvůj počítač · localhost",
      available: Boolean(openable),
      url: null,
      action: openable ? "open_local" : null,
      reason: openable ? null : "Tady na počítači teď nejde spustit — vyřeš nejdřív stav modulu na kartě.",
    },
  ];
}

export function isAttentionState(app) {
  return [
    "needs_install",
    "stale_lockfile",
    "missing_access",
    "planned_slot",
    "restricted",
    "invalid_manifest",
    "missing_package",
    "unknown_package_manager",
  ].includes(app.dependencies?.state)
    || ["unhealthy", "starting", "unknown"].includes(app.runtime_status)
    // Git attention (CAC-0044/CAC-0042): nezávislý toggle kontroly zahrnuje i
    // git stavy (novější verze, čeká na odeslání, jiný režim…). Anotaci git_attention
    // dodává app.js z git read modelu; bez read modelu je vždy false,
    // takže se chování nemění (graceful).
    || app.git_attention === true;
}
