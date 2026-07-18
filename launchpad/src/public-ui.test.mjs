import { expect, test } from "bun:test";
import { readFile as readRawFile } from "fs/promises";
import { join } from "path";

const publicRoot = join(import.meta.dirname, "..", "public");

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

async function readFile(path, encoding) {
  return normalizeLineEndings(await readRawFile(path, encoding));
}

test("Launchpad public shell exposes a header space switcher and app cards", async () => {
  const [html, js, css, server] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
    readFile(join(import.meta.dirname, "server.mjs"), "utf8"),
  ]);

  // Shell regions and engineering fallback are still present.
  expect(html).toContain('id="spaceSwitcherButton"');
  expect(html).toContain('id="spaceSwitcherMenu"');
  expect(html).toContain('id="appsGrid"');
  expect(html).toContain('class="debug-table"');
  expect(html).not.toContain('id="organizationRail"');
  expect(html).not.toContain('id="companyFilter"');
  expect(html).not.toContain('id="filterRail"');
  expect(html).not.toContain('id="surfaceFilter"');
  expect(html).not.toContain('id="tagFilter"');
  expect(html).not.toContain('class="brand-name"');
  expect(html).not.toContain('class="workspace-chip"');
  expect(html).not.toContain('class="summary-grid"');
  expect(html).not.toContain('id="appCount"');
  expect(html).not.toContain('id="companyCount"');
  expect(html).not.toContain('id="failureCount"');

  // Přepínač v headeru drží právě jeden scope: Osobní nebo jednu Organizaci.
  expect(js).toContain("function renderSpaceSwitcher");
  expect(js).toContain("function spaceProfileCard");
  expect(js).toContain("function profileSettingsItem");
  expect(js).toContain("elements.spaceSwitcherButton.focus()");
  expect(js).toContain("restoreSpaceMenuFocusOnClose");
  expect(js).toContain('.space-switcher-option[aria-selected="true"]');
  expect(js).toContain("E-mail není nastavený");
  expect(js).toContain("function normalizeActiveSpace");
  expect(js).toContain("function spaceOption");
  expect(js).toContain("function selectSpace");
  expect(js).toContain("suppressNextDrawerOpen");
  expect(js).toContain("function visibleRecentModules");
  expect(js).toContain("function visibleMostUsed");
  expect(js).toContain('?company=${encodeURIComponent(requestedCompany)}');
  expect(js).toContain("const requestedCompany = state.filters.company");
  expect(js).toContain('state.filters.company !== requestedCompany) return');
  expect(js).toContain("return filtered(state.apps)");
  expect(js).toContain("--space-logo-hue");
  expect(js).toContain("space.organization.logo_url");
  expect(js).toContain("function applyOrganizationTheme");
  expect(js).toContain("space.organization.theme");
  expect(js).toContain('root.setAttribute("data-organization-theme"');
  expect(js).toContain("ORGANIZATION_THEME_TOKENS");
  expect(js).toContain('"--on-accent"');
  expect(js).toContain("safeOrganizationThemeValue");
  expect(js).toContain("accentLockedByOrganization");
  expect(js).toContain('if (state.filters.scope === "org") return false');
  expect(js).toContain('if (space.kind === "personal")');
  expect(js).not.toContain("https://github.com/");
  const profileBlock = js.slice(js.indexOf("function spaceProfileCard"), js.indexOf("function profileInitials"));
  expect(profileBlock).toContain('const name = document.createElement("a")');
  expect(profileBlock).toContain("name.href = profile.settings_url");
  expect(profileBlock).toContain('name.target = "_blank"');
  const settingsBlock = js.slice(js.indexOf("function profileSettingsItem"), js.indexOf("function settingsIcon"));
  expect(settingsBlock).toContain('document.createElement("div")');
  expect(settingsBlock).toContain('item.setAttribute("aria-disabled", "true")');
  expect(settingsBlock).not.toContain(".href");
  expect(server).toContain("organizationLogoCandidates");
  expect(server).toContain("launchpad/app/v1/web/launchpad-icon.png");
  expect(server).toContain("launchpad/app/v1/web/logo-square.png");
  expect(server).toContain("launchpad/app/v1/web/favicon.svg");
  expect(server).toContain("serveOrganizationLogo");
  expect(server).toContain("maxOrganizationLogoBytes");
  expect(server).toContain('"content-security-policy": "sandbox"');
  expect(server).toContain('"cross-origin-resource-policy": "same-origin"');
  expect(js).toContain("function renderScopeControls");
  expect(js).toContain('state.filters.scope === "personal"');
  expect(html).toContain('id="runtimeRootBadge"');
  expect(js).toContain('WORKTREE · ${worktreeName}');
  expect(js).toContain('rootPath?.replaceAll("\\\\", "/")');
  expect(js).toContain('elements.drawerToggle.classList.toggle("hidden", personal)');
  expect(js).toContain('state.filters.scope = "personal";\n  state.filters.company = "all";');
  const switcherBlock = js.slice(js.indexOf("function renderSpaceSwitcher"), js.indexOf("Side panels:"));
  expect(switcherBlock).not.toContain("organizationStats");
  expect(switcherBlock).not.toContain("organization-badges");
  expect(switcherBlock).not.toContain("organization-mount");
  expect(switcherBlock).not.toContain("chip(");
  expect(js).toContain("function renderAppsGrid");
  expect(js).toContain("reconcileSelectedAppId");
  expect(js).toContain("if (firstSuccessfulLoad) state.suppressNextDrawerOpen = true");
  expect(js).toContain("function scrollBelowStickyTopbar");
  expect(js).toContain("window.scrollBy({ top: delta, behavior: \"smooth\" })");
  expect(js).toContain("function primaryNextAction");
  expect(js).toContain("problems-details");
  expect(js).toContain("stale_lockfile");
  expect(js).toContain("missing_access");
  expect(js).toContain("planned_slot");
  expect(js).toContain('["current-instance", "adopted-port"].includes(app.runtime?.owner)');
  expect(js).toContain('return ["foreign-port", "unknown-port"].includes(app.runtime?.owner)');
  expect(js).toContain('title: app.runtime?.owner === "foreign-port" ? "Cizí checkout na portu" : "Checkout procesu nelze ověřit"');
  expect(js).toContain('actionLabel: "Zobrazit detail"');
  expect(js).toContain('label: app.runtime?.owner === "foreign-port" ? "Cizí checkout na portu" : "Checkout procesu nelze ověřit"');
  expect(js).toContain('small.textContent = blocked ? "blokovaná"');
  expect(js).toContain('action.textContent = blocked ? "Zobrazit detail"');
  expect(js).toContain('primaryNextAction(app).type !== "disabled"');

  expect(css).toContain(".space-switcher-menu");
  expect(css).toContain(".space-switcher-option");
  expect(css).toContain("max-height: calc(100vh - 5.5rem)");
  expect(css).toContain("overflow-y: auto");
  expect(css).toContain(".space-logo-organization");
  expect(css).toContain(".space-logo img");
  expect(css).toContain("var(--launchpad-body-background)");
  expect(css).toContain("color-mix(in srgb, var(--bg) 96%, #000)");
  expect(css).toContain("var(--font-heading, var(--font-body))");
  expect(css).toContain("--on-accent: #fff;");
  const primaryButtonBlock = css.slice(css.indexOf(".btn-primary {"), css.indexOf("}", css.indexOf(".btn-primary {")) + 1);
  expect(primaryButtonBlock).toContain("color: var(--on-accent);");
  expect(css).toContain("min-height: 34px");
  expect(css).toContain("width: min(280px");
  expect(css).toContain(".space-profile-card");
  expect(css).toContain(".space-profile-photo img");
  expect(css).toContain(".space-profile-settings");
  expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
  expect(css).not.toContain(".rail-panel");
  expect(css).toContain(".runtime-root-badge");
  expect(css).not.toContain(".organization-rail");
  expect(css).toContain(".apps-grid");
  expect(css).toContain(".app-card");
});

