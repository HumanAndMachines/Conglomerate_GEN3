import { expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";

const publicRoot = join(import.meta.dirname, "..", "public");
const schemasRoot = join(import.meta.dirname, "..", "schemas");

test("Launchpad renderuje personalspace jako vlastní sekci v hlavní ploše (ne rail) přes oddělenou lane", async () => {
  const [html, appJs, appStateJs] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "app-state.js"), "utf8"),
  ]);

  // Personalspace už NENÍ nacpaný v úzkém railu — je to vlastní vizuálně
  // odlišená sekce v hlavní ploše (nad workspace/productionspace).
  expect(html).not.toContain('id="personalspaceRail"');
  expect(appJs).toContain("function personalspaceSectionNode");
  expect(appJs).toContain('"app-section app-section-personalspace"');
  expect(appJs).toContain('id = "personalspaceSectionBody"');
  // Header selector (Osobní / Organizace) filtruje hlavní plochu na daný prostor.
  expect(appJs).toContain("function renderSpaceSwitcher");
  expect(appJs).toContain('state.filters.scope = "personal"');
  expect(appJs).toContain('scope: "org"');
  expect(appJs).toContain("function personalspaceScopeAvailable");
  expect(appJs).toContain("if (state.personalspace) {");
  expect(appJs).toContain("data.ok === true");
  // Personalspace se čte z vlastního endpointu, ne z /api/apps.
  expect(appJs).toContain('fetchJson("/api/personalspace")');
  // Transportní selhání nesmí shodit org povrch. Úspěšný HTTP payload je ale
  // autorita i při ok:false, aby se odebraný soukromý prostor nevracel ze stale
  // klientské cache.
  expect(appJs).toContain("fetchPersonalspaceSafe()");
  expect(appStateJs).toContain("export function replacePersonalspaceResponse");
  expect(appJs).toContain("replacePersonalspaceResponse(state.personalspace, personalspaceResponse.data)");
  expect(appJs).not.toContain("mergePersonalspaceResponse");
  expect(appJs).toContain("if (personalspaceResponse.ok)");
  expect(appJs).toContain("state.personalspaceError = personalspaceResponse.error");
  expect(appJs).toContain("state.personalspaceError = personalspaceResponse.error");
  // Renderer jde z odděleného personalspace modulu.
  expect(appJs).toContain("renderPersonalspace");
  // Hero musí počítat stav aktivního osobního prostoru z jeho aplikací; prázdný
  // org filtr nesmí falešně tvrdit, že je vše připravené.
  expect(appJs).toContain("renderHero(heroApps, spaceHealth)");
  expect(appJs).toContain("function activeSpaceApps");
  expect(appJs).toContain("function heroDiagnostics");
  expect(appJs).toContain("state.personalspace?.spaces");
  expect(appJs).toContain("state.personalspace?.failures");
  expect(appJs).toContain("state.personalspace?.warnings");
  // Sdílený rail filtrů už neexistuje. V osobním scope se skrývá jen toolbar
  // aplikací; attention CTA proto vede přímo na osobní karty s warning panely.
  expect(appJs).toContain("function renderScopeControls");
  expect(appJs).toContain('elements.hero.classList.toggle("hidden", personal)');
  expect(html).toContain('id="personalPrivacyBadge"');
  expect(appJs).toContain('elements.personalPrivacyBadge?.toggleAttribute("hidden", !personal)');
  expect(appJs).not.toContain("filterRail");
  expect(appJs).toContain('elements.appsToolbar.classList.toggle("hidden", personal)');
  expect(appJs).toContain('elements.drawerToggle.classList.toggle("hidden", personal)');
  expect(appJs).toContain('elements.recentChangesSidebar.classList.toggle("hidden", personal)');
  expect(appJs).toContain('if (state.filters.scope === "personal")');
  expect(appJs).toContain('Boolean(state.personalspace)');
});

