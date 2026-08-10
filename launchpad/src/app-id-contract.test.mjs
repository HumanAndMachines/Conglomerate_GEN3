// Kontrakt app id vs. doctor surface (decision 0118, founder ruling 2026-07-29).
//
// Proč tenhle soubor existuje. Doctor staví id runtime checku jako
// `launchpad.runtime.${app.id}` (diagnostics-lib.mjs, runtimeAppCheck). Surface
// doctor reportu z decision 0118 vyžaduje `^[a-z0-9]+([._-][a-z0-9]+)*$` — samá
// malá písmena. Manifestový pattern pro `companyascode.app.id` byl přitom malý
// od začátku, jenže porušení bylo podle decision 0043 jen scoped varování v
// `invalid_apps`, ne brána. Dvacet manifestů (`AgentMint-*`, `Macano-Tech-*`)
// tak žilo měsíce a jejich id uteklo do reportu — `doctor.self_conformance`
// hlásil 20 porušení schématu. Pravidlo platilo, mechanismus chyběl.
//
// Konkrétní den, kvůli kterému to tady je: 2026-07-29 se root doctor poprvé
// porovnal se svým vlastním surfacem a spadl na datech, kterých si předtím
// nikdo nevšiml, protože se zobrazovala jen jako oranžová karta v Launchpadu.
// Tenhle test tu vazbu drží mechanicky: rozšíří-li někdo manifestový pattern o
// velká písmena (návrh, který v té době ležel v otevřeném PR), spadne to tady,
// a ne až v reportu o generaci dál.

import { expect, test } from "bun:test";
import { readFile, readdir, stat } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { organizationAppIdPrefix, validateAppManifest } from "./discovery-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const appSchemaPath = join(repoRoot, "launchpad", "schemas", "launchpad-app.schema.json");
const doctorSchemaPath = join(repoRoot, "launchpad", "schemas", "doctor-report.schema.json");

// Surface doctor reportu (decision 0118). Drží se tu jako literál, protože
// `doctor-report.schema.json` přišel až se samotným doctor surfacem — jakmile je
// na disku, test níž ověří, že se ta dvě místa neliší. Podmíněné přeskočení by
// bylo horší než literál: neběžící kontrola vypadá stejně jako splněná.
const DOCTOR_CHECK_ID_PATTERN = "^[a-z0-9]+([._-][a-z0-9]+)*$";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("app identity prefix se odvozuje z Organization slug, ne z Teamu nebo brandu", () => {
  expect(organizationAppIdPrefix("HumanAndMachine-ai")).toBe("humanandmachine-ai-");
  expect(organizationAppIdPrefix("ExampleOrg")).toBe("exampleorg-");

  const app = {
    id: "humanandmachine-ai-website-lazurio-v1",
    company: "HumanAndMachine-ai",
    module: "website-lazurio",
  };
  expect(app.company).toBe("HumanAndMachine-ai");
  expect(app.id.startsWith(organizationAppIdPrefix(app.company))).toBe(true);
  expect(app.id.startsWith("lazurio-")).toBe(false);
});

test("manifestový pattern pro app.id nepovoluje velká písmena", async () => {
  const schema = await readJson(appSchemaPath);
  const pattern = schema.properties?.id?.pattern;

  expect(pattern).toBe("^[a-z0-9]+(-[a-z0-9]+)*$");
  // Rozšíření na [A-Za-z0-9] by drift legalizovalo, ne opravilo: check id se
  // staví z app.id bez ohledu na to, jestli je manifest validní, takže
  // `doctor.self_conformance` by padal dál a jen by zmizela oranžová karta.
  expect(new RegExp(pattern).test("Macano-Tech-cenik-v2")).toBe(false);
  expect(new RegExp(pattern).test("AgentMint-design-system-v1")).toBe(false);
  expect(new RegExp(pattern).test("macano-tech-cenik-v2")).toBe(true);
  expect(new RegExp(pattern).test("agentmint-design-system-v1")).toBe(true);
});

test("doctor surface pattern v repozitáři se shoduje s tím, proti čemu se tady testuje", async () => {
  // Žádná tolerance chybějícího souboru: `doctor-report.schema.json` je
  // vendorovaná kopie surfacu z HumanAndMachines a v tomhle repu je od merge
  // PR #63. Kdyby se test uměl kolem chybějícího souboru „prosmýknout",
  // vypadalo by jeho přeskočení stejně jako splněná kontrola.
  const doctorSchema = await readJson(doctorSchemaPath);
  const pattern = doctorSchema.properties?.checks?.items?.properties?.id?.pattern
    ?? doctorSchema.$defs?.check?.properties?.id?.pattern;
  expect(pattern).toBe(DOCTOR_CHECK_ID_PATTERN);
});

