import {
  appBaseTitle,
  appVersionLabel,
  computeSpaceHeroState,
  familyTitle,
  filterApps,
  groupAppFamilies,
  groupFamiliesByWorkspace,
  isAttentionState,
  offersMoreThanLocalRun,
  replacePersonalspaceResponse,
  reconcileSelectedAppId,
  runtimeStagesForApp,
  summarizeOrganizationSpaceHealth,
  variantMenuLabel,
  variantTag,
} from "./app-state.js";
import { gitChipModel } from "./git-status-copy.js";
import { semanticAppIconKey } from "./app-icon-key.js";
// Personalspace (CAC-0048) je samostatný privátní povrch v odděleném modulu —
// čte jen z lokálního /api/personalspace, nikdy se nemíchá do org discovery ani
// filtrů aplikací. Renderuje se jako vlastní vizuálně odlišená sekce v hlavní
// ploše (nahoře, nad workspace/productionspace); layout se mění, datová izolace
// (oddělená lane + Private badge) zůstává.
import { initPersonalspace, renderPersonalspace } from "./personalspace.js";

const state = {
  apps: [],
  companies: [],
  failures: [],
  warnings: [],
  personalspace: null,
  personalspaceError: null,
  doctor: null,
  doctorRunState: "idle",
  selectedAppId: null,
  selectedLogs: null,
  selectedReadonlyDetail: null,
  actionMessage: null,
  pendingAction: null,
  updateStatus: null,
  updatePending: false,
  openVersionMenu: null,
  // CAC-0044: per-modul poslední změny + lokální usage tracking + git read model.
  recentModules: [],
  mostUsed: [],
  coldStartUsage: true,
  // Git read model (CAC-0042): mapa repo_key → repo. Prázdné = graceful
  // absence, git chip se nevykreslí.
  gitReposByModule: new Map(),
  gitChangesByRepo: new Map(),
  bulkPullResult: null,
  runtimeSourcesByApp: new Map(),
  openingApps: new Set(),
  // Diagnostický detail není součást denního surface. Uživatel si jej odhalí
  // explicitně z agregovaného hero banneru.
  problemsRequested: false,
  problemsExpanded: false,
  loaded: false,
  spaceMenuOpen: false,
  suppressNextDrawerOpen: false,
  // Poslední změny žijí v trvalém pravém panelu Organization scope. Nejčastější
  // a detail zůstávají ve skládacím draweru, který detail appky otevře automaticky.
  drawerOpen: false,
  drawerView: "overview",
  filters: {
    // Scope selector vždy ukazuje právě jeden prostor: personalspace nebo
    // konkrétní Organizaci. Cross-organization pohled „Vše" není v denním UI.
    scope: "org",
    company: "all",
    surface: "all",
    tag: "all",
    status: "all",
    attentionOnly: false,
    query: "",
  },
};

// Where the hero CTA should jump. Updated on every renderHero so the single
// click handler stays in sync with the computed verdict.
let heroAction = "reload";
let loadDataInFlight = null;
let quietPollTimer = null;
let restoreSpaceMenuFocusOnClose = false;
let drawerReturnFocus = null;
let organizationThemeRenderKey = null;

// Appearance is split into two independent axes so a future settings panel can
// drive both dynamically: `mode` (light/dark via data-theme) and `accent`
// (a named colour preset via data-accent — see the accent presets in styles.css).
// Components never hardcode colours; they read CSS variables that follow these.
// Declared up here because initTheme() runs during module init, before the
// theme section below would otherwise initialise these consts.
const THEME_STORAGE = { mode: "launchpad-theme", accent: "launchpad-accent" };
const ACCENT_PRESETS = ["default", "emerald", "amber", "rose", "slate"];
const ORGANIZATION_THEME_TOKENS = new Set([
  "--bg", "--bg-elevated", "--bg-subtle", "--bg-muted", "--surface", "--surface-console",
  "--text", "--text-muted", "--text-subtle", "--line", "--line-strong", "--accent",
  "--accent-soft", "--accent-ring", "--shadow-sm", "--shadow-md", "--shadow-lg",
  "--shadow-hover", "--r-sm", "--r-md", "--r-lg", "--r-pill", "--font-body",
  "--font-heading", "--font-mono", "--c-accent-200", "--c-accent-400", "--c-accent-500",
  "--c-accent-700", "--c-accent-800", "--c-accent-900", "--launchpad-body-background",
]);
const OPEN_STARTING_WAIT_MS = 120_000;
const OPEN_STARTING_POLL_MS = 1_500;
const ACTIVE_POLL_INTERVAL_MS = 15_000;
const mobilePanelQuery = window.matchMedia("(max-width: 900px)");
const mobileTopbarQuery = window.matchMedia("(max-width: 900px)");
const APP_ICON_STYLES = {
  control: { color: "#3730a3", background: "#e0e7ff", border: "#c7d2fe" },
  book: { color: "#0e7490", background: "#cffafe", border: "#a5f3fc" },
  pen: { color: "#9a3412", background: "#ffedd5", border: "#fed7aa" },
  palette: { color: "#a21caf", background: "#fae8ff", border: "#f5d0fe" },
  deal: { color: "#c2410c", background: "#ffedd5", border: "#fdba74" },
  warehouse: { color: "#166534", background: "#dcfce7", border: "#86efac" },
  product: { color: "#047857", background: "#d1fae5", border: "#6ee7b7" },
  datasheet: { color: "#1d4ed8", background: "#dbeafe", border: "#93c5fd" },
  pricebook: { color: "#a16207", background: "#fef3c7", border: "#fcd34d" },
  invoice: { color: "#7e22ce", background: "#f3e8ff", border: "#d8b4fe" },
  installation: { color: "#0f766e", background: "#ccfbf1", border: "#5eead4" },
  dashboard: { color: "#4f46e5", background: "#e0e7ff", border: "#a5b4fc" },
  profitability: { color: "#4d7c0f", background: "#ecfccb", border: "#bef264" },
  marketing: { color: "#be185d", background: "#fce7f3", border: "#f9a8d4" },
  website: { color: "#0369a1", background: "#e0f2fe", border: "#7dd3fc" },
  examples: { color: "#475569", background: "#f1f5f9", border: "#cbd5e1" },
  database: { color: "#1d4ed8", background: "#dbeafe", border: "#bfdbfe" },
  system: { color: "#9a5b00", background: "#fef3c7", border: "#fde68a" },
  app: { color: "#5f5147", background: "#eadfd2", border: "#d3c0ad" },
};

// Org-agnostic lidské fallbacky drží karty čitelné i ve firmě, která ještě
// nedoplnila prezentační metadata. Manifest zůstává autorita a vždy vyhrává.
const APP_DESCRIPTION_FALLBACKS = Object.freeze({
  control: "Procesy, automatizace a koordinace každodenní práce.",
  book: "Dokumentace, návody a sdílené znalosti.",
  pen: "Tvorba, správa a publikace obsahu.",
  palette: "Vizuální systém, značka a sdílené komponenty.",
  deal: "Obchodní případy, nabídky a práce se zákazníky.",
  warehouse: "Skladové položky, zásoby a pohyby materiálu.",
  product: "Produktový katalog, parametry a podklady.",
  datasheet: "Strukturovaná data a technické podklady.",
  pricebook: "Ceníky, sazby a obchodní podklady.",
  invoice: "Faktury, odběratelé a evidence úhrad.",
  installation: "Realizace u zákazníků a návazná projektová práce.",
  dashboard: "Přehled firmy, výsledků a důležitých ukazatelů.",
  profitability: "Marže, náklady a finanční zdraví zakázek.",
  marketing: "Marketingové aktivity, kampaně a podklady.",
  website: "Webový obsah, stránky a veřejná prezentace.",
  examples: "Ukázky, vzory a referenční řešení.",
  database: "Data, záznamy a jejich bezpečná správa.",
  app: "Pracovní podklady a soubory tohoto modulu.",
  system: "Provozní nástroje a technická infrastruktura.",
});

const APP_ICON_PATHS = {
  control:
    '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  book:
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  pen:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  palette:
    '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.5-1.1-.3-.3-.5-.7-.5-1.1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.4-4.5-8-10-8Z"/>',
  deal:
    '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/><path d="M10 12v2h4v-2"/>',
  warehouse:
    '<path d="M3 21V8l9-5 9 5v13"/><path d="M3 10h18"/><path d="M8 21v-6h8v6"/>',
  product:
    '<path d="m21 8-9 5-9-5"/><path d="m3 8 9-5 9 5v8l-9 5-9-5Z"/><path d="M12 13v8"/>',
  datasheet:
    '<path d="m21 8-9 5-9-5"/><path d="m3 8 9-5 9 5v8l-9 5-9-5Z"/><path d="M12 13v8"/>',
  pricebook:
    '<path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  invoice:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>',
  installation:
    '<path d="M14.7 6.3a4 4 0 0 0-5-5L7.5 3.5l3 3-4 4-3-3-2.2 2.2a4 4 0 0 0 5 5L14 7Z"/><path d="m12 12 8.5 8.5"/><path d="M18 19.5 19.5 18"/>',
  dashboard:
    '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  profitability:
    '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  marketing:
    '<path d="m3 11 18-5v12L3 14v-3Z"/><path d="M11.6 16.5 13 21H8l-1.3-5.7"/><path d="M21 10v4"/>',
  website:
    '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/>',
  examples:
    '<path d="m8 9-4 3 4 3"/><path d="m16 9 4 3-4 3"/><path d="m14 5-4 14"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  app:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  system:
    '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><line x1="7" y1="7" x2="7.01" y2="7"/><line x1="7" y1="17" x2="7.01" y2="17"/>',
};

const elements = {
  topbar: document.querySelector(".topbar"),
  spaceSwitcher: document.querySelector("#spaceSwitcher"),
  spaceSwitcherButton: document.querySelector("#spaceSwitcherButton"),
  spaceSwitcherMenu: document.querySelector("#spaceSwitcherMenu"),
  currentSpaceLogo: document.querySelector("#currentSpaceLogo"),
  currentSpaceLabel: document.querySelector("#currentSpaceLabel"),
  topbarOverflow: document.querySelector("#topbarOverflow"),
  runtimeRootBadge: document.querySelector("#runtimeRootBadge"),
  personalPrivacyBadge: document.querySelector("#personalPrivacyBadge"),
  doctorStatus: document.querySelector("#doctorStatus"),
  updateButton: document.querySelector("#updateButton"),
  reloadButton: document.querySelector("#reloadButton"),
  pullAllButton: document.querySelector("#pullAllButton"),
  themeToggle: document.querySelector("#themeToggle"),
  hero: document.querySelector("#hero"),
  heroTitle: document.querySelector("#heroTitle"),
  heroCta: document.querySelector("#heroCta"),
  appsToolbar: document.querySelector("#appsToolbar"),
  workspaceWelcome: document.querySelector("#workspaceWelcome"),
  workspaceWelcomeTitle: document.querySelector("#workspaceWelcomeTitle"),
  appsSearch: document.querySelector("#appsSearch"),
  attentionToggle: document.querySelector("#attentionToggle"),
  segmentedControl: document.querySelectorAll("[data-status-segment]"),
  problemsPanel: document.querySelector("#problemsPanel"),
  actionPanel: document.querySelector("#actionPanel"),
  appsGrid: document.querySelector("#appsGrid"),
  appsTable: document.querySelector("#appsTable"),
  appDetail: document.querySelector("#appDetail"),
  detailDrawer: document.querySelector("#detailDrawer"),
  drawerToggle: document.querySelector("#drawerToggle"),
  spaceHealthBadge: document.querySelector("#spaceHealthBadge"),
  drawerClose: document.querySelector("#drawerClose"),
  drawerBackdrop: document.querySelector("#drawerBackdrop"),
  drawerBody: document.querySelector(".drawer-body"),
  layout: document.querySelector(".layout"),
  recentChangesSidebar: document.querySelector("#recentChangesSidebar"),
  toastRoot: document.querySelector("#toastRoot"),
  recentModules: document.querySelector("#recentModules"),
  mostUsedPanel: document.querySelector("#mostUsedPanel"),
  organizationGitStatus: document.querySelector("#organizationGitStatus"),
  mostUsed: document.querySelector("#mostUsed"),
  recentModuleModal: document.querySelector("#recentModuleModal"),
  recentModuleTitle: document.querySelector("#recentModuleTitle"),
  recentModuleSubtitle: document.querySelector("#recentModuleSubtitle"),
  recentModuleCommits: document.querySelector("#recentModuleCommits"),
};

initTheme();
initScrollOffset();
initResponsiveChrome();
// Personalspace rail dostane most k toastům a k Synchronizovat reloadu, ať
// osobní runtime akce vypadají stejně jako firemní.
initPersonalspace({
  onToast: (message, tone, timeout) => toast(message, tone, timeout),
  onReload: () => loadData({ quiet: true }),
});

elements.reloadButton.addEventListener("click", () => {
  closeMobileOverflow();
  loadData();
});
elements.pullAllButton?.addEventListener("click", () => pullAllRepositories());
elements.updateButton?.addEventListener("click", () => runRootUpdate());
elements.heroCta.addEventListener("click", () => runHeroAction());
elements.doctorStatus.addEventListener("click", () => {
  closeMobileOverflow();
  revealProblems();
});
elements.spaceSwitcherButton.addEventListener("click", (event) => {
  event.stopPropagation();
  restoreSpaceMenuFocusOnClose = false;
  state.spaceMenuOpen = !state.spaceMenuOpen;
  applySpaceMenuState();
});
elements.appsSearch.addEventListener("input", (event) => {
  state.filters.query = event.target.value ?? "";
  render();
});
for (const segment of elements.segmentedControl) {
  segment.addEventListener("click", () => {
    state.filters.status = segment.dataset.statusSegment ?? "all";
    syncSegmentedControl();
    render();
  });
}
elements.attentionToggle?.addEventListener("click", () => {
  state.filters.attentionOnly = !state.filters.attentionOnly;
  render();
});

// Drawer doplňkových panelů (Nejčastější / detail). Poslední změny jsou v
// Organization scope trvale viditelné vedle hlavní plochy.
elements.drawerToggle?.addEventListener("click", () => {
  if (state.drawerOpen) {
    setDrawer(false);
    return;
  }
  state.drawerView = "overview";
  setDrawer(true);
  render();
});
elements.drawerClose?.addEventListener("click", () => setDrawer(false));
elements.drawerBackdrop?.addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.spaceMenuOpen) {
    restoreSpaceMenuFocusOnClose = true;
    state.spaceMenuOpen = false;
    applySpaceMenuState();
  }
  if (event.key === "Tab" && state.drawerOpen && mobilePanelQuery.matches) trapDrawerFocus(event);
  if (event.key === "Escape" && state.drawerOpen) setDrawer(false);
  if (event.key === "Escape") closeMobileOverflow();
});

document.addEventListener("click", (event) => {
  if (elements.topbarOverflow?.open && !elements.topbarOverflow.contains(event.target)) {
    closeMobileOverflow();
  }
});

function initResponsiveChrome() {
  const syncPanels = () => {
    const useSheet = mobilePanelQuery.matches;
    if (useSheet && elements.recentChangesSidebar?.parentElement !== elements.drawerBody) {
      elements.drawerBody?.prepend(elements.recentChangesSidebar);
    } else if (!useSheet && elements.recentChangesSidebar?.parentElement === elements.drawerBody) {
      elements.layout?.insertBefore(elements.recentChangesSidebar, elements.drawerBackdrop);
    }
    elements.detailDrawer?.classList.toggle("is-bottom-sheet", useSheet);
    applyDrawerState();
    if (useSheet && state.drawerOpen) focusMobileDrawer();
  };
  const syncTopbar = () => {
    if (!elements.topbarOverflow) return;
    if (mobileTopbarQuery.matches) closeMobileOverflow();
    else elements.topbarOverflow.open = true;
  };
  syncPanels();
  syncTopbar();
  mobilePanelQuery.addEventListener("change", syncPanels);
  mobileTopbarQuery.addEventListener("change", syncTopbar);
}

function closeMobileOverflow() {
  const overflow = elements.topbarOverflow;
  if (!mobileTopbarQuery.matches || !overflow?.open) return;
  const restoreFocus = overflow.contains(document.activeElement);
  overflow.open = false;
  if (restoreFocus) {
    const toggle = overflow.querySelector("summary");
    if (toggle instanceof HTMLElement) toggle.focus();
  }
}

function setDrawer(open) {
  const wasOpen = state.drawerOpen;
  if (open && !wasOpen) {
    drawerReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : elements.drawerToggle;
  }
  state.drawerOpen = open;
  applyDrawerState();
  if (open && !wasOpen && mobilePanelQuery.matches) focusMobileDrawer();
  if (!open && wasOpen) restoreDrawerFocus();
}

