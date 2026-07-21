// Launchpad owner-first Personalspace + volitelný Buddy + gbrain browser
// (CAC-0044/CAC-0048,
// decision 0051).
//
// PRIVÁTNÍ POVRCH. Tento modul renderuje pouze osobní prostor Principála
// mašiny. Cizí Personalspace discovery odmítá podle decision 0091. Data teče výhradně
// z lokálního /api/personalspace a /api/personalspace/<space>/gbrain/* (server
// běží jen na 127.0.0.1). Osobní data se nikde nelogují ani neposílají dál.
//
// - Personalspace Principála je jediný povolený prostor.
// - Osobní aplikace jsou GEN2-minimal dlaždice (port appCardu z GEN2-minimal karty): čistá
//   klikatelná dlaždice (ikona + název + popis + ↗), jediný „● Běží" chip jen
//   když běží, sekundární akce (Zastavit / Restart / Logy) pod ⋯ menu a inline
//   warning panel jen když je co řešit. Private badge zůstává — privátní surface
//   se nikdy nesmí splést s firemní. Runtime jede přes oddělenou personalspace
//   lane (/api/personalspace/apps/<id>/…), klik na dlaždici volá /open chain.
// - gbrain sekce: tlačítko „Otevřít v Obsidianu" (obsidian://open) + read-only
//   listování zápisů (strom, markdown render, fulltext) jako fallback.

const state = {
  data: null,
  // per-space gbrain UI stav: { open, tree, note, notePath, search, query, loading, error }
  gbrain: new Map(),
  pendingAction: null,
  // Právě běžící one-click open chainy (id osobní aplikace) — dlaždice ukazuje
  // „Otevírám" a druhý souběžný chain nespustí.
  openingApps: new Set(),
  openingMessages: new Map(),
  // Otevřené ⋯ menu (id osobní aplikace; jen jedno naráz).
  openMenu: null,
  // Rozbalení technických detailů se zachová přes tiché obnovení i gbrain
  // interakce, které překreslují celý Personalspace strom.
  technicalOpen: new Set(),
};

const PERSONAL_OPEN_STARTING_WAIT_MS = 120_000;
const PERSONAL_OPEN_STARTING_POLL_MS = 1_500;

// Zavři otevřené ⋯ menu při kliknutí kamkoli mimo něj (port app.js). Menu drží
// stav ve state.openMenu, aby ho tiché 5s obnovení nezavíralo uprostřed práce.
document.addEventListener("click", (event) => {
  if (state.openMenu && event.target instanceof Element && !event.target.closest(".app-version-menu")) {
    state.openMenu = null;
    rerender();
  }
});

let deps = {
  onToast: () => {},
  onReload: async () => {},
};

export function initPersonalspace(options = {}) {
  deps = { ...deps, ...options };
}

// Kolik osobních aplikací je napříč prostory (pro count v section headu a pro
// rozhodnutí, jestli personalspace sekci vůbec renderovat).
export function personalAppCount(data) {
  return (data?.spaces ?? []).reduce((sum, space) => sum + (space.apps?.length ?? 0), 0);
}

export function hasPersonalspace(data) {
  return (data?.spaces ?? []).length > 0;
}

// Hlavní vstup: vezme /api/personalspace odpověď a vyrenderuje osobní plochu.
// Buddy karta se ukáže jen při skutečném bindingu; Personalspace bez Buddyho
// zůstává plnohodnotný. Technické údaje jsou schované v rozbalovací sekci.
export function renderPersonalspace(container, data) {
  if (!container) return;
  state.data = data;
  const spaces = data?.spaces ?? [];
  const activeSpaceNames = new Set(spaces.map((space) => space.dir_name));
  for (const spaceName of state.gbrain.keys()) {
    if (!activeSpaceNames.has(spaceName)) state.gbrain.delete(spaceName);
  }
  for (const spaceName of state.technicalOpen) {
    if (!activeSpaceNames.has(spaceName)) state.technicalOpen.delete(spaceName);
  }

  // Zachovej focus a pozici kurzoru ve fulltext inputu přes destruktivní
  // replaceChildren — jinak by tiché 5s obnovení kradlo focus uprostřed psaní.
  const activeFocus = captureGbrainSearchFocus(container);

  const root = document.createElement("div");
  root.className = "personalspace-body-inner";

  if (spaces.length === 0 && (data?.ok === false || (data?.failures?.length ?? 0) > 0)) {
    root.append(personalspaceErrorState());
    container.replaceChildren(root);
    return;
  }

  if (spaces.length === 0) {
    root.append(personalspaceEmptyState());
    container.replaceChildren(root);
    return;
  }

  for (const space of spaces) {
    root.append(spaceBlock(space));
  }

  container.replaceChildren(root);
  restoreGbrainSearchFocus(container, activeFocus);
}

function personalspaceErrorState() {
  const card = document.createElement("section");
  card.className = "personalspace-friendly-empty is-error";
  const title = document.createElement("h2");
  title.textContent = "Osobní prostor se nepodařilo načíst";
  const copy = document.createElement("p");
  copy.textContent = "Zkus prostor znovu synchronizovat. Technický důvod najde technolog v přehledu problémů.";
  card.append(title, copy);
  return card;
}

// Focus/kurzor fulltext inputu: zachyť, kterého prostoru se týká, a po
// re-renderu ho obnov, aby tiché obnovení nekradlo psaní.
function captureGbrainSearchFocus(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;
  if (!active.classList?.contains("personalspace-gbrain-search-input")) return null;
  return {
    space: active.dataset?.space ?? null,
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd,
  };
}

function restoreGbrainSearchFocus(container, captured) {
  if (!captured) return;
  const selector = captured.space
    ? `.personalspace-gbrain-search-input[data-space="${cssEscape(captured.space)}"]`
    : ".personalspace-gbrain-search-input";
  const input = container.querySelector(selector);
  if (!input) return;
  input.focus();
  try {
    input.setSelectionRange(captured.selectionStart ?? input.value.length, captured.selectionEnd ?? input.value.length);
  } catch {
    // některé input typy nepodporují setSelectionRange — focus stačí
  }
}

function cssEscape(value) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}

