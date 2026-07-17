import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { buildPortOwner, formatPortCollisionFailure } from "./port-ownership-lib.mjs";

const ignoredDirs = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  // Productionspace is an organization-owned release/runtime boundary.
  // It must not acquire Launchpad lifecycle actions merely by containing a package manifest.
  "productionspace",
]);
const launchpadRoot = join(import.meta.dirname, "..");
const appSchemaPath = join(launchpadRoot, "schemas", "launchpad-app.schema.json");
const pluginSchemaPath = join(launchpadRoot, "schemas", "launchpad-plugin.schema.json");
const defaultOrganizationMountpoint = "organizations";
const defaultModuleTemplateMountpoint = "templates";
const requiredLaunchpadRootPaths = ["launchpad.gen3.json", "launchpad", "guide", "organizations", "manual"];
const requiredOrganizationWorkspacePaths = [
  "company.gen3.json",
  "modules.manifest.json",
  "manual",
  "company/colleagues",
];

// Jednotný strukturální gate přítomného Organization mountu — sdílí ho app
// discovery (hard failure) i git inventory (skip + warning), aby rozbitý mount
// nemohl zmizet z jedné plochy a zůstat akční na druhé.
export function organizationMountStructureIssues({ organizationRoot, label }) {
  const issues = [];
  validateRequiredPaths({
    root: organizationRoot,
    label,
    requiredPaths: requiredOrganizationWorkspacePaths,
    failures: issues,
  });
  return issues;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Per-machine override soubor launchpad.gen3.local.json (gitignored, nikdy
// trackovaný). Nese jen stroj-specifická data: personalspace_owner, extra local
// surfaces a planned_organizations. Rozbitý JSON override neshazuje discovery —
// soubor je per-machine pohodlí — ale musí být vidět jako warning, ne tiše zmizet.
export async function readLocalOverrideConfig(companiesRoot, warnings) {
  const path = join(companiesRoot, "launchpad.gen3.local.json");
  if (!existsSync(path)) return null;
  try {
    return await readJson(path);
  } catch (error) {
    warnings?.push(`launchpad.gen3.local.json: nejde přečíst, per-machine override se ignoruje: ${error.message}`);
    return null;
  }
}

async function walkPackageJson(root, current, output, company) {
  if (!existsSync(current)) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      // Dot-directories are local/temporary implementation surfaces (for
      // example workspace/.warehouse-pr41-buddy-review), never canonical app
      // owners. Scanning them can let a hidden copy win deterministic app-id
      // ordering over workspace/<module>, so ignore the whole subtree.
      if (entry.name.startsWith(".") || ignoredDirs.has(entry.name)) continue;
      await walkPackageJson(root, absolutePath, output, company);
      continue;
    }
    if (entry.isFile() && entry.name === "package.json") {
      output.push({
        packagePath: relative(root, absolutePath),
        company,
      });
    }
  }
}

async function collectDeclaredAppPorts({ companiesRoot, packageEntries }) {
  const ports = new Set();
  for (const { packagePath } of packageEntries) {
    const packageJson = await readJson(join(companiesRoot, packagePath));
    const port = packageJson.companyascode?.app?.port;
    if (Number.isInteger(port)) ports.add(port);
  }
  return ports;
}

function validateStringPattern({ value, pattern, key, packagePath, failures }) {
  if (typeof value !== "string" || !new RegExp(pattern).test(value)) {
    failures.push(`${packagePath}: companyascode.app.${key} neodpovídá patternu ${pattern}`);
  }
}

// Builder-metadata pole (icon/description/group, CAC-0044) jsou volitelná a
// warning-first: špatná hodnota nezneplatní appku, jen se zaloguje varování a
// karta spadne na čitelný fallback. Autorita je manifest, ne shared hardcode.
const BUILDER_METADATA_SOFT_LIMITS = {
  description: 240,
  group: 80,
};