test("Launchpad shell ships GEN2-like command center, theme and feedback affordances", async () => {
  const [html, js, css] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  // Agregovaný stav prostoru žije v pravém sloupci, ne v celoplošné liště.
  expect(html).toContain('id="hero"');
  expect(html).toContain('id="heroTitle"');
  expect(html).toContain('id="heroCta"');
  expect(html.indexOf('id="hero"')).toBeGreaterThan(html.indexOf('id="recentChangesSidebar"'));
  expect(html.indexOf('id="hero"')).toBeLessThan(html.indexOf('id="organizationGitPanel"'));
  expect(html).toContain('id="spaceHealthBadge"');
  expect(html).not.toContain('id="heroSubtitle"');
  expect(js).toContain("function renderHero");
  expect(js).toContain("function computeHeroState");
  expect(js).toContain("computeSpaceHeroState");
  expect(js).toContain("summarizeOrganizationSpaceHealth");
  expect(js).toContain("const heroApps = activeSpaceApps()");
  expect(js).toContain("renderHero(heroApps, spaceHealth)");
  expect(js).toContain("renderProblems(spaceHealth)");
  expect(js).toContain("spaceFailures: personalFailures");
  expect(js).not.toContain("spaceFailures: state.failures");
  expect(js).toContain("Doktor: dokončeno ·");
  expect(js).toContain("function slotAccessChip");
  expect(js).toContain("function activeOrganizationSlotBlockers");
  expect(js).toContain("Blokátor aktivního prostoru:");
  expect(js).toContain("Blokátor aplikace");
  expect(js).toContain("Blokátor osobního prostoru:");
  expect(js).toContain("Chybí očekávaný přístup");
  expect(js).toContain("Očekávaně omezený přístup");
  expect(js).not.toContain("elements.heroSubtitle");
  expect(css).toContain("padding: 0 clamp(2rem, 3vw, 3.5rem) 3rem");
  expect(css).toContain(".hero .btn-sm");
  expect(css).toContain(".hero.hero-ok {");
  expect(css).toContain(".hero.hero-warn {");
  expect(css).toContain(".hero.hero-danger {");
  expect(css).toContain("background: var(--surface)");
  expect(css).toContain(".hero.hero-ok .btn-secondary");
  expect(css).toContain(".hero.hero-warn .btn-secondary");
  expect(css).toContain(".hero.hero-danger .btn-secondary");
  expect(css).toContain('.space-health-badge[data-tone="danger"]');
  expect(css).toContain("#drawerToggle {");
  expect(css).toContain("position: relative");
  expect(js).toContain("function renderSpaceHealthBadge");
  expect(js).toContain('toggle.setAttribute("aria-label", label)');
  expect(js).toContain("if (mobilePanelQuery.matches && state.drawerOpen) setDrawer(false)");
  expect(js).toContain("state.suppressNextDrawerOpen = true");
  expect(js).toContain("if (mobilePanelQuery.matches) setDrawer(false)");

  // Theme toggle + persisted theme.
  expect(html).toContain('data-theme="light"');
  expect(html).toContain('id="themeToggle"');
  expect(js).toContain("function initTheme");
  expect(js).toContain("launchpad-theme");
  expect(css).toContain('[data-theme="dark"]');

  // Theming is built to be driven dynamically by a future settings panel:
  // a mode axis (data-theme) and a named accent axis (data-accent presets),
  // exposed via window.LaunchpadTheme, with accent-derived tokens via color-mix.
  expect(js).toContain("function applyTheme");
  expect(js).toContain("window.LaunchpadTheme");
  expect(js).toContain("launchpad-accent");
  expect(css).toContain('[data-accent="emerald"]');
  expect(css).toContain("color-mix(in srgb, var(--accent)");

  // Search + segmented status filter in the workbench.
  expect(html).toContain('id="appsSearch"');
  expect(html).toContain("data-status-segment");
  expect(html).not.toContain('data-status-segment="attention"');
  expect(html).toContain('id="attentionToggle"');
  expect(html).toContain("Jen vyžadující kontrolu");
  expect(js).toContain("state.filters.attentionOnly = !state.filters.attentionOnly");
  expect(js).toContain("function syncAttentionToggle");
  expect(css).toContain(".segmented-control");
  expect(css).toContain(".attention-toggle");

  // Toast + skeleton feedback.
  expect(html).toContain('id="toastRoot"');
  expect(js).toContain("function toast");
  expect(js).toContain("function renderSkeleton");
  expect(css).toContain(".toast");
  expect(css).toContain(".skeleton-card");

  // Productionspace stays read-only and raw JSON is demoted to a debug payload.
  expect(js).toContain("isProductionspace");
  expect(js).toContain("debug-payload");
});