// Blok jediného povoleného Personalspace Principála v hlavní ploše.
function spaceBlock(space) {
  const block = document.createElement("div");
  block.className = "personalspace-space-block is-primary";
  block.setAttribute("aria-label", `Osobní prostor ${space.display_name}`);

  if (!space.config_valid) {
    const invalid = document.createElement("section");
    invalid.className = "personalspace-friendly-empty";
    const title = document.createElement("h2");
    title.textContent = "Osobní prostor teď nejde načíst";
    const copy = document.createElement("p");
    copy.textContent = "Zkus obnovit stav. Pokud problém zůstane, podrobnosti najde technolog v technických informacích.";
    const technical = document.createElement("details");
    technical.className = "personalspace-technical";
    bindTechnicalDetails(technical, space.dir_name);
    const summary = document.createElement("summary");
    summary.textContent = "Technické informace";
    const issues = document.createElement("p");
    issues.className = "personalspace-invalid";
    issues.textContent = (space.config_issues ?? []).join("; ");
    technical.append(summary, issues);
    invalid.append(title, copy, technical);
    block.append(invalid);
    return block;
  }

  if (space.is_owner_primary) {
    block.append(buddyOverview(space));
  }

  block.append(personalAppsSection(space));

  if (space.is_owner_primary) {
    block.append(personalSupportCards(space));
  }

  block.append(technicalDetails(space));
  return block;
}

function personalspaceEmptyState() {
  const card = document.createElement("section");
  card.className = "personalspace-friendly-empty";
  const title = document.createElement("h2");
  title.textContent = "Personalspace zatím není vytvořený";
  const copy = document.createElement("p");
  copy.textContent = "Vytvoř si privátní osobní prostor; Buddyho můžeš připojit až později.";
  card.append(title, copy);
  return card;
}

function buddyOverview(space) {
  const overview = document.createElement("div");
  overview.className = "personalspace-overview";
  if (!space.buddy) {
    overview.append(noBuddyCard());
    return overview;
  }
  overview.append(buddyCard(space), recurringTasksCard(space));
  return overview;
}

function noBuddyCard() {
  const card = document.createElement("section");
  card.className = "personalspace-friendly-empty personalspace-no-buddy";
  const title = document.createElement("h2");
  title.textContent = "Personalspace je připravený";
  const copy = document.createElement("p");
  copy.textContent = "Buddy není připojený — osobní aplikace i gbrain můžeš používat samostatně a Buddyho přidat později.";
  card.append(title, copy);
  return card;
}

function buddyCard(space) {
  const buddy = space.buddy ?? {};
  const name = buddy.display_name ?? "Tvůj Buddy";
  const card = document.createElement("article");
  card.className = "buddy-card";

  const portrait = document.createElement("div");
  portrait.className = "buddy-portrait";
  // Vzdálené avatar_url z repozitářového manifestu záměrně nenačítáme:
  // bez image proxy/allowlistu by pouhé otevření Launchpadu provedlo síťový
  // request na libovolný host. Draft proto používá bezpečný lokální placeholder.
  portrait.append(buddyPortraitPlaceholder());

  const content = document.createElement("div");
  content.className = "buddy-card-content";
  const eyebrow = document.createElement("span");
  eyebrow.className = "buddy-eyebrow";
  eyebrow.textContent = "Tvůj Buddy";
  const title = document.createElement("h2");
  title.textContent = name;
  const status = badge("Buddy je nastavený", "buddy-status is-configured");
  const description = document.createElement("p");
  description.className = "buddy-description";
  description.textContent = buddy.description
    ?? "Pomáhá ti zachytit nápady, navázat na rozdělanou práci a připomenout věci, na kterých ti záleží.";
  content.append(eyebrow, title, status, description);

  if (buddy.application) content.append(buddyApplicationRow(buddy.application));

  const actions = document.createElement("div");
  actions.className = "buddy-actions";
  const openUrl = safeExternalUrl(buddy.application?.url);
  if (openUrl) {
    const open = document.createElement("a");
    open.className = "btn btn-primary buddy-open";
    open.href = openUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = `Otevřít ${name}`;
    actions.append(open);
  } else {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn-primary buddy-open";
    open.disabled = true;
    open.textContent = `Otevřít ${name}`;
    open.title = "Buddy zatím nemá nastavený odkaz na komunikační aplikaci.";
    actions.append(open);
  }
  const settings = document.createElement("button");
  settings.type = "button";
  settings.className = "btn btn-secondary";
  settings.disabled = true;
  settings.textContent = "Nastavení Buddyho";
  settings.title = "Nastavení Buddyho bude součástí připravovaného administračního rozhraní.";
  actions.append(settings);
  content.append(actions);
  card.append(portrait, content);
  return card;
}

function buddyApplicationRow(application) {
  const row = document.createElement("div");
  row.className = "buddy-application";
  const icon = document.createElement("span");
  icon.className = `buddy-application-icon is-${application.type ?? "other"}`;
  icon.append(application.type === "telegram" ? telegramIcon() : messageIcon());
  const copy = document.createElement("span");
  copy.className = "buddy-application-copy";
  const label = document.createElement("span");
  label.textContent = "Používáš v aplikaci";
  const name = document.createElement("strong");
  name.textContent = application.name ?? "Komunikační aplikace";
  copy.append(label, name);
  row.append(icon, copy, badge("Nastaveno", "buddy-application-state"));
  return row;
}

function recurringTasksCard(space) {
  const buddy = space.buddy ?? {};
  const tasks = buddy.recurring_tasks ?? [];
  const card = document.createElement("aside");
  card.className = "buddy-routines";
  const title = document.createElement("h2");
  title.textContent = "Pravidelné úkoly";
  const intro = document.createElement("p");
  intro.textContent = tasks.length > 0
    ? `Co je pro ${buddy.display_name ?? "Buddyho"} nastavené jako pravidelný úkol.`
    : "Buddy zatím nemá popsané žádné opakované úkoly.";
  card.append(title, intro);

  const list = document.createElement("div");
  list.className = "buddy-routine-list";
  for (const task of tasks) list.append(recurringTask(task));
  card.append(list);
  return card;
}

function recurringTask(task) {
  const item = document.createElement("article");
  item.className = "buddy-routine";
  item.dataset.taskId = task.id;
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = task.title;
  const description = document.createElement("p");
  description.textContent = task.description ?? task.delivery_channel ?? "";
  copy.append(title);
  if (description.textContent) copy.append(description);
  const schedule = document.createElement("span");
  schedule.className = "buddy-routine-schedule";
  schedule.textContent = task.schedule_label;
  item.append(copy, schedule);
  return item;
}