function drawerFocusableElements() {
  if (!elements.detailDrawer) return [];
  return [...elements.detailDrawer.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function focusMobileDrawer() {
  queueMicrotask(() => {
    const [first] = drawerFocusableElements();
    (first ?? elements.detailDrawer)?.focus();
  });
}

function trapDrawerFocus(event) {
  const focusable = drawerFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    elements.detailDrawer?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!elements.detailDrawer?.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function restoreDrawerFocus() {
  const target = drawerReturnFocus;
  drawerReturnFocus = null;
  queueMicrotask(() => {
    const fallback = elements.drawerToggle?.isConnected
      && !elements.drawerToggle.classList.contains("hidden")
      ? elements.drawerToggle
      : elements.spaceSwitcherButton;
    (target?.isConnected ? target : fallback)?.focus();
  });
}

function applyDrawerState() {
  const open = state.drawerOpen;
  elements.detailDrawer?.classList.toggle("is-open", open);
  elements.detailDrawer?.setAttribute("aria-hidden", open ? "false" : "true");
  elements.detailDrawer?.toggleAttribute("inert", !open);
  elements.drawerToggle?.setAttribute("aria-expanded", open ? "true" : "false");
  elements.drawerToggle?.classList.toggle("is-active", open);
  elements.detailDrawer?.setAttribute("aria-modal", mobilePanelQuery.matches && open ? "true" : "false");
  document.body.classList.toggle("drawer-open", mobilePanelQuery.matches && open);
  if (elements.drawerBackdrop) elements.drawerBackdrop.hidden = !open;
}

function selectAppDetail(appId) {
  state.selectedReadonlyDetail = null;
  state.selectedAppId = appId;
  state.drawerView = "detail";
  if (state.selectedLogs?.app_id !== appId) state.selectedLogs = null;
  setDrawer(true);
  render();
}

function selectReadonlyDetail(detail) {
  state.selectedReadonlyDetail = detail;
  state.selectedAppId = null;
  state.drawerView = "detail";
  state.selectedLogs = null;
  setDrawer(true);
  render();
}

// Close an open version menu when clicking anywhere outside it.
document.addEventListener("click", (event) => {
  if (state.spaceMenuOpen && !event.target.closest("#spaceSwitcher")) {
    restoreSpaceMenuFocusOnClose = false;
    state.spaceMenuOpen = false;
    applySpaceMenuState();
  }
  if (state.openVersionMenu && !event.target.closest(".app-version-menu")) {
    state.openVersionMenu = null;
    render();
  }
});

renderSkeleton();
await loadData();
// Update pill se načítá až po hlavních datech — status dělá git fetch a nesmí
// blokovat první vykreslení prostoru.
loadUpdateStatus();
initActiveWindowPolling();

/* =========================================================
   Theme + toasts
   ========================================================= */

function applyTheme({ mode, accent } = {}) {
  const root = document.documentElement;
  if (mode) {
    root.setAttribute("data-theme", mode);
    localStorage.setItem(THEME_STORAGE.mode, mode);
  }
  if (accent) {
    if (accent === "default") root.removeAttribute("data-accent");
    else root.setAttribute("data-accent", accent);
    localStorage.setItem(THEME_STORAGE.accent, accent);
  }
  applyOrganizationTheme();
}

function currentThemeMode() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function initTheme() {
  const storedMode = localStorage.getItem(THEME_STORAGE.mode);
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
  applyTheme({
    mode: storedMode || (prefersDark ? "dark" : "light"),
    accent: localStorage.getItem(THEME_STORAGE.accent) || "default",
  });

  elements.themeToggle?.addEventListener("click", () => {
    applyTheme({ mode: currentThemeMode() === "dark" ? "light" : "dark" });
  });

  // Forward-compatible hook: a future appearance/settings UI can call
  // window.LaunchpadTheme.setMode("dark") or .setAccent("emerald") to recolour
  // the whole app dynamically without touching any component CSS.
  window.LaunchpadTheme = {
    setMode: (mode) => applyTheme({ mode }),
    setAccent: (accent) => {
      if (state.filters.scope === "org") return false;
      applyTheme({ accent });
      return true;
    },
    accents: ACCENT_PRESETS,
    getState: () => ({
      mode: currentThemeMode(),
      accent: document.documentElement.getAttribute("data-accent") || "default",
      accentLockedByOrganization: state.filters.scope === "org",
    }),
  };
}

// Keep --topbar-h in sync with the real sticky topbar so every scroll target's
// scroll-margin-top (see styles.css) clears it. The CSS ships a static fallback;
// this makes the offset exact and resilient when the bar reflows (responsive
// padding, wrapping on narrow widths). Without it the hero CTA smooth-scroll
// lands the problems panel underneath the topbar.
function measureTopbar() {
  const height = elements.topbar?.getBoundingClientRect().height;
  if (height && Number.isFinite(height)) {
    document.documentElement.style.setProperty("--topbar-h", `${Math.round(height)}px`);
  }
}

function initScrollOffset() {
  measureTopbar();
  window.addEventListener("resize", measureTopbar, { passive: true });
}

function toast(message, tone = "info", timeout = 4200) {
  const root = elements.toastRoot;
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast is-${tone}`;
  node.textContent = message;
  root.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(8px)";
    node.style.transition = "all 240ms ease";
    setTimeout(() => node.remove(), 240);
  }, timeout);
}

/* =========================================================
   Data loading
   ========================================================= */

async function loadData({ quiet = false } = {}) {
  if (loadDataInFlight) return loadDataInFlight;
  loadDataInFlight = runLoadData({ quiet });
  try {
    return await loadDataInFlight;
  } finally {
    loadDataInFlight = null;
  }
}

// Polling exists only while this tab is both visible and focused. A recursive
// timeout avoids overlapping cycles and, unlike a permanent interval, creates
// no background work while the user is elsewhere. Returning to the window
// performs one immediate refresh and then resumes the normal cadence.
function initActiveWindowPolling() {
  document.addEventListener("visibilitychange", syncQuietPolling);
  window.addEventListener("focus", syncQuietPolling);
  window.addEventListener("blur", stopQuietPolling);
  scheduleQuietPoll();
}

function pollingWindowIsActive() {
  return !document.hidden && document.hasFocus();
}

function syncQuietPolling() {
  if (!pollingWindowIsActive()) {
    stopQuietPolling();
    return;
  }
  scheduleQuietPoll({ immediate: true });
}

function stopQuietPolling() {
  if (quietPollTimer !== null) clearTimeout(quietPollTimer);
  quietPollTimer = null;
}

function scheduleQuietPoll({ immediate = false } = {}) {
  stopQuietPolling();
  if (!pollingWindowIsActive()) return;
  quietPollTimer = setTimeout(async () => {
    quietPollTimer = null;
    if (!pollingWindowIsActive()) return;
    try {
      await loadData({ quiet: true });
    } finally {
      scheduleQuietPoll();
    }
  }, immediate ? 0 : ACTIVE_POLL_INTERVAL_MS);
}

async function runLoadData({ quiet = false } = {}) {
  const firstSuccessfulLoad = !state.loaded;
  if (!quiet) {
    state.doctorRunState = "running";
    renderDoctorStatus();
    elements.reloadButton.disabled = true;
    elements.reloadButton.classList.add("is-busy");
  }
  try {
    // Uživatelská akce je Synchronizovat (decision 0042): POST /api/sync znovu
    // projede lokální auto-discovery a Doctor. Tiché 15s pozadí je lehké:
    // nevolá Doctor, běží jen v aktivním okně a nepřekrývá se s dalším loadem,
    // aby neucpalo runtime akce.
    const [appsResponse, doctorResponse, personalspaceResponse] = await Promise.all(
      quiet
        ? [
            fetchJson("/api/apps"),
            Promise.resolve(null),
            fetchPersonalspaceSafe(),
          ]
        : [
            fetchJson("/api/sync", { method: "POST" }),
            fetchJson("/api/doctor"),
            fetchPersonalspaceSafe(),
          ],
    );
    state.apps = appsResponse.apps ?? [];
    state.companies = appsResponse.companies ?? [];
    state.failures = appsResponse.failures ?? [];
    state.warnings = appsResponse.warnings ?? [];
    // Transportní výpadek oddělené personalspace lane zachová poslední stav.
    // Jakákoli úspěšná HTTP odpověď je ale aktuální autorita i s ok:false:
    // odebraný/revokovaný prostor ani jeho soukromá Buddy data nesmíme vrátit.
    if (personalspaceResponse.ok) {
      state.personalspace = replacePersonalspaceResponse(state.personalspace, personalspaceResponse.data);
      state.personalspaceError = personalspaceResponse.error;
    } else {
      state.personalspaceError = personalspaceResponse.error;
    }
    if (doctorResponse) {
      state.doctor = doctorResponse;
      state.doctorRunState = "complete";
    }
    state.loaded = true;
    // První reconcile vybere aplikaci aktivní Organizace. Když je první položka
    // globálního discovery seznamu z jiného scope (např. root Guide), nesmí tato
    // technická změna výběru sama otevřít desktop drawer ani mobilní bottom
    // sheet a zakrýt uživateli denní plochu ještě před první interakcí.
    if (firstSuccessfulLoad) state.suppressNextDrawerOpen = true;
    if (!state.selectedAppId && state.apps.length > 0) {
      state.selectedAppId = state.apps[0].id;
    }
    render();
    // Panely Poslední změny / Nejčastější + git read model se načítají zvlášť a
    // best-effort — pomalejší git nesmí blokovat hlavní mřížku aplikací.
    void loadSidePanels();
  } catch (error) {
    // Přechodný poll výpadek nesmí zahodit poslední úspěšně objevené prostory
    // ani přepnout uživatele z vybrané Organizace na personalspace.
    if (!state.loaded) {
      state.apps = [];
      state.companies = [];
      state.warnings = [];
    }
    state.failures = [error.message];
    if (!quiet) state.doctorRunState = "unavailable";
    state.loaded = true;
    if (!quiet || !state.doctor) {
      state.doctor = {
        summary: { status: "fail", fail: 1, warn: 0, ok: 0 },
        checks: [
          {
            id: "launchpad.ui.fetch",
            status: "fail",
            message: error.message,
            details: [],
          },
        ],
      };
    }
    render();
  } finally {
    if (!quiet) {
      elements.reloadButton.disabled = false;
      elements.reloadButton.classList.remove("is-busy");
    }
  }
}

async function fetchJson(path, { method = "GET", headers = undefined, body = undefined } = {}) {
  const response = await fetch(path, { method, headers, body, cache: "no-store" });
  if (!response.ok) {
    let message = `${path} ${response.status}`;
    try {
      const payload = await response.clone().json();
      if (payload?.message) message = payload.message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function fetchPersonalspaceSafe() {
  try {
    const data = await fetchJson("/api/personalspace");
    const detail = data?.ok === false
      ? (data.failures ?? []).join("; ") || "discovery osobního prostoru selhalo"
      : null;
    return {
      ok: true,
      data,
      error: detail ? `Některé osobní prostory se nepodařilo obnovit: ${detail}` : null,
    };
  } catch (error) {
    return { ok: false, data: undefined, error: `Osobní prostor se nepodařilo obnovit: ${error.message}` };
  }
}

// Best-effort read jednoho endpointu — vrátí null místo výjimky, ať jeden
// nedostupný panel (nebo zatím nemergnutý git read model) neshodí zbytek UI.
async function fetchJsonSafe(path, options = {}) {
  try {
    return await fetchJson(path, options);
  } catch {
    return null;
  }
}

// Načte pravé panely a git read model. Git read model (/api/git/repos) dodává
// CAC-0042; dokud read model není dostupný, endpoint vrátí 404 → gitReposByModule
// zůstane prázdná a git chip se na kartách graceful nevykreslí.
async function loadSidePanels() {
  if (state.filters.scope === "personal" || state.filters.company === "all") {
    state.recentModules = [];
    state.mostUsed = [];
    state.coldStartUsage = true;
    return;
  }
  const requestedCompany = state.filters.company;
  const companyQuery = `?company=${encodeURIComponent(requestedCompany)}`;
  const [recent, mostUsed, git] = await Promise.all([
    fetchJsonSafe(`/api/recent-changes${companyQuery}`),
    fetchJsonSafe(`/api/most-used${companyQuery}`),
    fetchJsonSafe(`/api/git/repos${companyQuery}`),
  ]);
  // Pomalejší odpověď předchozí Organizace nesmí přepsat panely prostoru,
  // který uživatel mezitím nově vybral.
  if (state.filters.scope !== "org" || state.filters.company !== requestedCompany) return;
  state.recentModules = recent?.recent_modules ?? [];
  state.mostUsed = mostUsed?.most_used ?? [];
  state.coldStartUsage = mostUsed ? mostUsed.cold_start !== false && (mostUsed.most_used ?? []).length === 0 : true;
  state.gitReposByModule = indexGitReposByModule(git?.repos ?? []);
  // Plný render, ne jen grid: git model právě dorazil, takže annotateGitAttention
  // musí přepočítat git_attention, aby toggle kontroly i hero počet zahrnuly
  // git stavy hned, ne až po dalším aktivním poll ticku.
  render();
}

// Index git repos podle modulu, aby karta rychle našla svůj stav. Klíč je
// company::module (stejně jako recent-changes id), s fallbackem na repo key.
function indexGitReposByModule(repos) {
  const map = new Map();
  for (const repo of repos) {
    if (repo.organization && repo.module) {
      map.set(`${repo.organization}::${repo.module}`, repo);
    }
    if (repo.key) map.set(repo.key, repo);
  }
  return map;
}

// Najde git repo pro daný app/modul z read modelu (graceful — může vrátit null).
function gitRepoForApp(app) {
  if (!app || state.gitReposByModule.size === 0) return null;
  if (app.company && app.module) {
    const byModule = state.gitReposByModule.get(`${app.company}::${app.module}`);
    if (byModule) return byModule;
  }
  return null;
}

function canAutostashPull(git) {
  return git?.status === "draft_changes"
    && Number(git.counts?.incoming) > 0
    && Number(git.counts?.outgoing) === 0;
}

// Anotuje každou appku booleanem git_attention podle git read modelu, ať toggle
// kontroly (isAttentionState v app-state.js) může git stavy zahrnout, aniž
// by app-state znal git model. Graceful: bez git modelu je vždy false.
function annotateGitAttention(apps) {
  for (const app of apps) {
    const chipModel = gitChipModel(gitRepoForApp(app));
    app.git_attention = Boolean(chipModel && chipModel.attention);
  }
}

function syncSegmentedControl() {
  for (const segment of elements.segmentedControl) {
    const active = segment.dataset.statusSegment === state.filters.status;
    segment.classList.toggle("is-active", active);
    segment.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function syncAttentionToggle() {
  const active = state.filters.attentionOnly;
  elements.attentionToggle?.classList.toggle("is-active", active);
  elements.attentionToggle?.setAttribute("aria-pressed", active ? "true" : "false");
}

/* =========================================================
   Render orchestration
   ========================================================= */

function render() {
  normalizeActiveSpace();
  applyOrganizationTheme();
  const previousSelectedAppId = state.selectedAppId;
  const suppressDrawerOpen = state.suppressNextDrawerOpen;
  state.suppressNextDrawerOpen = false;
  if (state.selectedReadonlyDetail && !readonlyDetailInView(state.selectedReadonlyDetail)) {
    state.selectedReadonlyDetail = null;
  }
  if (state.filters.scope === "personal") {
    state.selectedAppId = null;
    state.selectedLogs = null;
  } else if (state.selectedReadonlyDetail) {
    state.selectedAppId = null;
    state.selectedLogs = null;
  } else {
    state.selectedAppId = reconcileSelectedAppId(state.apps, state.filters, state.selectedAppId);
    if (previousSelectedAppId !== state.selectedAppId && state.selectedLogs?.app_id !== state.selectedAppId) {
      state.selectedLogs = null;
    }
    // Výběr appky (detail) otevře drawer s panely, ať je detail vidět.
    if (state.selectedAppId && previousSelectedAppId !== state.selectedAppId && !suppressDrawerOpen) {
      state.drawerView = "detail";
      setDrawer(true);
    }
  }

  // Anotace git_attention z git read modelu — nezávislý toggle ji zahrne
  // (graceful: bez git read modelu je model prázdný a anotace je vždy false).
  annotateGitAttention(state.apps);

  const filteredApps = filtered(state.apps);
  renderSpaceSwitcher();
  renderScopeControls();
  renderWorkspaceWelcome();
  syncSegmentedControl();
  syncAttentionToggle();
  const heroApps = activeSpaceApps();
  const spaceHealth = heroDiagnostics(heroApps);
  renderHero(heroApps, spaceHealth);
  renderDoctorStatus();
  renderProblems(spaceHealth);
  renderActionMessage();
  renderAppsGrid(filteredApps);
  renderApps(filteredApps);
  renderDetail(filteredApps);
  renderOrganizationGitStatus();
  renderRecentModules();
  renderMostUsed();
}

/* =========================================================
   Hero command center
   ========================================================= */

function computeHeroState(apps, diagnostics) {
  return computeSpaceHeroState({
    ...diagnostics,
    running: apps.filter((app) => app.runtime_status === "healthy").length,
  });
}

function renderHero(apps, diagnostics) {
  const hero = elements.hero;
  hero.classList.remove("hero-ok", "hero-warn", "hero-danger", "hero-loading");

  if (!state.loaded) {
    hero.classList.add("hero-loading");
    elements.heroTitle.textContent = "Načítám stav…";
    elements.heroCta.textContent = "Zkontrolovat stav";
    heroAction = "reload";
    renderSpaceHealthBadge();
    return;
  }

  const verdict = computeHeroState(apps, diagnostics);
  hero.classList.add(`hero-${verdict.tone}`);
  elements.heroTitle.textContent = verdict.title;
  elements.heroCta.textContent = verdict.cta;
  heroAction = verdict.action;
  renderSpaceHealthBadge(verdict, diagnostics);
}

function renderSpaceHealthBadge(verdict, diagnostics) {
  const badge = elements.spaceHealthBadge;
  const toggle = elements.drawerToggle;
  if (!badge || !toggle) return;
  const count = verdict?.tone === "danger"
    ? diagnostics?.blockers ?? 0
    : verdict?.tone === "warn"
      ? diagnostics?.warnings ?? 0
      : 0;
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.dataset.tone = verdict?.tone ?? "loading";
  const label = verdict?.title ? `Panely · Stav prostoru: ${verdict.title}` : "Panely · Stav prostoru se načítá";
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
}

function runHeroAction() {
  if (mobilePanelQuery.matches && state.drawerOpen) setDrawer(false);
  if (heroAction === "reload") {
    loadData();
    return;
  }
  if (heroAction === "attention") {
    if (state.filters.scope === "personal") {
      elements.appsGrid.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    state.filters.status = "all";
    state.filters.attentionOnly = true;
    state.suppressNextDrawerOpen = true;
    render();
    if (mobilePanelQuery.matches) setDrawer(false);
    elements.appsGrid.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  // problems
  revealProblems();
}

function revealProblems() {
  state.problemsRequested = true;
  state.problemsExpanded = true;
  renderProblems(heroDiagnostics(activeSpaceApps()));
  const target = state.problemsVisible ? elements.problemsPanel : elements.appsGrid;
  scrollBelowStickyTopbar(target);
}

function scrollBelowStickyTopbar(target) {
  if (!target) return;
  requestAnimationFrame(() => {
    const topbarBottom = elements.topbar?.getBoundingClientRect().bottom ?? 0;
    const breathingRoom = 12;
    const delta = target.getBoundingClientRect().top - topbarBottom - breathingRoom;
    window.scrollBy({ top: delta, behavior: "smooth" });
  });
}

/* =========================================================
   Doctor + problems
   ========================================================= */

function renderDoctorStatus() {
  const status = state.doctor?.summary?.status ?? "unknown";
  const runState = state.doctorRunState;
  const chipStatus = runState === "unavailable" ? "fail" : runState === "complete" ? status : "unknown";
  elements.doctorStatus.className = `status-pill status-${chipStatus}`;
  elements.doctorStatus.textContent = runState === "running"
    ? "Doktor: kontroluje…"
    : runState === "unavailable"
      ? "Doktor: nedostupný"
      : runState === "complete"
        ? `Doktor: dokončeno · ${statusLabel(status)}`
        : "Doktor: bez výsledku";
  elements.doctorStatus.title = "Dostupnost Doctora a výsledek root diagnostiky; stav aktivního prostoru shrnuje banner.";
  const rootPath = state.doctor?.scope?.absolute_path;
  const rootName = state.doctor?.scope?.name ?? "Launchpad root";
  const normalizedRootPath = rootPath?.replaceAll("\\", "/");
  const isWorktree = normalizedRootPath?.includes("/.worktrees/");
  const worktreeName = isWorktree ? normalizedRootPath.slice(normalizedRootPath.lastIndexOf("/") + 1) : null;
  elements.runtimeRootBadge.hidden = !rootPath;
  elements.runtimeRootBadge.textContent = isWorktree ? `WORKTREE · ${worktreeName}` : "MAIN";
  elements.runtimeRootBadge.title = rootPath ? `${rootName}: ${rootPath}` : "";
}

function renderProblems(spaceHealth) {
  const reportedChecks = (state.doctor?.checks ?? []).filter((check) => check.status === "fail" || check.status === "warn");
  const hasRuntimeAppCheck = reportedChecks.some((check) => check.id.startsWith("launchpad.runtime."));
  const failedChecks = reportedChecks.filter((check) => check.id !== "launchpad.runtime" || !hasRuntimeAppCheck);
  const activeSlotBlockers = activeOrganizationSlotBlockers(failedChecks);
  const currentAppBlockers = spaceHealth?.blocking_apps ?? [];
  const activeAppBlockers = currentAppBlockers.filter(
    (app) => !failedChecks.some((check) => check.id === `launchpad.runtime.${app.id}`),
  );
  const appSeverityAdjustments = currentAppBlockers.filter((app) => {
    const check = failedChecks.find((item) => item.id === `launchpad.runtime.${app.id}`);
    return check?.status !== "fail";
  }).length;
  const rawPersonalFailures = state.filters.scope === "personal"
    ? (state.personalspace?.failures ?? [])
    : [];
  const personalFailures = rawPersonalFailures.filter((failure) => !failedChecks.some(
        (check) => check.id === "launchpad.personalspace"
          && (check.details ?? []).some((detail) => String(detail).includes(failure)),
      ));
  const personalWarnings = state.filters.scope === "personal"
    ? [
        ...(state.personalspace?.warnings ?? []),
        ...(state.personalspace?.presentation_warnings ?? []),
      ].filter((warning) => !failedChecks.some(
        (check) => check.id === "launchpad.personalspace"
          && (check.details ?? []).some((detail) => String(detail).includes(warning)),
      ))
    : [];
  const personalspaceTransportError = state.personalspaceError
    && (state.personalspace?.failures?.length ?? 0) === 0
    ? state.personalspaceError
    : null;
  const problemNodes = [
    ...failedChecks.map(problemCheckNode),
    ...activeSlotBlockers.map((slot) => problemTextNode(
      `Blokátor aktivního prostoru: ${slot.path}${slot.message ? ` — ${slot.message}` : ""}`,
    )),
    ...activeAppBlockers.map((app) => problemTextNode(
      `Blokátor aplikace ${app.title ?? app.id}: ${app.dependencies?.message ?? app.runtime?.message ?? "aplikace není použitelná"}`,
    )),
    ...personalFailures.map((failure) => problemTextNode(`Blokátor osobního prostoru: ${failure}`)),
    ...personalWarnings.map((warning) => problemTextNode(`Varování osobního prostoru: ${warning}`)),
    ...state.failures.map(problemTextNode),
    ...state.warnings.map((warning) => problemTextNode(`Varování: ${warning}`)),
    ...(personalspaceTransportError ? [problemTextNode(`Varování: ${personalspaceTransportError}`)] : []),
  ];
  if (problemNodes.length === 0) {
    state.problemsRequested = false;
    state.problemsExpanded = false;
    state.problemsVisible = false;
    elements.doctorStatus.disabled = true;
    elements.doctorStatus.setAttribute("aria-expanded", "false");
    elements.problemsPanel.classList.add("hidden");
    elements.problemsPanel.replaceChildren();
    return;
  }

  const hardFailureCount = failedChecks.filter((check) => check.status === "fail").length
    + state.failures.length
    + activeSlotBlockers.length
    + appSeverityAdjustments
    + personalFailures.length;
  const warnCount = problemNodes.length - hardFailureCount;
  const hasPersonalspaceDoctorFailure = failedChecks.some(
    (check) => check.id === "launchpad.personalspace" && check.status === "fail",
  );
  const personalspaceFailureVisible = state.filters.scope === "personal"
    && (rawPersonalFailures.length > 0 || hasPersonalspaceDoctorFailure || personalspaceTransportError);
  const panelDisclosed = state.problemsRequested || personalspaceFailureVisible;

  // Diagnostický detail se materializuje až po explicitní akci z hero banneru;
  // denní seznam aplikací tak neopakuje stejný alarm podruhé.
  const details = document.createElement("details");
  details.className = "problems-details";
  details.open = state.problemsExpanded;
  const summary = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "problems-dot";
  const label = document.createElement("span");
  label.className = "problems-summary-label";
  label.textContent =
    hardFailureCount > 0
      ? `Diagnostické detaily · ${hardFailureCount} ${pluralBlocker(hardFailureCount)}${warnCount > 0 ? `, ${warnCount} varování` : ""}`
      : `Diagnostické detaily · ${problemNodes.length} varování`;
  const hint = document.createElement("span");
  hint.className = "problems-summary-hint";
  hint.textContent = "Zobrazit detail";
  summary.append(dot, label, hint);

  const list = document.createElement("div");
  list.className = "problems-list";
  list.append(...problemNodes);
  details.append(summary, list);
  details.addEventListener("toggle", () => {
    state.problemsExpanded = details.open;
    elements.doctorStatus.setAttribute("aria-expanded", String(details.open));
  });

  state.problemsVisible = true;
  elements.doctorStatus.disabled = false;
  elements.doctorStatus.setAttribute("aria-expanded", String(state.problemsExpanded));
  elements.problemsPanel.className = `problems-panel ${hardFailureCount > 0 ? "is-danger" : "is-warn"}${panelDisclosed ? "" : " hidden"}`;
  elements.problemsPanel.replaceChildren(details);
}

function activeOrganizationSlotBlockers(reportedChecks = []) {
  if (state.filters.scope !== "org") return [];
  const organization = state.companies.find((company) => company.slug === state.filters.company);
  const reportedDetails = reportedChecks
    .find((check) => check.id === "launchpad.workspace_declarations")
    ?.details ?? [];
  return (organization?.space_readiness?.blocking_slots ?? []).filter((slot) => {
    const detailPrefix = `${organization.path}/${slot.path}:`;
    return !reportedDetails.some((detail) => String(detail).startsWith(detailPrefix));
  });
}

function problemCheckNode(check) {
  const node = document.createElement("div");
  node.className = "problem-item";
  const title = document.createElement("strong");
  title.textContent = `${check.id}: ${check.message}`;
  node.append(title);
  const meta = [...(check.paths ?? []), ...(check.details ?? [])];
  if (meta.length > 0) {
    const list = document.createElement("ul");
    list.className = "problem-meta";
    for (const item of meta) {
      const li = document.createElement("li");
      li.textContent = item;
      list.append(li);
    }
    node.append(list);
  }
  return node;
}

function problemTextNode(text) {
  const node = document.createElement("div");
  node.className = "problem-item";
  node.textContent = text;
  return node;
}

function renderActionMessage() {
  if (!state.actionMessage) {
    elements.actionPanel.classList.add("hidden");
    elements.actionPanel.replaceChildren();
    return;
  }

  elements.actionPanel.className = `action-panel action-${state.actionMessage.type}`;
  elements.actionPanel.textContent = state.actionMessage.message;
}

/* =========================================================
   Space switcher
   ========================================================= */

// Header drží právě jeden aktivní prostor. Personalspace zůstává datově
// oddělená lane; selector je pouze společná navigační vrstva nad ní a nad
// Organizacemi. Položky záměrně ukazují jen logo + název, bez provozních metrik.
function normalizeActiveSpace() {
  // Už zvolený Osobní scope držíme i při přechodném failure payloadu, aby se
  // člověk svévolně nepřepnul do Organizace a viděl pravdivý error state.
  if (state.filters.scope === "personal" && state.personalspace) return;
  if (
    state.filters.scope === "org"
    && state.companies.some((organization) => organization.slug === state.filters.company)
  ) return;

  const firstOrganization = state.companies[0];
  if (firstOrganization) {
    state.filters.scope = "org";
    state.filters.company = firstOrganization.slug;
    return;
  }
  state.filters.scope = "personal";
  state.filters.company = "all";
}

function personalspaceScopeAvailable(data) {
  if (!data) return false;
  if ((data.spaces?.length ?? 0) > 0) return true;
  return data.ok === true && (data.failures?.length ?? 0) === 0;
}

function activeSpace() {
  if (state.filters.scope === "personal") {
    return { kind: "personal", label: "Osobní", slug: "personal" };
  }
  const organization = state.companies.find((company) => company.slug === state.filters.company);
  return organization
    ? { kind: "organization", label: organization.display_name ?? organization.slug, organization }
    : { kind: "personal", label: "Osobní", slug: "personal" };
}

// Shared Launchpad drží layout a chování, ale aktivní Organizace dodává skin.
// Server propustí jen povolené sémantické tokeny z jejího design systému / GEN2
// adaptéru; klient je znovu allowlistuje a aplikuje podle light/dark režimu.
function applyOrganizationTheme() {
  const root = document.documentElement;
  const space = activeSpace();
  const theme = space.kind === "organization" ? space.organization.theme : null;
  const mode = currentThemeMode();
  const renderKey = `${space.kind}:${space.organization?.slug ?? "personal"}:${mode}:${JSON.stringify(theme ?? null)}`;
  if (renderKey === organizationThemeRenderKey) return;
  organizationThemeRenderKey = renderKey;

  for (const token of ORGANIZATION_THEME_TOKENS) root.style.removeProperty(token);
  root.removeAttribute("data-organization-theme");
  if (!theme?.light || typeof theme.light !== "object") {
    if (space.kind === "personal") {
      const personalAccent = localStorage.getItem(THEME_STORAGE.accent) || "default";
      if (personalAccent === "default") root.removeAttribute("data-accent");
      else root.setAttribute("data-accent", personalAccent);
    } else {
      root.removeAttribute("data-accent");
    }
    return;
  }

  // Firemní brand je v Organization scope autorita; uživatelský accent preset
  // se vrátí až v Osobním / výchozím prostoru.
  root.removeAttribute("data-accent");
  const properties = {
    ...theme.light,
    ...(mode === "dark" && theme.dark && typeof theme.dark === "object" ? theme.dark : {}),
  };
  for (const [token, value] of Object.entries(properties)) {
    if (!ORGANIZATION_THEME_TOKENS.has(token) || !safeOrganizationThemeValue(token, value)) continue;
    root.style.setProperty(token, value);
  }
  root.setAttribute("data-organization-theme", space.organization.slug);
}

function safeOrganizationThemeValue(token, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || /[\\{};<>:@]/.test(value)) {
    return false;
  }
  if (token.startsWith("--font-")) return /^[a-zA-Z0-9 ,"'_-]+$/.test(value);
  if (token.startsWith("--r-")) return /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/.test(value);
  if (token.startsWith("--shadow-")) {
    if (!/^[a-zA-Z0-9#.,%()\s+-]+$/.test(value)) return false;
    const functions = [...value.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*\(/g)].map((match) => match[1]);
    return functions.every((name) => ["rgb", "rgba", "hsl", "hsla"].includes(name));
  }
  if (token === "--launchpad-body-background") {
    return value === "linear-gradient(180deg, var(--bg-muted) 0%, var(--bg) 42%)";
  }
  return /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.%,\s+-]+\)|transparent|white|black)$/.test(value);
}

function renderSpaceSwitcher() {
  const current = activeSpace();
  elements.currentSpaceLabel.textContent = current.label;
  renderSpaceLogo(elements.currentSpaceLogo, current);

  const options = [];
  // Jakmile Personalspace lane skutečně odpověděla, musí zůstat dosažitelná i
  // s nulou prostorů a failure payloadem — právě v Osobním scope se vykreslí
  // jeho cílený error state a náprava.
  if (state.personalspace) {
    options.push(spaceOption({ kind: "personal", label: "Osobní", slug: "personal" }));
  }
  options.push(
    ...state.companies.map((organization) => spaceOption({
      kind: "organization",
      label: organization.display_name ?? organization.slug,
      organization,
    })),
  );

  const spaces = document.createElement("div");
  spaces.className = "space-switcher-options";
  spaces.setAttribute("role", "listbox");
  spaces.setAttribute("aria-label", "Vybrat prostor");
  spaces.append(...options);

  const profile = state.personalspace?.profile;
  const profileNodes = profile ? [spaceProfileCard(profile), profileSettingsItem()] : [];
  if (profileNodes.length > 0 && options.length > 0) {
    const divider = document.createElement("div");
    divider.className = "space-switcher-divider";
    divider.setAttribute("aria-hidden", "true");
    profileNodes.push(divider);
  }
  elements.spaceSwitcherMenu.replaceChildren(...profileNodes, spaces);
  elements.spaceSwitcherButton.disabled = options.length === 0;
  applySpaceMenuState();
}

function spaceProfileCard(profile) {
  const card = document.createElement("div");
  card.className = "space-profile-card";

  const photo = document.createElement("span");
  photo.className = "space-profile-photo";
  const fallback = document.createElement("span");
  fallback.className = "space-profile-photo-fallback";
  fallback.textContent = profileInitials(profile.display_name);
  photo.append(fallback);
  if (profile.avatar_url) {
    const image = document.createElement("img");
    image.src = profile.avatar_url;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    photo.append(image);
  }

  const copy = document.createElement("span");
  copy.className = "space-profile-copy";
  const name = document.createElement("a");
  name.className = "space-profile-name";
  name.href = profile.settings_url;
  name.target = "_blank";
  name.rel = "noopener noreferrer";
  name.textContent = profile.display_name ?? profile.github_username ?? "Uživatel";
  name.addEventListener("click", () => {
    restoreSpaceMenuFocusOnClose = true;
    state.spaceMenuOpen = false;
    applySpaceMenuState();
  });
  const email = document.createElement("span");
  email.className = "space-profile-email";
  email.textContent = profile.email ?? "E-mail není nastavený";
  copy.append(name, email);
  card.append(photo, copy);
  return card;
}

function profileInitials(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join("") || "U").toUpperCase();
}

function profileSettingsItem() {
  const item = document.createElement("div");
  item.className = "space-profile-settings is-disabled";
  item.setAttribute("aria-disabled", "true");
  item.append(settingsIcon(), document.createTextNode("Nastavení"));
  return item;
}

function settingsIcon() {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(namespace, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "3");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.36.7.66.96.3.26.68.4 1.08.4H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z");
  svg.append(circle, path);
  return svg;
}

function spaceOption(space) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "space-switcher-option";
  button.setAttribute("role", "option");
  const selected = space.kind === "personal"
    ? state.filters.scope === "personal"
    : state.filters.scope === "org" && state.filters.company === space.organization.slug;
  button.setAttribute("aria-selected", selected ? "true" : "false");

  const logo = document.createElement("span");
  renderSpaceLogo(logo, space);
  const label = document.createElement("span");
  label.className = "space-switcher-option-label";
  label.textContent = space.label;
  button.append(logo, label);
  button.addEventListener("click", () => selectSpace(space));
  return button;
}

function selectSpace(space) {
  restoreSpaceMenuFocusOnClose = true;
  state.spaceMenuOpen = false;
  state.suppressNextDrawerOpen = true;
  state.selectedReadonlyDetail = null;
  state.selectedAppId = null;
  state.selectedLogs = null;
  state.problemsRequested = false;
  state.problemsExpanded = false;
  setDrawer(false);
  if (space.kind === "personal") {
    state.filters.scope = "personal";
    state.filters.company = "all";
  } else {
    state.filters.scope = "org";
    state.filters.company = space.organization.slug;
  }
  render();
  void loadSidePanels();
}

function renderSpaceLogo(mount, space) {
  mount.className = `space-logo ${space.kind === "personal" ? "space-logo-personal" : "space-logo-organization"}`;
  mount.setAttribute("aria-hidden", "true");
  mount.replaceChildren();
  if (space.kind === "personal") {
    mount.append(personalSpaceIcon());
    return;
  }

  const fallback = document.createElement("span");
  fallback.className = "space-logo-fallback";
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = (space.label.trim()[0] ?? "O").toUpperCase();
  const hue = [...String(space.organization.slug ?? space.label)]
    .reduce((value, character) => ((value * 31) + character.charCodeAt(0)) % 360, 0);
  mount.style.setProperty("--space-logo-hue", String(hue));
  mount.append(fallback);
  if (space.organization.logo_url) {
    const image = document.createElement("img");
    image.src = space.organization.logo_url;
    image.alt = "";
    image.addEventListener("error", () => image.remove(), { once: true });
    mount.append(image);
  }
}

function personalSpaceIcon() {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const circle = document.createElementNS(namespace, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "8");
  circle.setAttribute("r", "4");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", "M4 21a8 8 0 0 1 16 0");
  svg.append(circle, path);
  return svg;
}

function applySpaceMenuState() {
  const wasOpen = !elements.spaceSwitcherMenu.hidden;
  elements.spaceSwitcherMenu.hidden = !state.spaceMenuOpen;
  elements.spaceSwitcherButton.setAttribute("aria-expanded", state.spaceMenuOpen ? "true" : "false");
  elements.spaceSwitcherButton.classList.toggle("is-open", state.spaceMenuOpen);
  if (state.spaceMenuOpen && !elements.spaceSwitcherMenu.contains(document.activeElement)) {
    queueMicrotask(() => {
      const selected = elements.spaceSwitcherMenu.querySelector('.space-switcher-option[aria-selected="true"]');
      (selected ?? elements.spaceSwitcherMenu.querySelector("a, button"))?.focus();
    });
  } else if (!state.spaceMenuOpen && wasOpen && restoreSpaceMenuFocusOnClose) {
    elements.spaceSwitcherButton.focus();
  }
  if (!state.spaceMenuOpen) restoreSpaceMenuFocusOnClose = false;
}

function renderScopeControls() {
  const personal = state.filters.scope === "personal";
  elements.hero.classList.toggle("hidden", personal);
  elements.personalPrivacyBadge?.toggleAttribute("hidden", !personal);
  elements.appsToolbar.classList.toggle("hidden", personal);
  elements.drawerToggle.classList.toggle("hidden", personal);
  elements.layout.classList.toggle("is-personal", personal);
  elements.recentChangesSidebar.classList.toggle("hidden", personal);
  if (personal && state.drawerOpen) setDrawer(false);
}

function renderWorkspaceWelcome() {
  const personal = state.filters.scope === "personal";
  elements.workspaceWelcome?.toggleAttribute("hidden", personal);
  if (personal || !elements.workspaceWelcomeTitle) return;

  const organization = state.companies.find((company) => company.slug === state.filters.company);
  const organizationName = organization?.display_name ?? organization?.slug;
  elements.workspaceWelcomeTitle.textContent = organizationName
    ? `Vítejte v pracovním prostoru ${organizationName}`
    : "Vítejte v pracovních prostorech";
}

/* =========================================================
   Side panels: Poslední změny + Nejčastější (CAC-0044)
   ========================================================= */

function renderOrganizationGitStatus() {
  const mount = elements.organizationGitStatus;
  if (!mount) return;
  mount.replaceChildren();
  const organization = state.filters.scope === "org" ? state.filters.company : null;
  const rootRepo = organization ? state.gitReposByModule.get(`${organization}::root`) : null;
  const bulkPending = state.pendingAction === "git:pull-all";
  if (elements.pullAllButton) {
    elements.pullAllButton.disabled = bulkPending || !organization;
    elements.pullAllButton.textContent = bulkPending ? "Pulluju…" : "Pullnout vše";
  }

  if (!rootRepo) {
    const empty = document.createElement("p");
    empty.className = "rail-copy";
    empty.textContent = "Root repo Organizace zatím nemá dostupný Git stav.";
    mount.append(empty);
    return;
  }

  const card = document.createElement("article");
  card.className = `organization-git-card is-${rootRepo.severity ?? "ok"}`;
  const title = document.createElement("strong");
  title.textContent = "Root repo Organizace";
  const model = gitChipModel(rootRepo);
  const badges = document.createElement("div");
  badges.className = "organization-git-badges";
  if (model) badges.append(gitChipNode(model));
  const copy = document.createElement("p");
  copy.textContent = rootRepoStatusMessage(rootRepo);
  const freshness = document.createElement("small");
  freshness.textContent = `Vzdálená verze: ${gitFreshnessLabel(rootRepo.freshness)}`;
  card.append(title, badges, copy, freshness);

  if (rootRepo.status === "pull_available" || canAutostashPull(rootRepo)) {
    const action = builderActionButton(
      canAutostashPull(rootRepo) ? "Stáhnout a zachovat změny" : "Stáhnout root",
      () => pullGitRepository({
        git: rootRepo,
        label: `${organization} root`,
        autostash: canAutostashPull(rootRepo),
      }),
    );
    action.disabled = state.pendingAction === `git-pull:${rootRepo.key}`;
    card.append(action);
  }
  mount.append(card);

  if (state.bulkPullResult) mount.append(bulkPullSummaryNode(state.bulkPullResult));
}

function rootRepoStatusMessage(repo) {
  const incoming = Number(repo.counts?.incoming) || 0;
  if (repo.status === "draft_changes" && incoming > 0) {
    return `${incoming} ${pluralCommit(incoming)} ke stažení a lokální změny k zachování.`;
  }
  return repo.message ?? repo.title ?? "Git stav root repa je dostupný.";
}

function bulkPullSummaryNode(payload) {
  const details = document.createElement("details");
  details.className = "bulk-pull-summary";
  const summary = document.createElement("summary");
  const counts = payload.summary ?? {};
  summary.textContent = `Poslední Pullnout vše: ${counts.updated_count ?? 0} aktualizováno`;
  details.append(summary);
  const meta = document.createElement("p");
  meta.textContent = [
    `${counts.up_to_date_count ?? 0} aktuálních`,
    `${counts.skipped_count ?? 0} přeskočených`,
    `${counts.conflict_count ?? 0} konfliktů`,
    `${counts.failed_count ?? 0} chyb`,
  ].join(" · ");
  details.append(meta);
  const attention = (payload.results ?? []).filter((result) => ["skipped", "conflict", "failed"].includes(result.outcome));
  if (attention.length > 0) {
    const list = document.createElement("ul");
    for (const result of attention) {
      const item = document.createElement("li");
      item.textContent = `${result.repo_key}: ${result.message}`;
      list.append(item);
    }
    details.append(list);
  }
  return details;
}

// Panel „Poslední změny" (step-006): per-modul poslední commity z git read
// modelu. Rozklik otevře modal s detailem commitů daného modulu (port GEN2
// renderRecentModules + openRecentModuleModal, app.js:2535–2606).
function renderRecentModules() {
  const mount = elements.recentModules;
  if (!mount) return;
  mount.replaceChildren();
  const modules = visibleRecentModules();

  if (modules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "rail-copy";
    empty.textContent = "Zatím tu nevidím žádné změněné moduly.";
    mount.append(empty);
    return;
  }

  for (const module of modules) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-module-item";
    const icon = document.createElement("span");
    icon.className = "recent-module-icon app-card-icon";
    icon.style.cssText = appIconStyle(appIconKey(module));
    icon.innerHTML = appIconSvg(appIconKey(module));
    const copy = document.createElement("span");
    copy.className = "recent-module-copy";
    const name = document.createElement("span");
    name.className = "recent-module-name";
    name.textContent = module.name;
    const meta = document.createElement("span");
    meta.className = "recent-module-meta";
    meta.textContent = `${formatModuleChangeDate(module.last_commit_at)} · ${newCommitCountLabel(module.commit_count)}`;
    copy.append(name, meta);
    button.append(icon, copy);
    button.addEventListener("click", () => openRecentModuleModal(module.id));
    mount.append(button);
  }
}

function openRecentModuleModal(moduleId) {
  const module = visibleRecentModules().find((item) => item.id === moduleId);
  const modal = elements.recentModuleModal;
  if (!module || !modal) return;
  elements.recentModuleTitle.textContent = module.name;
  elements.recentModuleSubtitle.textContent =
    `Poslední změna ${formatModuleChangeDate(module.last_commit_at, { includeTime: true })} · ${recentCommitCountLabel(module.commits.length)} v detailu`;
  const mount = elements.recentModuleCommits;
  mount.replaceChildren();
  for (const [index, commit] of module.commits.entries()) {
    const item = document.createElement("article");
    item.className = "module-commit-item";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "module-commit-toggle";
    toggle.setAttribute("aria-expanded", "false");
    const subject = document.createElement("strong");
    subject.textContent = commit.subject || "(bez popisu)";
    const line = document.createElement("span");
    line.textContent = `${formatModuleChangeDate(commit.committed_at, { includeTime: true })} · ${commit.author} · ${commit.short_hash}`;
    toggle.append(subject, line);
    const detail = document.createElement("div");
    detail.className = "module-commit-detail";
    detail.hidden = true;
    const body = document.createElement("p");
    body.className = "module-commit-description";
    body.textContent = commit.body?.trim() ? commit.body.trim() : "Bez dalšího popisu.";
    const fullHash = document.createElement("span");
    fullHash.className = "module-commit-full-hash";
    fullHash.textContent = commit.hash;
    detail.append(body, fullHash);
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      item.classList.toggle("is-open", !expanded);
      detail.hidden = expanded;
    });
    item.append(toggle, detail);
    mount.append(item);
  }
  if (typeof modal.showModal === "function") modal.showModal();
}

// Panel „Nejčastější" (step-007): aplikace řazené podle skutečného lokálního
// použití. Cold start (nic zatím neotevřeno) → fallback na připravené aplikace.
function renderMostUsed() {
  const mount = elements.mostUsed;
  if (!mount) return;
  const detailOpen = state.drawerView === "detail";
  elements.mostUsedPanel?.toggleAttribute("hidden", detailOpen);
  if (detailOpen) return;
  mount.replaceChildren();

  const usedItems = visibleMostUsed();
  const items = usedItems.length > 0 ? usedItems : coldStartMostUsed();
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "rail-copy";
    empty.textContent = "Zatím nemám co nabídnout — otevři první aplikaci.";
    mount.append(empty);
    return;
  }

  if (usedItems.length === 0) {
    const hint = document.createElement("p");
    hint.className = "rail-copy rail-copy-hint";
    hint.textContent = "Zatím podle připravených aplikací; jak budeš otevírat, seřadí se podle tvého použití.";
    mount.append(hint);
  }

  for (const item of items) {
    const app = state.apps.find((candidate) => candidate.id === item.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-app";
    const mark = document.createElement("span");
    mark.className = "quick-app-mark app-card-icon";
    mark.style.cssText = appIconStyle(appIconKey(app ?? item));
    mark.innerHTML = appIconSvg(appIconKey(app ?? item));
    const text = document.createElement("span");
    text.className = "quick-app-text";
    const strong = document.createElement("strong");
    strong.textContent = item.name;
    const small = document.createElement("small");
    const nextAction = app ? primaryNextAction(app) : null;
    const blocked = nextAction?.type === "disabled";
    small.textContent = blocked ? "blokovaná" : app?.runtime_status === "healthy" ? "otevřená" : "připravená";
    text.append(strong, small);
    const action = document.createElement("span");
    action.className = "quick-app-action";
    action.textContent = blocked ? "Zobrazit detail" : app ? openActionLabel(app) : "Otevřít";
    button.append(mark, text, action);
    if (app && !isProductionspace(app)) {
      button.addEventListener("click", () => blocked ? revealAppDetail(app) : void openAppChain(app, {}));
    } else {
      button.disabled = true;
    }
    mount.append(button);
  }
}

function visibleRecentModules() {
  if (state.filters.scope === "personal") return [];
  return state.recentModules.filter((module) => module.company === state.filters.company);
}

function visibleMostUsed() {
  if (state.filters.scope === "personal") return [];
  return state.mostUsed.filter((item) => item.company === state.filters.company);
}

// Cold-start fallback: prvních pár připravených (ne-productionspace) aplikací.
function coldStartMostUsed() {
  return filtered(state.apps)
    .filter((app) => !isProductionspace(app))
    .filter((app) => primaryNextAction(app).type !== "disabled")
    .slice(0, 6)
    .map((app) => ({ id: app.id, name: appBaseTitle(app), icon: app.icon ?? null }));
}

function formatModuleChangeDate(value, { includeTime = false } = {}) {
  if (!value) return "neznámé datum";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "neznámé datum";
  const dayDiff = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  const base =
    dayDiff <= 0 ? "dnes" : dayDiff === 1 ? "včera" : `před ${dayDiff} ${pluralDay(dayDiff)}`;
  if (!includeTime) return base;
  const time = date.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
  return `${base} v ${time}`;
}

function pluralDay(count) {
  return count >= 2 && count <= 4 ? "dny" : "dní";
}

function newCommitCountLabel(count) {
  if (count === 1) return "1 změna";
  if (count >= 2 && count <= 4) return `${count} změny`;
  return `${count} změn`;
}

function recentCommitCountLabel(count) {
  if (count === 1) return "1 commit";
  if (count >= 2 && count <= 4) return `${count} commity`;
  return `${count} commitů`;
}

/* =========================================================
   App cards (daily launcher surface)
   ========================================================= */

function renderSkeleton() {
  const grid = document.createElement("div");
  grid.className = "apps-grid";
  grid.append(
    ...Array.from({ length: 6 }, () => {
      const node = document.createElement("div");
      node.className = "skeleton-card";
      return node;
    }),
  );
  elements.appsGrid.replaceChildren(grid);
}

function renderAppsGrid(apps) {
  const scope = state.filters.scope;
  // I prázdná úspěšná odpověď má vlastní Buddy-first empty state. Podmínkou
  // proto není počet prostorů, ale dostupná odpověď personalspace lane.
  const showPersonal = scope === "personal" && Boolean(state.personalspace);
  const personalNode = showPersonal ? personalspaceSectionNode() : null;

  // Osobní scope: hlavní plocha ukazuje jen personalspace sekci (nic z org lane).
  if (scope === "personal") {
    if (personalNode) {
      elements.appsGrid.replaceChildren(personalNode);
      fillPersonalspaceSection();
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-card";
      empty.textContent = "Zatím tu není namountovaný žádný osobní prostor.";
      elements.appsGrid.replaceChildren(empty);
    }
    return;
  }

  const families = groupAppFamilies(apps);
  const workspaceSections = sectionsWithManifestModules(groupFamiliesByWorkspace(families), families);
  const productionspace = productionspaceInView();
  if (apps.length === 0 && workspaceSections.length === 0 && productionspace.length === 0 && !personalNode) {
    const empty = document.createElement("div");
    empty.className = "empty-card";
    empty.textContent = "Žádné aplikace ani moduly pro aktuální filtr.";
    elements.appsGrid.replaceChildren(empty);
    return;
  }

  // Organizace používá workspace grid; personalspace se vrací výše samostatnou
  // větví a nikdy se s Organization discovery datově nemíchá.
  const nodes = [];
  if (personalNode) nodes.push(personalNode);

  const manifestModuleCount = workspaceSections.reduce((count, section) => count + (section.modules?.length ?? 0), 0);
  const structured = workspaceSections.length > 1 || productionspace.length > 0 || manifestModuleCount > 0;
  if (!structured) {
    nodes.push(familyGridNode(families));
  } else {
    for (const section of workspaceSections) nodes.push(workspaceSectionNode(section));
    for (const entry of productionspace) nodes.push(productionspaceSectionNode(entry));
  }
  elements.appsGrid.replaceChildren(...nodes);
  if (personalNode) fillPersonalspaceSection();
}

// Personalspace má vlastní Buddy-first kompozici. App.js drží jen neutrální
// mount; veškerý obsah i privátní datová hranice zůstávají v personalspace.js.
function personalspaceSectionNode() {
  const section = document.createElement("section");
  section.className = "app-section app-section-personalspace";
  const body = document.createElement("div");
  body.id = "personalspaceSectionBody";
  body.className = "personalspace-body";
  section.append(body);
  return section;
}

function fillPersonalspaceSection() {
  const body = document.querySelector("#personalspaceSectionBody");
  if (body && state.personalspace) renderPersonalspace(body, state.personalspace);
}

function familyGridNode(families) {
  const grid = document.createElement("div");
  grid.className = "apps-grid";
  grid.append(...families.map((family) => appCard(family.primary, family)));
  return grid;
}

function workspaceSectionNode(section) {
  const company = section.company ?? section.families[0]?.company;
  const modules = section.modules ?? [];
  const moduleCount = section.families.length + modules.length;
  const grid = familyGridNode(section.families);
  grid.append(...modules.map((module) => workspaceModuleCard(module, company)));
  const node = document.createElement("section");
  node.className = "app-section app-section-workspace";
  node.append(
    appSectionHead(null, workspaceLabel(company, section.workspace), pluralModule(moduleCount), {
      count: moduleCount,
    }),
    grid,
  );
  return node;
}

function sectionsWithManifestModules(appSections, families) {
  const moduleSections = workspaceModulesInView(families);
  if (moduleSections.length === 0) return appSections;
  const byWorkspace = new Map(appSections.map((section) => [section.workspace, { ...section, modules: [] }]));
  for (const moduleSection of moduleSections) {
    const current = byWorkspace.get(moduleSection.workspace);
    if (current) {
      current.modules = moduleSection.modules;
    } else {
      byWorkspace.set(moduleSection.workspace, { ...moduleSection, families: [] });
    }
  }
  return [...byWorkspace.values()].filter((section) => section.families.length > 0 || (section.modules?.length ?? 0) > 0);
}

function workspaceModulesInView(families) {
  if (state.filters.company === "all") return [];
  if (state.filters.status !== "all" || state.filters.attentionOnly) return [];
  const organization = state.companies.find((company) => company.slug === state.filters.company);
  if (!organization) return [];
  const appModules = new Set(families.map((family) => family.module).filter(Boolean));
  const query = state.filters.query.trim().toLowerCase();
  return (organization.workspaces ?? [])
    .map((workspace) => ({
      company: organization.slug,
      workspace: workspace.slug,
      modules: (workspace.modules ?? [])
        .filter((module) => !appModules.has(module.slug))
        .filter((module) => moduleMatchesQuery(module, query)),
    }))
    .filter((section) => section.modules.length > 0);
}

function moduleMatchesQuery(module, query) {
  if (!query) return true;
  return [module.name, module.slug, module.path, module.category, module.default_access]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function readonlyDetailInView(detail) {
  if (!detail || state.filters.scope === "personal") return false;
  if (detail.kind === "workspace-module") {
    if (state.filters.company !== detail.company || state.filters.status !== "all" || state.filters.attentionOnly) return false;
    const organization = state.companies.find((company) => company.slug === detail.company);
    const module = (organization?.workspaces ?? [])
      .find((workspace) => workspace.slug === detail.workspace)
      ?.modules?.find((entry) => readonlyDetailKey("workspace-module", detail.company, detail.workspace, entry.slug ?? entry.path ?? entry.name) === detail.id);
    return Boolean(module && moduleMatchesQuery(module, state.filters.query.trim().toLowerCase()));
  }
  if (detail.kind === "productionspace") {
    if (state.filters.company !== detail.company || state.filters.status !== "all" || state.filters.attentionOnly || state.filters.query.trim() !== "") return false;
    const organization = state.companies.find((company) => company.slug === detail.company);
    return Boolean((organization?.productionspace?.systems ?? []).some(
      (system) => readonlyDetailKey("productionspace", detail.company, "productionspace", system.slug ?? system.path ?? system.name) === detail.id,
    ));
  }
  return false;
}

function readonlyDetailKey(kind, company, scope, key) {
  return [kind, company, scope, key].filter(Boolean).join(":");
}

function workspaceModuleDetail(module, companySlug) {
  const workspaceSlug = module.workspace ?? "workspace";
  const organization = state.companies.find((company) => company.slug === companySlug);
  const dependencyState = module.status ?? "invalid_manifest";
  return {
    id: readonlyDetailKey("workspace-module", companySlug, workspaceSlug, module.slug ?? module.path ?? module.name),
    kind: "workspace-module",
    title: module.name ?? module.slug ?? module.path ?? "Workspace modul",
    company: companySlug,
    company_display_name: organization?.display_name ?? companySlug,
    module: module.slug ?? module.path ?? "workspace-module",
    surface: "internal",
    icon: null,
    tags: module.category ? [module.category] : [],
    runtime_status: "unknown",
    dependencies: {
      state: dependencyState,
      message: module.status
        ? "Modul je deklarovaný v organization manifestu, ale zatím nemá spustitelný app manifest."
        : "Chybí app manifest pro lifecycle akce v Launchpadu.",
      can_start: false,
    },
    package_path: module.path ?? "-",
    cwd: module.path ?? "-",
    can_open_folder: module.status === "available",
    is_readonly_system: true,
    readonly_reason: module.status === "available"
      ? "Modul nemá vlastní aplikaci, ale jeho lokální složku můžeš otevřít a pracovat s ní."
      : "Modul nemá vlastní aplikaci a jeho lokální složka zatím není dostupná.",
  };
}

function workspaceModuleCard(module, companySlug) {
  const detail = workspaceModuleDetail(module, companySlug);
  const selected = state.selectedReadonlyDetail?.id === detail.id;
  const openable = detail.can_open_folder;
  const card = document.createElement("article");
  card.className = `app-card system-card manifest-module-card ${openable ? "is-openable" : "is-readonly is-unavailable"} ${selected ? "selected" : ""}`.trim();
  card.dataset.readonlyDetailId = detail.id;
  card.tabIndex = 0;
  card.setAttribute("aria-label", openable ? `Otevřít složku ${detail.title}` : `${detail.title} — detail`);

  const head = document.createElement("div");
  head.className = "app-card-head";
  const titleBlock = document.createElement("div");
  titleBlock.className = "app-title-block";
  titleBlock.append(appIconNode(detail));
  const titleBody = document.createElement("div");
  titleBody.className = "app-title-body";
  const titleRow = document.createElement("div");
  titleRow.className = "app-card-title-row";
  const title = document.createElement("h3");
  title.className = "app-card-title";
  title.textContent = module.name ?? humanizeModuleSlug(module.slug);
  titleRow.append(title);
  const desc = document.createElement("p");
  desc.className = "app-card-desc";
  desc.textContent = openable
    ? appDescription(detail)
    : module.status === "missing_access"
      ? "Modul není na tomto počítači dostupný."
      : "Modul je zatím naplánovaný, ale ještě není připravený.";
  titleBody.append(titleRow, desc);
  titleBlock.append(titleBody);
  head.append(titleBlock);
  if (openable) {
    const cue = document.createElement("span");
    cue.className = "app-open-cue";
    cue.setAttribute("aria-hidden", "true");
    cue.innerHTML = iconOpenGlyph();
    head.append(cue);
  }
  card.append(head);
  card.addEventListener("click", (event) => {
    if (!shouldOpenFromCardSurface(event.target)) return;
    if (openable) void openWorkspaceModuleFolder(detail);
    else selectReadonlyDetail(detail);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (openable) void openWorkspaceModuleFolder(detail);
    else selectReadonlyDetail(detail);
  });
  return card;
}

// Productionspace systems are read-only references to externally-developed repos
// with their own rules — never lifecycle apps.
function productionspaceSectionNode(entry) {
  const node = document.createElement("section");
  node.className = "app-section app-section-productionspace";
  node.append(
    appSectionHead(
      "Productionspace",
      entry.productionspace.display_name ?? "Productionspace",
      `${pluralSystem(entry.productionspace.systems.length)} · externě spravované`,
      { count: entry.productionspace.systems.length },
    ),
  );
  const note = document.createElement("p");
  note.className = "app-section-note";
  note.textContent = "Release a runtime systémy s vlastními pravidly. V Launchpadu jen pro čtení, nespouští se odsud.";
  node.append(note);
  const grid = document.createElement("div");
  grid.className = "apps-grid";
  grid.append(...entry.productionspace.systems.map((system) => productionspaceCard(system, entry)));
  node.append(grid);
  return node;
}

function productionspaceCard(system, entry) {
  const detail = productionspaceDetail(system, entry);
  const selected = state.selectedReadonlyDetail?.id === detail.id;
  const card = document.createElement("article");
  card.className = `app-card system-card is-readonly ${selected ? "selected" : ""}`.trim();
  card.dataset.readonlyDetailId = detail.id;
  card.tabIndex = 0;
  card.setAttribute("aria-label", `${detail.title} — detail`);

  const head = document.createElement("div");
  head.className = "app-card-head";
  const icon = document.createElement("span");
  icon.className = "app-card-icon";
  icon.style.cssText = appIconStyle("system");
  icon.innerHTML = appIconSvg("system");
  const titles = document.createElement("div");
  titles.className = "app-card-titles";
  const titleRow = document.createElement("div");
  titleRow.className = "app-card-title-row";
  const title = document.createElement("h3");
  title.className = "app-card-title";
  title.textContent = system.name;
  titleRow.append(title);
  const sub = document.createElement("p");
  sub.className = "app-card-sub";
  sub.textContent = `${entry.companyName} · productionspace`;
  titles.append(titleRow, sub);
  head.append(icon, titles);

  const badges = document.createElement("div");
  badges.className = "app-card-badges";
  badges.append(chip("Productionspace", "chip-prod"), chip(entry.productionspace.status ?? "candidate", "chip-muted"));
  // Readiness slotu (decision 0042) i pro productionspace systémy — např.
  // deklarovaný firmware bez lokálního checkoutu.
  if (system.status === "missing_access") badges.append(slotAccessChip(system));
  if (system.status === "planned_slot") badges.append(chip("planned slot", "chip-warn"));

  const path = document.createElement("p");
  path.className = "app-card-endpoint";
  path.textContent = system.path;

  const actions = document.createElement("div");
  actions.className = "app-card-actions";
  const readonly = cardActionButton("Jen pro čtení", null, true);
  readonly.classList.add("primary-action", "btn", "btn-ghost");
  actions.append(readonly);

  card.append(head, badges, path, actions);
  card.addEventListener("click", (event) => {
    if (!shouldOpenFromCardSurface(event.target)) return;
    selectReadonlyDetail(detail);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectReadonlyDetail(detail);
  });
  return card;
}

function slotAccessChip(slot) {
  const blocking = slot.readiness?.severity === "blocking"
    || !slot.readiness;
  const node = chip(blocking ? "Chybí očekávaný přístup" : "Očekávaně omezený přístup", blocking ? "chip-danger" : "chip-muted");
  node.title = slot.readiness?.message ?? "Závažnost vychází z access deklarace modulu.";
  return node;
}

function productionspaceDetail(system, entry) {
  const dependencyState = system.status === "missing_access" || system.status === "planned_slot"
    ? system.status
    : "restricted";
  return {
    id: readonlyDetailKey("productionspace", entry.company, "productionspace", system.slug ?? system.path ?? system.name),
    kind: "productionspace",
    title: system.name,
    company: entry.company,
    company_display_name: entry.companyName,
    module: system.slug ?? system.path ?? "productionspace",
    surface: "productionspace",
    icon: "system",
    runtime_status: "unknown",
    dependencies: {
      state: dependencyState,
      message: "Productionspace repozitář má vlastní pravidla mimo Launchpad lifecycle.",
      can_start: false,
    },
    package_path: system.path ?? "-",
    cwd: system.path ?? "-",
    is_productionspace: true,
    is_readonly_system: true,
    readonly_reason: "Productionspace systémy jsou v Launchpadu jen pro čtení. Nespouštějí se ani nereleasují z rootu bez explicitní policy.",
  };
}

// Section header in GEN2 group style (port web/app.js app-group-head:2728–2737):
// eyebrow and a title row with the title, count badge and its unit.
function appSectionHead(eyebrow, title, meta, { count } = {}) {
  const head = document.createElement("header");
  head.className = "app-section-head";
  const titleRow = document.createElement("div");
  titleRow.className = "app-section-title-row";
  const titleNode = document.createElement("h2");
  titleNode.className = "app-section-title";
  titleNode.textContent = title;
  titleRow.append(titleNode);
  if (Number.isFinite(count)) {
    const countNode = document.createElement("span");
    countNode.className = "app-section-count";
    countNode.textContent = String(count);
    titleRow.append(countNode);
  }
  if (eyebrow) {
    const eyebrowNode = document.createElement("span");
    eyebrowNode.className = "app-section-eyebrow";
    eyebrowNode.textContent = eyebrow;
    head.append(eyebrowNode);
  }
  if (meta) {
    const metaNode = document.createElement("span");
    metaNode.className = "app-section-meta";
    metaNode.textContent = meta;
    titleRow.append(metaNode);
  }
  head.append(titleRow);
  return head;
}

// Productionspace is organization-scoped infrastructure: surfaced only when a
// single org is in focus and the user isn't actively filtering apps.
function productionspaceInView() {
  if (state.filters.company === "all") return [];
  if (state.filters.query.trim() !== "" || state.filters.status !== "all" || state.filters.attentionOnly) return [];
  const org = state.companies.find((company) => company.slug === state.filters.company);
  if (!org?.productionspace || (org.productionspace.systems ?? []).length === 0) return [];
  return [{ company: org.slug, companyName: org.display_name ?? org.slug, productionspace: org.productionspace }];
}

function workspaceLabel(companySlug, workspaceSlug) {
  if (workspaceSlug === null) return "Organizace";
  const org = state.companies.find((company) => company.slug === companySlug);
  const workspace = (org?.workspaces ?? []).find((entry) => entry.slug === workspaceSlug);
  return workspace?.display_name ?? (workspaceSlug === "workspace" ? "Workspace" : workspaceSlug);
}

// Karta modulu (CAC-0044, port GEN2 web/app.js:2666–3095): celá karta je
// klikatelná a spouští one-click open (install → start → otevřít URL), s guardem
// na vnitřní ovládací prvky (shouldOpenFromCardSurface). Ikona/popis jdou z app
// manifestu s čitelnými fallbacky; ⋯ menu vysvětluje hlavní akci a nabízí
// varianty; git chip s lidským textem se vykreslí, jen když je git read model.
function appCard(app, family = { key: app.id, members: [app], primary: app }) {
  const members = family.members;
  const moduleName = familyTitle(members);
  const others = members.filter((member) => member.id !== app.id);
  const selected = members.some((member) => member.id === state.selectedAppId);
  const nextAction = primaryNextAction(app);
  const readOnly = isProductionspace(app) || nextAction.type === "disabled";
  const running = app.runtime_status === "healthy";
  const warning = cardWarningModel(app, gitRepoForApp(app));

  const card = document.createElement("article");
  card.className = `app-card is-${appCardTone(app, warning)} ${selected ? "selected" : ""} ${readOnly ? "is-readonly" : "is-openable"}`.trim();
  card.dataset.appId = app.id;
  card.tabIndex = 0;
  card.setAttribute("aria-label", readOnly ? `${appBaseTitle(app)} — detail` : `Otevřít ${appBaseTitle(app)}`);

  // GEN2-minimal dlaždice (port web/app.js:2875–2896 zjednodušený per owner
  // request 2026-07-05): ikona nad názvem (+ verze) a popisem. Žádný
  // company·module sub-řádek ani trvalé statusové chipy — v čistém zastaveném
  // stavu je karta jen klikatelná dlaždice, která otevře výchozí verzi. ↗ cue a
  // ⋯ menu jsou vpravo nahoře.
  const head = document.createElement("div");
  head.className = "app-card-head";

  const titleBlock = document.createElement("div");
  titleBlock.className = "app-title-block";
  titleBlock.append(appIconNode(app));
  const titleBody = document.createElement("div");
  titleBody.className = "app-title-body";

  // Org kicker: v multi-org „Vše" pohledu můžou splynout moduly z různých
  // Organizací (stejný default workspace slug → jedna sekce bez hlavičky).
  // Nenápadná org značka proto zůstává bez ohledu na zdroj popisu; v single-org
  // nebo filtrovaném pohledu se neukazuje.
  const orgLabel = app.company_display_name ?? app.company;
  if (orgLabel && shouldShowCardOrg()) {
    const org = document.createElement("p");
    org.className = "app-card-org";
    org.textContent = orgLabel;
    titleBody.append(org);
  }

  const titleRow = document.createElement("div");
  titleRow.className = "app-card-title-row";
  const title = document.createElement("h3");
  title.className = "app-card-title";
  title.textContent = moduleName;
  titleRow.append(title);
  const versionBadge = badgeNode(variantTag(app, moduleName));
  if (versionBadge) titleRow.append(versionBadge);

  const desc = document.createElement("p");
  desc.className = "app-card-desc";
  desc.textContent = appDescription(app);

  titleBody.append(titleRow, desc);
  // Jediný povolený stavový chip je „Běží" — a jen když modul opravdu běží.
  if (running) {
    const badges = document.createElement("div");
    badges.className = "app-card-badges";
    badges.append(runtimeChip(app));
    titleBody.append(badges);
  }
  titleBlock.append(titleBody);
  head.append(titleBlock);

  const topActions = document.createElement("div");
  topActions.className = "app-card-top-actions";
  if (!readOnly) {
    const cue = document.createElement("span");
    cue.className = "app-open-cue";
    cue.setAttribute("aria-hidden", "true");
    cue.innerHTML = iconOpenGlyph();
    topActions.append(cue);
  }
  // ⋯ menu drží „další možnosti" (varianty, zastavit, restart, detail/logy).
  // Zobrazí se, jen když je co nabídnout — čistá dlaždice zůstane bez ⋯.
  if (cardHasMenu(app, others)) {
    topActions.append(versionMenuNode(app, others, family.key, moduleName));
  }
  head.append(topActions);

  const feedback = document.createElement("div");
  feedback.className = "card-feedback empty";
  feedback.setAttribute("aria-live", "polite");

  card.append(head);
  // Sofistikovaný warning panel jen když je co řešit: stáhnout novější verzi,
  // nainstalovat/opravit balíčky, nebo vysvětlit blokující/failed stav. Žádná
  // velká trvalá tlačítka — hlavní akce (otevřít) je klik na celou dlaždici.
  if (warning) card.append(cardWarningNode(app, warning));
  // Runtime stages (founder 2026-07-15/16): kompaktní řádek „Kde spustit" pod
  // kartou — čtyři runy jednoho modulu (PROD / MAIN / DEV remote / DEV local).
  // Launchpad nabízí všechny čtyři; Dashboard by otevřel jen PROD. DEV local
  // znovu používá stejný one-click open, není to druhý běhový mechanismus.
  // Progressive disclosure (founder 2026-07-16): řádek se ukáže, jen když modul
  // nabízí víc než výchozí DEV local (= klik na dlaždici) — jinak žádná tlačítka.
  const stagesRow = renderRuntimeStages(app, readOnly, feedback);
  if (stagesRow) card.append(stagesRow);
  card.append(feedback);

  if (readOnly) {
    // Read-only karta jen vybere modul do detailu.
    card.addEventListener("click", (event) => {
      if (!shouldOpenFromCardSurface(event.target)) return;
      selectAppDetail(app.id);
    });
    card.addEventListener("keydown", (event) => {
      if (event.target !== card) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectAppDetail(app.id);
    });
  } else {
    // Openable karta: klik na plochu (mimo tlačítka/menu) spustí one-click open.
    card.addEventListener("click", (event) => {
      if (!shouldOpenFromCardSurface(event.target)) return;
      void openAppChain(app, { feedback });
    });
    card.addEventListener("keydown", (event) => {
      if (event.target !== card) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void openAppChain(app, { feedback });
    });
  }

  return card;
}

// Runtime stages řádek (founder 2026-07-15/16, refactor 2026-07-16 densita):
// jeden modul = jedna karta; karta nabízí čtyři runy jednoho modulu jako JEDEN
// kompaktní řádek pilulek (PROD · MAIN · DEV remote · DEV local), ne 2×2 mřížku
// s odstavci. Builder surface — čte tooltipy. Řádek sedí POD kartou (ne nový
// panel). Popisky (caption) a důvody (reason) žijí v title tooltipu + aria-label,
// NE jako viditelný text pod kartou. PROD je skutečný odkaz do nové karty, když
// modul deklaruje production_url; jinak honest disabled pilulka. MAIN a DEV
// remote jsou honest „přes tailnet" stavy, které zatím nejsou propojené. DEV
// local znovu používá stejný one-click open jako klik na dlaždici (openAppChain)
// — žádný duplicitní běhový mechanismus.
// Progressive disclosure (founder 2026-07-16): když je na výběr jen DEV local,
// řádek se NErenderuje — DEV local zůstává implicitní výchozí (klik na dlaždici).
// Jakmile modul nabízí víc (production_url / Workspace-Host run), ukáže se
// PLNÝ řádek všech čtyř runů, nedostupné dimmed jako dřív.
function renderRuntimeStages(app, readOnly, feedback) {
  if (!offersMoreThanLocalRun(app)) return null;
  const stages = runtimeStagesForApp(app, {
    openable: !readOnly,
    worktreeCount: ownedRuntimeWorktrees(app).length,
  });
  const row = document.createElement("div");
  row.className = "runtime-stages";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Kde modul spustit");
  for (const stage of stages) {
    row.append(runtimeStageNode(app, stage, feedback));
  }
  return row;
}

// Title tooltip nese caption (a u disabled stavů i důvod / u PROD i URL) — vše,
// co dřív byl viditelný odstavec, se přesouvá sem.
function runtimeStageTooltip(stage) {
  const parts = [stage.caption];
  if (stage.reason) parts.push(stage.reason);
  else if (stage.action === "open_url" && stage.url) parts.push(stage.url);
  return parts.join(" — ");
}

// Accessible name: „MAIN — <důvod>" u disabled, „PROD — <caption>" u dostupných.
function runtimeStageAriaLabel(stage) {
  return `${stage.label} — ${stage.reason || stage.caption}`;
}

function runtimeStageNode(app, stage, feedback) {
  const stateClass = stage.available ? "is-available" : "is-disabled";
  const tooltip = runtimeStageTooltip(stage);
  const ariaLabel = runtimeStageAriaLabel(stage);

  if (stage.action === "open_url" && stage.url) {
    // PROD: skutečný odkaz na nasazenou instanci, nová karta. Klik nesmí
    // probublat do one-click open dlaždice.
    const link = document.createElement("a");
    link.className = `runtime-stage stage-${stage.stage} ${stateClass}`;
    link.href = stage.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = tooltip;
    link.setAttribute("aria-label", ariaLabel);
    link.textContent = stage.label;
    link.addEventListener("click", (event) => event.stopPropagation());
    return link;
  }

  if (stage.action === "open_local") {
    // DEV local: přesně tentýž one-click open jako klik na dlaždici.
    const button = document.createElement("button");
    button.type = "button";
    button.className = `runtime-stage stage-${stage.stage} ${stateClass}`;
    button.title = tooltip;
    button.setAttribute("aria-label", ariaLabel);
    button.textContent = stage.label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void openAppChain(app, { feedback });
    });
    return button;
  }

  // Nedostupný run: dimmed pilulka, která PROČ říká v tooltipu + aria-label
  // (žádný viditelný odstavec). Non-interaktivní span s aria-disabled, cursor
  // default — uživatel na ni neklikne do prázdna.
  const chip = document.createElement("span");
  chip.className = `runtime-stage stage-${stage.stage} ${stateClass}`;
  chip.setAttribute("aria-disabled", "true");
  chip.title = tooltip;
  chip.setAttribute("aria-label", ariaLabel);
  chip.textContent = stage.label;
  return chip;
}

// Warning model karty (owner request 2026-07-05): v čistém stavu vrací null,
// jinak strukturovaný popis toho, co je potřeba vyřešit. Priorita: blokující
// dependency stav > chybějící/zastaralé balíčky > spadlé spuštění > novější
// verze na mainu. Jen „nainstalovat" a „stáhnout" nesou přímou akci; zbytek
// vysvětluje a posílá do detailu.
function isUntrustedPortOwner(app) {
  return ["foreign-port", "unknown-port"].includes(app.runtime?.owner);
}

function cardWarningModel(app, gitRepo) {
  if (isProductionspace(app)) return null;
  const dependencyState = app.dependencies?.state;

  if (isUntrustedPortOwner(app)) {
    return {
      tone: "danger",
      title: app.runtime?.owner === "foreign-port" ? "Cizí checkout na portu" : "Checkout procesu nelze ověřit",
      detail: app.runtime?.message || "Launchpad nedokázal bezpečně ověřit proces na portu. Otevři detail a vyřeš instanci mimo Launchpad.",
      actionLabel: "Zobrazit detail",
      run: () => revealAppDetail(app),
    };
  }

  // Blokující dependency stavy: modul teď nejde spustit — vysvětli proč (bez
  // one-click akce, řešení patří do detailu / doctora).
  if (["missing_access", "planned_slot", "restricted", "invalid_manifest", "missing_package", "unknown_package_manager"].includes(dependencyState)) {
    return {
      tone: "danger",
      title: humanDependencyLabel(dependencyState),
      detail: app.dependencies?.message || "Modul teď nejde spustit. Otevři detail pro další krok.",
    };
  }

  // Chybí nebo jsou zastaralé balíčky: nainstaluj/oprav před prvním spuštěním.
  if ((dependencyState === "needs_install" || dependencyState === "stale_lockfile") && canInstall(app)) {
    return {
      tone: "warn",
      title: dependencyState === "needs_install" ? "Chybí balíčky" : "Balíčky k opravě",
      detail:
        dependencyState === "needs_install"
          ? "Modul ještě nemá nainstalované balíčky. Nainstaluj je před prvním spuštěním."
          : "Zámek balíčků je zastaralý. Oprav balíčky, ať start proběhne čistě.",
      actionLabel: installLabel(app),
      run: () => runRuntimeAction(app, installAction(app)),
      pending: `${app.id}:${installAction(app)}`,
    };
  }

  // Poslední spuštění spadlo: pošli do detailu k logům.
  if (app.runtime_status === "unhealthy") {
    return {
      tone: "danger",
      title: "Spuštění selhalo",
      detail: "Poslední spuštění spadlo. Otevři detail a podívej se do logů.",
      actionLabel: "Zobrazit logy",
      run: () => revealAppDetail(app),
    };
  }

  if (canAutostashPull(gitRepo)) {
    const incoming = Number(gitRepo.counts?.incoming) || 0;
    return {
      tone: "warn",
      title: `Nová verze - ${incoming} změn`,
      actionLabel: "Stáhnout",
      actionStyle: "secondary",
      run: () => pullLatestRepoVersion(app, gitRepo, { autostash: true }),
      pending: `${app.id}:git-pull`,
    };
  }

  // Novější verze na mainu: bezpečný fast-forward pull (guarded na serveru).
  if (gitRepo && gitRepo.status === "pull_available") {
    const incoming = Number(gitRepo.counts?.incoming) || 0;
    return {
      tone: "warn",
      title: `Nová verze - ${incoming} změn`,
      actionLabel: "Stáhnout",
      actionStyle: "secondary",
      run: () => pullLatestRepoVersion(app, gitRepo),
      pending: `${app.id}:git-pull`,
    };
  }

  if (gitRepo?.status === "push_required") {
    return {
      tone: "warn",
      title: "Změny k odeslání",
      actionLabel: "Zobrazit detail",
      actionStyle: "secondary",
      run: () => revealAppDetail(app),
    };
  }

  // Ostatní git stavy „ke kontrole" (rozdělaná práce, čeká na odeslání, jiný
  // režim, diverged…) nemají bezpečnou one-click akci — jen vysvětli lidsky
  // a pošli do detailu, ať karta při zapnutém kontrolním togglu nikdy nevisí bez důvodu.
  const gitModel = gitChipModel(gitRepo);
  if (gitModel && gitModel.attention) {
    return {
      tone: gitModel.tone === "danger" ? "danger" : "warn",
      title: `Ke kontrole: ${gitModel.label}`,
      detail: gitModel.message || "Tenhle modul je ke kontrole. Otevři detail pro další krok.",
      actionLabel: "Zobrazit detail",
      run: () => revealAppDetail(app),
    };
  }

  return null;
}

// Inline warning panel na kartě: ikona + nadpis/vysvětlení + volitelné akční
// tlačítko. Git upozornění používají klidnější sekundární akci; instalační
// upozornění zůstává primární, protože bez ní aplikaci nejde otevřít.
// Tlačítko zastaví propagaci, aby neotevřelo kartu.
function cardWarningNode(app, warning) {
  const node = document.createElement("div");
  node.className = `card-warning is-${warning.tone}`;

  const icon = document.createElement("span");
  icon.className = "card-warning-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = warningGlyph(warning.tone);

  const body = document.createElement("div");
  body.className = "card-warning-body";
  const title = document.createElement("strong");
  title.className = "card-warning-title";
  title.textContent = warning.title;
  body.append(title);
  if (warning.detail) {
    const detail = document.createElement("p");
    detail.className = "card-warning-detail";
    detail.textContent = warning.detail;
    body.append(detail);
  }

  node.append(icon, body);

  if (warning.actionLabel && typeof warning.run === "function") {
    const button = document.createElement("button");
    button.type = "button";
    const actionClass = warning.actionStyle === "secondary"
      ? "btn-secondary"
      : warning.tone === "warn"
        ? "btn-primary"
        : "btn-ghost";
    button.className = `btn btn-sm card-warning-action ${actionClass}`;
    button.textContent = warning.actionLabel;
    button.disabled = warning.pending ? state.pendingAction === warning.pending : false;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      warning.run();
    });
    node.append(button);
  }

  return node;
}

function warningGlyph(tone) {
  const paths =
    tone === "danger"
      ? '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
      : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>';
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// Vybere modul do detailu a odroluje na detail panel — cíl „Zobrazit detail
// a logy" z ⋯ menu i z warning panelu.
function revealAppDetail(app) {
  selectAppDetail(app.id);
  elements.appDetail?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Org kicker se ukáže jen v pohledu, kde můžou splynout moduly z různých
// Organizací — tj. filtr Organizace = „Vše" a je namountovaná víc než jedna.
function shouldShowCardOrg() {
  return state.filters.company === "all" && state.companies.length > 1;
}

// ⋯ menu se ukáže, jen když má obsah: víc verzí modulu nebo runtime/detail akce.
function cardHasMenu(app, others) {
  return others.length > 0 || cardMenuActions(app).length > 0;
}

// „Další možnosti" pod ⋯: zastavit/restart instance vlastněné aktuálním
// Launchpadem i procesy adoptované podle app-owned portu a přístup do
// detailu/logů. Čistá zastavená dlaždice nevrací nic (žádné ⋯).
function cardMenuActions(app) {
  const actions = [];
  if (canStop(app)) {
    actions.push({ label: "Zastavit", run: () => runRuntimeAction(app, "stop"), pending: `${app.id}:stop` });
  }
  if (canRestart(app)) {
    actions.push({ label: "Restart", run: () => runRuntimeAction(app, "restart"), pending: `${app.id}:restart` });
  }
  // Detail/logy nabídni, jen když je co zkoumat — běžící, spadlá nebo vlastněná
  // instance.
  if (actions.length > 0 || app.runtime_status === "healthy" || app.runtime_status === "unhealthy") {
    actions.push({ label: "Zobrazit detail a logy", run: () => revealAppDetail(app) });
  }
  return actions;
}

// Řádek akce v ⋯ menu (odlišný od variant option řádku): jednoduché tlačítko,
// po kliknutí menu zavře.
function menuActionRow(action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "app-menu-action";
  button.textContent = action.label;
  button.disabled = action.pending ? state.pendingAction === action.pending : false;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    button.closest("details")?.removeAttribute("open");
    state.openVersionMenu = null;
    action.run();
  });
  return button;
}

// Guard na vnitřní ovládací prvky (port GEN2 shouldOpenFromCardSurface,
// web/app.js:3003–3017): klik na tlačítko/odkaz/menu neotevírá kartu.
function shouldOpenFromCardSurface(target) {
  return !(
    target instanceof Element &&
    target.closest("button, a, summary, details, input, select, textarea")
  );
}

// One-click open chain (CAC-0044, step-003): rezervace tabu → průběh → toast →
// klasifikace chyb (port GEN2 web/app.js:2900–2994, 2938–2950).
async function openAppChain(app, { feedback } = {}) {
  if (state.openingApps.has(app.id)) return;
  state.openingApps.add(app.id);
  // Rezervace tabu PŘED akcí, aby ho prohlížeč nezablokoval (není to
  // asynchronní window.open po fetchi).
  const reservedTab = reserveResultTab(app);
  writeCardProgress(feedback, "Otevírám", { loading: true });
  writeReservedTabStatus(reservedTab, app, "Spouštím aplikaci...");
  render();
  try {
    const payload = await fetchJson(`/api/apps/${encodeURIComponent(app.id)}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: sourcePayloadForApp(app) }),
    });
    if (payload.url) {
      writeCardProgress(feedback, "");
      toast(`${appBaseTitle(app)}: ${translateOpenStatus(payload)}`, "success");
      openResultUrl(payload.url, reservedTab, app);
    } else if (payload.status === "starting") {
      toast(`${appBaseTitle(app)}: startuje, otevřu ji hned jak naběhne`, "info", 6000);
      const runtime = await waitForOpenRuntime(app, { reservedTab, feedback });
      writeCardProgress(feedback, "");
      toast(`${appBaseTitle(app)}: běží, otevírám`, "success");
      openResultUrl(runtime.url ?? app.url, reservedTab, app);
    } else if (payload.status === "healthy" && (payload.runtime?.url || app.url)) {
      writeCardProgress(feedback, "");
      toast(`${appBaseTitle(app)}: běží, otevírám`, "success");
      openResultUrl(payload.runtime?.url ?? app.url, reservedTab, app);
    } else {
      throw new Error(
        payload.runtime?.last_error
          ?? payload.runtime?.message
          ?? payload.message
          ?? "Launchpad nedostal URL běžící aplikace.",
      );
    }
    await loadData({ quiet: true });
  } catch (error) {
    closeReservedTab(reservedTab);
    const message = error instanceof Error ? error.message : String(error);
    writeCardProgress(feedback, classifyOpenError(message));
    toast(`${appBaseTitle(app)}: ${classifyOpenError(message)}`, "error", 6000);
  } finally {
    state.openingApps.delete(app.id);
    render();
  }
}