test("Daily surface hides diagnostics until the hero action requests them", async () => {
  const [html, js, css] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  // Agregovaný hero zůstává pravdivý, ale duplicitní červený panel není
  // součástí denního seznamu. Explicitní CTA detail odhalí a rovnou otevře.
  expect(js).toContain("problemsRequested: false");
  expect(js).toContain("problemsExpanded: false");
  expect(js).toContain("state.problemsRequested = true");
  expect(js).toContain("state.problemsExpanded = true");
  expect(js).toContain("details.open = state.problemsExpanded");
  expect(js).toContain("const panelDisclosed = state.problemsRequested || personalspaceFailureVisible");
  expect(js).toContain('panelDisclosed ? "" : " hidden"');
  expect(js).toContain("state.problemsRequested = false");
  expect(js).not.toContain("Něco není v pořádku");
  expect(js).toContain("problems-summary-label");
  // Globální Doctor chyby mohou být mimo scoped hero agregaci. Stavový chip je
  // proto druhá explicitní, klávesnicí dostupná cesta ke stejnému detailu.
  expect(html).toContain('id="doctorStatus"');
  expect(html).toContain('aria-controls="problemsPanel"');
  expect(js).toContain('elements.doctorStatus.addEventListener("click", () => {');
  expect(js).toContain("closeMobileOverflow();");
  expect(js).toContain('elements.doctorStatus.setAttribute("aria-expanded", String(details.open))');
  expect(js).toContain('check.id === "launchpad.personalspace" && check.status === "fail"');
  expect(js).toContain("rawPersonalFailures.length > 0 || hasPersonalspaceDoctorFailure");
  expect(css).toContain(".status-pill:not(:disabled)");
  expect(css).toContain(".problems-list");
  expect(css).toContain(".problems-panel.is-danger");

  // Endpoints / paths / packages / raw JSON live behind a collapsed
  // "Technické detaily" drawer, not on the default detail view.
  expect(js).toContain("function renderDetailTech");
  expect(js).toContain('"detail-tech"');
  expect(js).toContain("Technické detaily");
  expect(css).toContain(".detail-tech");

  // The default detail view renders only identity, status and the next action.
  const detailRender = js.slice(js.indexOf("function renderDetail("), js.indexOf("function renderDetailTech"));
  expect(detailRender).toContain("renderDetailHeader");
  expect(detailRender).toContain("renderDetailStatus");
  expect(detailRender).toContain("renderDetailNextAction");
  expect(detailRender).not.toContain("renderDetailEndpoint");
  expect(detailRender).not.toContain("renderDetailPaths");
});

test("Launchpad quiet refresh is lightweight and non-overlapping", async () => {
  const js = await readFile(join(publicRoot, "app.js"), "utf8");
  const loadDataBlock = js.slice(
    js.indexOf("async function loadData"),
    js.indexOf("async function fetchJson"),
  );

  expect(js).toContain("let loadDataInFlight = null;");
  expect(loadDataBlock).toContain("if (loadDataInFlight) return loadDataInFlight;");
  expect(loadDataBlock).toContain("runLoadData({ quiet })");
  expect(loadDataBlock).toContain("quiet");
  expect(loadDataBlock).toContain('fetchJson("/api/apps")');
  expect(loadDataBlock).toContain('Promise.resolve(null)');
  expect(loadDataBlock).toContain('fetchJson("/api/sync", { method: "POST" })');
  expect(loadDataBlock).toContain('fetchJson("/api/doctor")');
  expect(loadDataBlock).toContain("if (doctorResponse) {");
  expect(loadDataBlock).toContain('state.doctorRunState = "complete"');
  expect(loadDataBlock).toContain("if (!state.loaded)");
  expect(loadDataBlock).toContain("if (!quiet || !state.doctor)");
  expect(loadDataBlock).not.toContain("state.companies = [];\n    state.failures");
  expect(js).toContain("function pollingWindowIsActive");
  expect(js).toContain("!document.hidden && document.hasFocus()");
  expect(js).toContain('document.addEventListener("visibilitychange", syncQuietPolling)');
  expect(js).toContain('window.addEventListener("blur", stopQuietPolling)');
  expect(js).toContain("ACTIVE_POLL_INTERVAL_MS = 15_000");
  expect(js).not.toContain("setInterval(() => loadData");
  expect(js).toContain("fetchJsonSafe(`/api/git/repos${companyQuery}`)");
  expect(js).toContain("function gitFreshnessLabel");
  expect(js).toContain('["Vzdálená verze", gitFreshnessLabel(git.freshness)]');
});