function personalAppsSection(space) {
  const section = document.createElement("section");
  section.className = "personal-apps-section";
  const title = document.createElement("h2");
  title.textContent = "Moje aplikace";
  section.append(title);

  // Osobní aplikace — stejná `.apps-grid` mřížka jako workspace sekce.
  const apps = space.apps ?? [];
  if (apps.length === 0) {
    const emptyApps = document.createElement("div");
    emptyApps.className = "personalspace-apps-empty";
    const heading = document.createElement("strong");
    heading.textContent = "Zatím tu nemáš další osobní aplikace";
    const copy = document.createElement("p");
    copy.textContent = "Personalspace funguje i bez nich. Až nějakou přidáš, objeví se právě tady.";
    emptyApps.append(heading, copy);
    section.append(emptyApps);
  } else {
    const grid = document.createElement("div");
    grid.className = "apps-grid personalspace-apps-grid";
    for (const app of apps) {
      grid.append(personalAppCard(app));
    }
    section.append(grid);
  }
  return section;
}

function personalSupportCards(space) {
  const grid = document.createElement("div");
  grid.className = "personal-support-grid";
  grid.append(
    supportCard(
      "Osobní paměť",
      space.gbrain?.exists
        ? "Gbrain je připojený jako soukromá dlouhodobá paměť vlastníka."
        : "Soukromý gbrain zatím není připojený.",
    ),
    supportCard(
      "Osobní účet a soukromí",
      "Spravuješ svůj soukromý prostor. Obsah se automaticky nesdílí do Organizací.",
    ),
  );
  return grid;
}

function supportCard(titleText, copyText) {
  const card = document.createElement("article");
  card.className = "personal-support-card";
  const title = document.createElement("h2");
  title.textContent = titleText;
  const copy = document.createElement("p");
  copy.textContent = copyText;
  card.append(title, copy);
  return card;
}

function technicalDetails(space) {
  const details = document.createElement("details");
  details.className = "personalspace-technical";
  bindTechnicalDetails(details, space.dir_name);
  const summary = document.createElement("summary");
  summary.textContent = "Technické informace";
  const inner = document.createElement("div");
  inner.className = "personalspace-technical-inner";
  const mount = document.createElement("p");
  mount.className = "personalspace-space-mount";
  mount.textContent = `Zdroj: ${space.mount_path}`;
  inner.append(mount);

  // Nedostupné/plánované moduly (missing_access / planned_slot) — jako u Organizací.
  const slots = (space.modules ?? []).filter((slot) => slot.status !== "available");
  if (slots.length > 0) {
    const slotsWrap = document.createElement("div");
    slotsWrap.className = "personalspace-slots";
    for (const slot of slots) {
      slotsWrap.append(moduleSlotChip(slot));
    }
    inner.append(slotsWrap);
  }

  inner.append(gbrainSection(space));
  details.append(summary, inner);
  return details;
}

function bindTechnicalDetails(details, spaceKey) {
  details.open = state.technicalOpen.has(spaceKey);
  details.addEventListener("toggle", () => {
    if (details.open) state.technicalOpen.add(spaceKey);
    else state.technicalOpen.delete(spaceKey);
  });
}

function safeExternalUrl(value, protocols = ["https:", "http:", "tg:", "sgnl:", "whatsapp:"]) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function buddyPortraitPlaceholder() {
  const wrapper = document.createElement("span");
  wrapper.className = "buddy-portrait-placeholder";
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = '<svg viewBox="0 0 240 300" role="img"><circle cx="120" cy="104" r="65" fill="#f0c9b4"/><path d="M55 105c0-55 26-85 65-85 43 0 68 34 68 88-19-25-41-38-67-38-25 0-47 12-66 35Z" fill="#29313a"/><path d="M72 107c0 52 18 83 48 83 31 0 49-31 49-83-15-17-32-25-49-25-17 0-33 8-48 25Z" fill="#f0c9b4" stroke="#29313a" stroke-width="5"/><path d="M92 126h13m30 0h13" stroke="#29313a" stroke-width="7" stroke-linecap="round"/><path d="M112 158c7 5 14 5 21 0" stroke="#8a5142" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M45 292c4-62 32-94 75-94 44 0 72 32 76 94" fill="#242b33"/><path d="M108 200h24l12 92h-48Z" fill="#b94d2b"/></svg>';
  return wrapper;
}

function telegramIcon() {
  return svgIcon('<path fill="currentColor" stroke="none" d="M21.6 3.7 18.3 20c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.3-8.4c.4-.4-.1-.6-.6-.2L5.7 13.5.8 12c-1.1-.3-1.1-1.1.2-1.6L20.1 3c.9-.3 1.7.2 1.5.7Z"/>');
}

function messageIcon() {
  return svgIcon('<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/>');
}