function builderMetadataString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// PROD run adresa (runtime stages, founder 2026-07-15/16): jen http(s) URL projde,
// jinak null → karta i Dashboard ukážou honest disabled PROD stub. Warning-first
// jako ostatní builder metadata: vadná hodnota appku nezneplatní.
function builderMetadataProductionUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Stejné fail-closed pravidlo jako public/app-state.js productionUrl (builder
  // review P1 2026-07-16): musí se PARSOVAT jako URL, jen http/https, s neprázdným
  // hostname — prefix test pouštěl "https://", "http://[", "https:// user".
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

function validateBuilderMetadata({ app, packagePath, softWarnings }) {
  if (!softWarnings) return;
  for (const key of ["icon", "description", "group"]) {
    if (app[key] === undefined) continue;
    if (typeof app[key] !== "string" || app[key].trim() === "") {
      softWarnings.push(
        `${packagePath}: companyascode.app.${key} má být neprázdný string; ignoruji a použiju fallback`,
      );
      continue;
    }
    const limit = BUILDER_METADATA_SOFT_LIMITS[key];
    if (limit && app[key].length > limit) {
      softWarnings.push(
        `${packagePath}: companyascode.app.${key} je delší než ${limit} znaků; karta text zkrátí`,
      );
    }
  }
  if (app.production_url !== undefined && builderMetadataProductionUrl(app.production_url) === null) {
    softWarnings.push(
      `${packagePath}: companyascode.app.production_url má být http(s) URL; ignoruji a PROD zůstane bez odkazu`,
    );
  }
}

// Exportováno pro personalspace discovery lane (CAC-0048): osobní aplikace drží
// identický companyascode.app kontrakt jako org aplikace, takže znovu používají
// přesně stejnou validaci proti launchpad-app.schema.json. Personalspace lane
// zůstává jinak úplně oddělená od organizations/* auto-discovery.
export function validateAppManifest({ app, packageJson, packagePath, schema, failures, softWarnings }) {
  for (const key of schema.required ?? []) {
    if (app[key] === undefined) failures.push(`${packagePath}: companyascode.app.${key} chybí`);
  }

  const properties = schema.properties ?? {};
  const allowedKeys = new Set(Object.keys(properties));

  for (const key of Object.keys(app)) {
    if (!allowedKeys.has(key)) {
      failures.push(`${packagePath}: companyascode.app.${key} není povolené pole ve schématu`);
    }
  }

  if (app.schema_version !== properties.schema_version?.const) {
    failures.push(`${packagePath}: companyascode.app.schema_version musí být ${properties.schema_version?.const}`);
  }
  if (properties.id?.pattern) {
    validateStringPattern({ value: app.id, pattern: properties.id.pattern, key: "id", packagePath, failures });
  }
  if (typeof app.title !== "string" || app.title.trim() === "") {
    failures.push(`${packagePath}: companyascode.app.title musí být neprázdný string`);
  }
  if (properties.company?.pattern) {
    validateStringPattern({
      value: app.company,
      pattern: properties.company.pattern,
      key: "company",
      packagePath,
      failures,
    });
  }
  if (app.module !== undefined && properties.module?.pattern) {
    validateStringPattern({
      value: app.module,
      pattern: properties.module.pattern,
      key: "module",
      packagePath,
      failures,
    });
  }
  if (!properties.surface?.enum?.includes(app.surface)) {
    failures.push(`${packagePath}: companyascode.app.surface musí být ${properties.surface?.enum?.join(", ")}`);
  }
  const portSchema = properties.port ?? {};
  if (!Number.isInteger(app.port) || app.port < portSchema.minimum || app.port > portSchema.maximum) {
    failures.push(
      `${packagePath}: companyascode.app.port musí být číslo ${portSchema.minimum}-${portSchema.maximum}`,
    );
  }
  if (!properties.host?.enum?.includes(app.host)) {
    failures.push(`${packagePath}: companyascode.app.host musí být ${properties.host?.enum?.join(", ")}`);
  }
  if (typeof app.health_path !== "string" || !app.health_path.startsWith("/")) {
    failures.push(`${packagePath}: companyascode.app.health_path musí začínat /`);
  }
  for (const scriptKey of ["dev_script", "preview_script", "build_script"]) {
    if (app[scriptKey] !== undefined && !packageJson.scripts?.[app[scriptKey]]) {
      failures.push(`${packagePath}: ${scriptKey} ${app[scriptKey]} neexistuje v scripts`);
    }
  }
  if (!Array.isArray(app.tags)) {
    failures.push(`${packagePath}: companyascode.app.tags musí být pole`);
  } else {
    const tagPattern = properties.tags?.items?.pattern;
    if (tagPattern) {
      for (const [index, tag] of app.tags.entries()) {
        validateStringPattern({
          value: tag,
          pattern: tagPattern,
          key: `tags[${index}]`,
          packagePath,
          failures,
        });
      }
    }
  }
  if (app.plugin !== undefined && (typeof app.plugin !== "string" || app.plugin.trim() === "")) {
    failures.push(`${packagePath}: companyascode.app.plugin musí být neprázdný string`);
  }
  validateBuilderMetadata({ app, packagePath, softWarnings });
}

function validateRequiredPaths({ root, label, requiredPaths, failures }) {
  for (const requiredPath of requiredPaths) {
    if (!existsSync(join(root, requiredPath))) {
      failures.push(`${label}: chybí ${requiredPath}`);
    }
  }
}

// Scan-first (decision 0042): sdílený launchpad.gen3.json NENÍ allowlist. Organizace,
// template mounty i module šablony se zjišťují výhradně skenem disku. Legacy registry
// klíče (organizations[]/companies[]/templates[]) ve stale lokální kopii se IGNORUJÍ
// s jedním deprecation warningem — nikdy nezpůsobí failure a nikdy nerozhodují, co je
// namountované. (personalspace_owner řeší personalspace-lib ve své lane.)
const LEGACY_REGISTRY_KEYS = ["organizations", "companies", "templates"];

function deprecatedRegistryKeys(companiesConfig) {
  return LEGACY_REGISTRY_KEYS.filter((key) => {
    const value = companiesConfig?.[key];
    // Prázdné pole = neškodný pozůstatek, nevaruj; jen neprázdná registry data.
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  });
}

// Vrátí string, jen pokud není prázdný ani placeholder (`<VYPLNIT_…>`). Jinak null.
function nonPlaceholderString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("<")) return null;
  return trimmed;
}