test("Launchpad icon registry is initialized before the first async data render", async () => {
  const js = await readFile(join(publicRoot, "app.js"), "utf8");

  expect(js.indexOf("const APP_ICON_STYLES")).toBeGreaterThanOrEqual(0);
  expect(js.indexOf("const APP_ICON_PATHS")).toBeGreaterThanOrEqual(0);
  expect(js.indexOf("renderSkeleton();")).toBeGreaterThan(js.indexOf("const APP_ICON_STYLES"));
  expect(js.indexOf("await loadData();")).toBeGreaterThan(js.indexOf("const APP_ICON_PATHS"));
});

test("Version families render as one card with a default version and a more-menu", async () => {
  const [js, css] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  // Grid groups apps into version families instead of one card per build.
  expect(js).toContain("groupAppFamilies");
  expect(js).toContain("function versionMenuNode");
  expect(js).toContain("function versionOptionNode");
  expect(js).toContain("app-version-menu");
  expect(js).toContain("app-version-badge");
  expect(css).toContain(".app-version-menu");
  expect(css).toContain(".app-version-badge");
  expect(css).toContain(".app-version-option");
});

test("CAC-0044: karty jsou celé klikatelné a spouští one-click open s guardem", async () => {
  const [html, js, css] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  // Guard na vnitřní ovládací prvky + one-click open chain (port GEN2).
  expect(js).toContain("function shouldOpenFromCardSurface");
  expect(js).toContain('target.closest("button, a, summary, details, input, select, textarea")');
  expect(js).toContain("function openAppChain");
  expect(js).toContain("/open");
  // Rezervace tabu před akcí + průběh + klasifikace chyb.
  expect(js).toContain("function reserveResultTab");
  expect(js).toContain('window.open("about:blank"');
  expect(js).toContain("function writeReservedTabStatus");
  expect(js).toContain("function waitForOpenRuntime");
  expect(js).toContain('payload.status === "starting"');
  expect(js).toContain("Launchpad nedostal URL běžící aplikace");
  expect(js).toContain(`/health`);
  expect(js).toContain("function classifyOpenError");
  expect(js).toContain("Aplikace startuje moc dlouho");
  expect(js).toContain("EADDRINUSE");
  expect(js).toContain("function writeCardProgress");
  // Karta čte popis a ikonu z manifestu s fallbacky.
  expect(js).toContain("function appDescription");
  expect(js).toContain("app.icon");
  // Žádný org-specific hardcode z GEN2 se nepřenesl.
  expect(js).not.toContain("APP_COPY");
  expect(js).not.toContain("QUICK_APP_IDS");
  expect(js).not.toContain("APP_GROUPS");
  expect(css).toContain(".card-feedback");
  expect(css).toContain(".app-open-cue");
});

test("CAC-0044: pravé panely Poslední změny + Nejčastější a git chip", async () => {
  const [html, js, css] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  // Panel mounty a modal.
  expect(html).toContain('id="recentModules"');
  expect(html).toContain('id="recentChangesSidebar"');
  expect(html).toContain('id="mostUsed"');
  expect(html).toContain('id="recentModuleModal"');
  // Render funkce + data loading.
  expect(js).toContain("function renderRecentModules");
  expect(js).toContain("function renderMostUsed");
  expect(js).toContain("function openRecentModuleModal");
  expect(js).toContain("/api/recent-changes");
  expect(js).toContain("/api/most-used");
  // Nejčastější má cold-start fallback.
  expect(js).toContain("function coldStartMostUsed");
  // Git read model se čte graceful a kontrolní toggle zahrne git stavy.
  expect(js).toContain("/api/git/repos");
  expect(js).toContain("function annotateGitAttention");
  expect(js).toContain("git_attention");
  expect(css).toContain(".side-panel");
  expect(css).toContain(".recent-changes-sidebar");
  expect(css).toContain("grid-template-columns: minmax(0, 1fr) minmax(250px, 300px)");
  expect(css).toContain(".recent-module-item");
  expect(css).toContain(".quick-app");
  expect(js).toContain('elements.recentChangesSidebar.classList.toggle("hidden", personal)');
});

test("CAC-0044: git stavy mají lidský text a vstupují do kontrolního togglu", async () => {
  const [copy, appState] = await Promise.all([
    readFile(join(publicRoot, "git-status-copy.js"), "utf8"),
    readFile(join(publicRoot, "app-state.js"), "utf8"),
  ]);

  // Lidské texty portované 1:1 z GEN2 Kontroly.
  expect(copy).toContain("Někdo mezitím poslal novější verzi. Můžeš ji bezpečně stáhnout.");
  expect(copy).toContain("Tady je rozepsaná práce. Můžeš si zobrazit, co se změnilo.");
  expect(copy).toContain("export function gitChipModel");
  expect(copy).toContain("export function isGitAttentionStatus");
  // Graceful absence: bez git dat vrací null.
  expect(copy).toContain("if (!gitRepo || typeof gitRepo.status !== \"string\") return null;");
  // Kontrolní toggle zahrnuje git stavy přes anotaci git_attention.
  expect(appState).toContain("app.git_attention === true");
});