// GEN2-minimal dlaždice osobní aplikace (port appCardu z GEN2-minimal karty): ikona nad
// názvem + popisem, Private badge na title-row (privátní hranice zůstává
// viditelná), žádná velká trvalá tlačítka ani trvalé statusové chipy. Hlavní
// akce (spustit a otevřít) je klik na celou dlaždici; ostatní jde pod ⋯ a do
// warning panelu.
function personalAppCard(app) {
  const running = app.runtime_status === "healthy";
  const warning = personalCardWarningModel(app);
  const openable = isOpenable(app);
  const opening = state.openingApps.has(app.id);

  const card = document.createElement("article");
  card.className = `personalspace-app is-${appTone(app, warning)} ${openable ? "is-openable" : "is-readonly"}`.trim();
  card.dataset.appId = app.id;
  card.tabIndex = 0;
  card.setAttribute("aria-label", openable ? `Otevřít ${app.title}` : `${app.title} — detail`);

  const head = document.createElement("div");
  head.className = "personalspace-app-head";

  const titleBlock = document.createElement("div");
  titleBlock.className = "personalspace-app-titleblock";
  titleBlock.append(personalAppIconNode(app));

  const titleBody = document.createElement("div");
  titleBody.className = "personalspace-app-titles";
  const titleRow = document.createElement("div");
  titleRow.className = "personalspace-app-title-row";
  const title = document.createElement("h4");
  title.className = "personalspace-app-title";
  title.textContent = app.title;
  // Private badge zůstává na title-row — osobní surface se nikdy nesmí splést
  // s firemní (izolace per decision 0051).
  titleRow.append(title, badge("Private", "personalspace-private-badge"));
  const desc = document.createElement("p");
  desc.className = "personalspace-app-desc";
  desc.textContent = personalAppDescription(app);
  titleBody.append(titleRow, desc);
  // Jediný povolený stavový chip je „Běží" — a jen když aplikace opravdu běží.
  if (running) {
    const badges = document.createElement("div");
    badges.className = "personalspace-app-badges";
    badges.append(runtimeChip(app));
    titleBody.append(badges);
  }
  titleBlock.append(titleBody);
  head.append(titleBlock);

  const topActions = document.createElement("div");
  topActions.className = "personalspace-app-top-actions";
  if (openable) {
    const cue = document.createElement("span");
    cue.className = "app-open-cue";
    cue.setAttribute("aria-hidden", "true");
    cue.innerHTML = iconOpenGlyph();
    topActions.append(cue);
  }
  // ⋯ menu se ukáže, jen když má obsah (zastavit/restart/logy) — čistá zastavená
  // dlaždice zůstane bez ⋯.
  const menu = personalMenuNode(app);
  if (menu) topActions.append(menu);
  head.append(topActions);

  card.append(head);
  // Sofistikovaný warning panel jen když je co řešit: nainstalovat/opravit
  // balíčky, blokující manifest, nebo vysvětlit spadlé spuštění. Jinak zůstává
  // dlaždice čistá.
  if (warning) card.append(cardWarningNode(app, warning));

  const feedback = document.createElement("div");
  feedback.className = "card-feedback empty";
  feedback.setAttribute("aria-live", "polite");
  if (opening) {
    feedback.classList.remove("empty");
    const note = document.createElement("p");
    note.className = "progress-note loading-dots";
    note.textContent = state.openingMessages.get(app.id) ?? "Otevírám";
    feedback.append(note);
  }
  card.append(feedback);

  // Openable dlaždice: klik na plochu (mimo tlačítka/menu) spustí one-click open.
  if (openable) {
    const activate = (event) => {
      if (event.type === "keydown") {
        if (event.target !== card) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
      } else if (!shouldOpenFromCardSurface(event.target)) {
        return;
      }
      void openPersonalApp(app);
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", activate);
  }
  return card;
}

function moduleSlotChip(slot) {
  const chipEl = document.createElement("span");
  chipEl.className = `personalspace-slot-chip is-${slot.status}`;
  const label = slot.status === "missing_access" ? "chybí přístup" : "plánovaný slot";
  chipEl.textContent = `${slot.slug} · ${label}`;
  chipEl.title = slot.path;
  return chipEl;
}

/* ---- gbrain -------------------------------------------------------------- */

function gbrainState(space) {
  if (!state.gbrain.has(space.dir_name)) {
    state.gbrain.set(space.dir_name, {
      open: false,
      tree: null,
      note: null,
      notePath: null,
      searchResults: null,
      query: "",
      loading: false,
      error: null,
    });
  }
  return state.gbrain.get(space.dir_name);
}

function gbrainSection(space) {
  const section = document.createElement("div");
  section.className = "personalspace-gbrain";
  const gbrain = space.gbrain ?? {};

  const head = document.createElement("div");
  head.className = "personalspace-gbrain-head";
  const label = document.createElement("span");
  label.className = "personalspace-gbrain-label";
  label.append(brainIcon(), document.createTextNode(" gbrain"));
  head.append(label);
  section.append(head);

  if (!gbrain.exists) {
    const missing = document.createElement("p");
    missing.className = "personalspace-gbrain-missing";
    missing.textContent = gbrain.transitional_missing
      ? `Přechodný gbrain zdroj ${gbrain.transitional_missing} není lokálně dostupný. Zkontroluj mount nebo migraci.`
      : "gbrain vault pro tento prostor není lokálně dostupný.";
    section.append(missing);
    return section;
  }

  // Obsidian deep link + read-only browser pro Principálův vault.
  const buttons = document.createElement("div");
  buttons.className = "personalspace-gbrain-buttons";

  const obsidianBtn = document.createElement("a");
  obsidianBtn.className = "btn btn-secondary btn-sm personalspace-gbrain-obsidian";
  obsidianBtn.textContent = "Otevřít v Obsidianu";
  obsidianBtn.href = obsidianDeepLink(gbrain);
  obsidianBtn.title = "Otevře vault v desktopové aplikaci Obsidian (obsidian://open).";
  // Obsidian deep link nemusí fungovat, pokud vault v Obsidianu není
  // zaregistrovaný — vždy ukážeme i cestu jako fallback.
  buttons.append(obsidianBtn);

  const gstate = gbrainState(space);
  const browseBtn = document.createElement("button");
  browseBtn.type = "button";
  browseBtn.className = "btn btn-ghost btn-sm";
  browseBtn.textContent = gstate.open ? "Skrýt zápisy" : "Procházet zápisy";
  browseBtn.addEventListener("click", () => toggleGbrainBrowser(space));
  buttons.append(browseBtn);
  section.append(buttons);

  const pathHint = document.createElement("p");
  pathHint.className = "personalspace-gbrain-path";
  const modeLabel = gbrain.mode === "transitional" ? " (přechodný mount)" : "";
  pathHint.textContent = `Vault: ${gbrain.source_rel}${modeLabel}. Pokud se Obsidian neotevře, vault v něm ještě není zaregistrovaný — otevři tuto cestu ručně.`;
  section.append(pathHint);

  if (gbrain.default_shared === false) {
    const priv = document.createElement("p");
    priv.className = "personalspace-gbrain-private";
    priv.textContent = "gbrain se defaultně nesdílí — přístup drží jen pár Kolega ↔ jeho Buddy.";
    section.append(priv);
  }

  if (gstate.open) {
    section.append(gbrainBrowser(space, gstate));
  }
  return section;
}

function gbrainBrowser(space, gstate) {
  const browser = document.createElement("div");
  browser.className = "personalspace-gbrain-browser";

  // Fulltext
  const searchForm = document.createElement("form");
  searchForm.className = "personalspace-gbrain-search";
  const input = document.createElement("input");
  input.type = "search";
  input.className = "personalspace-gbrain-search-input";
  input.dataset.space = space.dir_name;
  input.placeholder = "Fulltext v zápisech…";
  input.value = gstate.query ?? "";
  input.addEventListener("input", (event) => {
    gstate.query = event.target.value ?? "";
  });
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runGbrainSearch(space);
  });
  const searchBtn = document.createElement("button");
  searchBtn.type = "submit";
  searchBtn.className = "btn btn-secondary btn-sm";
  searchBtn.textContent = "Hledat";
  searchForm.append(input, searchBtn);
  browser.append(searchForm);

  if (gstate.error) {
    const err = document.createElement("p");
    err.className = "personalspace-gbrain-error";
    err.textContent = gstate.error;
    browser.append(err);
  }
  if (gstate.loading) {
    const loading = document.createElement("p");
    loading.className = "personalspace-gbrain-loading";
    loading.textContent = "Načítám…";
    browser.append(loading);
  }

  const columns = document.createElement("div");
  columns.className = "personalspace-gbrain-columns";

  // Levý sloupec: strom nebo výsledky hledání
  const listCol = document.createElement("div");
  listCol.className = "personalspace-gbrain-list";
  if (gstate.searchResults) {
    listCol.append(gbrainSearchResults(space, gstate));
  } else if (gstate.tree) {
    const count = document.createElement("p");
    count.className = "personalspace-gbrain-count";
    count.textContent = `${gstate.tree.file_count} zápisů`;
    listCol.append(count, gbrainTreeNode(space, gstate.tree.tree));
  }
  columns.append(listCol);

  // Pravý sloupec: náhled zápisu
  const noteCol = document.createElement("div");
  noteCol.className = "personalspace-gbrain-note";
  if (gstate.note) {
    const noteTitle = document.createElement("div");
    noteTitle.className = "personalspace-gbrain-note-title";
    noteTitle.textContent = gstate.note.path;
    const body = document.createElement("div");
    body.className = "personalspace-gbrain-note-body markdown-body";
    body.innerHTML = renderMarkdown(gstate.note.content);
    noteCol.append(noteTitle, body);
  } else {
    const hint = document.createElement("p");
    hint.className = "personalspace-gbrain-note-empty";
    hint.textContent = "Vyber zápis vlevo pro náhled (read-only).";
    noteCol.append(hint);
  }
  columns.append(noteCol);
  browser.append(columns);
  return browser;
}