function configuredLocalSurfaces(companiesConfig, localConfig = null, warnings = null) {
  const shared = Array.isArray(companiesConfig.local_surfaces) ? companiesConfig.local_surfaces : [];
  const machineLocal = Array.isArray(localConfig?.local_surfaces) ? localConfig.local_surfaces : [];
  const surfaces = [...shared];
  const seenPaths = new Set(shared.map((surface) => surface?.path).filter((path) => typeof path === "string"));

  for (const surface of machineLocal) {
    if (typeof surface?.path === "string" && seenPaths.has(surface.path)) {
      warnings?.push(
        `launchpad.gen3.local.json: local_surfaces ${surface.path} duplikuje sdílený surface; sdílený záznam má přednost`,
      );
      continue;
    }
    surfaces.push(surface);
    if (typeof surface?.path === "string") seenPaths.add(surface.path);
  }
  return surfaces;
}

function launchpadRootSurfaceCompany(companiesConfig, surface) {
  const launchpadRootConfig = companiesConfig.launchpad_root ?? {};
  return {
    slug: launchpadRootConfig.slug ?? "conglomerate",
    display_name: launchpadRootConfig.display_name ?? "Conglomerate",
    path: surface.path,
    organization_type: surface.kind ?? "local-surface",
    status: "mounted",
    discovery_source: "local_surface",
  };
}

async function discoverLocalSurfacePackages({
  companiesRoot,
  companiesConfig,
  localConfig,
  packageEntries,
  failures,
  warnings,
}) {
  for (const surface of configuredLocalSurfaces(companiesConfig, localConfig, warnings)) {
    if (!surface || typeof surface !== "object" || surface.kind !== "shared-guide") continue;
    if (typeof surface.path !== "string" || surface.path.trim() === "") {
      failures.push("launchpad.gen3.json: local_surfaces shared-guide musí mít path");
      continue;
    }
    if (isAbsolute(surface.path) || surface.path.split(/[\\/]/).includes("..")) {
      failures.push(`launchpad.gen3.json: local_surfaces ${surface.path} musí být relativní cesta uvnitř Launchpad rootu`);
      continue;
    }
    const surfaceRoot = join(companiesRoot, surface.path);
    if (!existsSync(surfaceRoot)) {
      failures.push(`launchpad.gen3.json: local surface ${surface.path} neexistuje`);
      continue;
    }
    await walkPackageJson(
      companiesRoot,
      surfaceRoot,
      packageEntries,
      launchpadRootSurfaceCompany(companiesConfig, surface),
    );
  }
}

function isPlaceholderOrganization({ slug }) {
  // Klasifikace šablony (dřív hardcoded string na jméno OrganizationTemplate) se
  // přesunula na strojový marker company.gen3.json organization_kind (viz
  // organizationKindFromCompanyJson). Placeholder guard hlídá jen nevyplněné /
  // ukázkové slugy, ne druh mountu.
  const normalizedSlug = String(slug ?? "").trim().toLowerCase();
  return (
    !normalizedSlug ||
    normalizedSlug.includes("<") ||
    normalizedSlug.includes("vyplnit") ||
    normalizedSlug === "example"
  );
}

// Strojový marker druhu mountu (company.gen3.schema.json organization_kind).
// Chybějící / neznámá hodnota = organization (zpětná kompatibilita, founder
// 2026-07-12). Template mount se validuje se stejnými gates jako firma, ale je
// vyloučený z runtime akcí, business přehledů a org počtů.
function organizationKindFromCompanyJson(companyJson) {
  return companyJson?.organization_kind === "template" ? "template" : "organization";
}

function autoOrganizationFromCompanyJson({ companyJson, path, directoryName }) {
  const company = companyJson.company ?? {};
  const kind = organizationKindFromCompanyJson(companyJson);
  const directorySlug = directoryName.replace(/_GEN3$/, "");
  const declaredSlug = typeof company.slug === "string" ? company.slug : null;
  // Běžná firma s prázdným / example / <placeholder> slugem = nedokončený mount →
  // přeskoč. Template mount je placeholder ze své podstaty (vyplní se až při forku
  // do reálné Organizace); identifikuje ho marker organization_kind=template, ne
  // slug, takže se placeholder guard na něj nevztahuje a slug bere z adresáře mountu.
  if (kind !== "template" && isPlaceholderOrganization({ slug: declaredSlug ?? directorySlug })) {
    return null;
  }
  const slug = declaredSlug && !isPlaceholderOrganization({ slug: declaredSlug })
    ? declaredSlug
    : directorySlug;
  return {
    slug,
    display_name: nonPlaceholderString(company.display_name) ?? (kind === "template" ? directoryName : slug),
    path,
    repository: company.repository ?? null,
    git_url: company.git_url ?? null,
    github_org: company.github_org ?? null,
    generation: companyJson.organization_generation ?? "gen3",
    migration_marker: directoryName.endsWith("_GEN3") ? "_GEN3" : null,
    materialization: "local-auto",
    organization_kind: kind,
    organization_type: kind === "template" ? "organization-template" : "organization-gen3",
    status: "mounted",
    discovery_source: "filesystem",
  };
}

