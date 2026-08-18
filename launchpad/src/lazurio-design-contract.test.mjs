import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const publicUrl = new URL("../public/", import.meta.url);
const rootUrl = new URL("../../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, publicUrl), "utf8");
}

test("Launchpad načítá kanonické Lazurio tokeny a lokální fonty", async () => {
  const [styles, html] = await Promise.all([source("styles.css"), source("index.html")]);
  expect(styles).toContain('@import url("/fonts/fonts.css")');
  expect(styles).toContain('@import url("/vendor/lazurio/components.css")');
  expect(html).not.toContain("fonts.googleapis.com");
  expect(html).not.toContain("fonts.gstatic.com");
  expect(styles).not.toMatch(/var\(--lz-space-(?:1|2)\)/);
});

test("Launchpad používá kanonické Lazurio logo ve webové i systémové ikoně", async () => {
  const [html, server, favicon, webIco, touchIcon, shortcutSvg, shortcutIco] = await Promise.all([
    source("index.html"),
    readFile(new URL("launchpad/src/server.mjs", rootUrl), "utf8"),
    readFile(new URL("favicon.svg", publicUrl), "utf8"),
    readFile(new URL("favicon.ico", publicUrl)),
    readFile(new URL("apple-touch-icon.png", publicUrl)),
    readFile(new URL("assets/launchpad.svg", rootUrl), "utf8"),
    readFile(new URL("assets/launchpad.ico", rootUrl)),
  ]);

  expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="any" />');
  expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  expect(server).toContain('if (path.endsWith(".ico")) return "image/x-icon";');
  expect(favicon).toContain('viewBox="0 0 1024 1024"');
  expect(shortcutSvg).toContain('viewBox="-14.02 -16.25 128 128"');
  expect(shortcutSvg).toContain('fill="#ffffff"');
  expect(shortcutSvg).toContain('stop-color="#0d12db"');
  expect(webIco.subarray(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0]));
  expect(touchIcon.readUInt32BE(16)).toBe(180);
  expect(touchIcon.readUInt32BE(20)).toBe(180);
  expect(shortcutIco.subarray(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0]));
});

test("Launchpad nepoužívá neschválenou kapitalizaci ani Lucide ikony", async () => {
  const [styles, html] = await Promise.all([source("styles.css"), source("index.html")]);
  expect(styles).not.toContain("text-transform: uppercase");
  expect(html).not.toContain("lucide/");
});