function gbrainTreeNode(space, nodes) {
  const ul = document.createElement("ul");
  ul.className = "personalspace-gbrain-tree";
  for (const node of nodes) {
    const li = document.createElement("li");
    if (node.type === "dir") {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = node.name;
      details.append(summary, gbrainTreeNode(space, node.children ?? []));
      li.append(details);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `personalspace-gbrain-file ${isActiveNote(space, node.path) ? "is-active" : ""}`.trim();
      btn.textContent = node.name;
      btn.title = node.path;
      btn.addEventListener("click", () => openGbrainNote(space, node.path));
      li.append(btn);
    }
    ul.append(li);
  }
  return ul;
}

function gbrainSearchResults(space, gstate) {
  const wrap = document.createElement("div");
  wrap.className = "personalspace-gbrain-results";
  const summary = document.createElement("div");
  summary.className = "personalspace-gbrain-results-head";
  summary.textContent = `${gstate.searchResults.result_count} zápisů se shodou`;
  const back = document.createElement("button");
  back.type = "button";
  back.className = "btn btn-ghost btn-sm";
  back.textContent = "Zpět na strom";
  back.addEventListener("click", () => {
    gstate.searchResults = null;
    rerender();
  });
  summary.append(back);
  wrap.append(summary);

  for (const result of gstate.searchResults.results) {
    const item = document.createElement("div");
    item.className = "personalspace-gbrain-result";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `personalspace-gbrain-file ${isActiveNote(space, result.path) ? "is-active" : ""}`.trim();
    btn.textContent = result.path;
    btn.addEventListener("click", () => openGbrainNote(space, result.path));
    item.append(btn);
    for (const snippet of result.snippets ?? []) {
      const snip = document.createElement("p");
      snip.className = "personalspace-gbrain-snippet";
      snip.textContent = `${snippet.line}: ${snippet.text}`;
      item.append(snip);
    }
    wrap.append(item);
  }
  return wrap;
}

function isActiveNote(space, path) {
  const gstate = gbrainState(space);
  return gstate.notePath === path;
}

async function toggleGbrainBrowser(space) {
  const gstate = gbrainState(space);
  gstate.open = !gstate.open;
  if (gstate.open && !gstate.tree) {
    await loadGbrainTree(space);
  } else {
    rerender();
  }
}

async function loadGbrainTree(space) {
  const gstate = gbrainState(space);
  gstate.loading = true;
  gstate.error = null;
  rerender();
  try {
    gstate.tree = await fetchJson(`/api/personalspace/${encodeURIComponent(space.dir_name)}/gbrain/tree`);
  } catch (error) {
    gstate.error = `Strom zápisů se nepodařilo načíst: ${error.message}`;
  } finally {
    gstate.loading = false;
    rerender();
  }
}

async function openGbrainNote(space, path) {
  const gstate = gbrainState(space);
  gstate.loading = true;
  gstate.error = null;
  gstate.notePath = path;
  rerender();
  try {
    gstate.note = await fetchJson(
      `/api/personalspace/${encodeURIComponent(space.dir_name)}/gbrain/note?path=${encodeURIComponent(path)}`,
    );
  } catch (error) {
    gstate.error = `Zápis se nepodařilo načíst: ${error.message}`;
    gstate.note = null;
  } finally {
    gstate.loading = false;
    rerender();
  }
}

async function runGbrainSearch(space) {
  const gstate = gbrainState(space);
  const query = (gstate.query ?? "").trim();
  if (query.length < 2) {
    gstate.error = "Hledaný výraz musí mít aspoň 2 znaky.";
    rerender();
    return;
  }
  gstate.loading = true;
  gstate.error = null;
  rerender();
  try {
    gstate.searchResults = await fetchJson(
      `/api/personalspace/${encodeURIComponent(space.dir_name)}/gbrain/search?q=${encodeURIComponent(query)}`,
    );
  } catch (error) {
    gstate.error = `Hledání selhalo: ${error.message}`;
  } finally {
    gstate.loading = false;
    rerender();
  }
}

/* ---- runtime akce -------------------------------------------------------- */

// Dlaždice je „openable", když ji jde jedním klikem spustit a otevřít: běžící
// s URL, nebo zastavená s připravenými balíčky. needs_install / blokující
// manifest / spadlé spuštění vede přes warning panel, ne přes klik na dlaždici.
function isOpenable(app) {
  if (app.runtime_status === "healthy") return Boolean(app.url);
  return canStart(app);
}

// Popis dlaždice: osobní aplikace nemají manifest description, tak ukážeme modul
// a endpoint (host:port) — pro buildera užitečný kontext, kam se otevře.
function personalAppDescription(app) {
  const endpoint = app.host && app.port ? `${app.host}:${app.port}` : null;
  const parts = [app.module, endpoint].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Osobní aplikace";
}