// Scan-first (decision 0042/0043): jediná autorita je namountovaný
// company.gen3.json, ne žádný registry záznam. Skenuje se organizations/*/ a každý
// adresář s company.gen3.json se klasifikuje markerem organization_kind. Vrací dvě
// oddělené kolekce: `organizations` (běžné firmy — runtime, business přehledy, org
// počty) a `templateMounts` (marker organization_kind=template — stejné gates, ale
// mimo runtime/business/counts). Nepřítomnost adresáře nebo company.gen3.json =
// prostě to není v seznamu, NIKDY failure.
async function discoverOrganizations({ companiesRoot, companiesConfig, failures, warnings }) {
  const organizations = [];
  const templateMounts = [];
  const seenSlugs = new Set();
  const seenTemplateSlugs = new Set();

  const mountpoint = companiesConfig.organization_mountpoint ?? defaultOrganizationMountpoint;
  const organizationsRoot = join(companiesRoot, mountpoint);
  if (!existsSync(organizationsRoot)) return { organizations, templateMounts };

  let entries;
  try {
    entries = await readdir(organizationsRoot, { withFileTypes: true });
  } catch (error) {
    failures.push(`${mountpoint}: nejde přečíst organization mountpoint: ${error.message}`);
    return { organizations, templateMounts };
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || ignoredDirs.has(entry.name)) continue;

    const path = `${mountpoint}/${entry.name}`;
    const companyJsonPath = join(companiesRoot, path, "company.gen3.json");
    // Bez company.gen3.json to není namountovaná Organizace (může to být holý
    // checkout nebo pracovní složka) — přeskoč bez failure.
    if (!existsSync(companyJsonPath)) continue;

    let companyJson;
    try {
      companyJson = await readJson(companyJsonPath);
    } catch (error) {
      // Marker existuje, ale nejde přečíst = přítomný mount s rozbitou hranicí.
      // Po zrušení registry je marker jediná stopa, že tu Organizace je — tichý
      // skip s warningem by ji nechal zmizet z discovery i doctora (hard failure,
      // stejně jako chybějící povinná GEN3 struktura).
      failures.push(`${path}: company.gen3.json nejde přečíst: ${error.message}`);
      continue;
    }

    const mount = autoOrganizationFromCompanyJson({ companyJson, path, directoryName: entry.name });
    if (!mount) continue;

    if (mount.organization_kind === "template") {
      if (seenTemplateSlugs.has(mount.slug)) {
        warnings.push(`${mount.path}: template mount přeskočen, protože slug ${mount.slug} už drží jiný template mount`);
        continue;
      }
      templateMounts.push(mount);
      seenTemplateSlugs.add(mount.slug);
      continue;
    }
    if (seenSlugs.has(mount.slug)) {
      warnings.push(`${mount.path}: mount přeskočen, protože slug ${mount.slug} už drží jiná Organizace`);
      continue;
    }
    organizations.push(mount);
    seenSlugs.add(mount.slug);
  }

  return { organizations, templateMounts };
}

function appendPlannedOrganizations({ localConfig, organizations, templateMounts, warnings }) {
  const planned = localConfig?.planned_organizations;
  if (planned === undefined || planned === null) return;
  if (!Array.isArray(planned)) {
    warnings.push("launchpad.gen3.local.json: planned_organizations musí být pole; ignoruji");
    return;
  }
  const mountedSlugs = new Set([
    ...organizations.map((organization) => organization.slug),
    ...templateMounts.map((mount) => mount.slug),
  ]);
  for (const slot of planned) {
    const slug = typeof slot?.slug === "string" ? slot.slug.trim() : "";
    // Placeholder slug = nevyplněný example řádek — přeskoč bez warningu, aby šel
    // .example zkopírovat tak, jak je.
    if (isPlaceholderOrganization({ slug })) continue;
    if (mountedSlugs.has(slug)) continue;
    mountedSlugs.add(slug);
    organizations.push({
      slug,
      display_name: nonPlaceholderString(slot.display_name) ?? slug,
      path: null,
      repository: slot.repository ?? null,
      git_url: nonPlaceholderString(slot.git_url),
      github_org: null,
      generation: "gen3",
      migration_marker: null,
      materialization: "planned",
      organization_kind: "organization",
      organization_type: "organization-gen3",
      status: "planned",
      discovery_source: "local_override",
    });
  }
}