test("každé app.id povolené manifestem dá doctor check id v souladu se surfacem", async () => {
  const schema = await readJson(appSchemaPath);
  const appIdPattern = new RegExp(schema.properties.id.pattern);
  const checkIdPattern = new RegExp(DOCTOR_CHECK_ID_PATTERN);

  // Reprezentativní vzorek přes celý povolený tvar: jedno písmeno, číslice,
  // pomlčky jako oddělovač i ve shluku, verzovaný suffix, reálná produkční id.
  const accepted = [
    "a",
    "9",
    "app",
    "app-v1",
    "macano-tech-cenik-v2",
    "macano-tech-rozvadece-dokumentace-v1",
    "agentmint-mission-control-v1",
    "test-company-demo-v1",
  ];
  for (const id of accepted) {
    expect(appIdPattern.test(id)).toBe(true);
    expect(checkIdPattern.test(`launchpad.runtime.${id}`)).toBe(true);
  }

  // A obráceně: co manifest odmítne, to se do reportu nemá jak dostat.
  const rejected = ["Macano-Tech-cenik-v2", "AgentMint-knowledgebase-v1", "-leading", "under_score", "MiXeD"];
  for (const id of rejected) {
    expect(appIdPattern.test(id)).toBe(false);
  }

  // ŽÁDNÁ DÍRA MEZI TĚMI DVĚMA PATTERNY. První verze tohohle testu `trailing-`
  // jen ZAZNAMENALA jako známou odchylku — jenže zaznamenaná díra je pořád díra:
  // manifest by ho pustil, `launchpad.runtime.trailing-` by surface odmítl a
  // `doctor.self_conformance` by spadl přesně tak, jak spadl 2026-07-29, jen o
  // jeden znak jinak (nález greptile na PR #64). Manifestový pattern je proto
  // teď PODMNOŽINA surfacu: segmenty oddělené pomlčkou, každý neprázdný.
  for (const id of ["trailing-", "-leading", "double--hyphen", "-"]) {
    expect({ id, manifest: appIdPattern.test(id) }).toEqual({ id, manifest: false });
    expect(checkIdPattern.test(`launchpad.runtime.${id}`)).toBe(false);
  }

  // Vyčerpávající důkaz, že podmnožina platí i pro tvary, na které nikdo
  // nepomyslel: každý řetězec do délky 5 nad abecedou {a, 1, -}, který
  // manifest pustí, musí dát platné check id. Prochází 363 kombinací.
  const alphabet = ["a", "1", "-"];
  let checked = 0;
  const leaks = [];
  const walk = (prefix) => {
    if (prefix !== "") {
      checked += 1;
      if (appIdPattern.test(prefix) && !checkIdPattern.test(`launchpad.runtime.${prefix}`)) {
        leaks.push(prefix);
      }
    }
    if (prefix.length === 5) return;
    for (const character of alphabet) walk(prefix + character);
  };
  walk("");
  expect({ leaks, checked }).toEqual({ leaks: [], checked: 363 });
});

test("validateAppManifest hlásí velké písmeno v app.id jako failure, ne jako soft warning", async () => {
  const schema = await readJson(appSchemaPath);
  const failures = [];
  const softWarnings = [];
  const app = {
    schema_version: "companyascode.launchpad_app.v1",
    id: "Macano-Tech-cenik-v2",
    title: "Ceník",
    company: "Macano-Tech",
    module: "cenik",
    surface: "internal",
    port: 5724,
    host: "127.0.0.1",
    health_path: "/health",
    dev_script: "dev",
    tags: ["internal"],
  };

  validateAppManifest({
    app,
    packageJson: { scripts: { dev: "bun server.mjs" } },
    packagePath: "organizations/Macano-Tech_GEN3/workspace/cenik/app/v2/package.json",
    schema,
    failures,
    softWarnings,
  });

  expect(failures.some((failure) => failure.includes("companyascode.app.id"))).toBe(true);
  expect(softWarnings.some((warning) => warning.includes("companyascode.app.id"))).toBe(false);

  // Kontrolní běh: stejný manifest s malým id nemá k app.id co vytknout.
  const cleanFailures = [];
  validateAppManifest({
    app: { ...app, id: "macano-tech-cenik-v2" },
    packageJson: { scripts: { dev: "bun server.mjs" } },
    packagePath: "organizations/Macano-Tech_GEN3/workspace/cenik/app/v2/package.json",
    schema,
    failures: cleanFailures,
    softWarnings: [],
  });
  expect(cleanFailures.filter((failure) => failure.includes("companyascode.app.id"))).toEqual([]);
});