test("personalspace.js renderuje prostory, Private badge, owner badge a runtime akce oddělenou lane", async () => {
  const js = await readFile(join(publicRoot, "personalspace.js"), "utf8");

  expect(js).toContain("export function renderPersonalspace");
  expect(js).toContain("function spaceBlock");
  expect(js).toContain("function personalAppCard");
  // Dlaždice jdou do stejné `.apps-grid` mřížky jako workspace sekce.
  expect(js).toContain("apps-grid personalspace-apps-grid");
  // Primární prostor vs. nasdílený s owner badge.
  expect(js).toContain("is_owner_primary");
  expect(js).toContain("personalspace-owner-badge");
  // Private badge na kartách osobních aplikací.
  expect(js).toContain("personalspace-private-badge");
  expect(js).toContain('badge("Private"');
  // Runtime akce přes oddělenou personalspace lane: one-click open (start &
  // otevři) klikem na dlaždici + zastavit/restart pod ⋯ menu.
  expect(js).toContain("/api/personalspace/apps/");
  expect(js).toContain("function openPersonalApp");
  expect(js).toContain('/open`, { method: "POST" }');
  expect(js).toContain("function writePersonalTabStatus");
  expect(js).toContain("function waitForPersonalRuntime");
  expect(js).toContain("/health");
  expect(js).toContain("Launchpad nedostal URL běžící osobní aplikace");
  expect(js).toContain("function classifyPersonalOpenError");
  expect(js).toContain("EADDRINUSE");
  expect(js).toContain('"stop"');
  expect(js).toContain('"restart"');
  // missing_access / planned_slot sloty (sdílené prostory).
  expect(js).toContain("missing_access");
  expect(js).toContain("planned_slot");
});