// Module šablony (templates/<owner>/<template>/) jsou INFORMAČNÍ: sdílený root je
// jen ukazuje, nevynucuje (žádné required_for_first_client gating, žádná Git mount
// gate). First-client rollout si čte, co potřebuje, přímo z disku. Nepřítomnost =
// prostě nejsou v seznamu, NIKDY failure.
async function discoverModuleTemplates({ companiesRoot }) {
  const templatesRoot = join(companiesRoot, defaultModuleTemplateMountpoint);
  if (!existsSync(templatesRoot)) return [];
  let owners;
  try {
    owners = await readdir(templatesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const templates = [];
  for (const owner of owners.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!owner.isDirectory() || owner.name.startsWith(".") || ignoredDirs.has(owner.name)) continue;
    let entries;
    try {
      entries = await readdir(join(templatesRoot, owner.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ignoredDirs.has(entry.name)) continue;
      templates.push({
        slug: entry.name,
        owner: owner.name,
        path: `${defaultModuleTemplateMountpoint}/${owner.name}/${entry.name}`,
        discovery_source: "filesystem",
      });
    }
  }
  return templates;
}

// Projde mounty (běžné Organizace i template mounty), zvaliduje jejich strukturu
// (required paths) a nasbírá package.json balíčky do `packageEntries`. Stejná
// strukturální gate platí pro oba druhy; rozdíl je jen v cílové kolekci balíčků,
// kterou volající předá (organizace → runnable apps, template → template_apps).
async function walkMountPackages({
  mounts,
  companiesRoot,
  packageEntries,
  failures,
}) {
  for (const company of mounts) {
    // Scan-first: mount buď existuje (proto ho vidíme), nebo zmizel mezi skenem a
    // průchodem → prostě přeskoč. Nepřítomnost mountu NIKDY není failure (decision
    // 0042); chybějící Organizace se jednoduše neobjeví v seznamu.
    if (company.status === "planned" || !company.path) continue;
    const companyRoot = join(companiesRoot, company.path);
    if (!existsSync(companyRoot)) continue;
    const requiredPathIssues = organizationMountStructureIssues({
      organizationRoot: companyRoot,
      label: company.path,
    });
    // Scan-first ignoruje NEPŘÍTOMNOST mountu, ne rozbitou hranici přítomného
    // mountu: namountovaná Organizace bez povinné GEN3 struktury je hard failure
    // (stejná gate jako před scan-first) a její balíčky se neprocházejí — appka
    // z nezvalidované hranice se nesmí stát spustitelnou.
    if (requiredPathIssues.length > 0) {
      failures.push(...requiredPathIssues);
      continue;
    }
    await walkPackageJson(companiesRoot, companyRoot, packageEntries, company);
  }
}

// Decision 0043: nevalidní app manifest izoluje jen dotčenou appku. Discovery ji
// vrací jako scoped invalid_apps záznam + warning, ne jako root failure —
// bezpečnostní invarianty (port/id kolize, plugin read-only violation) zůstávají
// hard failures níže.
function invalidAppRecord({ app, packagePath, company, issues }) {
  const id = typeof app.id === "string" && app.id.trim() !== "" ? app.id : `invalid-manifest:${packagePath}`;
  return {
    id,
    title: typeof app.title === "string" && app.title.trim() !== "" ? app.title : packagePath,
    company: company.slug,
    module: typeof app.module === "string" ? app.module : null,
    surface: typeof app.surface === "string" ? app.surface : null,
    port: Number.isInteger(app.port) ? app.port : null,
    host: typeof app.host === "string" ? app.host : null,
    package_path: packagePath,
    organization_path: company.path,
    cwd: dirname(packagePath),
    tags: Array.isArray(app.tags) ? app.tags.filter((tag) => typeof tag === "string") : [],
    manifest_state: "invalid_manifest",
    manifest_issues: issues,
  };
}

// Plugin je read-only metadata povrch. Porušení read-only kontraktu (ne-JSON
// cíl, únik mimo Organizaci, akční/nepovolená pole) je bezpečnostní invariant a
// jde do securityIssues (vždy hard failure, decision 0043). Chybějící nebo
// nečitelný plugin soubor je kvalita manifestu dané appky a jde do
// manifestIssues (izolace jako invalid_manifest).
async function readPluginManifest({ app, companiesRoot, packagePath, company, schema, securityIssues, manifestIssues }) {
  if (!app.plugin) return null;
  if (!app.plugin.endsWith(".json")) {
    securityIssues.push(`${packagePath}: companyascode.app.plugin musí odkazovat na read-only JSON manifest`);
    return null;
  }

  const packageDir = join(companiesRoot, dirname(packagePath));
  const companyRoot = join(companiesRoot, company.path);
  const pluginPath = resolve(packageDir, app.plugin);
  const relativeToCompany = relative(companyRoot, pluginPath);
  if (isAbsolute(app.plugin) || relativeToCompany.startsWith("..")) {
    securityIssues.push(`${packagePath}: plugin cesta ${app.plugin} musí zůstat uvnitř ${company.path}`);
    return null;
  }
  if (!existsSync(pluginPath)) {
    manifestIssues.push(`${packagePath}: plugin cesta ${app.plugin} neexistuje`);
    return null;
  }

  let plugin;
  try {
    plugin = await readJson(pluginPath);
  } catch (error) {
    manifestIssues.push(`${relative(companiesRoot, pluginPath)}: plugin JSON nejde přečíst: ${error.message}`);
    return null;
  }

  const pluginPackagePath = relative(companiesRoot, pluginPath);
  validatePluginManifest({
    plugin,
    pluginPath: pluginPackagePath,
    schema,
    securityIssues,
    qualityIssues: manifestIssues,
  });
  return {
    ...plugin,
    path: pluginPackagePath,
  };
}

// Read-only kontrakt pluginu (nepovolená/akční pole) je bezpečnostní invariant
// (decision 0043) → securityIssues. Obsahová kvalita (prázdné stringy, tvary
// metadata/links/sections) je kvalita manifestu dané appky → qualityIssues
// (izolace jako invalid_manifest). Path/URL bezpečnost v links zůstává security.
function validatePluginManifest({ plugin, pluginPath, schema, securityIssues, qualityIssues }) {
  if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
    qualityIssues.push(`${pluginPath}: plugin manifest musí být JSON object`);
    return;
  }

  const allowedKeys = new Set(Object.keys(schema.properties ?? {}));
  for (const key of Object.keys(plugin)) {
    if (!allowedKeys.has(key)) {
      securityIssues.push(`${pluginPath}: ${key} není povolené pole v read-only plugin schématu`);
    }
  }

  if (plugin.schema_version !== schema.properties?.schema_version?.const) {
    qualityIssues.push(`${pluginPath}: schema_version musí být ${schema.properties?.schema_version?.const}`);
  }
  validateNonEmptyString(plugin.title, `${pluginPath}: title`, qualityIssues);
  if (plugin.summary !== undefined) {
    validateNonEmptyString(plugin.summary, `${pluginPath}: summary`, qualityIssues);
  }
  validatePluginMetadata(plugin.metadata, pluginPath, qualityIssues);
  validatePluginLinks(plugin.links, pluginPath, { securityIssues, qualityIssues });
  validatePluginSections(plugin.sections, pluginPath, qualityIssues);
}

function validatePluginMetadata(metadata, pluginPath, failures) {
  if (metadata === undefined) return;
  if (!Array.isArray(metadata)) {
    failures.push(`${pluginPath}: metadata musí být pole`);
    return;
  }
  for (const [index, item] of metadata.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      failures.push(`${pluginPath}: metadata[${index}] musí být object`);
      continue;
    }
    validateAllowedKeys(item, ["label", "value"], `${pluginPath}: metadata[${index}]`, failures);
    validateNonEmptyString(item.label, `${pluginPath}: metadata[${index}].label`, failures);
    validateNonEmptyString(item.value, `${pluginPath}: metadata[${index}].value`, failures);
  }
}