async function openWorkspaceModuleFolder(module) {
  if (!module?.company || !module?.cwd || !module.can_open_folder) return;
  const pendingKey = `${module.id}:open-folder`;
  if (state.pendingAction === pendingKey) return;
  state.pendingAction = pendingKey;
  render();
  try {
    await fetchJson("/api/modules/open-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organization: module.company,
        module_path: module.cwd,
      }),
    });
    toast(`${module.title}: složka otevřená.`, "success");
  } catch (error) {
    toast(`${module.title}: ${error.message}`, "error", 7000);
  } finally {
    state.pendingAction = null;
    render();
  }
}

function reserveResultTab(app) {
  const tab = window.open("about:blank", "_blank");
  if (tab) {
    tab.opener = null;
    try {
      tab.document.title = `Spouštím ${appBaseTitle(app)}`;
    } catch {}
  }
  return tab;
}

function writeReservedTabStatus(tab, app, message) {
  if (!tab || tab.closed) return;
  try {
    tab.document.open();
    tab.document.write(`<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Spouštím ${escapeHtml(appBaseTitle(app))}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17133f;background:#f8f7ff}
    main{max-width:28rem;padding:2rem;text-align:center}
    .mark{width:3rem;height:3rem;margin:0 auto 1rem;border-radius:1rem;background:#ebe7ff;color:#6d5dfc;display:grid;place-items:center;font-size:1.5rem}
    h1{margin:0 0 .5rem;font-size:1.25rem}
    p{margin:0;color:#6b668a;line-height:1.5}
  </style>
</head>
<body>
  <main>
    <div class="mark">↗</div>
    <h1>${escapeHtml(message)}</h1>
    <p>${escapeHtml(appBaseTitle(app))} se otevře v tomhle panelu, jakmile odpoví health endpoint.</p>
  </main>
</body>
</html>`);
    tab.document.close();
  } catch {}
}

