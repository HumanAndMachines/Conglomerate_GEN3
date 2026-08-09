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
  expect(shortcutSvg).toContain('viewBox="0 0 1024 1024"');
  expect(shortcutSvg).toContain('fill="#171717"');
  expect(webIco.subarray(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0]));
  expect(touchIcon.byteLength).toBeGreaterThan(1_000);
  expect(shortcutIco.subarray(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0]));
});

test("Launchpad nepoužívá neschválenou kapitalizaci ani Lucide ikony", async () => {
  const [styles, html] = await Promise.all([source("styles.css"), source("index.html")]);
  expect(styles).not.toContain("text-transform: uppercase");
  expect(html).not.toContain("lucide/");
});

test("výběr dlaždice drží důraz hranou a stav není barevný pruh", async () => {
  const [styles, app] = await Promise.all([source("styles.css"), source("app.js")]);
  const experiment = styles.slice(styles.indexOf("/* Experiment dlaždic podle produktové reference"));
    expect(experiment).toMatch(/\.app-card\.selected\s*{[\s\S]*?border-color: var\(--app-focus-accent, var\(--app-accent\)\);[\s\S]*?box-shadow: inset 3px 0 0 var\(--app-focus-accent, var\(--app-accent\)\)/);
  expect(styles).toMatch(/\.app-card\.is-running::before[\s\S]*?display: none/);
  expect(styles).toMatch(/\.app-section-organization,[\s\S]*?\.app-section-workspace[\s\S]*?border-radius: 0/);
  expect(styles).toMatch(/\.skeleton-card[\s\S]*?border-radius: 0/);
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
  expect(app).toContain('kampan: { color: "var(--lz-expressive-yellow-figure)"');
  expect(app).toContain('card.style.setProperty("--app-accent"');
  expect(app).toContain('card.style.setProperty("--app-focus-accent"');
  expect(app).toContain("return style.accent ?? style.color");
  expect(app).toContain("return style.focusAccent ?? style.color");
  expect(styles).toMatch(/\.app-card:hover\s*{[\s\S]*?border-color: var\(--app-accent\)/);
  expect(styles).toMatch(/\.app-card:focus-within\s*{[\s\S]*?border-color: var\(--app-focus-accent, var\(--app-accent\)\)/);
  expect(styles).toMatch(/\.app-card-icon\s*{[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?color: var\(--app-icon-color\)/);
});

test("Personalspace používá ostré Lazurio plochy a stavové ikony", async () => {
  const [styles, personalspace] = await Promise.all([source("styles.css"), source("personalspace.js")]);
  expect(styles).toMatch(/\.personalspace-overview[\s\S]*?border-radius: 0/);
  expect(styles).toMatch(/\.buddy-card,[\s\S]*?\.personal-support-card[\s\S]*?border-radius: 0/);
  expect(styles).toMatch(/\.buddy-card h2[\s\S]*?font-size: var\(--lz-size-display\)/);
  expect(personalspace).toContain('statusBadge("Buddy je nastavený"');
  expect(personalspace).toContain('statusBadge("Soukromé"');
  expect(personalspace).toContain("var(--lz-persona-buddy)");
  expect(personalspace).not.toContain('badge("Private"');
});

test("filtr aplikací používá dvě samostatné Lazurio pilulky", async () => {
  const styles = await source("styles.css");
  expect(styles).toMatch(/\.apps-toolbar \.segmented-control\s*{[\s\S]*?background: transparent/);
  expect(styles).toMatch(/\.apps-toolbar \.segment\s*{[\s\S]*?border-radius: var\(--lz-radius-pill\)/);
  expect(styles).toContain('.apps-toolbar .segment[aria-pressed="true"]');
  expect(styles).toMatch(/\.apps-toolbar \.segment\[aria-pressed="true"\],[\s\S]*?background: var\(--lz-ink\)[\s\S]*?color: var\(--lz-white\)/);
  expect(styles).toMatch(/\.search-field:focus-within\s*{[\s\S]*?outline: none;/);
  expect(styles).toMatch(/\.search-field input:focus-visible\s*{[\s\S]*?outline: none;/);
});

test("Organizace, Workspace a Productionspace používají nadpis jako modrou záložku na hraně", async () => {
  const [styles, app] = await Promise.all([source("styles.css"), source("app.js")]);
  expect(styles).toMatch(/\.app-section-organization:not\(\.skeleton-section\),[\s\S]*?border-top-color: var\(--lz-blue-500\)/);
  expect(styles).toMatch(/\.app-section-workspace > \.app-section-head:first-child[\s\S]*?transform: translateY\(-100%\)/);
  expect(styles).toMatch(/\.app-section-workspace > \.app-section-head:first-child \.app-section-title[\s\S]*?background: var\(--lz-blue-500\)[\s\S]*?color: var\(--lz-white\)/);
  expect(styles).toMatch(/\.app-section-productionspace > \.app-section-head:first-child\s*{[\s\S]*?position: static;[\s\S]*?transform: none/);
  expect(styles).toMatch(/\.app-section-productionspace > \.app-section-head:first-child \.app-section-title[\s\S]*?background: var\(--lz-blue-500\)[\s\S]*?color: var\(--lz-white\)/);
  expect(styles).toContain("font-variant-numeric: tabular-nums");
  expect(app).toContain('appSectionHead("Organizace"');
  expect(app).toContain('appSectionHead("Workspace"');
  expect(app).toContain('entry.productionspace.display_name ?? "Productionspace"');
  expect(app).not.toContain("app-section-eyebrow");
});

test("experimentální modulové dlaždice mají stálou hranu a vzdušný rytmus", async () => {
  const [styles, app] = await Promise.all([source("styles.css"), source("app.js")]);
  const experiment = styles.slice(styles.indexOf("/* Experiment dlaždic podle produktové reference"));
  expect(experiment).toMatch(/\.apps-grid\s*{[\s\S]*?align-items: start/);
  expect(experiment).toMatch(/\.apps-grid > \.app-card\s*{[\s\S]*?align-self: start/);
  expect(experiment).toMatch(/\.app-card\s*{[\s\S]*?min-height: 16rem;[\s\S]*?padding: var\(--lz-space-24\);[\s\S]*?border: 1px solid color-mix\(in srgb, var\(--lz-line-faint\) 50%, var\(--lz-line\)\);[\s\S]*?border-radius: 18px/);
  expect(experiment).toMatch(/\.app-title-block\s*{[\s\S]*?gap: 28px/);
  expect(experiment).toMatch(/\.app-title-body\s*{[\s\S]*?gap: var\(--lz-space-16\)/);
  expect(experiment).toMatch(/\.app-card-desc\s*{[\s\S]*?font-size: 15px;[\s\S]*?line-height: 1\.55/);
  expect(experiment).toMatch(/\.app-card:hover\s*{[\s\S]*?border-color: var\(--app-accent\)/);
  expect(experiment).toMatch(/\.app-card\.selected\s*{[\s\S]*?border-color: var\(--app-focus-accent, var\(--app-accent\)\)/);
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
  expect(material).toMatch(/\.organization-git-status\s*{[\s\S]*?background: var\(--lz-paper\)/);
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
  expect(personalspace).toContain("if (menu?.panel) card.append(menu.panel)");
  expect(personalspace).toContain('trigger.setAttribute("aria-expanded", String(isOpen))');
});