function validatePluginLinks(links, pluginPath, { securityIssues, qualityIssues }) {
  if (links === undefined) return;
  if (!Array.isArray(links)) {
    qualityIssues.push(`${pluginPath}: links musí být pole`);
    return;
  }
  const allowedKinds = new Set(["source-of-truth", "manual", "data", "app", "external"]);
  for (const [index, link] of links.entries()) {
    const label = `${pluginPath}: links[${index}]`;
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      qualityIssues.push(`${label} musí být object`);
      continue;
    }
    validateAllowedKeys(link, ["label", "kind", "path", "url"], label, securityIssues);
    validateNonEmptyString(link.label, `${label}.label`, qualityIssues);
    if (!allowedKinds.has(link.kind)) {
      qualityIssues.push(`${label}.kind musí být source-of-truth, manual, data, app nebo external`);
    }
    if ((link.path === undefined && link.url === undefined) || (link.path !== undefined && link.url !== undefined)) {
      qualityIssues.push(`${label} musí mít právě jedno z polí path nebo url`);
    }
    if (link.path !== undefined) {
      // Únik cesty mimo Organizaci je bezpečnostní invariant.
      validateSafeRelativePath(link.path, `${label}.path`, securityIssues);
    }
    if (link.url !== undefined) {
      // Nepovolený protokol (javascript: apod.) je bezpečnostní invariant.
      validateAllowedUrl(link.url, `${label}.url`, securityIssues);
    }
  }
}

function validatePluginSections(sections, pluginPath, failures) {
  if (sections === undefined) return;
  if (!Array.isArray(sections)) {
    failures.push(`${pluginPath}: sections musí být pole`);
    return;
  }
  for (const [index, section] of sections.entries()) {
    const label = `${pluginPath}: sections[${index}]`;
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      failures.push(`${label} musí být object`);
      continue;
    }
    validateAllowedKeys(section, ["title", "body"], label, failures);
    validateNonEmptyString(section.title, `${label}.title`, failures);
    validateNonEmptyString(section.body, `${label}.body`, failures);
  }
}

function validateAllowedKeys(object, allowedKeys, label, failures) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      failures.push(`${label}.${key} není povolené pole`);
    }
  }
}

function validateNonEmptyString(value, label, failures) {
  if (typeof value !== "string" || value.trim() === "") {
    failures.push(`${label} musí být neprázdný string`);
  }
}

function validateSafeRelativePath(value, label, failures) {
  if (typeof value !== "string" || value.trim() === "") {
    failures.push(`${label} musí být neprázdný string`);
    return;
  }
  if (isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    failures.push(`${label} musí být relativní cesta uvnitř Organization`);
  }
}

function validateAllowedUrl(value, label, failures) {
  if (typeof value !== "string" || value.trim() === "") {
    failures.push(`${label} musí být neprázdný string`);
    return;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    failures.push(`${label} musí být platná URL`);
    return;
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    failures.push(`${label} smí používat jen http nebo https`);
  }
}