test("Personalspace je Buddy-first a technické údaje ukazuje až po rozbalení", async () => {
  const [js, css] = await Promise.all([
    readFile(join(publicRoot, "personalspace.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  expect(js).toContain("function buddyCard");
  expect(js).toContain("function recurringTasksCard");
  expect(js).toContain("function telegramIcon");
  expect(js).toContain("Pravidelné úkoly");
  expect(js).toContain("Používáš v aplikaci");
  expect(js).toContain("Buddy je nastavený");
  expect(js).toContain('badge("Nastaveno", "buddy-application-state")');
  expect(js).not.toContain("image.src = avatarUrl");
  expect(js).toContain("Moje aplikace");
  expect(js).toContain("Technické informace");
  expect(js).toContain("function safeExternalUrl");
  expect(js).toContain("technicalOpen: new Set()");
  expect(js).toContain("function bindTechnicalDetails");
  expect(js).toContain("details.open = state.technicalOpen.has(spaceKey)");
  expect(js).toContain("Aplikace v prostoru");
  expect(js).toContain("function personalspaceErrorState");
  expect(js).toContain("Osobní prostor se nepodařilo načíst");
  expect(js).not.toContain('textContent = "Demo Buddy"');
  expect(css).toContain(".personalspace-overview");
  expect(css).toContain(".privacy-pill");
  expect(css).toContain(".buddy-card");
  expect(css).toContain(".buddy-routines");
  expect(css).toContain(".personalspace-technical");
  expect(css).toContain("@media (max-width: 680px)");
  expect(css).toContain(".layout.is-personal .problems-panel:not(.hidden)");
  const boundary = js.indexOf("if (!gbrainBrowsable)");
  const obsidian = js.indexOf('obsidianBtn.textContent = "Otevřít v Obsidianu"');
  expect(boundary).toBeGreaterThan(-1);
  expect(obsidian).toBeGreaterThan(boundary);
  expect(js.slice(boundary, obsidian)).toContain("return section");
  expect(js).toContain("if (!activeSpaceNames.has(spaceName)) state.gbrain.delete(spaceName)");
});

test("personalspace.js má gbrain sekci: Obsidian deep link + read-only browser (strom/note/fulltext)", async () => {
  const js = await readFile(join(publicRoot, "personalspace.js"), "utf8");

  // Obsidian deep link.
  expect(js).toContain("Otevřít v Obsidianu");
  expect(js).toContain("obsidian://open");
  expect(js).toContain("function obsidianDeepLink");
  // Fallback text pro nezaregistrovaný vault.
  expect(js).toContain("vault v něm ještě není zaregistrovaný");
  // Read-only browser: strom, náhled zápisu, fulltext.
  expect(js).toContain("/gbrain/tree");
  expect(js).toContain("/gbrain/note");
  expect(js).toContain("/gbrain/search");
  expect(js).toContain("function renderMarkdown");
  // gbrain se defaultně nesdílí — UI to říká.
  expect(js).toContain("defaultně nesdílí");
});

test("personalspace.js markdown render neinjektuje raw HTML z obsahu vaultu", async () => {
  const js = await readFile(join(publicRoot, "personalspace.js"), "utf8");
  // Obsah se nejdřív escapuje (žádný raw HTML z vaultu do DOM).
  expect(js).toContain('.replace(/&/g, "&amp;")');
  expect(js).toContain('.replace(/</g, "&lt;")');
  // Odkazy z obsahu se renderují jen jako text (žádné klikací URL z vaultu).
  expect(js).toContain("žádné klikací odkazy z obsahu vaultu");
});

test("styles.css nese personalspace section + private treatment + drawer styly", async () => {
  const css = await readFile(join(publicRoot, "styles.css"), "utf8");
  // Vlastní vizuálně odlišená sekce v hlavní ploše (private treatment).
  expect(css).toContain(".app-section-personalspace");
  expect(css).toContain(".personalspace-space-block");
  expect(css).toContain(".personalspace-private-badge");
  expect(css).toContain(".personalspace-owner-badge");
  expect(css).toContain(".personalspace-gbrain");
  expect(css).toContain(".personalspace-gbrain-browser");
  // Osobní logo v header selectoru + skládací drawer pravých panelů (3-col layout).
  expect(css).toContain(".space-logo-personal");
  expect(css).toContain(".detail-drawer");
});

test("kanonická Personalspace schema kopie zůstává base kontraktem s privátními consts", async () => {
  const schema = JSON.parse(await readFile(join(schemasRoot, "personal.gen3.schema.json"), "utf8"));
  expect(schema.$comment).toContain("Upstream source of truth");
  expect(schema.$id).toBe("https://rozjedeme.ai/schemas/personal.gen3.schema.json");
  // Tvrdá privátní hranice v kontraktu.
  expect(schema.properties.privacy.properties.shared_outputs.const).toBe("metadata-only");
  expect(schema.properties.repository.properties.visibility.const).toBe("private");
  expect(schema.properties.gbrain.properties.default_shared.const).toBe(false);
  expect(schema.properties.gbrain.properties.agent_access.const).toBe("mcp-only");
  expect(schema.properties.buddy.properties.display_name).toBeUndefined();
  // Identity invariant stavební kameny (patterny na repo/mount).
  expect(schema.properties.repository.properties.github_repo.pattern).toContain("_GEN3");
  expect(schema.properties.repository.properties.mount_path.pattern).toContain("personalspace/");
});

test("Buddy presentation overlay je oddělený neautoritativní draft", async () => {
  const schema = JSON.parse(await readFile(join(schemasRoot, "personal-buddy-presentation.draft.schema.json"), "utf8"));
  expect(schema.$comment).toContain("Nesmí rozhodovat o validitě personal.gen3.json");
  expect(schema.$id).toContain("personal-buddy-presentation.draft.schema.json");
  expect(schema.properties.application.properties.type.enum).toContain("telegram");
  const mapShape = schema.properties.recurring_tasks.anyOf.find((shape) => shape.type === "object");
  const arrayShape = schema.properties.recurring_tasks.anyOf.find((shape) => shape.type === "array");
  expect(mapShape.additionalProperties.required).toContain("schedule_label");
  expect(mapShape.propertyNames.pattern).toContain("[a-z0-9]");
  expect(arrayShape.items.required).toContain("id");
});

test("Personalspace dlaždice je GEN2-minimal (port GEN2-minimal karty): tile-first, jeden chip, ⋯ menu, warning panel", async () => {
  const [js, css, server] = await Promise.all([
    readFile(join(publicRoot, "personalspace.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
    readFile(join(import.meta.dirname, "server.mjs"), "utf8"),
  ]);

  // Žádná velká trvalá tlačítka ani sekundární akční řádek — dlaždice se otevírá
  // klikem na plochu (one-click open chain přes personalspace lane).
  expect(js).not.toContain("function primaryActionNode");
  expect(js).not.toContain("function secondaryActionNodes");
  expect(js).not.toContain("personalspace-app-actions");
  expect(js).toContain("function openPersonalApp");
  expect(js).toContain("function shouldOpenFromCardSurface");
  expect(js).toContain("function isOpenable");
  expect(js).toContain("openingMessages");
  expect(js).toContain("Osobní aplikace startuje moc dlouho");

  // Jediný povolený stavový chip je „Běží" a jen když aplikace opravdu běží;
  // trvalý „Připraveno" chip (dependencyChip) je pryč.
  expect(js).not.toContain("function dependencyChip");
  expect(js).toContain('const running = app.runtime_status === "healthy";');
  expect(js).toContain("if (running) {");
  expect(js).toContain("badges.append(runtimeChip(app));");

  // Sofistikovaný warning panel se ukáže jen když je co řešit (null jinak);
  // reuse .card-warning* patternů z GEN2-minimal karty.
  expect(js).toContain("function personalCardWarningModel");
  expect(js).toContain("function cardWarningNode");
  expect(js).toContain("if (warning) card.append(cardWarningNode(app, warning))");
  expect(js).toContain("appTone(app, warning)");
  // Přímé akce warning panelu: nainstalovat/opravit balíčky; spadlé spuštění → logy.
  expect(js).toContain("runAction(app, action)");
  expect(js).toContain("Spuštění selhalo");

  // Sekundární akce (zastavit/restart/logy) žijí pod ⋯ menu, které se ukáže jen
  // když má obsah — reuse .app-version-menu / .app-menu-action z GEN2-minimal karty.
  expect(js).toContain("function personalMenuNode");
  expect(js).toContain("function personalMenuActions");
  expect(js).toContain("function menuActionRow");
  expect(js).toContain('summary.className = `app-more-button');
  expect(js).toContain('button.className = "app-menu-action";');

  // Ikona + ↗ open cue dlaždice.
  expect(js).toContain("function personalAppIconNode");
  expect(js).toContain("function iconOpenGlyph");
  expect(js).toContain('cue.className = "app-open-cue";');

  // Private badge zůstává — privátní hranice se nikdy nesmí splést s firemní.
  expect(js).toContain('badge("Private"');

  // CSS: nové dlaždicové třídy + reuse sdílených warning/menu tříd z GEN2-minimal karty.
  expect(css).toContain(".personalspace-app.is-openable");
  expect(css).toContain(".personalspace-app-icon");
  expect(css).toContain(".personalspace-app-title-row");
  expect(css).toContain(".personalspace-app-desc");
  expect(css).toContain(".personalspace-app-top-actions");
  expect(css).toContain(".personalspace-app.is-openable:hover .app-open-cue");
  expect(css).toContain(".card-warning");
  expect(css).toContain(".app-menu-action");

  // Server: personalspace lane má /open chain (ensure install → start → wait
  // healthy → URL) oddělený od firemního manageru.
  expect(server).toContain("personalspaceRuntimeManager.open(route.appId)");
  expect(server).toContain('route.action === "health" && (request.method === "GET" || request.method === "POST")');
  expect(server).toContain("restart|logs|open");
});