test("CAC-0044: step-005 aktivuje Ukázat změny a guarded Stáhnout novější verzi", async () => {
  const [js, css] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  expect(js).toContain("function renderGitBuilderActions");
  expect(js).toContain("Ukázat změny");
  expect(js).toContain("Stáhnout novější verzi");
  expect(js).toContain("function showRepoChanges");
  expect(js).toContain("function pullLatestRepoVersion");
  expect(js).toContain("/changes");
  expect(js).toContain("/pull");
  expect(js).toContain("git.status === \"pull_available\"");
  expect(js).toContain("state.gitChangesByRepo");
  expect(css).toContain(".git-builder-actions");
  expect(css).toContain(".git-change-list");
  expect(css).toContain(".toast.is-success");
  expect(css).toContain(".toast.is-error");
});

test("Launchpad nabízí Organization root stav, autostash pull a jeden globální Pullnout vše", async () => {
  const [html, js, css] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  expect(html).toContain('id="organizationGitStatus"');
  expect(html).toContain('id="pullAllButton"');
  expect(html).toContain("Pullnout vše");
  expect(js).toContain("function renderOrganizationGitStatus");
  expect(js).toContain('state.gitReposByModule.get(`${organization}::root`)');
  expect(js).toContain("function canAutostashPull");
  expect(js).toContain("Stáhnout a zachovat změny");
  expect(js).toContain('autostash ? "pull-autostash" : "pull"');
  expect(js).toContain("function pullAllRepositories");
  expect(js).toContain('fetchJson("/api/git/pull-all", { method: "POST" })');
  expect(css).toContain(".organization-git-card");
  expect(css).toContain(".bulk-pull-summary");
});

test("CAC-0042: detail panel vysvětluje Mission Control ownership worktrees", async () => {
  const [js, css] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  expect(js).toContain("function renderDetailMissionControlOwnership");
  expect(js).toContain("Mission Control ownership");
  expect(js).toContain("Owned by");
  expect(js).toContain("Orphan worktree");
  expect(js).toContain("Pokračovat v plánu");
  expect(js).toContain("Přiřadit Mission Control plán");
  expect(css).toContain(".worktree-list");
  expect(css).toContain(".worktree-item");
  expect(css).toContain(".worktree-item.is-orphan");
});

test("CAC-0042: detail umí zvolit main/worktree runtime source a posílá ho do runtime API", async () => {
  const [js, css] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  expect(js).toContain("runtimeSourcesByApp");
  expect(js).toContain("function renderRuntimeSourceChooser");
  expect(js).toContain("function selectedRuntimeSourceForApp");
  expect(js).toContain("function sourcePayloadForApp");
  expect(js).toContain("WORKTREE ·");
  expect(js).toContain("DEV z worktree");
  expect(js).toContain("JSON.stringify({ source: sourcePayloadForApp(app) })");
  expect(js).toContain('headers: { "content-type": "application/json" }');
  expect(css).toContain(".runtime-source-chooser");
  expect(css).toContain(".runtime-source-option");
  expect(css).toContain(".runtime-source-badge");
});

test("CAC-0042: detail nabízí guarded worktree create a publish assistant jako explicitní builder akce", async () => {
  const [js, css] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  expect(js).toContain("function renderWorktreeBuilderActions");
  expect(js).toContain("Guarded worktree create");
  expect(js).toContain("Publish draft");
  expect(js).toContain("function createWorktreeForPlan");
  expect(js).toContain("function publishSelectedWorktreeDraft");
  expect(js).toContain("/worktrees/create");
  expect(js).toContain("/publish");
  expect(js).toContain("commitMessage");
  expect(js).toContain("payload?.message");
  expect(js).toContain("PR krok je oddělený");
  expect(css).toContain(".worktree-builder-actions");
  expect(css).toContain(".builder-action-card");
});

test("scroll targets clear the sticky topbar (offset-aware, no under-topbar landing)", async () => {
  const [css, js] = await Promise.all([
    readFile(join(publicRoot, "styles.css"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
  ]);

  // A single sticky-topbar offset token drives every in-page scroll target so a
  // smooth-scrolled panel lands below the sticky .topbar, not underneath it.
  expect(css).toContain("--topbar-h");
  expect(css).toContain("--scroll-offset");
  expect(css).toContain("scroll-margin-top: var(--scroll-offset)");

  // Every hero-CTA / in-page scroll destination carries the offset. These are
  // exactly the elements runHeroAction and the panels scroll into view.
  const scrollRule = css.slice(
    css.indexOf("#appsGrid,"),
    css.indexOf("scroll-margin-top: var(--scroll-offset)") + 40,
  );
  for (const id of ["#appsGrid", "#problemsPanel", "#actionPanel", "#appDetail"]) {
    expect(scrollRule).toContain(id);
  }

  // The offset is measured from the real topbar at runtime (not a magic pixel
  // constant frozen in JS), so it stays correct when the bar reflows.
  expect(js).toContain("function measureTopbar");
  expect(js).toContain("--topbar-h");
  expect(js).toContain('.topbar?.getBoundingClientRect().height');
  // And it is wired before any scroll can happen + kept in sync on resize.
  expect(js).toContain("initScrollOffset()");
  expect(js).toContain('window.addEventListener("resize", measureTopbar');

  // The hero CTA still scrolls the problems panel / grid into view (the action
  // this fix protects). scrollIntoView + the offset together are the contract.
  expect(js).toContain("scrollIntoView({ behavior: \"smooth\", block: \"start\" })");
});

test("mobilní toolbar drží search kompaktní a sekundární panely přesouvá do sheetu", async () => {
  const [html, css, js] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
  ]);

  expect(html).toContain('id="topbarOverflow"');
  expect(html).toContain('class="topbar-overflow-menu"');
  expect(css).toContain("flex: 0 0 46px");
  expect(css).toContain("min-height: 46px");
  expect(css).toContain(".detail-drawer.is-bottom-sheet");
  expect(css).toContain("transform: translateY(102%)");
  expect(js).toContain('const mobilePanelQuery = window.matchMedia("(max-width: 900px)")');
  expect(js).toContain('const mobileTopbarQuery = window.matchMedia("(max-width: 900px)")');
  expect(js).toContain("elements.drawerBody?.prepend(elements.recentChangesSidebar)");
  expect(js).toContain("elements.layout?.insertBefore(elements.recentChangesSidebar, elements.drawerBackdrop)");
  expect(js).toContain("const restoreFocus = overflow.contains(document.activeElement)");
  expect(js).toContain('const toggle = overflow.querySelector("summary")');
  expect(js).toContain("if (toggle instanceof HTMLElement) toggle.focus()");
  expect(js).toContain("function trapDrawerFocus");
  expect(js).toContain("function restoreDrawerFocus");
  expect(js).toContain("target?.isConnected ? target : fallback");
  expect(js).toContain('toggleAttribute("inert", !open)');
  expect(html).toContain('aria-modal="false" tabindex="-1" inert');
});