export async function discoverLaunchpadApps(
  companiesRoot = join(import.meta.dirname, "..", ".."),
  options = {},
) {
  const failures = [];
  const warnings = [];
  const companiesConfigPath = join(companiesRoot, "launchpad.gen3.json");
  if (!existsSync(companiesConfigPath)) {
    return {
      apps: [],
      invalid_apps: [],
      template_apps: [],
      organizations: [],
      template_mounts: [],
      module_templates: [],
      failures: [`Chybí launchpad.gen3.json v ${companiesRoot}`],
      warnings: [],
    };
  }

  validateRequiredPaths({
    root: companiesRoot,
    label: relative(process.cwd(), companiesRoot) || ".",
    requiredPaths: requiredLaunchpadRootPaths,
    failures,
  });

  const companiesConfig = await readJson(companiesConfigPath);
  // Legacy registry klíče (stale lokální kopie) se ignorují s jedním deprecation
  // warningem — discovery je nikdy nečte a nikdy z nich neselže (decision 0042).
  const deprecated = deprecatedRegistryKeys(companiesConfig);
  if (deprecated.length > 0) {
    warnings.push(
      `launchpad.gen3.json: zastaralé registry klíče ${deprecated.join(", ")} se ve scan-first modelu (decision 0042) ignorují; smaž je z trackovaného configu (Organizace i šablony se zjišťují skenem disku).`,
    );
  }
  const appSchema = await readJson(appSchemaPath);
  const pluginSchema = await readJson(pluginSchemaPath);
  const packageEntries = [];
  const templatePackageEntries = [];
  const { organizations, templateMounts } = await discoverOrganizations({
    companiesRoot,
    companiesConfig,
    failures,
    warnings,
  });
  // Planned sloty jsou per-machine záležitost (gitignored launchpad.gen3.local.json):
  // sdílený tracked config nesmí nést něčí plánované Organizace — na cizí mašině se
  // ukazovaly jako chybějící přístup (decision 0042, founder 2026-07-12). Planned
  // slot je informační: nemá path, nikdy nevyrábí failure a namountovaná Organizace
  // se stejným slugem vyhrává.
  const localConfig = await readLocalOverrideConfig(companiesRoot, warnings);
  appendPlannedOrganizations({ localConfig, organizations, templateMounts, warnings });
  const moduleTemplates = await discoverModuleTemplates({ companiesRoot });
  await walkMountPackages({
    mounts: organizations,
    companiesRoot,
    packageEntries,
    failures,
  });
  // Template mounty se validují se stejnými strukturálními gates (required paths),
  // ale jejich balíčky jdou do oddělené kolekce — nikdy se nestanou spustitelnými
  // aplikacemi (runtime/business/counts exclusion, founder 2026-07-12).
  await walkMountPackages({
    mounts: templateMounts,
    companiesRoot,
    packageEntries: templatePackageEntries,
    failures,
  });

  await discoverLocalSurfacePackages({
    companiesRoot,
    companiesConfig,
    localConfig,
    packageEntries,
    failures,
    warnings,
  });

  const sortedPackageEntries = packageEntries.sort((a, b) => a.packagePath.localeCompare(b.packagePath));
  const apps = [];
  const invalidApps = [];
  const ports = new Map();
  const usedPorts = await collectDeclaredAppPorts({ companiesRoot, packageEntries: sortedPackageEntries });
  const appIds = new Map();
  for (const { packagePath, company } of sortedPackageEntries) {
    const absolutePackagePath = join(companiesRoot, packagePath);
    const packageJson = await readJson(absolutePackagePath);
    const app = packageJson.companyascode?.app;
    if (!app) continue;

    const manifestIssues = [];
    const securityIssues = [];
    const builderMetadataWarnings = [];
    validateAppManifest({
      app,
      packageJson,
      packagePath,
      schema: appSchema,
      failures: manifestIssues,
      softWarnings: builderMetadataWarnings,
    });
    if (typeof app.company === "string" && app.company !== company.slug) {
      manifestIssues.push(
        `${packagePath}: companyascode.app.company musí být ${company.slug}, protože package leží ve ${company.path}`,
      );
    }

    const plugin = manifestIssues.length === 0
      ? await readPluginManifest({
          app,
          companiesRoot,
          packagePath,
          company,
          schema: pluginSchema,
          securityIssues,
          manifestIssues,
        })
      : null;

    // Bezpečnostní invarianty jsou vždy hard failure — i pro auto-discovered
    // Organizace (decision 0042 bezpečnostní parita, decision 0043).
    if (securityIssues.length > 0) {
      failures.push(...securityIssues);
      continue;
    }
    if (manifestIssues.length > 0) {
      const issues = [...manifestIssues];
      const record = invalidAppRecord({ app, packagePath, company, issues });
      // Dvě položky v apps response nikdy nesmí sdílet id (UI i runtime
      // adresují akce podle id): volné id si nevalidní appka rezervuje,
      // obsazené id dostane syntetickou náhradu + kolizní issue.
      if (typeof app.id === "string" && app.id.trim() !== "") {
        const existing = appIds.get(app.id);
        if (existing) {
          issues.push(`${packagePath}: app id ${app.id} koliduje s ${existing}`);
          record.id = `invalid-manifest:${packagePath}`;
        } else {
          appIds.set(app.id, packagePath);
        }
      }
      record.manifest_issues = issues;
      warnings.push(...issues.map((issue) => `${issue} (invalid app manifest)`));
      invalidApps.push(record);
      continue;
    }
    if (typeof app.id === "string") {
      const existing = appIds.get(app.id);
      if (existing) {
        // Decision 0043: duplicitní app id je legitimní failure daného
        // manifestu, ale nesmí brát s sebou celý root — druhý manifest se
        // izoluje jako invalid_manifest, první (deterministicky podle cesty)
        // zůstává platný. Záznam dostane syntetické id, aby response nikdy
        // nenesla dvě položky se stejným id.
        const issue = `${packagePath}: app id ${app.id} koliduje s ${existing}`;
        warnings.push(`${issue} (invalid app manifest)`);
        const record = invalidAppRecord({ app, packagePath, company, issues: [issue] });
        record.id = `invalid-manifest:${packagePath}`;
        invalidApps.push(record);
        continue;
      }
      appIds.set(app.id, packagePath);
    }
    if (Number.isInteger(app.port)) {
      const portOwner = buildPortOwner({ app, packagePath, company });
      const existing = ports.get(app.port);
      if (existing) {
        // Port kolize je bezpečnostní invariant (decision 0043) — vždy hard failure.
        failures.push(formatPortCollisionFailure({ owner: portOwner, existingOwner: existing, usedPorts }));
        continue;
      }
      ports.set(app.port, portOwner);
    }

    // Warning-first builder metadata (CAC-0044): valid appka se špatným
    // volitelným polem zůstává funkční, jen zaloguje varování.
    warnings.push(...builderMetadataWarnings.map((issue) => `${issue} (builder metadata)`));

    apps.push({
      id: app.id,
      title: app.title,
      company: app.company,
      module: app.module ?? null,
      surface: app.surface,
      port: app.port,
      host: app.host,
      health_path: app.health_path,
      dev_script: app.dev_script,
      plugin,
      package_path: packagePath,
      organization_path: company.path,
      company_workspace_path: company.path,
      cwd: dirname(packagePath),
      tags: app.tags ?? [],
      // Builder metadata z manifestu (CAC-0044) — normalizované na string|null,
      // ať UI nemusí řešit prázdné hodnoty. Chybějící = fallback heuristika.
      icon: builderMetadataString(app.icon),
      description: builderMetadataString(app.description),
      group: builderMetadataString(app.group),
      // PROD run adresa (runtime stages): normalizovaná na platnou http(s) URL
      // nebo null. UI z ní staví PROD odkaz; null = honest disabled PROD stub.
      production_url: builderMetadataProductionUrl(app.production_url),
    });
  }

  const templateApps = await collectTemplateApps({
    companiesRoot,
    templatePackageEntries,
    appSchema,
    warnings,
  });

  return {
    apps,
    invalid_apps: invalidApps,
    template_apps: templateApps,
    organizations,
    template_mounts: templateMounts,
    module_templates: moduleTemplates,
    // Internal per-machine evidence for downstream readiness classification.
    // buildLaunchpadAppsResponse does not expose this object through /api/apps.
    local_config: localConfig,
    failures,
    warnings,
  };
}