// Sken pracovního stromu je POZOROVÁNÍ, ne brána. Brána jsou tři testy výš:
// pattern ve schématu a `validateAppManifest`, které běží i v čistém klonu.
// `organizations/` je gitignored (tracked je jen README), takže v CI sken uvidí
// nula manifestů — a nula naskenovaných manifestů není prokázaná čistota.
// Proto se tu netvrdí žádný počet: kolik jich sken viděl, se objeví v hlášce
// selhání, kde je to k něčemu, a nikdy jako boolean, který nemůže být false.
test("žádný app manifest v pracovním stromu nenese app.id mimo pattern", async () => {
  const schema = await readJson(appSchemaPath);
  const appIdPattern = new RegExp(schema.properties.id.pattern);
  const checkIdPattern = new RegExp(DOCTOR_CHECK_ID_PATTERN);
  const organizationsRoot = resolve(
    process.env.LAUNCHPAD_CONTRACT_ORGANIZATIONS_ROOT
      ?? join(repoRoot, "organizations"),
  );

  let entries;
  try {
    entries = await readdir(organizationsRoot, { withFileTypes: true });
  } catch (error) {
    // Fail closed: neumět vyjmenovat mounty není totéž jako nemít je.
    throw new Error(`nelze vyjmenovat ${organizationsRoot}: ${error.message}`);
  }

  const offenders = [];
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const organizationPath = join(organizationsRoot, entry.name);
    let companyConfig;
    try {
      companyConfig = await readJson(join(organizationPath, "company.gen3.json"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      offenders.push(`${relative(repoRoot, organizationPath)}: company.gen3.json nejde přečíst`);
      continue;
    }
    const companySlug = companyConfig?.company?.slug;
    if (companyConfig?.organization_kind === "template") continue;
    if (typeof companySlug !== "string" || companySlug.length === 0) {
      offenders.push(`${relative(repoRoot, organizationPath)}: chybí company.slug`);
      continue;
    }
    const expectedPrefix = organizationAppIdPrefix(companySlug);
    for await (const packagePath of walkPackageJson(organizationPath)) {
      const packageJson = await readJson(packagePath).catch(() => null);
      const app = packageJson?.companyascode?.app;
      if (!app || app.schema_version !== "companyascode.launchpad_app.v1") continue;
      scanned += 1;
      const id = app.id;
      if (typeof id !== "string" || !appIdPattern.test(id) || !checkIdPattern.test(`launchpad.runtime.${id}`)) {
        offenders.push(`${relative(repoRoot, packagePath)}: ${JSON.stringify(id)}`);
      } else if (app.company !== companySlug) {
        offenders.push(
          `${relative(repoRoot, packagePath)}: company ${JSON.stringify(app.company)} != ${JSON.stringify(companySlug)}`,
        );
      } else if (!id.startsWith(expectedPrefix)) {
        offenders.push(
          `${relative(repoRoot, packagePath)}: id ${JSON.stringify(id)} nezačíná ${JSON.stringify(expectedPrefix)}`,
        );
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `z ${scanned} app manifestů pod ${organizationsRoot} porušuje Organization identity kontrakt `
      + `${offenders.length}:\n${offenders.join("\n")}`,
    );
  }
});

// Sken je záměrně nezávislý na discovery: discovery umí manifest odfiltrovat
// dřív, než se na jeho id kdokoli podívá (mount contract, chybějící
// modules.manifest.json). Tenhle test má vidět i takový manifest, protože i ten
// se dřív nebo později stane namountovanou aplikací.
async function* walkPackageJson(root) {
  const skip = new Set(["node_modules", ".git", ".worktrees", "dist", "build", ".next", "target", "generated"]);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue;
      yield* walkPackageJson(path);
      continue;
    }
    if (entry.name === "package.json") {
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) yield path;
    }
  }
}