// Warning model dlaždice (port cardWarningModel z GEN2-minimal karty, ořezaný na personalspace
// lane — bez git/pull a bez detail panelu): v čistém stavu vrací null, jinak
// popíše, co je potřeba vyřešit. Priorita: blokující manifest > chybějící/
// zastaralé balíčky > spadlé spuštění. Jen instalace/oprava nese přímou akci.
function personalCardWarningModel(app) {
  const dependencyState = app.dependencies?.state;

  // Blokující stavy: aplikace teď nejde spustit — vysvětli proč (bez one-click
  // akce, řešení patří do manifestu / logů).
  if (["invalid_manifest", "missing_package", "unknown_package_manager"].includes(dependencyState)) {
    return {
      tone: "danger",
      title: dependencyLabel(dependencyState),
      detail: app.dependencies?.message || "Osobní aplikace teď nejde spustit. Oprav manifest a balíčky.",
    };
  }

  // Chybí nebo jsou zastaralé balíčky: nainstaluj/oprav před prvním spuštěním.
  if ((dependencyState === "needs_install" || dependencyState === "stale_lockfile") && (app.dependencies?.can_install ?? false)) {
    const action = dependencyState === "needs_install" ? "install" : "repair";
    return {
      tone: "warn",
      title: dependencyState === "needs_install" ? "Chybí balíčky" : "Balíčky k opravě",
      detail:
        dependencyState === "needs_install"
          ? "Osobní aplikace ještě nemá nainstalované balíčky. Nainstaluj je před prvním spuštěním."
          : "Zámek balíčků je zastaralý. Oprav balíčky, ať start proběhne čistě.",
      actionLabel: dependencyState === "needs_install" ? "Instalovat" : "Opravit balíčky",
      run: () => runAction(app, action),
      pending: `${app.id}:${action}`,
    };
  }

  // Poslední spuštění spadlo: pošli do logů (toast).
  if (app.runtime_status === "unhealthy") {
    return {
      tone: "danger",
      title: "Spuštění selhalo",
      detail: "Poslední spuštění spadlo. Otevři logy a podívej se proč.",
      actionLabel: "Logy",
      run: () => loadLogs(app),
      pending: `${app.id}:logs`,
    };
  }

  return null;
}

// Inline warning panel na dlaždici (reuse .card-warning* vzoru): ikona +
// nadpis/vysvětlení + volitelné akční tlačítko. Tón řídí barvu i typ tlačítka
// (warn = primární akce, danger = neutrální ghost). Klik zastaví propagaci, aby
// neotevřel dlaždici.
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
    button.className = `btn btn-sm card-warning-action ${warning.tone === "warn" ? "btn-primary" : "btn-ghost"}`;
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

// ⋯ menu osobní dlaždice (reuse .app-version-menu / .app-more-button / panel
// z GEN2-minimal karty). Osobní aplikace nemají varianty verzí, takže menu drží jen
// runtime akce (zastavit/restart/logy) a ukáže se, jen když má obsah.
function personalMenuNode(app) {
  const actions = personalMenuActions(app);
  if (actions.length === 0) return null;

  const details = document.createElement("details");
  details.className = "app-version-menu";
  details.open = state.openMenu === app.id;
  details.addEventListener("click", (event) => event.stopPropagation());

  const summary = document.createElement("summary");
  summary.className = `app-more-button ${app.runtime_status === "healthy" ? "has-running" : ""}`.trim();
  summary.setAttribute("aria-label", "Další možnosti aplikace");
  summary.title = "Další možnosti";
  summary.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
  summary.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.openMenu = state.openMenu === app.id ? null : app.id;
    rerender();
  });

  const panel = document.createElement("div");
  panel.className = "app-version-menu-panel";
  panel.append(...actions.map((action) => menuActionRow(action)));

  details.append(summary, panel);
  return details;
}

// „Další možnosti" pod ⋯: zastavit/restart vlastněné instance a logy běžící
// aplikace. Spadlá aplikace má logy už ve warning panelu — v menu je nezdvojíme.
function personalMenuActions(app) {
  const actions = [];
  if (canStop(app)) {
    actions.push({ label: "Zastavit", run: () => runAction(app, "stop"), pending: `${app.id}:stop` });
  }
  if (canRestart(app)) {
    actions.push({ label: "Restart", run: () => runAction(app, "restart"), pending: `${app.id}:restart` });
  }
  if (app.runtime_status === "healthy") {
    actions.push({ label: "Logy", run: () => loadLogs(app), pending: `${app.id}:logs` });
  }
  return actions;
}

// Řádek akce v ⋯ menu (reuse .app-menu-action vzoru): jednoduché tlačítko,
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
    state.openMenu = null;
    action.run();
  });
  return button;
}

// Guard na vnitřní ovládací prvky (port shouldOpenFromCardSurface z app.js):
// klik na tlačítko/odkaz/menu neotevírá dlaždici.
function shouldOpenFromCardSurface(target) {
  return !(
    target instanceof Element &&
    target.closest("button, a, summary, details, input, select, textarea")
  );
}

// Ikona ↗ „otevře na klik" (port iconOpenGlyph z app.js).
function iconOpenGlyph() {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
}

// Ikona osobní aplikace: heuristika podle modulu/id/tagů (osobní appky nemají
// manifest icon). Všechny sdílí jednu „private" paletu (accent-tint), což
// vizuálně drží osobní dlaždice pohromadě a odlišuje je od firemních.
function personalAppIconNode(app) {
  const span = document.createElement("span");
  span.className = "personalspace-app-icon";
  span.innerHTML = personalAppIconSvg(personalAppIconKey(app));
  return span;
}

function personalAppIconKey(app) {
  const hay = `${app.module ?? ""} ${app.app_id ?? app.id ?? ""} ${(app.tags ?? []).join(" ")}`.toLowerCase();
  if (/todo|task|plan|kanban|check/.test(hay)) return "check";
  if (/note|journal|diary|memo|write|log/.test(hay)) return "pen";
  if (/brain|memory|knowledge|gbrain|recall/.test(hay)) return "brain";
  if (/calendar|schedule|agenda|day|time/.test(hay)) return "calendar";
  if (/money|budget|finance|expense|wallet/.test(hay)) return "wallet";
  if (/health|habit|fitness|track/.test(hay)) return "pulse";
  return "app";
}