// Template mount se validuje (schema manifestu + interní port/id kolize), ale
// nikdy nevrací spustitelné aplikace. Balíčky jdou do template_apps s příznakem
// organization_kind=template a manifest_state; port/id kolize jsou izolované ve
// vlastních mapách, takže vadný template NIKDY nezhavaruje runtime reálné firmy
// (žádný zápis do global failures). Runtime pole (dev_script, health, plugin)
// se úmyslně nevrací — template appka se nespouští.
async function collectTemplateApps({ companiesRoot, templatePackageEntries, appSchema, warnings }) {
  const sorted = [...templatePackageEntries].sort((a, b) => a.packagePath.localeCompare(b.packagePath));
  const templateApps = [];
  const templatePorts = new Map();
  const templateAppIds = new Map();
  for (const { packagePath, company } of sorted) {
    let packageJson;
    try {
      packageJson = await readJson(join(companiesRoot, packagePath));
    } catch (error) {
      // Izolace selhání: vadný template package.json NIKDY nesmí shodit discovery
      // reálných firem — konvertuje se na template warning + invalid_manifest záznam.
      const issue = `${packagePath}: template package.json nejde přečíst: ${error.message}`;
      warnings.push(`${issue} (template app manifest)`);
      templateApps.push({
        id: null,
        title: packagePath,
        company: company.slug ?? null,
        module: null,
        surface: null,
        port: null,
        host: null,
        package_path: packagePath,
        organization_path: company.path,
        organization_kind: "template",
        manifest_state: "invalid_manifest",
        manifest_issues: [issue],
      });
      continue;
    }
    const app = packageJson.companyascode?.app;
    if (!app) continue;

    const manifestIssues = [];
    validateAppManifest({
      app,
      packageJson,
      packagePath,
      schema: appSchema,
      softWarnings: null,
      failures: manifestIssues,
    });
    // Company-slug match se u template mountu ZÁMĚRNĚ nekontroluje: slug template
    // mountu je placeholder-derived label (jméno adresáře), ne kanonická identita
    // firmy. Template app manifesty legitimně nesou generický placeholder company
    // (např. "organization-template"), který se přepíše až při forku do reálné
    // Organizace — vynucovat rovnost proti odvozenému slugu nemá smysl. Interní
    // konzistenci template (schema, port/id kolize) hlídáme dál.
    if (typeof app.id === "string" && app.id.trim() !== "") {
      const existing = templateAppIds.get(app.id);
      if (existing) manifestIssues.push(`${packagePath}: template app id ${app.id} koliduje s ${existing}`);
      else templateAppIds.set(app.id, packagePath);
    }
    if (Number.isInteger(app.port)) {
      const existing = templatePorts.get(app.port);
      if (existing) manifestIssues.push(`${packagePath}: template port ${app.port} koliduje s ${existing}`);
      else templatePorts.set(app.port, packagePath);
    }

    if (manifestIssues.length > 0) {
      warnings.push(...manifestIssues.map((issue) => `${issue} (template app manifest)`));
    }
    templateApps.push({
      id: typeof app.id === "string" ? app.id : null,
      title: typeof app.title === "string" ? app.title : packagePath,
      company: typeof app.company === "string" ? app.company : company.slug,
      module: app.module ?? null,
      surface: typeof app.surface === "string" ? app.surface : null,
      port: Number.isInteger(app.port) ? app.port : null,
      host: typeof app.host === "string" ? app.host : null,
      package_path: packagePath,
      organization_path: company.path,
      organization_kind: "template",
      manifest_state: manifestIssues.length === 0 ? "template" : "invalid_manifest",
      manifest_issues: manifestIssues,
    });
  }
  return templateApps;
}