test("UI is prepared for multiple workspaces and read-only productionspace", async () => {
  const [js, css, diag] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
    readFile(join(import.meta.dirname, "diagnostics-lib.mjs"), "utf8"),
  ]);

  // Apps are grouped by workspace; manifest-only modules are still visible even
  // when they do not have a Launchpad app manifest yet; productionspace renders
  // as a distinct, read-only section (never a lifecycle app).
  expect(js).toContain("groupFamiliesByWorkspace");
  expect(js).toContain("function workspaceSectionNode");
  expect(js).toContain('appSectionHead(null, workspaceLabel(company, section.workspace)');
  expect(js).toContain("titleRow.append(metaNode)");
  const titleRowCss = css.slice(
    css.indexOf(".app-section-title-row {"),
    css.indexOf("}", css.indexOf(".app-section-title-row {")) + 1,
  );
  const sectionMetaCss = css.slice(
    css.indexOf(".app-section-meta {"),
    css.indexOf("}", css.indexOf(".app-section-meta {")) + 1,
  );
  expect(titleRowCss).toContain("flex-wrap: wrap");
  expect(sectionMetaCss).toContain("white-space: normal");
  expect(js).toContain("function workspaceModuleCard");
  expect(js).toContain("function workspaceModulesInView");
  expect(js).toContain("Otevřít složku");
  expect(js).toContain("function openWorkspaceModuleFolder");
  expect(js).toContain('fetchJson("/api/modules/open-folder"');
  expect(js).toContain("function productionspaceSectionNode");
  expect(js).toContain("function productionspaceCard");
  expect(js).toContain("Jen pro čtení");
  expect(css).toContain(".app-section-productionspace");
  expect(css).toContain(".system-card");
  const systemCardCss = css.slice(
    css.indexOf(".system-card {"),
    css.indexOf("}", css.indexOf(".system-card {")) + 1,
  );
  expect(systemCardCss).toContain("align-self: start");

  // Discovery is additively enriched: per-app workspace + per-org module slots + productionspace.
  // Decision 0041: workspace grouping jede z manifest deklarací, ne z cesty.
  expect(diag).toContain("readOrganizationSpaces");
  expect(diag).toContain("readOrganizationModuleManifest");
  expect(diag).toContain("workspaceResolverForOrganization");
  expect(diag).not.toContain("deriveWorkspaceSlug");
  expect(diag).toContain("workspace:");
});

test("manifest-only module cards keep semantic icon precedence over a broad category", async () => {
  const js = await readFile(join(publicRoot, "app.js"), "utf8");
  const detailBlock = js.slice(
    js.indexOf("function workspaceModuleDetail"),
    js.indexOf("function workspaceModuleCard"),
  );
  const cardBlock = js.slice(
    js.indexOf("function workspaceModuleCard"),
    js.indexOf("// Productionspace systems"),
  );

  expect(detailBlock).toContain("icon: null");
  expect(detailBlock).toContain("tags: module.category ? [module.category] : []");
  expect(cardBlock).toContain("appIconNode(detail)");
  expect(cardBlock).not.toContain('appIconSvg("module")');
  expect(cardBlock).toContain('desc.className = "app-card-desc"');
  expect(cardBlock).toContain("appDescription(detail)");
  expect(cardBlock).not.toContain('badges.append(chip("Workspace modul"');
  expect(cardBlock).not.toContain('path.className = "app-card-endpoint"');
});