test("tmavá hlavička je kanonická bez URL experimentu", async () => {
  const [styles, app] = await Promise.all([source("styles.css"), source("app.js")]);
  expect(styles).toMatch(/\/\* Tmavá hlavička ukotvuje shell[\s\S]*?\.topbar\.topbar\s*{[\s\S]*?background: var\(--lz-gray-950\)/);
  expect(styles).toMatch(/\.topbar \.icon-btn,[\s\S]*?color: var\(--lz-gray-100\)/);
  expect(styles).not.toContain("data-header-experiment");
  expect(app).not.toContain("headerExperiment");
});

test("stavové odznaky v hlavičce sdílejí jednu geometrii", async () => {
  const styles = await source("styles.css");
  const badges = styles.slice(styles.indexOf("/* Stavové odznaky v hlavičce jsou jeden systém."));
  expect(badges).toMatch(/\.topbar \.notifications-badge,[\s\S]*?\.topbar \.doctor-status-alert,[\s\S]*?\.topbar \.space-health-badge\s*{/);
  expect(badges).toMatch(/top: -2px;[\s\S]*?right: -5px;[\s\S]*?min-width: 18px;[\s\S]*?height: 18px/);
  expect(badges).toMatch(/border: 2px solid var\(--lz-gray-950\);[\s\S]*?font-size: 10px;[\s\S]*?font-variant-numeric: tabular-nums/);
});

test("výběr dlaždice drží důraz hranou a stav není barevný pruh", async () => {
  const [styles, app] = await Promise.all([source("styles.css"), source("app.js")]);
  const canonical = styles.slice(styles.indexOf("/* CAC-0095 — kanonická materiálová dlaždice."));
  expect(canonical).toMatch(/\.apps-grid > \.app-card\.selected\s*{[\s\S]*?box-shadow:[\s\S]*?inset 3px 0 0 var\(--app-focus-accent, var\(--app-accent\)\)/);
  expect(styles).toMatch(/\.app-card\.is-running::before[\s\S]*?display: none/);
  expect(styles).toMatch(/\.app-section-organization,[\s\S]*?\.app-section-workspace[\s\S]*?border-radius: 0/);
  expect(styles).toMatch(/\.skeleton-card[\s\S]*?border-radius: var\(--lz-radius-md\)/);
  expect(app).toContain('section.className = "app-section app-section-organization skeleton-section"');
  expect(app).toContain('section.setAttribute("aria-busy", "true")');
});

test("modulové ikony a hover hrany používají schválenou expresivní sadu", async () => {
  const [app, styles] = await Promise.all([source("app.js"), source("styles.css")]);
  expect(app).not.toContain("#cccdff");
  expect(app).not.toContain("#fff5cc");
  expect(app).not.toContain("#ccffee");
  expect(app).not.toContain("#ffe7cc");
  expect(app).toContain('stavba: { color: "var(--lz-blue-500)"');
  expect(app).toContain('color: "var(--lz-expressive-orange-figure)"');
  expect(app).toContain('accent: "var(--lz-expressive-orange)"');
  expect(app).toContain('focusAccent: "var(--lz-expressive-orange-figure)"');
  expect(app).toContain('stroj: { color: "var(--lz-expressive-mint-figure)"');
  expect(app).toContain('obchod: { color: "var(--lz-expressive-vermilion-figure)"');
  expect(app).toContain('kampan: { color: "var(--lz-blue-700)"');
  expect(app).toContain('card.style.setProperty("--app-accent"');
  expect(app).toContain('card.style.setProperty("--app-focus-accent"');
  expect(app).toContain("return style.accent ?? style.color");
  expect(app).toContain("return style.focusAccent ?? style.color");
  expect(styles).toMatch(/\.app-card:hover\s*{[\s\S]*?border-color: var\(--app-accent\)/);
  expect(styles).toMatch(/\.app-card:focus-within\s*{[\s\S]*?border-color: var\(--app-focus-accent, var\(--app-accent\)\)/);
  expect(styles).toMatch(/\.app-card-icon\s*{[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?color: var\(--app-icon-color\)/);
});

test("Personalspace používá zaoblené Lazurio objekty a stavové ikony", async () => {
  const [styles, personalspace] = await Promise.all([source("styles.css"), source("personalspace.js")]);
  expect(styles).toMatch(/\.personalspace-overview,[\s\S]*?\.personal-support-card,[\s\S]*?border-radius: var\(--lz-radius-md\)/);
  expect(styles).toMatch(/\.buddy-portrait,[\s\S]*?\.personalspace-app-icon[\s\S]*?border-radius: var\(--lz-radius-sm\)/);
  expect(styles).toMatch(/\.personalspace-overview\s*{[\s\S]*?overflow: hidden/);
  expect(styles).toMatch(/\.personalspace-overview > \.buddy-card,[^}]*\.personalspace-overview > \.buddy-routines\s*{[^}]*border-radius: 0/);
  expect(styles).toMatch(/\.personal-support-grid > \.personal-support-card\s*{[^}]*border-radius: 0/);
  expect(styles).toMatch(/\.buddy-card h2[\s\S]*?font-size: var\(--lz-size-display\)/);
  expect(personalspace).toContain('statusBadge("Buddy je nastavený"');
  expect(personalspace).toContain('statusBadge("Soukromé"');
  expect(personalspace).toContain("var(--lz-blue-500)");
  expect(personalspace).not.toContain('badge("Private"');
});

test("Launchpad nepoužívá pyritovou barevnou roli", async () => {
  const [styles, app, personalspace] = await Promise.all([
    source("styles.css"),
    source("app.js"),
    source("personalspace.js"),
  ]);
  const authoredSurface = `${styles}\n${app}\n${personalspace}`;
  expect(authoredSurface).not.toContain("--lz-warning");
  expect(authoredSurface).not.toContain("--lz-expressive-yellow");
  expect(authoredSurface).not.toContain("--lz-persona-buddy");
  expect(authoredSurface).not.toMatch(/#(?:ad8b00|876612|9a5b00|78350f|f59e0b)/i);
  expect(styles).toContain("--c-warn: var(--lz-expressive-orange-figure)");
});

test("filtr aplikací používá jednu společnou Lazurio kapsli", async () => {
  const styles = await source("styles.css");
  expect(styles).toMatch(/#appsFilterControls \.segmented-control\s*{[^}]*gap: 0;[^}]*border: 1px solid var\(--lz-line\);[^}]*border-radius: var\(--lz-radius-pill\);[^}]*background: var\(--lz-gray-50\)/);
  expect(styles).toMatch(/#appsFilterControls \.segment\s*{[^}]*border: 0;[^}]*border-radius: var\(--lz-radius-pill\);[^}]*background: transparent/);
  expect(styles).toContain('#appsFilterControls .segment[aria-pressed="true"]');
  expect(styles).toMatch(/#appsFilterControls \.segment\[aria-pressed="true"\],[^}]*background: var\(--lz-ink\)[^}]*color: var\(--lz-white\)/);
  expect(styles).toMatch(/\.search-field:focus-within\s*{[\s\S]*?border-color: var\(--lz-gray-700\);[\s\S]*?background: var\(--lz-white\)/);
  expect(styles).toMatch(/\.search-field:focus-within\s*{[\s\S]*?outline: none;/);
  expect(styles).toMatch(/\.search-field input:focus-visible\s*{[\s\S]*?outline: none;/);
});

test("samostatné panely a popovery sdílejí měkký Lazurio radius", async () => {
  const styles = await source("styles.css");
  expect(styles).toMatch(/\.space-switcher-menu,[^}]*\.detail-panel\s*{[^}]*border-radius: var\(--lz-radius-md\)/);
  expect(styles).toMatch(/\.team-access-content\s*{[^}]*border-radius: var\(--lz-radius-md\)/);
  expect(styles).toMatch(/\/\* --- BANNER O NOVÉ VERZI[^]*?\.update-banner\s*{[^}]*border-radius: var\(--lz-radius-md\)/);
  expect(styles).toMatch(/\.recent-changes-sidebar > \.update-banner-group \.update-banner\s*{[^}]*border-radius: var\(--lz-radius-md\)/);
  expect(styles).toMatch(/\.app-version-menu-panel\s*{[\s\S]*?position: static/);
});

test("mobilní klidové stavy tvoří kompaktní řadu a akční stav zůstává výrazný", async () => {
  const styles = await source("styles.css");
  const mobileStatus = styles.slice(styles.indexOf("/* Na mobilu jsou klidové provozní stavy"));
  expect(mobileStatus).toMatch(/@media \(max-width: 760px\)[^]*?\.global-update-slot \.update-banner-group\s*{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  expect(mobileStatus).toMatch(/\.global-update-slot \.update-banner\s*{[^}]*min-height: 42px;[^}]*padding: var\(--lz-space-8\)/);
  expect(mobileStatus).toMatch(/\.global-update-slot \.update-banner\.is-blocked,[^}]*:has\(\.update-banner-action:not\(\[hidden\]\)\)\s*{[^}]*grid-column: 1 \/ -1/);
  expect(mobileStatus).toMatch(/@media \(max-width: 360px\)[^]*?grid-template-columns: minmax\(0, 1fr\)/);
});

test("Organizace, Workspace a Productionspace používají modrou záložku v bezpečném toku", async () => {
  const [styles, app] = await Promise.all([source("styles.css"), source("app.js")]);
  expect(styles).toMatch(/\.app-section-organization:not\(\.skeleton-section\),[\s\S]*?border-top-color: var\(--lz-blue-500\)/);
  const finalLayout = styles.slice(styles.indexOf("/* Filtry mohou hlavičku Organizace zvětšit"));
  expect(finalLayout).toMatch(/\.app-section-workspace > \.app-section-head:first-child\s*{[\s\S]*?position: static;[\s\S]*?transform: none/);
  expect(styles).toMatch(/\.app-section-workspace > \.app-section-head:first-child \.app-section-title[\s\S]*?background: var\(--lz-blue-500\)[\s\S]*?color: var\(--lz-white\)/);
  expect(styles).toMatch(/\.app-section-productionspace > \.app-section-head:first-child\s*{[\s\S]*?position: static;[\s\S]*?transform: none/);
  expect(styles).toMatch(/\.app-section-productionspace > \.app-section-head:first-child \.app-section-title[\s\S]*?background: var\(--lz-blue-500\)[\s\S]*?color: var\(--lz-white\)/);
  expect(styles).toContain("font-variant-numeric: tabular-nums");
  expect(app).toContain('appSectionHead("Organizace"');
  expect(app).toMatch(/"Workspace",\r?\n\s+`\$\{uniqueModules\.size\}/);
  expect(app).toContain('entry.productionspace.display_name ?? "Productionspace"');
  expect(app).not.toContain("app-section-eyebrow");
});

test("kanonické modulové dlaždice jsou samostatné zaoblené karty", async () => {
  const [styles, app] = await Promise.all([source("styles.css"), source("app.js")]);
  const base = styles.slice(styles.indexOf("/* Základ dlaždic podle produktové reference"));
  const canonical = styles.slice(styles.indexOf("/* CAC-0095 — kanonická materiálová dlaždice."));
  expect(base).toMatch(/\.app-card\s*{[\s\S]*?min-height: 16rem;[\s\S]*?padding: var\(--lz-space-24\)/);
  expect(base).toMatch(/\.app-title-block\s*{[\s\S]*?gap: 28px/);
  expect(base).toMatch(/\.app-card-desc\s*{[\s\S]*?font-size: 15px;[\s\S]*?line-height: 1\.55/);
  expect(canonical).toMatch(/\.apps-grid\s*{[\s\S]*?column-gap: var\(--lz-space-16\);[\s\S]*?row-gap: var\(--lz-space-16\);[\s\S]*?border: 0/);
  expect(canonical).toMatch(/\.apps-grid > \.app-card\s*{[\s\S]*?border: 1\.5px solid var\(--lz-line\);[\s\S]*?border-radius: var\(--lz-radius-md\)/);
  expect(canonical).toMatch(/\.apps-grid > \.app-card:not\(\.has-open-menu\):focus-within,[\s\S]*?\.apps-grid > \.app-card\.selected\s*{[\s\S]*?border-color: var\(--app-focus-accent, var\(--app-accent\)\)/);
  expect(canonical).toMatch(/\.apps-grid > \.app-card::after\s*{[\s\S]*?border-radius: inherit/);
  expect(canonical).toMatch(/box-shadow: 0 10px 24px -22px color-mix\(in srgb, var\(--lz-ink\) 24%, transparent\)/);
  expect(canonical).toMatch(/\.app-card:not\(\.selected\):not\(\.has-open-menu\):hover\s*{[\s\S]*?transform: none/);
  expect(canonical).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.apps-grid > \.app-card \.app-card-desc,[\s\S]*?\.apps-grid > \.app-card::after\s*{[\s\S]*?transition: none/);
  expect(styles).toMatch(/\.app-card-icon\.is-pixel-art img\s*{[\s\S]*?image-rendering: pixelated/);
  expect(app).toContain("const PIXEL_APP_ICON_FILES = Object.freeze({");
  expect(app).toContain("const key = appIconKey(app);");
  expect(app).not.toContain("guideIconExperiment");
  expect(app).toContain('app.module === "mission-control" ? "" : variantTag(app, moduleName)');
  expect(app).toContain('control: "Procesy, automatizace a koordinace práce."');
  expect(app).toContain('book: "Návody, dokumentace a sdílené znalosti."');
  expect(app).toContain('system: "Provozní nástroje a technické zázemí."');
});

test("pracovní plocha používá teplý papír bez mřížky a obvodových linek sekcí", async () => {
  const styles = await source("styles.css");
  const surface = styles.slice(styles.indexOf("/* Klidná pracovní plocha"));
  expect(surface).toMatch(/body\s*{[\s\S]*?background-color: var\(--lz-paper\);[\s\S]*?background-image: none/);
  expect(surface).toMatch(/\.app-section-organization:not\(\.skeleton-section\),[\s\S]*?\.app-section-workspace\s*{[\s\S]*?border: 0;[\s\S]*?background: transparent/);
  expect(surface).toMatch(/\.workspace-team\s*{[\s\S]*?border-top: 0/);
});

test("záložky sekcí mají vodicí linku a dlouhé názvy modulů se nezkracují elipsou", async () => {
  const styles = await source("styles.css");
  const tabs = styles.slice(styles.indexOf("/* Organizace, Workspace a Productionspace jsou strukturální záložky"));
  const finalSurface = styles.slice(styles.indexOf("/* Klidná pracovní plocha"));
  expect(tabs).toMatch(/\.app-section-workspace > \.app-section-head:first-child\s*{[\s\S]*?left: 0;[\s\S]*?right: 0/);
  expect(tabs).toMatch(/\.app-section-workspace > \.app-section-head:first-child \.app-section-title-row,[\s\S]*?\.app-section-productionspace > \.app-section-head:first-child \.app-section-title-row\s*{[\s\S]*?border-bottom: 1px solid var\(--lz-blue-500\)/);
  expect(finalSurface).toMatch(/\.app-card-title\s*{[\s\S]*?text-overflow: clip;[\s\S]*?white-space: normal;[\s\S]*?-webkit-line-clamp: 2;[\s\S]*?line-clamp: 2/);
});

test("informace o přístupu k Teamům je schovaná pod otazníkem", async () => {
  const [styles, app] = await Promise.all([source("styles.css"), source("app.js")]);
  const finalSurface = styles.slice(styles.indexOf("/* Klidná pracovní plocha"));
  expect(app).toContain('document.createElement("details")');
  expect(app).toContain('help.textContent = "?"');
  expect(finalSurface).toMatch(/\.team-access-summary > summary\s*{[\s\S]*?display: inline-flex;[\s\S]*?cursor: pointer/);
  expect(finalSurface).toMatch(/\.team-access-content\s*{[\s\S]*?position: absolute;[\s\S]*?background: var\(--lz-white\)/);
  expect(finalSurface).toMatch(/\.team-access-summary \.chip\s*{[\s\S]*?border: 0;[\s\S]*?background: transparent/);
});

test("materiálový průchod používá výraznější hrany a odstupňované Lazurio neutrály", async () => {
  const styles = await source("styles.css");
  const material = styles.slice(styles.indexOf("/* Materiálový průchod inspirovaný referencí"));
  expect(material).toMatch(/\.topbar\s*{[\s\S]*?border-bottom-width: 1\.5px;[\s\S]*?background: var\(--lz-white\)/);
  expect(material).toMatch(/\.search-field\s*{[\s\S]*?border-width: 1\.5px;[\s\S]*?background: var\(--lz-gray-50\)/);
  expect(material).toMatch(/\.app-card\s*{[\s\S]*?border-width: 1\.5px;[\s\S]*?border-color: var\(--lz-line\);[\s\S]*?background: var\(--lz-white\)/);
  expect(styles).toMatch(/\.app-card > \.card-warning\.is-fact,[\s\S]*?\.app-card > \.card-warning\.is-jen-akce\s*{[\s\S]*?display: flex;[\s\S]*?min-height: 52px;[\s\S]*?margin-top: auto;[\s\S]*?border-top: 1px solid var\(--lz-line-faint\)/);
  expect(styles).toContain(".app-card > .card-warning:not(.is-jen-akce):not(.is-fact)");
  expect(material).toMatch(/\.recent-changes-sidebar > \.update-banner-group \.update-banner\s*{[\s\S]*?background: var\(--lz-white\)/);
});

test("uvítání pracovního prostoru používá display hierarchii Lazuria", async () => {
  const styles = await source("styles.css");
  expect(styles).toMatch(/\.workspace-welcome-title\s*{[\s\S]*?font-size: var\(--lz-size-display\);[\s\S]*?font-weight: var\(--lz-weight-title\);[\s\S]*?line-height: var\(--lz-leading-display\);[\s\S]*?letter-spacing: var\(--lz-track-display\)/);
  expect(styles).toMatch(/\.workspace-welcome\s*{[\s\S]*?margin-bottom: var\(--lz-space-16\);/);
});

test("menu dalších možností se rozbalí uvnitř dlaždice bez vrstveného hoveru", async () => {
  const [styles, app, personalspace] = await Promise.all([
    source("styles.css"),
    source("app.js"),
    source("personalspace.js"),
  ]);
  expect(styles).toMatch(/\.app-version-menu-panel\s*{[\s\S]*?position: static;[\s\S]*?width: 100%;[\s\S]*?border-top: 1px solid var\(--lz-line-faint\)/);
  expect(styles).toMatch(/\.app-card\.has-open-menu:not\(\.selected\),[\s\S]*?border-color: var\(--lz-line\);[\s\S]*?background: var\(--lz-white\)/);
  expect(styles).toMatch(/\.apps-grid\s*{[\s\S]*?align-items: start/);
  expect(styles).toMatch(/\.apps-grid > \.app-card\s*{[\s\S]*?align-self: start/);
  expect(styles).toMatch(/\.personalspace-app\.has-open-menu,[\s\S]*?background: var\(--lz-paper\);[\s\S]*?box-shadow: none/);
  expect(app).toContain("if (inlineMenuPanel) card.append(inlineMenuPanel)");
  expect(app).toContain('trigger.setAttribute("aria-expanded", String(isOpen))');
  expect(app).toContain("focusMenuTriggerAfterRender(document, familyKey)");
  expect(personalspace).toContain("if (menu?.panel) card.append(menu.panel)");
  expect(personalspace).toContain('trigger.setAttribute("aria-expanded", String(isOpen))');
  expect(personalspace).toContain("focusMenuTriggerAfterRender(document, app.id)");
});