async function waitForOpenRuntime(app, { reservedTab, feedback } = {}) {
  const deadline = Date.now() + OPEN_STARTING_WAIT_MS;
  let lastRuntime = null;
  while (Date.now() < deadline) {
    writeCardProgress(feedback, "Aplikace ještě startuje", { loading: true });
    writeReservedTabStatus(reservedTab, app, "Aplikace ještě startuje...");
    await sleep(OPEN_STARTING_POLL_MS);
    const runtime = await fetchJson(`/api/apps/${encodeURIComponent(app.id)}/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: sourcePayloadForApp(app) }),
    });
    lastRuntime = runtime;
    if (runtime.status === "healthy") return runtime;
    if (runtime.status === "unhealthy" || runtime.status === "stopped") {
      const message = runtime.last_error ?? runtime.message ?? "Aplikace se po startu nerozeběhla.";
      throw new Error(message);
    }
  }
  throw new Error(lastRuntime?.message ?? "Aplikace pořád startuje a health endpoint zatím neodpovídá.");
}

function openResultUrl(url, reservedTab, app) {
  if (reservedTab && !reservedTab.closed) {
    reservedTab.location.href = url;
    return;
  }
  if (!window.open(url, "_blank", "noopener")) {
    toast(`${appBaseTitle(app)}: prohlížeč zablokoval nové okno.`, "warn", 6000);
  }
}

function closeReservedTab(reservedTab) {
  if (reservedTab && !reservedTab.closed) reservedTab.close();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function writeCardProgress(feedback, message, { loading = false } = {}) {
  if (!feedback) return;
  feedback.replaceChildren();
  if (!message) {
    feedback.className = "card-feedback empty";
    return;
  }
  feedback.className = "card-feedback is-progress";
  const note = document.createElement("p");
  note.className = "progress-note";
  if (loading) {
    note.append(
      document.createTextNode(message.replace(/…$/, "")),
      Object.assign(document.createElement("span"), { className: "loading-dots", ariaHidden: "true" }),
    );
  } else {
    note.textContent = message;
  }
  feedback.append(note);
}

function translateOpenStatus(payload) {
  const reused = (payload.steps ?? []).some((step) => step.step === "reuse");
  const installed = (payload.steps ?? []).some((step) => step.step === "install" || step.step === "repair");
  // Když server ještě čeká, až dev server začne poslouchat (žádné URL, status
  // 'starting'), řekni to na rovinu místo falešného „spuštěno".
  if (payload.status === "starting" && !payload.url) return "startuje, otevře se za chvíli";
  if (reused) return "už běží, otevírám";
  if (installed) return "nainstalováno a spuštěno";
  return "spuštěno";
}

// Klasifikace chyb one-click chainu do lidského jazyka (port GEN2 vzoru).
// Port kolize je blokující stav — žádný tichý fallback (decision 0049).
function classifyOpenError(message) {
  const text = String(message ?? "");
  if (/port/i.test(text) && /(obsazen|conflict|kolize|PID|EADDRINUSE|in use)/i.test(text)) {
    return "Port aplikace je obsazený jiným procesem. Zavři starou instanci nebo uvolni port.";
  }
  if (/already[_ ]?running|už běží/i.test(text)) {
    return "Aplikace už běží. Zkus ji jen otevřít nebo restartovat z menu.";
  }
  if (/install|balíč|dependency|needs_install/i.test(text)) {
    return "Nepodařilo se doinstalovat balíčky. Otevři detail a zkontroluj logy.";
  }
  if (/pořád startuje|ještě startuje|health endpoint|start timeout/i.test(text)) {
    return "Aplikace startuje moc dlouho. Launchpad ji dál neumí potvrdit přes health endpoint; otevři detail a logy.";
  }
  if (/not[_ ]?ready|app_not_ready|restricted|missing_access/i.test(text)) {
    return "Modul zatím není připravený ke spuštění. Otevři detail pro další krok.";
  }
  return "Spuštění se nepovedlo. Otevři detail aplikace a podívej se na logy.";
}

function badgeNode(label) {
  if (!label) return null;
  const badge = document.createElement("span");
  badge.className = "app-version-badge";
  badge.textContent = label;
  return badge;
}

// "More variants" dropdown: lists the non-default apps of a module (other
// versions or named sub-apps) so the default stays the face of the card and the
// rest are one click away.
function versionMenuNode(primary, others, familyKey, moduleName) {
  const details = document.createElement("details");
  details.className = "app-version-menu";
  details.open = state.openVersionMenu === familyKey;
  details.addEventListener("click", (event) => event.stopPropagation());

  const anyRunning = others.some((app) => app.runtime_status === "healthy");
  const summary = document.createElement("summary");
  summary.className = `app-more-button ${anyRunning ? "has-running" : ""}`.trim();
  summary.setAttribute("aria-label", "Další možnosti modulu");
  summary.title = "Další možnosti";
  summary.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
  summary.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.openVersionMenu = state.openVersionMenu === familyKey ? null : familyKey;
    render();
  });

  const panel = document.createElement("div");
  panel.className = "app-version-menu-panel";

  // Sekce 1 — varianty modulu (jiné verze / vedlejší aplikace). Note vysvětluje,
  // co dělá klik na dlaždici a že varianty se otevřou stejným jedním klikem.
  if (others.length > 0) {
    const note = document.createElement("p");
    note.className = "app-version-menu-note";
    const defaultTag = variantTag(primary, moduleName);
    note.textContent = defaultTag
      ? `Klik na dlaždici otevře výchozí verzi ${defaultTag}. Ostatní verze modulu se otevřou stejným jedním klikem.`
      : "Klik na dlaždici otevře tenhle modul. Vedlejší verze se otevřou stejným jedním klikem.";
    panel.append(note, ...others.map((app) => versionOptionNode(app, moduleName)));
  }

  // Sekce 2 — runtime / detail akce (zastavit, restart, detail a logy). Oddělené
  // od variant tenkým dividerem, když jsou obě sekce přítomné.
  const actions = cardMenuActions(primary);
  if (actions.length > 0) {
    if (others.length > 0) {
      const divider = document.createElement("div");
      divider.className = "app-menu-divider";
      divider.setAttribute("role", "separator");
      panel.append(divider);
    }
    panel.append(...actions.map((action) => menuActionRow(action)));
  }

  details.append(summary, panel);
  return details;
}

// Položka varianty v ⋯ menu: „Otevřít <varianta> — port · popis · stav"
// (port GEN2). Jeden klik = one-click open té varianty.
function versionOptionNode(app, moduleName) {
  const opening = state.openingApps.has(app.id);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "app-version-option";
  const label = document.createElement("strong");
  label.textContent = `${opening ? "Otevírám" : "Otevřít"} ${variantMenuLabel(app, moduleName)}`;
  const meta = document.createElement("small");
  meta.textContent = variantOptionDescription(app);
  const cue = document.createElement("span");
  cue.className = "app-version-option-cue";
  cue.setAttribute("aria-hidden", "true");
  cue.innerHTML = iconOpenGlyph();
  const text = document.createElement("span");
  text.className = "app-version-option-text";
  text.append(label, meta);
  button.append(text, cue);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    button.closest("details")?.removeAttribute("open");
    state.openVersionMenu = null;
    void openAppChain(app, {});
  });
  return button;
}

// Popis varianty: port · lidský stav (a případně krátký git stav).
function variantOptionDescription(app) {
  const parts = [`port ${app.port}`, humanRuntimeLabel(app.runtime_status)];
  const gitChip = gitChipModel(gitRepoForApp(app));
  if (gitChip && gitChip.attention) parts.push(gitChip.label);
  return parts.join(" · ");
}

function appIconNode(app) {
  const span = document.createElement("span");
  span.className = "app-card-icon";
  const style = appIconStyle(appIconKey(app));
  span.style.cssText = style;
  span.innerHTML = appIconSvg(appIconKey(app));
  return span;
}

function appCardTone(app, warning) {
  // Běžící modul má vždy „running" tón (zelený proužek) i s dostupnou novější
  // verzí — pull banner uvnitř karty už attention signalizuje.
  if (app.runtime_status === "healthy") return "running";
  // Warning model je autorita tónu pro zastavené karty; danger → blocked,
  // warn → attention.
  if (warning?.tone === "danger") return "blocked";
  if (warning?.tone === "warn") return "attention";
  // Fallback pro edge-case bez warningu (např. needs_install bez can_install).
  const dependencyState = app.dependencies?.state;
  if (["missing_package", "unknown_package_manager", "invalid_manifest", "missing_access", "restricted", "runtime_failed"].includes(dependencyState)) {
    return "blocked";
  }
  if (["needs_install", "stale_lockfile", "planned_slot"].includes(dependencyState)) {
    return "attention";
  }
  if (app.runtime_status === "unhealthy") return "blocked";
  return "ready";
}

function runtimeChip(app) {
  const tone =
    app.runtime_status === "healthy"
      ? "chip-success"
      : app.runtime_status === "unhealthy"
        ? "chip-danger"
        : app.runtime_status === "starting"
          ? "chip-warn"
          : "chip-muted";
  return chip(humanRuntimeLabel(app.runtime_status), tone, app.runtime_status === "healthy");
}

function dependencyChip(app) {
  const dependencyState = app.dependencies?.state;
  let tone = "chip-muted";
  if (dependencyState === "ready") tone = "chip-success";
  else if (["needs_install", "stale_lockfile", "planned_slot"].includes(dependencyState)) tone = "chip-warn";
  else if (["missing_package", "unknown_package_manager", "missing_access", "restricted", "invalid_manifest", "runtime_failed"].includes(dependencyState)) tone = "chip-danger";
  return chip(humanDependencyLabel(dependencyState), tone);
}

function chip(label, toneClass, withDot = false) {
  const node = document.createElement("span");
  node.className = `chip ${toneClass}`;
  if (withDot) {
    const dot = document.createElement("span");
    dot.className = "chip-dot";
    node.append(dot);
  }
  node.append(document.createTextNode(label));
  return node;
}

function primaryActionNode(app, nextAction) {
  let node;
  if (nextAction.type === "folder") {
    node = cardActionButton(
      nextAction.label,
      () => openWorkspaceModuleFolder(app),
      state.pendingAction === `${app.id}:open-folder`,
    );
  } else if (nextAction.type === "open" && app.url) {
    node = openLink(app.url);
    node.textContent = nextAction.label;
  } else if (nextAction.type === "logs") {
    node = cardActionButton(nextAction.label, () => loadLogs(app), state.pendingAction === `${app.id}:logs`);
  } else if (nextAction.type === "runtime") {
    node = cardActionButton(
      nextAction.label,
      () => runRuntimeAction(app, nextAction.action),
      state.pendingAction === `${app.id}:${nextAction.action}`,
    );
  } else {
    node = cardActionButton(nextAction.label, null, true);
  }
  node.classList.add("primary-action");
  if (node.tagName === "BUTTON") node.classList.add("btn", "btn-primary");
  return node;
}

function cardActionButton(label, onClick, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = Boolean(disabled);
  if (onClick) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
  }
  return button;
}

function primaryNextAction(app) {
  const dependencyState = app.dependencies?.state;
  if (app.kind === "workspace-module" && app.can_open_folder) {
    return { type: "folder", label: "Otevřít složku" };
  }
  if (isProductionspace(app) || app.is_readonly_system) {
    return { type: "disabled", label: "Jen pro čtení" };
  }
  if (isUntrustedPortOwner(app)) {
    return {
      type: "disabled",
      label: app.runtime?.owner === "foreign-port" ? "Cizí checkout na portu" : "Checkout procesu nelze ověřit",
    };
  }
  if (dependencyState === "needs_install") {
    return { type: "runtime", action: "install", label: "Instalovat" };
  }
  if (dependencyState === "stale_lockfile") {
    return { type: "runtime", action: "repair", label: "Opravit balíčky" };
  }
  if (["missing_access", "planned_slot", "restricted", "invalid_manifest", "missing_package", "unknown_package_manager"].includes(dependencyState)) {
    return { type: "disabled", label: humanDependencyLabel(dependencyState) };
  }
  if (app.runtime_status === "healthy" && app.url) {
    return { type: "open", label: "Otevřít" };
  }
  if (app.runtime_status === "unhealthy") {
    return { type: "logs", label: "Logy" };
  }
  if (canStart(app)) {
    return { type: "runtime", action: "start", label: "Spustit" };
  }
  return { type: "logs", label: "Logy" };
}

function isAttention(app) {
  return isAttentionState(app);
}

function isProductionspace(app) {
  return Boolean(app.is_productionspace) || app.surface === "productionspace";
}

function policyLabel(app) {
  return isProductionspace(app)
    ? "Productionspace: lifecycle akce jsou jen pro čtení, dokud nebude schválená policy."
    : "Workspace aplikace: lokální Instalovat/Opravit/Spustit jsou povolené, když projdou preconditions.";
}

/* =========================================================
   Debug table (kept as engineering fallback)
   ========================================================= */

function renderApps(apps) {
  if (apps.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = "Žádné aplikace";
    row.append(cell);
    elements.appsTable.replaceChildren(row);
    return;
  }

  elements.appsTable.replaceChildren(
    ...apps.map((app) => {
      const row = document.createElement("tr");
      row.className = app.id === state.selectedAppId ? "selected" : "";
      row.addEventListener("click", () => {
        selectAppDetail(app.id);
      });
      row.append(
        tableCell(appTitle(app)),
        tableCell(textBlock(app.company_display_name ?? app.company, app.company)),
        tableCell(surfaceLabel(app.surface)),
        tableCell(`${app.host}:${app.port}`),
        tableCell(runtimeNode(app)),
        tableCell(dependencyNode(app)),
        tableCell(pathNode(app.package_path)),
        tableCell(actionButtons(app)),
      );
      return row;
    }),
  );
}

function appTitle(app) {
  const wrapper = document.createElement("div");
  const title = document.createElement("span");
  title.className = "app-title";
  title.textContent = app.title;
  const subtitle = document.createElement("span");
  subtitle.className = "app-subtitle";
  subtitle.textContent = app.module ? `${app.id} / ${app.module}` : app.id;
  wrapper.append(title, subtitle, tagsNode(app.tags ?? []));
  return wrapper;
}

function textBlock(primary, secondary) {
  const wrapper = document.createElement("div");
  const strong = document.createElement("span");
  strong.className = "app-title";
  strong.textContent = primary;
  const small = document.createElement("span");
  small.className = "app-subtitle";
  small.textContent = secondary;
  wrapper.append(strong, small);
  return wrapper;
}

function pathNode(path) {
  const node = document.createElement("span");
  node.className = "path-text";
  node.textContent = path;
  return node;
}

function tagsNode(tags) {
  const wrapper = document.createElement("span");
  wrapper.className = "tag-list";
  for (const tag of tags) {
    const node = document.createElement("span");
    node.className = "tag";
    node.textContent = tag;
    wrapper.append(node);
  }
  return wrapper;
}

function openLink(url) {
  const link = document.createElement("a");
  link.className = "open-link";
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Otevřít";
  link.addEventListener("click", (event) => event.stopPropagation());
  return link;
}

function actionButtons(app) {
  const wrapper = document.createElement("div");
  wrapper.className = "action-buttons";
  // Appka s nevalidním manifestem nemá URL — odkaz se nenabízí.
  if (app.url) wrapper.append(openLink(app.url));
  wrapper.append(
    runtimeButton(app, installAction(app), installLabel(app), !canInstall(app)),
    runtimeButton(app, "start", "Spustit", !canStart(app)),
    runtimeButton(app, "stop", "Zastavit", !canStop(app)),
    runtimeButton(app, "restart", "Restart", !canRestart(app)),
    logsButton(app),
  );
  return wrapper;
}

function runtimeButton(app, action, label, disabled) {
  const button = document.createElement("button");
  button.className = "small-button";
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled || state.pendingAction === `${app.id}:${action}`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    runRuntimeAction(app, action);
  });
  return button;
}

function logsButton(app) {
  const button = document.createElement("button");
  button.className = "small-button";
  button.type = "button";
  button.textContent = "Logy";
  button.disabled = state.pendingAction === `${app.id}:logs`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    loadLogs(app);
  });
  return button;
}

function canInstall(app) {
  return !isProductionspace(app) && !app.is_readonly_system && Boolean(app.dependencies?.can_install);
}

function installAction(app) {
  return app.dependencies?.state === "needs_install" ? "install" : "repair";
}

function installLabel(app) {
  return app.dependencies?.state === "needs_install" ? "Instalovat" : "Opravit balíčky";
}

function canStart(app) {
  return !isProductionspace(app) && !app.is_readonly_system && ["stopped", "unknown"].includes(app.runtime_status) && app.dependencies?.can_start !== false;
}

function canStop(app) {
  return !isProductionspace(app)
    && !app.is_readonly_system
    && ["current-instance", "adopted-port"].includes(app.runtime?.owner)
    && Number.isInteger(app.runtime?.pid);
}

function canRestart(app) {
  return canStop(app);
}

function runtimeNode(app) {
  const wrapper = document.createElement("div");
  const status = document.createElement("span");
  status.className = `runtime-pill runtime-${app.runtime_status ?? "unknown"}`;
  status.textContent = runtimeLabel(app.runtime_status);
  const message = document.createElement("span");
  message.className = "app-subtitle";
  message.textContent = app.runtime?.message ?? app.health_path;
  wrapper.append(status, message);
  return wrapper;
}

function dependencyNode(app) {
  const dependencies = app.dependencies ?? {};
  const wrapper = document.createElement("div");
  const status = document.createElement("span");
  status.className = `runtime-pill ${dependencyClass(dependencies.state)}`;
  status.textContent = dependencyLabel(dependencies.state);
  const message = document.createElement("span");
  message.className = "app-subtitle";
  message.textContent = dependencies.install_command_display ?? dependencies.package_manager ?? "-";
  wrapper.append(status, message);
  return wrapper;
}

function tableCell(content) {
  const cell = document.createElement("td");
  if (content instanceof Node) {
    cell.append(content);
  } else {
    cell.textContent = content;
  }
  return cell;
}

/* =========================================================
   Detail panel (explainability surface)
   ========================================================= */

function renderDetail(apps) {
  const detailOpen = state.drawerView === "detail";
  elements.appDetail?.toggleAttribute("hidden", !detailOpen);
  if (!detailOpen) return;

  const app = state.selectedReadonlyDetail ?? apps.find((item) => item.id === state.selectedAppId);
  if (!app) {
    elements.appDetail.className = "empty-detail";
    elements.appDetail.textContent = "Vyber aplikaci";
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "detail-block";
  // Běžný detail odpovídá jen na tři otázky: co se děje, co to znamená a co
  // může uživatel udělat. Git/worktree diagnostika zůstává níže pod technickým
  // rozbalením.
  wrapper.append(renderDetailHeader(app), renderDetailSummary(app));
  // Logs are user-initiated (the "Logy" button), so show them when present.
  const logs = renderDetailLogs(app);
  if (logs) wrapper.append(logs);
  // Everything technical is collapsed away from everyday use.
  wrapper.append(renderDetailTech(app));

  elements.appDetail.className = "";
  elements.appDetail.replaceChildren(wrapper);
}

function renderDetailSummary(app) {
  const git = gitDetailForApp(app);
  const model = detailSummaryModel(app, git);
  const section = document.createElement("section");
  section.className = `detail-section detail-summary is-${model.tone}`;
  const title = document.createElement("h3");
  title.textContent = model.title;
  const message = document.createElement("p");
  message.textContent = model.message;
  section.append(title, message);

  if (model.change) {
    const change = document.createElement("p");
    change.className = "detail-summary-change";
    change.textContent = `Poslední změna: ${model.change}`;
    section.append(change);
  }

  if (model.action) {
    const actions = document.createElement("div");
    actions.className = "detail-summary-actions";
    actions.append(model.action);
    section.append(actions);
  }
  return section;
}

function detailSummaryModel(app, git) {
  const incoming = Number(git?.counts?.incoming) || 0;
  const outgoing = Number(git?.counts?.outgoing) || 0;
  const changedFiles = Number(git?.counts?.changed_files) || 0;
  const nextAction = primaryNextAction(app);
  const dependencyState = app.dependencies?.state;

  if (nextAction.type === "disabled") {
    return {
      tone: "danger",
      title: "Aplikaci teď nejde otevřít",
      message: nextActionReason(app, nextAction),
      action: primaryActionNode(app, nextAction),
    };
  }

  if (app.runtime_status === "unhealthy") {
    return {
      tone: "danger",
      title: "Spuštění se nepovedlo",
      message: "Podívejte se, co se při spuštění stalo.",
      action: primaryActionNode(app, nextAction),
    };
  }

  if (["needs_install", "stale_lockfile"].includes(dependencyState)) {
    return {
      tone: "warn",
      title: dependencyState === "needs_install" ? "Aplikaci je potřeba připravit" : "Aplikaci je potřeba opravit",
      message: dependencyState === "needs_install"
        ? "Než ji otevřete, je potřeba doplnit potřebné součásti."
        : "Než ji otevřete, je potřeba opravit její součásti.",
      action: primaryActionNode(app, nextAction),
    };
  }

  if (git?.status === "push_required") {
    return {
      tone: "warn",
      title: `${newCommitCountLabel(outgoing)} čeká na odeslání`,
      message: outgoing === 1
        ? "Je uložená na tomto počítači. Ostatní ji zatím nevidí."
        : "Jsou uložené na tomto počítači. Ostatní je zatím nevidí.",
      change: simpleChangeSubject(git.head?.subject),
    };
  }

  if (git?.status === "pull_available") {
    return {
      tone: "warn",
      title: `Nová verze - ${newCommitCountLabel(incoming)}`,
      message: "Můžete ji bezpečně stáhnout.",
      action: summaryButton("Stáhnout", () => pullLatestRepoVersion(app, git), `${app.id}:git-pull`),
    };
  }

  if (canAutostashPull(git)) {
    return {
      tone: "warn",
      title: `Nová verze - ${newCommitCountLabel(incoming)}`,
      message: "Můžete ji stáhnout. Vaše změny zůstanou zachované.",
      action: summaryButton(
        "Stáhnout",
        () => pullLatestRepoVersion(app, git, { autostash: true }),
        `${app.id}:git-pull`,
      ),
    };
  }

  if (git?.status === "draft_changes") {
    return {
      tone: "warn",
      title: "Rozpracované změny",
      message: `${newCommitCountLabel(changedFiles)} je zatím jen na tomto počítači.`,
      action: summaryButton("Zobrazit změny", () => showRepoChanges(app, git), `${app.id}:git-changes`),
    };
  }

  if (git?.status === "diverged") {
    return {
      tone: "danger",
      title: "Změny je potřeba porovnat",
      message: "Na tomto počítači i ve sdílené verzi jsou jiné změny.",
    };
  }

  if (["wrong_branch", "not_on_main"].includes(git?.status)) {
    return {
      tone: "warn",
      title: "Jiný pracovní režim",
      message: "Než budete pokračovat, je potřeba stav aplikace zkontrolovat.",
    };
  }

  if (app.runtime_status === "healthy") {
    return {
      tone: "ok",
      title: "Aplikace běží",
      message: "Můžete pokračovat v práci.",
      action: primaryActionNode(app, nextAction),
    };
  }
  return {
    tone: "ok",
    title: "Aplikace je připravená",
    message: "Můžete ji spustit a pokračovat v práci.",
    action: primaryActionNode(app, nextAction),
  };
}

function simpleChangeSubject(subject) {
  if (typeof subject !== "string" || !subject.trim()) return null;
  return subject.trim().replace(/^[^:]{1,48}:\s*/, "");
}

function summaryButton(label, onClick, pendingKey = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-primary btn-sm";
  button.textContent = label;
  button.disabled = pendingKey ? state.pendingAction === pendingKey : false;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function renderDetailTech(app) {
  const details = document.createElement("details");
  details.className = "detail-tech";
  const summary = document.createElement("summary");
  summary.textContent = "Technické detaily";
  const body = document.createElement("div");
  body.className = "detail-tech-body";
  body.append(renderDetailStatus(app));
  const ownership = renderDetailMissionControlOwnership(app);
  if (ownership) body.append(ownership);
  const gitBuilderActions = renderGitBuilderActions(app);
  if (gitBuilderActions) body.append(gitBuilderActions);
  const runtimeSource = renderRuntimeSourceChooser(app);
  if (runtimeSource) body.append(runtimeSource);
  const builderActions = renderWorktreeBuilderActions(app);
  if (builderActions) body.append(builderActions);
  body.append(renderDetailNextAction(app), renderDetailEndpoint(app), renderDetailPaths(app));
  const failure = renderDetailFailure(app);
  if (failure) body.append(failure);
  body.append(pluginNode(app.plugin), renderDebugPayload(app));
  details.append(summary, body);
  return details;
}

function renderDetailHeader(app) {
  const header = document.createElement("div");
  header.className = "detail-header";
  const row = document.createElement("div");
  row.className = "detail-title-row";
  row.append(appIconNode(app));
  const titles = document.createElement("div");
  titles.className = "app-card-titles";
  const headingRow = document.createElement("div");
  headingRow.className = "app-card-title-row";
  const heading = document.createElement("h2");
  heading.textContent = appBaseTitle(app);
  headingRow.append(heading);
  const versionBadge = badgeNode(appVersionLabel(app));
  if (versionBadge) headingRow.append(versionBadge);
  const sub = document.createElement("p");
  sub.className = "app-card-sub";
  sub.textContent = app.company_display_name ?? app.company;
  titles.append(headingRow, sub);
  row.append(titles);
  header.append(row);
  return header;
}

function renderDetailStatus(app) {
  const section = detailSection("Stav");
  const badges = document.createElement("div");
  badges.className = "detail-badges";
  badges.append(chip(surfaceLabel(app.surface), "chip-surface"), runtimeChip(app), dependencyChip(app));
  section.append(badges);
  // Only surface the policy note where it changes what the user may do
  // (productionspace stays read-only). Workspace apps get no extra noise.
  if (isProductionspace(app) || app.is_readonly_system) {
    const note = document.createElement("p");
    note.className = "detail-note";
    note.textContent = app.readonly_reason ?? policyLabel(app);
    section.append(note);
  }
  return section;
}

function renderDetailMissionControlOwnership(app) {
  const git = gitDetailForApp(app);
  if (!git) return null;
  const section = detailSection("Mission Control ownership");
  const chipModel = gitChipModel(git);
  const badges = document.createElement("div");
  badges.className = "detail-badges";
  if (chipModel) badges.append(gitChipNode(chipModel));
  const worktrees = normalizedGitWorktrees(git);
  badges.append(chip(`${worktrees.length} worktree`, worktrees.some((item) => item.isOrphan) ? "chip-warn" : "chip-muted"));
  section.append(badges);

  const ownership = normalizedMissionControlOwnership(git);
  section.append(
    detailList([
      ["Main checkout", git.title ?? git.status ?? "-"],
      ["Vzdálená verze", gitFreshnessLabel(git.freshness)],
      ["Doporučená akce", git.recommendedAction ?? git.recommended_action ?? git.message ?? "-"],
      ["Owner plan", ownership.ownerPlanCode ? `${ownership.ownerPlanCode} — ${ownership.ownerPlanTitle ?? "bez názvu"}` : "žádný aktivní owner plan"],
    ]),
  );

  if (worktrees.length === 0) {
    const note = document.createElement("p");
    note.className = "detail-note";
    note.textContent = "Žádný Mission Control worktree pro tenhle modul. DEV runtime může zatím běžet jen z main checkoutu.";
    section.append(note);
    return section;
  }

  const list = document.createElement("ul");
  list.className = "worktree-list";
  for (const worktree of worktrees) {
    list.append(worktreeItemNode(worktree));
  }
  section.append(list);
  return section;
}

function gitFreshnessLabel(freshness) {
  if (!freshness) return "Neověřeno v této relaci";
  if (freshness.remote_refresh_state === "refreshing") return "Právě ověřuji…";
  const checked = freshness.remote_checked_at
    ? formatModuleChangeDate(freshness.remote_checked_at, { includeTime: true })
    : null;
  if (freshness.remote_refresh_state === "error") {
    return checked ? `Ověření se nepovedlo · naposledy ${checked}` : "Ověření se nepovedlo · zkusím znovu";
  }
  if (checked) return `Ověřeno ${checked}`;
  return "Čeká na první ověření";
}

function worktreeItemNode(worktree) {
  const item = document.createElement("li");
  item.className = `worktree-item ${worktree.isOrphan ? "is-orphan" : "is-owned"}`.trim();
  const title = document.createElement("strong");
  title.textContent = worktree.isOrphan
    ? "Orphan worktree — no Mission Control owner"
    : `Owned by ${worktree.ownerPlan?.code ?? worktree.planCode ?? worktree.slug} — ${worktree.ownerPlan?.title ?? worktree.slug}`;
  const meta = document.createElement("span");
  meta.className = "worktree-meta";
  meta.textContent = [
    worktree.isOrphan ? "Přiřadit Mission Control plán" : "Pokračovat v plánu",
    worktree.branch ? `branch ${worktree.branch}` : null,
    worktree.status,
    worktree.ownerPlan?.path ?? worktree.path,
  ].filter(Boolean).join(" · ");
  if (worktree.message) {
    const message = document.createElement("span");
    message.className = "worktree-message";
    message.textContent = worktree.message;
    item.append(title, meta, message);
  } else {
    item.append(title, meta);
  }
  return item;
}

function gitDetailForApp(app) {
  const git = gitRepoForApp(app) ?? app.git ?? null;
  if (!git) return null;
  if (git.key && git.counts) return git;
  return {
    ...git,
    key: git.key ?? git.repo_key ?? null,
    counts: git.counts ?? {
      incoming: Number(git.incomingCommitCount) || 0,
      outgoing: Number(git.outgoingCommitCount) || 0,
      changed_files: Number(git.changedFiles) || 0,
    },
  };
}

function normalizedMissionControlOwnership(git) {
  const ownership = git?.mission_control_ownership ?? git?.missionControlOwnership ?? {};
  return {
    required: Boolean(ownership.required),
    ownerPlanCode: ownership.owner_plan_code ?? ownership.ownerPlanCode ?? null,
    ownerPlanPath: ownership.owner_plan_path ?? ownership.ownerPlanPath ?? null,
    ownerPlanTitle: ownership.owner_plan_title ?? ownership.ownerPlanTitle ?? null,
    orphan: Boolean(ownership.orphan),
  };
}

function normalizedGitWorktrees(git) {
  const raw = Array.isArray(git?.worktree_details)
    ? git.worktree_details
    : Array.isArray(git?.worktrees) && git.worktrees.every((item) => item && typeof item === "object")
      ? git.worktrees
      : [];
  return raw.map((worktree) => {
    const ownershipStatus = worktree.ownership_status ?? worktree.ownershipStatus ?? "unknown";
    const ownerPlan = worktree.owner_plan ?? worktree.ownerPlan ?? null;
    return {
      slug: worktree.slug,
      branch: worktree.branch,
      status: worktree.status,
      path: worktree.path,
      message: worktree.message,
      ownershipStatus,
      isOrphan: ownershipStatus !== "owned",
      ownerPlan,
      planCode: worktree.plan_code ?? worktree.planCode ?? ownerPlan?.code ?? null,
    };
  });
}

function ownedRuntimeWorktrees(app) {
  return normalizedGitWorktrees(gitDetailForApp(app)).filter((worktree) => !worktree.isOrphan && worktree.slug);
}

function renderGitBuilderActions(app) {
  const git = gitDetailForApp(app);
  if (!git?.key || isProductionspace(app)) return null;
  const section = detailSection("Git kontrola");
  const actions = document.createElement("div");
  actions.className = "git-builder-actions";

  const changesCard = builderActionCard(
    "Ukázat změny",
    "Zobrazí jen seznam změněných souborů a typ změny. Obsah souborů zůstává skrytý.",
  );
  changesCard.append(builderActionButton("Ukázat změny", () => showRepoChanges(app, git)));
  actions.append(changesCard);

  if (git.status === "pull_available") {
    const pullCard = builderActionCard(
      "Stáhnout novější verzi",
      "Bezpečný fast-forward pull je dostupný jen pro čistý main checkout bez lokálních draftů.",
    );
    pullCard.append(builderActionButton("Stáhnout novější verzi", () => pullLatestRepoVersion(app, git)));
    actions.append(pullCard);
  } else if (canAutostashPull(git)) {
    const pullCard = builderActionCard(
      "Stáhnout a zachovat změny",
      "Launchpad odloží tracked i untracked změny, stáhne pouze fast-forward a změny znovu obnoví. Konflikt zůstane viditelný a stash se nesmaže.",
    );
    pullCard.append(
      builderActionButton("Stáhnout a zachovat změny", () => pullLatestRepoVersion(app, git, { autostash: true })),
    );
    actions.append(pullCard);
  }

  section.append(actions);
  const cached = state.gitChangesByRepo.get(git.key);
  if (cached) section.append(gitChangeListNode(cached));
  return section;
}

function gitChangeListNode(payload) {
  const wrapper = document.createElement("div");
  wrapper.className = "git-change-list";
  const title = document.createElement("strong");
  title.textContent = payload.changes?.length ? "Změněné soubory" : "Žádné lokální změny";
  wrapper.append(title);
  if (payload.changes?.length) {
    const list = document.createElement("ul");
    for (const change of payload.changes) {
      const item = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = change.path;
      const meta = document.createElement("span");
      meta.textContent = change.porcelain ?? change.change ?? "změna";
      item.append(code, meta);
      list.append(item);
    }
    wrapper.append(list);
  }
  return wrapper;
}

async function showRepoChanges(app, git) {
  state.pendingAction = `${app.id}:git-changes`;
  render();
  try {
    const payload = await fetchJson(`/api/git/repos/${encodeURIComponent(git.key)}/changes`);
    state.gitChangesByRepo.set(git.key, payload);
    toast(`${appBaseTitle(app)}: změny načtené.`, "success");
  } catch (error) {
    toast(`${appBaseTitle(app)}: ${error.message}`, "error", 7000);
  } finally {
    state.pendingAction = null;
    render();
  }
}

async function pullLatestRepoVersion(app, git, { autostash = false } = {}) {
  return pullGitRepository({
    git,
    label: appBaseTitle(app),
    autostash,
    pendingKey: `${app.id}:git-pull`,
  });
}

async function pullGitRepository({ git, label, autostash = false, pendingKey = `git-pull:${git.key}` }) {
  const confirmation = autostash
    ? `Stáhnout novější verzi pro ${label} a zachovat lokální změny? Launchpad je odloží do bezpečného stash, provede pouze fast-forward a znovu je obnoví.`
    : `Stáhnout novější verzi pro ${label}? Launchpad dovolí pouze bezpečný fast-forward.`;
  if (!window.confirm(confirmation)) return;
  state.pendingAction = pendingKey;
  render();
  try {
    const action = autostash ? "pull-autostash" : "pull";
    const payload = await fetchJson(`/api/git/repos/${encodeURIComponent(git.key)}/${action}`, { method: "POST" });
    state.gitChangesByRepo.delete(git.key);
    const stashNote = payload.stash_preserved ? " Bezpečnostní kopie zůstala ve stash stacku." : "";
    toast(`${label}: novější verze stažená (${payload.after?.head?.short_sha ?? "aktuální"}).${stashNote}`, "success", 7000);
    await loadData({ quiet: true });
  } catch (error) {
    toast(`${label}: ${error.message}`, "error", 9000);
  } finally {
    state.pendingAction = null;
    render();
  }
}

// Update lane Conglomerate rootu (decision 0059, draft 0080) — oddělená od
// per-repo org pullů; pill v top baru ukazuje kanál, verzi a akční stav.
async function loadUpdateStatus() {
  const payload = await fetchJsonSafe("/api/update/status");
  state.updateStatus = payload && !payload.error ? payload : null;
  renderUpdatePill();
}

function renderUpdatePill() {
  const button = elements.updateButton;
  if (!button) return;
  const status = state.updateStatus;
  if (!status) {
    button.hidden = true;
    return;
  }
  const channel = status.channel ?? "stable";
  const version = status.version?.describe || status.head?.short_sha || "";
  const pill = (tone, label) => {
    button.className = `status-pill status-${tone} update-pill`;
    button.textContent = state.updatePending ? "Aktualizuju…" : label;
    button.disabled = state.updatePending;
    button.title = `${status.message ?? ""} Kanál: ${channel}. Verze: ${version}.`.trim();
    button.hidden = false;
  };
  switch (status.state) {
    case "up_to_date":
      pill("ok", `Aktuální · ${channel} · ${version}`);
      break;
    case "update_available":
      pill("warn", `Aktualizovat · ${channel}`);
      break;
    case "dirty_worktree":
      pill("warn", status.can_update_with_autostash ? "Aktualizovat (zachovat změny)" : `Lokální změny · ${channel}`);
      break;
    case "ahead_of_channel_target":
      pill("ok", `Před kanálem ${channel} · ${version}`);
      break;
    case "no_release_tag":
      pill("unknown", "Stable zatím bez release");
      break;
    default:
      pill("fail", `Update: vyžaduje pozornost`);
      break;
  }
}

async function runRootUpdate() {
  const status = state.updateStatus;
  if (!status || state.updatePending) return;
  let mode = null;
  if (status.state === "update_available") {
    if (!window.confirm(`Aktualizovat Conglomerate root na cíl kanálu ${status.channel} (${status.target?.ref ?? ""})? Provede se bezpečný fast-forward; po dokončení restartuj Launchpad.`)) return;
    mode = "ff_only";
  } else if (status.state === "dirty_worktree" && status.can_update_with_autostash) {
    if (!window.confirm("Tracked soubory mají lokální změny. Aktualizovat a zachovat změny? Změny se bezpečně odloží a po fast-forwardu obnoví; při konfliktu zůstanou ve stash zálohách.")) return;
    mode = "preserve_changes";
  } else {
    toast(status.message ?? "Aktualizace teď není bezpečně proveditelná.", "info", 8_000);
    return;
  }
  state.updatePending = true;
  renderUpdatePill();
  try {
    const payload = await fetchJson("/api/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (payload.ok && payload.updated) {
      toast(`Aktualizace hotová: ${payload.from_commit?.slice(0, 7)} → ${payload.to_commit?.slice(0, 7)}. Restartuj Launchpad, aby načetl novou verzi.`, "success", 12_000);
    } else if (payload.ok) {
      toast(payload.message ?? "Root je aktuální.", "success", 8_000);
    } else {
      toast(payload.message ?? "Aktualizace se nespustila.", "error", 12_000);
    }
    state.updateStatus = payload.after ?? state.updateStatus;
  } catch (error) {
    toast(`Aktualizace selhala: ${error.message}`, "error", 12_000);
  } finally {
    state.updatePending = false;
    renderUpdatePill();
    loadUpdateStatus();
  }
}

async function pullAllRepositories() {
  const confirmed = window.confirm(
    "Pullnout vše napříč všemi Organizacemi? Launchpad aktualizuje Organization root repa i Workspace moduly. Lokální změny bezpečně odloží a obnoví; productionspace, diverged nebo jinak rizikové checkouty přeskočí.",
  );
  if (!confirmed) return;
  state.pendingAction = "git:pull-all";
  render();
  try {
    const payload = await fetchJson("/api/git/pull-all", { method: "POST" });
    state.bulkPullResult = payload;
    const summary = payload.summary ?? {};
    const attention = (summary.conflict_count ?? 0) + (summary.failed_count ?? 0);
    const message = [
      `${summary.updated_count ?? 0} aktualizováno`,
      `${summary.up_to_date_count ?? 0} už aktuálních`,
      `${summary.skipped_count ?? 0} přeskočeno`,
      attention > 0 ? `${attention} vyžaduje pomoc` : null,
    ].filter(Boolean).join(" · ");
    toast(`Pullnout vše: ${message}.`, attention > 0 ? "error" : "success", 10_000);
    await loadData({ quiet: true });
  } catch (error) {
    toast(`Pullnout vše: ${error.message}`, "error", 10_000);
  } finally {
    state.pendingAction = null;
    render();
  }
}

function selectedRuntimeSourceForApp(app) {
  const selected = state.runtimeSourcesByApp.get(app.id);
  const owned = ownedRuntimeWorktrees(app);
  if (selected?.type === "worktree" && owned.some((worktree) => worktree.slug === selected.slug)) return selected;
  return { type: "main" };
}

function sourcePayloadForApp(app) {
  const source = selectedRuntimeSourceForApp(app);
  if (source.type === "worktree") return { type: "worktree", slug: source.slug };
  return { type: "main" };
}

function runtimeSourceLabel(source) {
  if (source.type !== "worktree") return "MAIN checkout";
  return `WORKTREE · ${source.planCode ?? source.slug} · ${source.branch ?? source.slug}`;
}

function renderRuntimeSourceChooser(app) {
  const worktrees = ownedRuntimeWorktrees(app);
  if (worktrees.length === 0) return null;
  const section = detailSection("DEV runtime source");
  const chooser = document.createElement("div");
  chooser.className = "runtime-source-chooser";
  chooser.append(
    runtimeSourceOptionNode(app, { type: "main", label: "MAIN checkout", meta: "DEV z main checkoutu" }),
    ...worktrees.map((worktree) => runtimeSourceOptionNode(app, {
      type: "worktree",
      slug: worktree.slug,
      label: runtimeSourceLabel({ type: "worktree", ...worktree }),
      meta: ["DEV z worktree", worktree.ownerPlan?.title, worktree.status].filter(Boolean).join(" · "),
    })),
  );
  section.append(chooser);
  const selected = selectedRuntimeSourceForApp(app);
  const note = document.createElement("p");
  note.className = "detail-note";
  note.textContent = selected.type === "worktree"
    ? "Spustit/Otevřít/Zastavit/Restart použije vybraný worktree a Launchpad mu přidělí samostatný DEV port."
    : "Spustit/Otevřít/Zastavit/Restart použije main checkout. Worktree lze zvolit tady bez přepínání gitu.";
  section.append(note);
  return section;
}

function runtimeSourceOptionNode(app, source) {
  const selected = selectedRuntimeSourceForApp(app);
  const active = selected.type === source.type && (source.type !== "worktree" || selected.slug === source.slug);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `runtime-source-option ${active ? "is-active" : ""}`.trim();
  button.setAttribute("aria-pressed", active ? "true" : "false");
  const badge = document.createElement("span");
  badge.className = "runtime-source-badge";
  badge.textContent = source.type === "worktree" ? "WORKTREE" : "MAIN";
  const text = document.createElement("span");
  text.className = "runtime-source-text";
  const label = document.createElement("strong");
  label.textContent = source.label;
  const meta = document.createElement("small");
  meta.textContent = source.meta;
  text.append(label, meta);
  button.append(badge, text);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    state.runtimeSourcesByApp.set(app.id, source.type === "worktree" ? { type: "worktree", slug: source.slug } : { type: "main" });
    state.selectedLogs = null;
    render();
  });
  return button;
}

function renderWorktreeBuilderActions(app) {
  const git = gitDetailForApp(app);
  if (!git?.key || isProductionspace(app)) return null;
  const section = detailSection("Builder worktree actions");
  const actions = document.createElement("div");
  actions.className = "worktree-builder-actions";
  actions.append(createWorktreeActionCard(app, git));
  const selected = selectedRuntimeSourceForApp(app);
  const selectedWorktree = selected.type === "worktree"
    ? ownedRuntimeWorktrees(app).find((worktree) => worktree.slug === selected.slug)
    : null;
  if (selectedWorktree) actions.append(publishWorktreeActionCard(app, git, selectedWorktree));
  const note = document.createElement("p");
  note.className = "detail-note";
  note.textContent = "Guarded worktree create a Publish draft jsou lokální builder akce. PR krok je oddělený a musí zůstat viditelný.";
  section.append(actions, note);
  return section;
}

function createWorktreeActionCard(app, git) {
  const card = builderActionCard(
    "Guarded worktree create",
    "Vytvoří canonical Mission-Control-owned worktree a sidecar jen když je main checkout čistý.",
  );
  const ownership = normalizedMissionControlOwnership(git);
  const defaultPlan = ownership.ownerPlanPath ?? firstPlanPathForGit(git) ?? "mission-control/plans/YYYY/MM/CAC-0000-plan.yaml";
  const defaultBranch = ownership.ownerPlanCode
    ? `${ownership.ownerPlanCode}-${app.module ?? "worktree"}`
    : `${app.module ?? "workspace"}-builder-worktree`;
  const button = builderActionButton("Vytvořit worktree", () => createWorktreeForPlan(app, git, { defaultPlan, defaultBranch }));
  card.append(button);
  return card;
}

function publishWorktreeActionCard(app, git, worktree) {
  const card = builderActionCard(
    "Publish draft",
    `Commitne a pushne vybraný worktree ${worktree.slug}. PR krok je oddělený — po pushi ho otevři zvlášť.`,
  );
  card.append(builderActionButton("Commit + push draft", () => publishSelectedWorktreeDraft(app, git, worktree)));
  return card;
}

function builderActionCard(titleText, bodyText) {
  const card = document.createElement("div");
  card.className = "builder-action-card";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const body = document.createElement("p");
  body.textContent = bodyText;
  card.append(title, body);
  return card;
}

function builderActionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-action builder-action-button";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

async function createWorktreeForPlan(app, git, { defaultPlan, defaultBranch }) {
  const planPath = window.prompt("Mission Control plan path", defaultPlan);
  if (!planPath) return;
  const branch = window.prompt("Nová branch/worktree", defaultBranch);
  if (!branch) return;
  state.pendingAction = `${app.id}:worktree-create`;
  render();
  try {
    const payload = await fetchJson(`/api/git/repos/${encodeURIComponent(git.key)}/worktrees/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planPath, branch, createdBy: "launchpad-builder" }),
    });
    state.runtimeSourcesByApp.set(app.id, { type: "worktree", slug: payload.worktree?.slug });
    toast(`${appBaseTitle(app)}: worktree vytvořený (${payload.worktree?.slug ?? branch}).`, "success");
    await loadData({ quiet: true });
  } catch (error) {
    toast(`${appBaseTitle(app)}: ${error.message}`, "error", 7000);
  } finally {
    state.pendingAction = null;
    render();
  }
}