test("read-only app and system detail selection opens the right drawer", async () => {
  const js = await readFile(join(publicRoot, "app.js"), "utf8");

  // Drawer opening is explicit on user detail selection, not only a side effect
  // of selectedAppId changing during render. This covers repeated clicks on the
  // same read-only detail card after the drawer was manually closed.
  const selectAppDetail = js.slice(js.indexOf("function selectAppDetail"), js.indexOf("function selectReadonlyDetail"));
  expect(selectAppDetail).toContain("setDrawer(true)");
  expect(selectAppDetail).toContain("render()");

  const selectReadonlyDetail = js.slice(js.indexOf("function selectReadonlyDetail"), js.indexOf("// Close an open version menu"));
  expect(selectReadonlyDetail).toContain("selectedReadonlyDetail");
  expect(selectReadonlyDetail).toContain("setDrawer(true)");

  // Standard read-only app cards route through the same helper, so production
  // app cards and disabled workspace cards reopen the drawer even when the
  // selection id was already active.
  const appCard = js.slice(js.indexOf("function appCard"), js.indexOf("function cardWarningModel"));
  expect(appCard).toContain("selectAppDetail(app.id)");

  // Manifest-only workspace modules and productionspace systems are not normal
  // app records, so they use a synthetic read-only detail model and still open
  // the drawer from the card surface.
  const workspaceModuleCard = js.slice(js.indexOf("function workspaceModuleCard"), js.indexOf("// Productionspace systems"));
  expect(workspaceModuleCard).toContain("workspaceModuleDetail");
  expect(workspaceModuleCard).toContain("selectReadonlyDetail(detail)");
  expect(workspaceModuleCard).toContain("openWorkspaceModuleFolder(detail)");
  const productionspaceCard = js.slice(js.indexOf("function productionspaceCard"), js.indexOf("function productionspaceDetail"));
  expect(productionspaceCard).toContain("productionspaceDetail");
  expect(productionspaceCard).toContain("selectReadonlyDetail(detail)");

  const detailRender = js.slice(js.indexOf("function renderDetail("), js.indexOf("function renderDetailTech"));
  expect(detailRender).toContain("state.selectedReadonlyDetail ??");
  expect(js).toContain("app.is_readonly_system");
});

test("Runtime stages (founder 2026-07-15/16): karta nabízí čtyři runy jednoho modulu pod dlaždicí", async () => {
  const [js, css, appState] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
    readFile(join(publicRoot, "app-state.js"), "utf8"),
  ]);

  // Pure model rozhoduje, které runy karta nabízí; app.js jen renderuje.
  expect(appState).toContain("export function runtimeStagesForApp");
  expect(appState).toContain("export function productionUrl");
  expect(js).toContain("runtimeStagesForApp");

  // Progressive disclosure (founder 2026-07-16): pure predikát rozhodne, jestli
  // modul nabízí víc než výchozí DEV local; jinak se řádek vůbec nevykreslí —
  // modul BEZ production_url nemá v kartě žádný .runtime-stages, modul S ním
  // dostane plný čtyřpilulkový řádek.
  expect(appState).toContain("export function offersMoreThanLocalRun");
  expect(js).toContain("if (!offersMoreThanLocalRun(app)) return null");
  expect(js).toContain("const stagesRow = renderRuntimeStages(app, readOnly, feedback)");
  expect(js).toContain("if (stagesRow) card.append(stagesRow)");

  // Řádek se vykresluje POD kartou (mezi warning panelem a feedbackem), ne jako
  // nový panel. Refactor 2026-07-16: JEDEN kompaktní řádek pilulek, ne 2×2 grid.
  expect(js).toContain("function renderRuntimeStages");
  expect(js).toContain("function runtimeStageNode");
  expect(js).toContain('row.className = "runtime-stages"');
  expect(js).toContain('row.setAttribute("aria-label", "Kde modul spustit")');

  // Pilulka nese JEN label; caption i reason žijí v tooltipu (title) + aria-label.
  expect(js).toContain("link.textContent = stage.label");
  expect(js).toContain("button.textContent = stage.label");
  expect(js).toContain("chip.textContent = stage.label");
  expect(js).toContain("function runtimeStageTooltip");
  expect(js).toContain("function runtimeStageAriaLabel");
  expect(js).toContain("link.setAttribute(\"aria-label\", ariaLabel)");
  expect(js).toContain("chip.setAttribute(\"aria-label\", ariaLabel)");
  // Aria-label kombinuje label a důvod ve stylu „MAIN — <důvod>".
  expect(js).toContain("`${stage.label} — ${stage.reason || stage.caption}`");
  // Žádný viditelný odstavec s důvodem už na kartě není.
  expect(js).not.toContain('reason.className = "runtime-stage-reason"');

  // PROD = skutečný odkaz do nové karty, když existuje production_url; klik nesmí
  // probublat do one-click open dlaždice.
  expect(js).toContain('stage.action === "open_url"');
  expect(js).toContain('link.target = "_blank"');
  expect(js).toContain('link.rel = "noreferrer"');
  expect(js).toContain("link.addEventListener(\"click\", (event) => event.stopPropagation())");

  // DEV local znovu používá stejný one-click open (openAppChain), ne druhý běh.
  expect(js).toContain('stage.action === "open_local"');
  expect(js).toContain("void openAppChain(app, { feedback })");

  // Disabled runy (MAIN, DEV remote, nedostupný PROD/DEV local) jsou dimmed
  // pilulky s aria-disabled a důvodem v tooltipu — žádné mrtvé tlačítko.
  expect(js).toContain('chip.setAttribute("aria-disabled", "true")');
  expect(js).toContain("chip.title = tooltip");

  // Model drží honest stavy: PROD stub, tailnet MAIN/DEV remote, jargon-free copy.
  expect(appState).toContain("Produkce zatím není nasazená");
  expect(appState).toContain("Přes tailnet");
  expect(appState).not.toContain("worktree —");

  // CSS: kompaktní pilulkový řádek (flex-wrap), stavové hooky přežily.
  expect(css).toContain(".runtime-stages");
  expect(css).toContain("flex-wrap: wrap");
  expect(css).toContain(".runtime-stage.is-disabled");
  expect(css).toContain(".runtime-stage.is-available");
});