const PERSONAL_APP_ICON_PATHS = {
  check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  brain:
    '<path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.5a2.5 2.5 0 0 0-2 4.5 2.5 2.5 0 0 0 0 4 2.5 2.5 0 0 0 2 4.5v.5a2.5 2.5 0 0 0 5 0V4.5A2.5 2.5 0 0 0 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.5a2.5 2.5 0 0 1 2 4.5 2.5 2.5 0 0 1 0 4 2.5 2.5 0 0 1-2 4.5v.5a2.5 2.5 0 0 1-5 0"/>',
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  wallet:
    '<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  app:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
};

function personalAppIconSvg(key) {
  const path = PERSONAL_APP_ICON_PATHS[key] ?? PERSONAL_APP_ICON_PATHS.app;
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function canStart(app) {
  return app.runtime?.owner !== "current-instance" && (app.dependencies?.can_start ?? false) && app.runtime_status === "stopped";
}
function canStop(app) {
  return app.runtime?.owner === "current-instance";
}
function canRestart(app) {
  return app.runtime?.owner === "current-instance";
}

async function runAction(app, action) {
  state.pendingAction = `${app.id}:${action}`;
  rerender();
  try {
    const response = await fetch(`/api/personalspace/apps/${encodeURIComponent(app.id)}/${action}`, {
      method: "POST",
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? `${action} selhal`);
    deps.onToast(`${app.title}: ${action} dokončeno.`, "ok");
    await deps.onReload();
  } catch (error) {
    deps.onToast(`${app.title}: ${error.message}`, "fail", 6000);
  } finally {
    state.pendingAction = null;
    rerender();
  }
}

async function loadLogs(app) {
  state.pendingAction = `${app.id}:logs`;
  rerender();
  try {
    const logs = await fetchJson(`/api/personalspace/apps/${encodeURIComponent(app.id)}/logs`);
    // Logy zobrazíme jako toast s odkazem — jednoduché read-only. Detailní log
    // panel řeší org lane; osobní appky drží slim povrch.
    deps.onToast(`${app.title}: log má ${logs.content ? logs.content.length : 0} znaků (viz ${logs.log_path}).`, "info", 5000);
  } catch (error) {
    deps.onToast(`${app.title}: logy se nepodařilo načíst.`, "fail", 6000);
  } finally {
    state.pendingAction = null;
    rerender();
  }
}

// One-click open klikem na celou dlaždici: ensure install → start → wait healthy
// → URL v oddělené personalspace lane (server /open chain, port openAppChain
// z app.js). Tab rezervujeme synchronně, aby ho popup blocker nezařízl.
async function openPersonalApp(app) {
  if (state.openingApps.has(app.id)) return;
  state.openingApps.add(app.id);
  state.openingMessages.set(app.id, "Otevírám");
  const reservedTab = reservePersonalTab(app);
  writePersonalTabStatus(reservedTab, app, "Spouštím osobní aplikaci...");
  rerender();
  try {
    const payload = await fetchJson(`/api/personalspace/apps/${encodeURIComponent(app.id)}/open`, { method: "POST" });
    if (payload.url) {
      openPersonalResultUrl(payload.url, reservedTab, app);
      deps.onToast(`${app.title}: běží, otevírám.`, "ok");
    } else if (payload.status === "starting") {
      deps.onToast(`${app.title}: startuje, otevřu ji hned jak naběhne.`, "info", 6000);
      const runtime = await waitForPersonalRuntime(app, reservedTab);
      openPersonalResultUrl(runtime.url ?? app.url, reservedTab, app);
      deps.onToast(`${app.title}: běží, otevírám.`, "ok");
    } else if (payload.status === "healthy" && (payload.runtime?.url || app.url)) {
      openPersonalResultUrl(payload.runtime?.url ?? app.url, reservedTab, app);
      deps.onToast(`${app.title}: běží, otevírám.`, "ok");
    } else {
      throw new Error(
        payload.runtime?.last_error
          ?? payload.runtime?.message
          ?? payload.message
          ?? "Launchpad nedostal URL běžící osobní aplikace.",
      );
    }
    await deps.onReload();
  } catch (error) {
    closePersonalTab(reservedTab);
    const message = error instanceof Error ? error.message : String(error);
    deps.onToast(`${app.title}: ${classifyPersonalOpenError(message)}`, "fail", 7000);
  } finally {
    state.openingApps.delete(app.id);
    state.openingMessages.delete(app.id);
    rerender();
  }
}

// Rezervace tabu PŘED fetchem (není to asynchronní window.open po awaitu, který
// by prohlížeč zablokoval).
function reservePersonalTab(app) {
  const tab = window.open("about:blank", "_blank");
  if (tab) {
    tab.opener = null;
    try {
      tab.document.title = `Spouštím ${app.title}`;
    } catch {
      // blank tab titulek není nutný — když to hodí, nevadí
    }
  }
  return tab;
}

function writePersonalTabStatus(tab, app, message) {
  if (!tab || tab.closed) return;
  try {
    tab.document.open();
    tab.document.write(`<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Spouštím ${escapeHtml(app.title)}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17133f;background:#fbfaff}
    main{max-width:28rem;padding:2rem;text-align:center}
    .mark{width:3rem;height:3rem;margin:0 auto 1rem;border-radius:1rem;background:#f0ebff;color:#6d5dfc;display:grid;place-items:center;font-size:1.5rem}
    h1{margin:0 0 .5rem;font-size:1.25rem}
    p{margin:0;color:#6b668a;line-height:1.5}
  </style>
</head>
<body>
  <main>
    <div class="mark">↗</div>
    <h1>${escapeHtml(message)}</h1>
    <p>${escapeHtml(app.title)} se otevře v tomhle panelu, jakmile odpoví health endpoint.</p>
  </main>
</body>
</html>`);
    tab.document.close();
  } catch {
    // Reserved about:blank tab je best-effort.
  }
}

async function waitForPersonalRuntime(app, reservedTab) {
  const deadline = Date.now() + PERSONAL_OPEN_STARTING_WAIT_MS;
  let lastRuntime = null;
  while (Date.now() < deadline) {
    state.openingMessages.set(app.id, "Aplikace ještě startuje");
    writePersonalTabStatus(reservedTab, app, "Osobní aplikace ještě startuje...");
    rerender();
    await sleep(PERSONAL_OPEN_STARTING_POLL_MS);
    const runtime = await fetchJson(`/api/personalspace/apps/${encodeURIComponent(app.id)}/health`, { method: "POST" });
    lastRuntime = runtime;
    if (runtime.status === "healthy") return runtime;
    if (runtime.status === "unhealthy" || runtime.status === "stopped") {
      throw new Error(runtime.last_error ?? runtime.message ?? "Osobní aplikace se po startu nerozeběhla.");
    }
  }
  throw new Error(lastRuntime?.message ?? "Osobní aplikace pořád startuje a health endpoint zatím neodpovídá.");
}

function openPersonalResultUrl(url, reservedTab, app) {
  if (reservedTab && !reservedTab.closed) {
    reservedTab.location.href = url;
    return;
  }
  if (!window.open(url, "_blank", "noopener")) {
    deps.onToast(`${app.title}: prohlížeč zablokoval nové okno.`, "fail", 6000);
  }
}

function closePersonalTab(reservedTab) {
  if (reservedTab && !reservedTab.closed) reservedTab.close();
}

function classifyPersonalOpenError(message) {
  const text = String(message ?? "");
  if (/port/i.test(text) && /(obsazen|conflict|kolize|PID|EADDRINUSE|in use)/i.test(text)) {
    return "Port osobní aplikace je obsazený jiným procesem. Zavři starou instanci nebo uvolni port.";
  }
  if (/install|balíč|dependency|needs_install/i.test(text)) {
    return "Nepodařilo se doinstalovat balíčky. Otevři logy osobní aplikace.";
  }
  if (/pořád startuje|ještě startuje|health endpoint|start timeout/i.test(text)) {
    return "Osobní aplikace startuje moc dlouho. Launchpad ji dál neumí potvrdit přes health endpoint.";
  }
  if (/not[_ ]?ready|app_not_ready|restricted|missing_access/i.test(text)) {
    return "Osobní modul zatím není připravený ke spuštění.";
  }
  return "Spuštění se nepovedlo. Otevři logy osobní aplikace.";
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

/* ---- helpers ------------------------------------------------------------- */

// Barevný tón dlaždice — warning model je autorita pro zastavené karty (port
// appCardTone z GEN2-minimal karty). Běžící má vždy „running", pak danger → blocked,
// warn → attention; fallback pro edge-case bez warningu.
function appTone(app, warning) {
  if (app.runtime_status === "healthy") return "running";
  if (warning?.tone === "danger") return "blocked";
  if (warning?.tone === "warn") return "attention";
  const dependencyState = app.dependencies?.state;
  if (["missing_package", "unknown_package_manager", "invalid_manifest"].includes(dependencyState)) return "blocked";
  if (["needs_install", "stale_lockfile"].includes(dependencyState)) return "attention";
  if (app.runtime_status === "unhealthy") return "blocked";
  return "idle";
}

function runtimeChip(app) {
  const labels = {
    healthy: ["Běží", "chip-success"],
    starting: ["Startuje", "chip-warn"],
    stopped: ["Zastavené", "chip-muted"],
    unhealthy: ["Runtime problém", "chip-warn"],
  };
  const [label, tone] = labels[app.runtime_status] ?? ["Neznámý stav", "chip-muted"];
  return chip(label, tone, app.runtime_status === "healthy");
}

function dependencyLabel(stateName) {
  return (
    {
      needs_install: "Chybí balíčky",
      stale_lockfile: "Lockfile k opravě",
      missing_package: "Chybí package.json",
      unknown_package_manager: "Nepodporovaný manažer",
      invalid_manifest: "Nevalidní manifest",
    }[stateName] ?? stateName
  );
}

function chip(label, toneClass, withDot = false) {
  const span = document.createElement("span");
  span.className = `chip ${toneClass}`;
  if (withDot) {
    const dot = document.createElement("span");
    dot.className = "chip-dot";
    span.append(dot);
  }
  span.append(document.createTextNode(label));
  return span;
}

function badge(label, className) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = label;
  return span;
}

function obsidianDeepLink(gbrain) {
  const parts = String(gbrain.source_rel ?? "").split("/").filter(Boolean);
  const vaultName = parts.at(-1) ?? "";
  const params = new URLSearchParams();
  if (vaultName) params.set("vault", vaultName);
  return `obsidian://open?${params.toString()}`;
}

async function fetchJson(path, init = {}) {
  const response = await fetch(path, { cache: "no-store", ...init });
  if (!response.ok) {
    let message = `${path} ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.message) message = payload.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return response.json();
}

// Minimální bezpečný markdown → HTML render (client-side). Escapuje HTML nejdřív,
// pak přidá jen základní formátování (nadpisy, tučné, kurzíva, kód, odkazy jen
// jako text, seznamy). Žádný raw HTML z obsahu se nikdy nevloží.
function renderMarkdown(md) {
  const escaped = String(md ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const lines = escaped.split(/\r?\n/);
  const html = [];
  let inCode = false;
  let inList = false;
  for (const line of lines) {
    const fence = line.match(/^```/);
    if (fence) {
      if (inCode) {
        html.push("</code></pre>");
        inCode = false;
      } else {
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
        html.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(`${line}\n`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const listItem = line.match(/^\s*[-*+]\s+(.*)$/);
    if (listItem) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(listItem[1])}</li>`);
      continue;
    }
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
    if (line.trim() === "") {
      html.push("");
      continue;
    }
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (inCode) html.push("</code></pre>");
  if (inList) html.push("</ul>");
  return html.join("\n");
}

function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    // [text](url) → jen text (žádné klikací odkazy z obsahu vaultu)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

// Znovu vyrenderuje tělo personalspace sekce z posledních dat (bez nového
// fetche) — cílí na `#personalspaceSectionBody` v hlavní ploše.
function rerender() {
  const container = document.querySelector("#personalspaceSectionBody");
  if (container && state.data) renderPersonalspace(container, state.data);
}

function brainIcon() {
  return svgIcon(
    '<path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.5a2.5 2.5 0 0 0-2 4.5 2.5 2.5 0 0 0 0 4 2.5 2.5 0 0 0 2 4.5v.5a2.5 2.5 0 0 0 5 0V4.5A2.5 2.5 0 0 0 9.5 2Z" /><path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.5a2.5 2.5 0 0 1 2 4.5 2.5 2.5 0 0 1 0 4 2.5 2.5 0 0 1-2 4.5v.5a2.5 2.5 0 0 1-5 0" />',
  );
}
function svgIcon(inner) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = inner;
  return svg;
}