async function publishSelectedWorktreeDraft(app, git, worktree) {
  const commitMessage = window.prompt("Commit message", `feat(${app.module ?? "workspace"}): publish ${worktree.planCode ?? worktree.slug}`);
  if (!commitMessage) return;
  state.pendingAction = `${app.id}:worktree-publish`;
  render();
  try {
    const payload = await fetchJson(`/api/git/repos/${encodeURIComponent(git.key)}/worktrees/${encodeURIComponent(worktree.slug)}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commitMessage, publisher: "launchpad-builder" }),
    });
    toast(`${appBaseTitle(app)}: draft pushnutý (${payload.commit?.short_sha ?? payload.commit?.sha ?? "commit"}). Otevři PR jako samostatný krok.`, "success", 7000);
    await loadData({ quiet: true });
  } catch (error) {
    toast(`${appBaseTitle(app)}: ${error.message}`, "error", 7000);
  } finally {
    state.pendingAction = null;
    render();
  }
}

function firstPlanPathForGit(git) {
  const plans = git?.mission_control_plans ?? git?.missionControlPlans ?? [];
  return Array.isArray(plans) ? plans.find((plan) => plan?.path)?.path ?? null : null;
}

function renderDetailNextAction(app) {
  const section = detailSection("Bezpečná další akce");
  const next = document.createElement("div");
  next.className = "detail-next";
  const nextAction = primaryNextAction(app);
  next.append(primaryActionNode(app, nextAction));
  const reason = nextActionReason(app, nextAction);
  if (reason) {
    const text = document.createElement("p");
    text.textContent = reason;
    next.append(text);
  }
  section.append(next);
  return section;
}

function nextActionReason(app, nextAction) {
  if (nextAction.type === "disabled") {
    if (app.is_readonly_system) {
      return app.readonly_reason ?? "Tenhle záznam je v Launchpadu jen pro čtení.";
    }
    if (isProductionspace(app)) {
      return "Productionspace systémy zůstávají read-only, dokud nebude commitnutá explicitní policy.";
    }
    if (isUntrustedPortOwner(app)) {
      return app.runtime?.message || "Launchpad nedokázal bezpečně ověřit proces na portu. Vyřeš instanci mimo Launchpad.";
    }
    return `Akce není dostupná: ${humanDependencyLabel(app.dependencies?.state)}. Vyřeš to přes Doktora nebo sync.`;
  }
  if (nextAction.type === "open") return "Aplikace běží — otevře se v novém panelu, nic se nespouští.";
  if (nextAction.type === "folder") return "Otevře lokální checkout ve správci souborů; nic v něm nemění.";
  if (nextAction.action === "install") return "Doplní chybějící balíčky v rozsahu cwd aplikace.";
  if (nextAction.action === "repair") return "Přeinstaluje balíčky kvůli drift mezi package a lockfile.";
  if (nextAction.action === "start") return "Spustí lokální dev proces, pokud nejsou runtime konflikty.";
  if (nextAction.type === "logs") return "Otevři logy a zjisti, proč runtime spadl.";
  return "";
}

function renderDetailEndpoint(app) {
  const section = detailSection("Lokální endpoint");
  section.append(
    detailList([
      ["URL", app.url, true],
      ["Health", app.health_url, true],
      ["Host : Port", `${app.host ?? "—"} : ${app.port ?? "—"}`, true],
    ]),
  );
  return section;
}

function renderDetailPaths(app) {
  const section = detailSection("Cesty a balíčky");
  section.append(
    detailList([
      ["ID", app.id, true],
      ["Dependency stav", `${humanDependencyLabel(app.dependencies?.state)} — ${app.dependencies?.message ?? "-"}`],
      ["Install command", app.dependencies?.install_command_display ?? "-", true],
      ["Package manager", app.dependencies?.package_manager ?? "-"],
      ["Package", app.package_path, true],
      ["Cwd", app.dependencies?.cwd ?? app.cwd ?? "-", true],
      ["Script", app.dev_script ?? "-", true],
      ["Log", app.runtime?.log_path ?? "-", true],
    ]),
  );
  return section;
}

function renderDetailFailure(app) {
  const failureKind = app.runtime?.failure_kind;
  const lastInstall = app.runtime?.last_install;
  if (!failureKind && !lastInstall && !app.runtime?.message) return null;
  const section = detailSection("Poslední akce / chyba");
  section.append(
    detailList([
      ["Runtime message", app.runtime?.message ?? "-"],
      ["Failure kind", failureKind ?? "-"],
      ["Last install", lastInstall ? `${lastInstall.action} → exit ${lastInstall.exit_code}` : "-"],
      ["Runtime PID", app.runtime?.managed ? String(app.runtime.pid) : "-"],
    ]),
  );
  return section;
}

function renderDetailLogs(app) {
  if (state.selectedLogs?.app_id !== app.id) return null;
  const section = document.createElement("section");
  section.className = "logs-block";
  const title = document.createElement("p");
  title.className = "detail-section-title";
  title.textContent = "Logy";
  const logs = document.createElement("pre");
  logs.className = "console logs-output";
  logs.textContent = state.selectedLogs.content || state.selectedLogs.message || "Log je prázdný.";
  section.append(title, logs);
  return section;
}

function renderDebugPayload(app) {
  const details = document.createElement("details");
  details.className = "debug-payload";
  const summary = document.createElement("summary");
  summary.textContent = "Debug payload";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(app, null, 2);
  details.append(summary, pre);
  return details;
}

function detailSection(titleText) {
  const section = document.createElement("section");
  section.className = "detail-section";
  const title = document.createElement("p");
  title.className = "detail-section-title";
  title.textContent = titleText;
  section.append(title);
  return section;
}

function detailList(rows) {
  const list = document.createElement("dl");
  list.className = "detail-list";
  for (const [term, value, mono] of rows) {
    const item = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value ?? "-";
    if (mono) dd.className = "is-mono";
    item.append(dt, dd);
    list.append(item);
  }
  return list;
}

function pluginNode(plugin) {
  if (!plugin) {
    const section = detailSection("Launchpad plugin");
    const node = document.createElement("p");
    node.className = "detail-note";
    node.textContent = "Aplikace nemá read-only Launchpad plugin.";
    section.append(node);
    return section;
  }

  const wrapper = document.createElement("section");
  wrapper.className = "detail-section plugin-block";
  const heading = document.createElement("h3");
  heading.textContent = plugin.title;
  wrapper.append(heading);
  if (plugin.summary) {
    const summary = document.createElement("p");
    summary.textContent = plugin.summary;
    wrapper.append(summary);
  }
  if ((plugin.metadata ?? []).length > 0) {
    wrapper.append(detailList(plugin.metadata.map((item) => [item.label, item.value])));
  }
  if ((plugin.links ?? []).length > 0) {
    const links = document.createElement("ul");
    links.className = "plugin-links";
    for (const item of plugin.links) {
      const row = document.createElement("li");
      const label = document.createElement(item.url ? "a" : "span");
      label.textContent = `${item.label} (${item.kind})`;
      if (item.url) {
        label.href = item.url;
        label.target = "_blank";
        label.rel = "noreferrer";
      }
      row.append(label);
      if (item.path) {
        const path = document.createElement("span");
        path.className = "path-text";
        path.textContent = item.path;
        row.append(path);
      }
      links.append(row);
    }
    wrapper.append(links);
  }
  for (const section of plugin.sections ?? []) {
    const title = document.createElement("h3");
    title.textContent = section.title;
    const body = document.createElement("p");
    body.textContent = section.body;
    wrapper.append(title, body);
  }
  return wrapper;
}

/* =========================================================
   Helpers + label vocabulary
   ========================================================= */

function filtered(apps) {
  if (state.filters.scope === "personal") return [];
  return filterApps(apps, state.filters);
}

function activeSpaceApps() {
  if (state.filters.scope !== "personal") {
    return state.apps.filter((app) => app.company === state.filters.company);
  }
  return (state.personalspace?.spaces ?? []).flatMap((space) => space.apps ?? []);
}

function heroDiagnostics(apps) {
  const personalScope = state.filters.scope === "personal";
  const organization = !personalScope
    ? state.companies.find((company) => company.slug === state.filters.company)
    : null;
  const personalFailures = personalScope ? (state.personalspace?.failures ?? []) : [];
  const personalWarnings = personalScope ? (state.personalspace?.warnings ?? []) : [];
  const transientPersonalspaceWarning = personalScope
    && state.personalspaceError
    && personalFailures.length === 0
    ? 1
    : 0;
  return summarizeOrganizationSpaceHealth({
    apps,
    organization,
    // Root discovery chyby patří do Doctor chipu a panelu problémů. Bez
    // strukturovaného scope je nesmíme připsat každé vybrané Organizaci.
    spaceFailures: personalFailures,
    extraWarnings: personalWarnings.length + transientPersonalspaceWarning,
  });
}

function statusLabel(status) {
  return (
    {
      ok: "v pořádku",
      warn: "varování",
      fail: "chyba",
      unknown: "nezjištěno",
    }[status] ?? status
  );
}

// Raw status tokens — kept English to mirror Doctor/discovery vocabulary in
// the debug table.
function runtimeLabel(status) {
  return (
    {
      healthy: "healthy",
      starting: "starting",
      stopped: "stopped",
      unhealthy: "unhealthy",
      unknown: "unknown",
    }[status] ?? "unknown"
  );
}

function dependencyLabel(status) {
  return (
    {
      ready: "ready",
      needs_install: "needs install",
      stale_lockfile: "stale lockfile",
      missing_package: "missing package",
      unknown_package_manager: "unknown manager",
      missing_access: "missing access",
      restricted: "restricted",
      planned_slot: "planned slot",
      invalid_manifest: "invalid manifest",
      runtime_failed: "runtime failed",
    }[status] ?? "unknown"
  );
}

// Human Czech labels — used on cards and in the detail panel.
function humanRuntimeLabel(status) {
  return (
    {
      healthy: "Běží",
      starting: "Startuje",
      stopped: "Zastaveno",
      unhealthy: "Selhalo",
      unknown: "Neznámé",
    }[status] ?? "Neznámé"
  );
}

function humanDependencyLabel(status) {
  return (
    {
      ready: "Připraveno",
      needs_install: "Instalovat",
      stale_lockfile: "Opravit balíčky",
      missing_package: "Chybí balíček",
      unknown_package_manager: "Neznámý správce",
      missing_access: "Chybí přístup",
      restricted: "Omezeno",
      planned_slot: "Plánováno",
      invalid_manifest: "Neplatný manifest",
      runtime_failed: "Runtime selhal",
    }[status] ?? "Neznámé"
  );
}

function dependencyClass(status) {
  if (status === "ready") return "runtime-healthy";
  if (["needs_install", "stale_lockfile", "planned_slot"].includes(status)) return "runtime-starting";
  if (["missing_package", "unknown_package_manager", "missing_access", "restricted", "invalid_manifest", "runtime_failed"].includes(status)) return "runtime-unhealthy";
  return "runtime-unknown";
}

function surfaceLabel(surface) {
  return (
    {
      internal: "Workspace",
      manual: "Manuál",
      admin: "Admin",
      productionspace: "Productionspace",
      "public-preview": "Public preview",
    }[surface] ?? surface
  );
}

function pluralApp(count) {
  return count === 1 ? "aplikace" : "aplikací";
}

function pluralBlocker(count) {
  return count === 1 ? "blocker" : count >= 2 && count <= 4 ? "blockery" : "blockerů";
}

function pluralCommit(count) {
  return count === 1 ? "commit" : count >= 2 && count <= 4 ? "commity" : "commitů";
}

function pluralWarning() {
  // "varování" is indeclinable in Czech — 1 varování, 2 varování, 5 varování.
  return "varování";
}

function pluralModule(count) {
  return count === 1 ? "modul" : count >= 2 && count <= 4 ? "moduly" : "modulů";
}

function pluralSystem(count) {
  return count === 1 ? "systém" : count >= 2 && count <= 4 ? "systémy" : "systémů";
}

// Má modul lidský popis z manifestu?
function hasManifestDescription(app) {
  return typeof app.description === "string" && app.description.trim() !== "";
}

// Popis karty z manifestu (CAC-0044) s lidským funkčním fallbackem.
function appDescription(app) {
  if (hasManifestDescription(app)) {
    return app.description.trim();
  }
  const purpose = APP_DESCRIPTION_FALLBACKS[appIconKey(app)] ?? `Aplikace pro každodenní práci v modulu ${appBaseTitle(app)}.`;
  const surface = ["manual", "admin", "productionspace", "public-preview"].includes(app.surface)
    ? surfaceLabel(app.surface)
    : null;
  return surface ? `${surface} · ${purpose}` : purpose;
}

// Label hlavní akce podle stavu (běží → Otevřít, jinak Spustit a otevřít).
function openActionLabel(app) {
  return app.runtime_status === "healthy" ? "Otevřít" : "Spustit a otevřít";
}

function iconOpenGlyph() {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
}

// Git chip na kartě s lidským textem (CAC-0044, step-005). Tooltip nese delší
// vysvětlení; tón mapuje severity. Klik na chip vybere modul do detailu.
function gitChipNode(model) {
  const toneClass =
    model.tone === "danger" ? "chip-danger" : model.tone === "warn" ? "chip-warn" : "chip-muted";
  const node = chip(model.label, toneClass, false);
  node.classList.add("git-chip");
  if (model.message) node.title = model.message;
  return node;
}

function appIconKey(app) {
  return semanticAppIconKey(app, APP_ICON_PATHS);
}

function appIconStyle(key) {
  const style = APP_ICON_STYLES[key] ?? APP_ICON_STYLES.app;
  return [`--app-icon-color:${style.color}`, `--app-icon-bg:${style.background}`, `--app-icon-border:${style.border}`].join(";");
}

function appIconSvg(key) {
  const path = APP_ICON_PATHS[key] ?? APP_ICON_PATHS.app;
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/* =========================================================
   Runtime actions
   ========================================================= */

async function runRuntimeAction(app, action) {
  state.pendingAction = `${app.id}:${action}`;
  state.actionMessage = null;
  render();
  try {
    const response = await fetch(`/api/apps/${encodeURIComponent(app.id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: sourcePayloadForApp(app) }),
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message ?? `${action} selhal`);
    }
    state.actionMessage = {
      type: "ok",
      message: `${app.title}: ${action} dokončeno.`,
    };
    toast(`${app.title}: ${action} dokončeno.`, "ok");
    await loadData({ quiet: true });
  } catch (error) {
    state.actionMessage = {
      type: "fail",
      message: `${app.title}: ${error.message}`,
    };
    toast(`${app.title}: ${error.message}`, "fail", 6000);
    render();
  } finally {
    state.pendingAction = null;
    render();
  }
}

async function loadLogs(app) {
  state.pendingAction = `${app.id}:logs`;
  selectAppDetail(app.id);
  try {
    state.selectedLogs = await fetchJson(`/api/apps/${encodeURIComponent(app.id)}/logs`);
  } catch (error) {
    state.selectedLogs = {
      app_id: app.id,
      content: "",
      message: error.message,
    };
    toast(`${app.title}: logy se nepodařilo načíst.`, "fail", 6000);
  } finally {
    state.pendingAction = null;
    render();
  }
}