test("Owner 2026-07-05: karta modulu je GEN2-minimal dlaždice bez velkých tlačítek a trvalých chipů", async () => {
  const [js, css] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  // Celá karta se otevírá klikem (one-click open zůstává); už žádné trvalé
  // velké „Spustit a otevřít" tlačítko ani sekundární ghost akce na kartě.
  expect(js).toContain("function openAppChain");
  expect(js).not.toContain("btn btn-primary primary-action");
  expect(js).not.toContain("function secondaryActionNodes");
  expect(js).not.toContain("function ghostButton");

  // Žádné trvalé statusové chipy: běžící stav přidá jediný chip a jen když modul
  // opravdu běží. Ostatní stavy jdou do warning panelu / detailu.
  expect(js).toContain("const running = app.runtime_status === \"healthy\";");
  expect(js).toContain("if (running) {");

  // Sofistikovaný warning panel se ukáže, jen když je co řešit (null jinak).
  expect(js).toContain("function cardWarningModel");
  expect(js).toContain("function cardWarningNode");
  expect(js).toContain("if (warning) card.append(cardWarningNode(app, warning))");
  expect(js).toContain("appCardTone(app, warning)");
  // Dvě přímé akce warning panelu: nainstalovat/opravit balíčky a stáhnout novější verzi.
  expect(js).toContain("runRuntimeAction(app, installAction(app))");
  expect(js).toContain("pullLatestRepoVersion(app, gitRepo)");
  expect(js).toContain("pull_available");

  // „Další možnosti" (varianty + zastavit/restart + detail/logy) žijí pod ⋯,
  // které se ukáže jen když má obsah.
  expect(js).toContain("function cardHasMenu");
  expect(js).toContain("function cardMenuActions");
  expect(js).toContain("function menuActionRow");
  expect(js).toContain("function revealAppDetail");
  expect(js).toContain("cardHasMenu(app, others)");
  expect(js).toContain("Zobrazit detail a logy");
  const canStop = js.slice(js.indexOf("function canStop"), js.indexOf("function canRestart"));
  expect(canStop).toContain('\"current-instance\", \"adopted-port\"');
  expect(canStop).toContain("Number.isInteger(app.runtime?.pid)");

  // Multi-org „Vše" pohled si drží nenápadnou org značku na kartě (kontext se
  // neztratí, když dvě Organizace sdílí default workspace slug).
  expect(js).toContain("function shouldShowCardOrg");
  expect(js).toContain("state.filters.company === \"all\" && state.companies.length > 1");
  expect(css).toContain(".app-card-org");

  // Warning panel + menu akce mají vlastní CSS.
  expect(css).toContain(".card-warning");
  expect(css).toContain(".card-warning.is-warn");
  expect(css).toContain(".card-warning.is-danger");
  expect(css).toContain(".card-warning-action");
  expect(css).toContain(".app-menu-action");
  expect(css).toContain(".app-menu-divider");
});

test("Launchpad používá jednotný kompaktní modulový grid bez stínů", async () => {
  const [js, css] = await Promise.all([
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
  expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
  expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  expect(css).toContain("min-height: 148px");
  expect(css).toContain("width: 2.6rem");
  expect(css).toContain("border: 1px solid transparent");
  expect(css).toContain("font-weight: 400");
  expect(css).toContain("outline: 3px solid var(--accent-soft)");
  expect(css).toContain("color-mix(in srgb, var(--accent) 58%, var(--line))");
  expect(css).toContain(".app-card.selected:focus-visible");
  expect(js).toContain("APP_DESCRIPTION_FALLBACKS");
  expect(js).toContain("Procesy, automatizace a koordinace každodenní práce.");
  expect(js).toContain('["manual", "admin", "productionspace", "public-preview"].includes(app.surface)');
  expect(js).toContain("return surface ? `${surface} · ${purpose}` : purpose");
  expect(js).toContain("if (orgLabel && shouldShowCardOrg())");
  expect(css).not.toContain("box-shadow");
  expect(css).not.toContain("text-shadow");
  expect(css).not.toContain("drop-shadow");
  expect(css).not.toContain("--shadow-");
});

test("Organization workspace má kompaktní uvítání s dynamickým názvem firmy", async () => {
  const [html, js, css] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  expect(html).toContain('id="workspaceWelcome"');
  expect(html.indexOf('id="workspaceWelcome"')).toBeLessThan(html.indexOf('id="appsToolbar"'));
  expect(html).toContain("Vyberte aplikaci a pokračujte tam, kde potřebujete.");
  expect(js).toContain("function renderWorkspaceWelcome");
  expect(js).toContain("`Vítejte v pracovním prostoru ${organizationName}`");
  expect(js).toContain('toggleAttribute("hidden", personal)');
  expect(css).toContain(".workspace-welcome-title");
  expect(css).toContain("font-size: 1.3rem");
  expect(css).toContain("font-weight: 720");
});

test("app icon constants initialize before the first data load render", async () => {
  const js = await readFile(join(publicRoot, "app.js"), "utf8");

  const firstDataLoad = js.indexOf("\nawait loadData();");
  expect(firstDataLoad).toBeGreaterThan(-1);
  expect(js.indexOf("const APP_ICON_STYLES")).toBeLessThan(firstDataLoad);
  expect(js.indexOf("const APP_ICON_PATHS")).toBeLessThan(firstDataLoad);
  expect(js.indexOf("const APP_DESCRIPTION_FALLBACKS")).toBeLessThan(firstDataLoad);
});
