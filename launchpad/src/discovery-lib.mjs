import { existsSync, lstatSync, readdirSync, realpathSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "path";
import { buildPortOwner, buildPortOwnershipIndex, canonicalListenerHost } from "./port-ownership-lib.mjs";
import { normalizePackageRuntime } from "../../lazurio/core/runtime-contract-lib.mjs";
import {
  materializeRuntimeFromModule,
  normalizeModuleManifest,
} from "./module-contract-lib.mjs";
import {
  normalizePortRegistry,
  validateModuleLeasesAgainstRegistry,
} from "./port-registry-lib.mjs";
import {
  isCanonicalOrganizationRepositorySlotPath,
  normalizeOrganizationSlotPath,
  organizationRepositorySlotCollectionIssues,
  organizationSlotRepositoryId,
  organizationSlotRepositoryMountIssue,
} from "../../lazurio/core/organization-slot-scope-lib.mjs";

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
const runtimeSourceIgnoredDirs = new Set([
  ".git",
  ".build",
  ".next",
  "__tests__",
  "archive",
  "assets",
  "build",
  "coverage",
  "data",
  "dist",
  "fixture",
  "fixtures",
  "generated",
  "migrations",
  "node_modules",
  "test",
  "tests",
  "vendor",
]);
const runtimeSourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const launchpadRoot = join(import.meta.dirname, "..");
const appSchemaPath = join(launchpadRoot, "schemas", "launchpad-app.schema.json");
const runtimeSchemaPath = join(launchpadRoot, "schemas", "lazurio-runtime.schema.json");
const moduleSchemaPath = join(launchpadRoot, "schemas", "lazurio-module.schema.json");
const portRegistrySchemaPath = join(launchpadRoot, "schemas", "lazurio-port-registry.schema.json");
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

function pathIsWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function canonicalProspectivePath(path) {
  const missing = [];
  let cursor = path;
  while (!entryExists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`nelze najít existujícího předka pro ${path}`);
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}

function observedCasePreservingPath({ organizationRoot, declaredPath }) {
  const observed = [];
  let cursor = organizationRoot;
  const segments = declaredPath.split("/");
  for (const [index, segment] of segments.entries()) {
    const entries = readdirSync(cursor);
    const foldedMatches = entries.filter(
      (entry) => entry.toLowerCase() === segment.toLowerCase(),
    );
    if (foldedMatches.length > 1) {
      throw new Error(
        `cesta "${declaredPath}" má v "${observed.join("/") || "."}" více case-insensitive protějšků`,
      );
    }
    if (entries.includes(segment)) {
      observed.push(segment);
      cursor = join(cursor, segment);
      continue;
    }
    if (foldedMatches.length === 0) return null;
    // Rozpor v existujícím prefixu je dostatečný důkaz i tehdy, když
    // deklarovaný leaf ještě není materializovaný.
    return [...observed, foldedMatches[0], ...segments.slice(index + 1)].join("/");
  }
  return observed.join("/");
}

// Jeden fail-closed gate pro všechny deklarované Organization-relative cesty.
// Kontroluje lexical formu i kanonický nejbližší existující předek, takže
// traversal, absolute/drive/UNC formy a symlink do jiné Organization nikdy
// nevstoupí do discovery, Doctoru ani akčních Git/worktree povrchů.
export function organizationRelativePathIssue({ organizationRoot, path }) {
  if (typeof path !== "string" || path.trim() === "") return "je prázdná";
  if (path !== path.trim()) {
    return `"${path}" uniká mimo Organization root (okolní whitespace mění identitu cesty)`;
  }
  const normalized = path.trim().replace(/\\/g, "/");
  const segments = normalized.split("/");
  const absoluteLike =
    isAbsolute(normalized) ||
    normalized.startsWith("//") ||
    /^[A-Za-z]:/.test(normalized);
  const ambiguousSegments = segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (absoluteLike || ambiguousSegments || normalized.includes("\0")) {
    return `"${path}" uniká mimo Organization root (neplatná lexical cesta)`;
  }

  try {
    const lexicalRoot = resolve(organizationRoot);
    const lexicalTarget = resolve(lexicalRoot, normalized);
    if (!pathIsWithin(lexicalRoot, lexicalTarget)) {
      return `"${path}" uniká mimo Organization root (lexical containment)`;
    }
    const canonicalRoot = realpathSync(organizationRoot);
    const canonicalTarget = canonicalProspectivePath(lexicalTarget);
    if (!pathIsWithin(canonicalRoot, canonicalTarget)) {
      return `"${path}" uniká mimo Organization root (canonical containment; existující cesta se přes symlink/junction dostává mimo root Organizace)`;
    }
    const observedPath = observedCasePreservingPath({
      organizationRoot: lexicalRoot,
      declaredPath: normalized,
    });
    if (observedPath !== null) {
      const casingIssue = organizationRepositoryPathCasingIssue({
        declaredPath: normalized,
        observedPath,
      });
      if (casingIssue) return casingIssue;
    }
  } catch (error) {
    return `"${path}" uniká mimo Organization root (kanonickou cestu nelze bezpečně ověřit: ${error.message})`;
  }
  return null;
}

export function organizationRepositoryPathCasingIssue({ declaredPath, observedPath }) {
  if (declaredPath === observedPath) return null;
  return `"${declaredPath}" neodpovídá přesnému psaní existující cesty "${observedPath}"`;
}

// Lokální cross-file gate Organization mountu. Plný manifestový kontrakt žije
// s vlastníkem Organization/template vrstvy, ale Launchpad/Doctor nesmí pro
// základní bezpečnostní invarianty záviset na jiném checkoutu nebo runtime
// importu. Proto zde držíme malou read-only kontrolu identity, kanonických cest,
// Team referencí a Git materializace. Platí shodně pro běžnou Organizaci i
// marker template mount.
async function organizationMountContractIssues({ organizationRoot, label, warnings }) {
  const issues = organizationMountStructureIssues({ organizationRoot, label });
  if (issues.length > 0) return issues;

  let companyConfig;
  let manifest;
  try {
    companyConfig = await readJson(join(organizationRoot, "company.gen3.json"));
  } catch (error) {
    return [`${label}: company.gen3.json nejde přečíst: ${error.message}`];
  }
  try {
    manifest = await readJson(join(organizationRoot, "modules.manifest.json"));
  } catch (error) {
    return [`${label}: modules.manifest.json nejde přečíst: ${error.message}`];
  }

  const company = companyConfig?.company ?? {};
  const organizationKind = organizationKindFromCompanyJson(companyConfig);
  const companySlug = trimmedString(company.slug);
  const manifestCompany = trimmedString(manifest?.company);
  if (companySlug && !manifestCompany) {
    issues.push(`${label}: modules.manifest.json company je povinné, když company.gen3.json deklaruje company.slug`);
  }
  if (!companySlug && manifestCompany) {
    issues.push(`${label}: company.gen3.json company.slug je povinné, když modules.manifest.json deklaruje company`);
  }
  if (companySlug && manifestCompany && companySlug !== manifestCompany) {
    const tolerableIncrementalMismatch =
      companySlug.toLowerCase() === manifestCompany.toLowerCase() ||
      (organizationKind === "template" &&
        isPlaceholderOrganization({ slug: companySlug }) &&
        isPlaceholderOrganization({ slug: manifestCompany }));
    (tolerableIncrementalMismatch ? warnings : issues).push(
      `${label}: company.gen3.json company.slug "${companySlug}" neodpovídá modules.manifest.json company "${manifestCompany}"${
        tolerableIncrementalMismatch ? "; během incremental rollout zůstává načtený, sjednoť canonical casing/placeholder" : ""
      }`,
    );
  }

  const companyGithubOrg = trimmedString(company.github_org);
  const manifestGithubOrg = trimmedString(manifest?.github_org);
  if (companyGithubOrg && !manifestGithubOrg) {
    issues.push(`${label}: modules.manifest.json github_org je povinné, když company.gen3.json deklaruje company.github_org`);
  }
  if (!companyGithubOrg && manifestGithubOrg) {
    issues.push(`${label}: company.gen3.json company.github_org je povinné, když modules.manifest.json deklaruje github_org`);
  }
  if (companyGithubOrg && manifestGithubOrg && companyGithubOrg !== manifestGithubOrg) {
    const tolerableIncrementalMismatch =
      companyGithubOrg.toLowerCase() === manifestGithubOrg.toLowerCase() ||
      (organizationKind === "template" &&
        isPlaceholderOrganization({ slug: companyGithubOrg }) &&
        isPlaceholderOrganization({ slug: manifestGithubOrg }));
    (tolerableIncrementalMismatch ? warnings : issues).push(
      `${label}: company.gen3.json company.github_org "${companyGithubOrg}" neodpovídá modules.manifest.json github_org "${manifestGithubOrg}"${
        tolerableIncrementalMismatch ? "; během incremental rollout zůstává načtený, sjednoť canonical casing/placeholder" : ""
      }`,
    );
  }

  const teamSlugs = declaredOrganizationTeamSlugs(companyConfig);
  const manifestSlots = Array.isArray(manifest?.module_slots) ? manifest.module_slots : [];
  issues.push(
    ...organizationRepositorySlotCollectionIssues(manifestSlots).map(
      (issue) => `${label}: modules.manifest.json module_slots ${issue}`,
    ),
  );
  for (const [index, slot] of manifestSlots.entries()) {
    validateDeclaredModule({
      slot,
      source: `modules.manifest.json module_slots[${index}]`,
      organizationRoot,
      label,
      teamSlugs,
      checkMaterializedGit: true,
      issues,
      warnings,
    });
  }

  // company.gen3.json#modules je druhý deklarativní povrch. Git/readiness je
  // kanonicky v modules.manifest.json, ale deprecated filesystem cesta nesmí
  // zůstat zelená jen proto, že ji drží pouze tento paralelní seznam.
  const companyModules = Array.isArray(companyConfig?.modules) ? companyConfig.modules : [];
  issues.push(
    ...organizationRepositorySlotCollectionIssues(companyModules).map(
      (issue) => `${label}: company.gen3.json modules ${issue}`,
    ),
  );
  issues.push(
    ...organizationRepositorySlotCollectionIssues(
      [...manifestSlots, ...companyModules],
      { allowEquivalentDuplicates: true },
    ).map(
      (issue) => `${label}: modules.manifest.json a company.gen3.json mají nejednoznačnou repo projekci — ${issue}`,
    ),
  );
  for (const [index, slot] of companyModules.entries()) {
    validateDeclaredModule({
      slot,
      source: `company.gen3.json modules[${index}]`,
      organizationRoot,
      label,
      teamSlugs,
      checkMaterializedGit: false,
      issues,
      warnings,
    });
  }

  return issues;
}

function validateDeclaredModule({
  slot,
  source,
  organizationRoot,
  label,
  teamSlugs,
  checkMaterializedGit,
  issues,
  warnings,
}) {
  if (!slot || typeof slot !== "object") return;
  if (typeof slot.path !== "string" || slot.path === "") return;
  const path = slot.path;

  const containmentIssue = organizationRelativePathIssue({ organizationRoot, path });
  if (containmentIssue) {
    issues.push(`${label}: ${source}.path ${containmentIssue}`);
    return;
  }

  if (!isCanonicalOrganizationRepositorySlotPath(path)) {
    issues.push(`${label}: ${source}.path "${path}" není kanonická podporovaná Organization-relative repo boundary`);
    return;
  }
  const canonicalPath = normalizeOrganizationSlotPath(path);
  if (organizationSlotRepositoryId(slot, canonicalPath) === null) {
    issues.push(`${label}: ${source} pro "${path}" potřebuje explicitní stabilní lowercase slug`);
    return;
  }
  const repositoryMountIssue = organizationSlotRepositoryMountIssue(slot, canonicalPath);
  if (repositoryMountIssue) {
    issues.push(`${label}: ${source}.path ${repositoryMountIssue}`);
    return;
  }

  if (path.startsWith("modules/")) {
    warnings.push(
      `${label}: ${source}.path "${path}" používá deprecated modules/*; během incremental rollout zůstává načtený, ale migruj na workspace/<modul>`,
    );
  }

  for (const team of declaredSlotTeams(slot)) {
    if (!teamSlugs.has(team)) {
      issues.push(
        `${label}: ${source}.teams odkazuje na neexistující Team "${team}" v company.gen3.json teams[]`,
      );
    }
  }

  if (!checkMaterializedGit || !isActiveModuleSlot(slot) || !existsSync(join(organizationRoot, path))) return;
  const inTreeTransition = trimmedString(slot.status)?.toLowerCase() === "in_tree_transition";
  const nestedGitMarker = join(organizationRoot, path, ".git");
  if (inTreeTransition && !existsSync(nestedGitMarker)) {
    warnings.push(
      `${label}: ${source} je explicitní in_tree_transition modul "${path}" vlastněný Organization root repozitářem; samostatnou git URL dostane až při reviewované extrakci`,
    );
    return;
  }
  const gitUrl = slot.git?.url ?? slot.repo ?? slot.repository ?? null;
  if (isMissingOrPlaceholderGitUrl(gitUrl)) {
    issues.push(
      `${label}: ${source} je materializovaný aktivní modul "${path}", ale nemá konkrétní git URL v git.url/repo/repository`,
    );
  }
}

function declaredOrganizationTeamSlugs(companyConfig) {
  const canonical = Array.isArray(companyConfig?.teams) ? companyConfig.teams : null;
  const legacy = Array.isArray(companyConfig?.workspaces) ? companyConfig.workspaces : null;
  const roster = canonical ?? legacy ?? [];
  const slugs = new Set(roster.map((team) => trimmedString(team?.slug)).filter(Boolean));
  // Chybějící roster má podle decision 0041 implicitní default Team workspace.
  if (slugs.size === 0) slugs.add("workspace");
  return slugs;
}

function declaredSlotTeams(slot) {
  if (Array.isArray(slot.teams)) return slot.teams.map(trimmedString).filter(Boolean);
  if (Array.isArray(slot.workspaces)) return slot.workspaces.map(trimmedString).filter(Boolean);
  const legacy = trimmedString(slot.workspace);
  return legacy ? [legacy] : [];
}

function isActiveModuleSlot(slot) {
  const status = trimmedString(slot.status)?.toLowerCase() ?? "active";
  return !new Set(["planned", "planned_slot", "inactive", "archived", "disabled"]).has(status);
}

function isMissingOrPlaceholderGitUrl(value) {
  const normalized = trimmedString(value)?.toLowerCase() ?? "";
  return (
    normalized === "" ||
    normalized.includes("<") ||
    normalized.includes("vyplnit") ||
    normalized.includes("placeholder")
  );
}

function trimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function resolveRuntimeModuleContract({
  companiesRoot,
  packagePath,
  company,
  runtime,
}) {
  const packageDirectory = dirname(resolve(companiesRoot, packagePath));
  const boundary = resolve(companiesRoot, company.path ?? ".");
  if (!pathIsWithin(boundary, packageDirectory)) {
    return {
      module: null,
      issues: [`${packagePath}: runtime package leží mimo deklarovanou company boundary ${company.path ?? "."}`],
    };
  }
  const declaredRoots = company.discovery_source === "local_surface"
    ? [boundary]
    : await declaredOrganizationModuleRoots(boundary);
  const containingRoots = declaredRoots
    .filter((root) => pathIsWithin(root, packageDirectory))
    .sort((left, right) => right.length - left.length);
  if (containingRoots.length === 0) {
    return {
      module: null,
      issues: [`${packagePath}: runtime package neleží v žádném modulu deklarovaném v modules.manifest.json nebo company.gen3.json#modules`],
    };
  }
  const moduleRoot = containingRoots[0];
  const nestedManifests = [];
  let cursor = packageDirectory;
  while (cursor !== moduleRoot && pathIsWithin(moduleRoot, cursor)) {
    const candidate = join(cursor, "lazurio.module.json");
    if (existsSync(candidate)) nestedManifests.push(workspaceRelativePath(companiesRoot, candidate));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (nestedManifests.length > 0) {
    return {
      module: null,
      issues: nestedManifests.map(
        (path) => `${path}: nested lazurio.module.json nesmí zastínit module-root lease ${workspaceRelativePath(companiesRoot, join(moduleRoot, "lazurio.module.json"))}`,
      ),
    };
  }
  const manifestPath = join(moduleRoot, "lazurio.module.json");
  const relativeManifestPath = workspaceRelativePath(companiesRoot, manifestPath);
  if (!existsSync(manifestPath)) {
    return {
      module: null,
      issues: [`${relativeManifestPath}: v deklarovaném kořeni modulu chybí lazurio.module.v1`],
    };
  }
  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    return {
      module: null,
      issues: [`${relativeManifestPath}: lazurio.module.json nejde přečíst: ${error.message}`],
    };
  }
  const normalized = normalizeModuleManifest({
    manifest,
    modulePath: relativeManifestPath,
  });
  if (runtime?.module && normalized.module?.id && runtime.module !== normalized.module.id) {
    normalized.issues.push(
      `${packagePath}: module-root ${relativeManifestPath} patří modulu ${normalized.module.id}, runtime deklaruje ${runtime.module}`,
    );
  }
  return normalized;
}

async function declaredOrganizationModuleRoots(organizationRoot) {
  const paths = [];
  for (const [fileName, collection] of [
    ["modules.manifest.json", "module_slots"],
    ["company.gen3.json", "modules"],
  ]) {
    const manifestPath = join(organizationRoot, fileName);
    if (!existsSync(manifestPath)) continue;
    const manifest = await readJson(manifestPath);
    for (const slot of manifest?.[collection] ?? []) {
      if (typeof slot?.path !== "string" || slot.path === "" || isAbsolute(slot.path)) continue;
      const root = resolve(organizationRoot, slot.path);
      if (pathIsWithin(organizationRoot, root)) paths.push(root);
    }
  }
  return [...new Set(paths)];
}

export function runtimeScriptPortAuthorityIssues({ packageJson, packagePath, module }) {
  const issues = [];
  for (const [scriptName, command] of Object.entries(packageJson?.scripts ?? {})) {
    if (typeof command !== "string") continue;
    const inlinePort = command.match(/(?:^|\s)--port(?:=|\s+)["']?(\d{4,5})(?=["'\s]|$)/);
    if (inlinePort) {
      issues.push(
        `${packagePath}: scripts.${scriptName} obsahuje číselný port ${inlinePort[1]}; použij Launchpadem injektované PORT nebo LAZURIO_RUNTIME_LISTENER_<ID>_PORT`,
      );
    }
    for (const lease of (module?.port_leases ?? []).filter((entry) => Number.isInteger(entry?.port))) {
      if (new RegExp(`(^|\\D)${lease.port}(?=\\D|$)`).test(command)) {
        issues.push(
          `${packagePath}: scripts.${scriptName} kopíruje module lease port ${lease.port}; použij Launchpadem injektované PORT nebo LAZURIO_RUNTIME_LISTENER_<ID>_PORT`,
        );
      }
    }
  }
  return issues;
}

function splitRuntimeValidationIssues(issues) {
  const authority = [];
  const appLocal = [];
  for (const issue of issues) {
    const portAuthorityIssue =
      issue.includes("package nesmí současně deklarovat lazurio.runtime a legacy companyascode.app")
      || /: lazurio\.runtime\.(module|port|host)(?:\s|\.)/.test(issue)
      || /: lazurio\.runtime\.listeners musí být neprázdné pole/.test(issue)
      || /: lazurio\.runtime\.listeners\[\d+\]\.(lease|port|host|allocation|claim)(?:\s|\.)/.test(issue);
    (portAuthorityIssue ? authority : appLocal).push(issue);
  }
  return { authority, appLocal };
}

export async function runtimeSourcePortAuthorityIssues({
  packageDirectory,
  packagePath,
  module,
}) {
  const leases = (module?.port_leases ?? []).filter((lease) => Number.isInteger(lease.port));
  if (leases.length === 0) return [];
  const issues = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!runtimeSourceIgnoredDirs.has(entry.name)) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!runtimeSourceExtensions.has(extension)) continue;
      if (/(^|[.-])(test|spec)([.-]|$)/i.test(entry.name)) continue;

      let source;
      try {
        source = await readFile(absolutePath, "utf8");
      } catch {
        continue;
      }
      const sourcePath = posix.join(
        posix.dirname(packagePath),
        relative(packageDirectory, absolutePath).replace(/\\/g, "/"),
      );
      const fallbackPatterns = [
        /(?:process\.env|Bun\.env)(?:\.(?:PORT|LAZURIO_RUNTIME_LISTENER_[A-Z0-9_]+_PORT)|\[["'](?:PORT|LAZURIO_RUNTIME_LISTENER_[A-Z0-9_]+_PORT)["']\])\s*(?:\?\?|\|\|)\s*["']?(\d{4,5})["']?/g,
        /(?:Number|parseInt)\([^;\n)]*(?:PORT|_PORT)[^;\n)]*\)\s*(?:\?\?|\|\|)\s*["']?(\d{4,5})["']?/g,
        /\b(?:const|let|var)\s+(?:[A-Z0-9]+_)*PORT(?:_[A-Z0-9]+)*\s*=\s*["']?(\d{4,5})["']?/g,
      ];
      for (const pattern of fallbackPatterns) {
        for (const match of source.matchAll(pattern)) {
          issues.push(
            `${sourcePath}: runtime source obsahuje číselný port fallback ${match[1]}; port smí materializovat jen module lease`,
          );
        }
      }
      for (const lease of leases) {
        if (new RegExp(`(^|\\D)${lease.port}(?=\\D|$)`).test(source)) {
          issues.push(
            `${sourcePath}: runtime source kopíruje module lease port ${lease.port}; použij Launchpadem injektované PORT nebo LAZURIO_RUNTIME_LISTENER_<ID>_PORT`,
          );
        }
      }
    }
  }

  await visit(packageDirectory);
  return issues;
}

// Cesty vracené v discovery/API modelu jsou přenositelné identifikátory
// workspace, ne nativní filesystem cesty. Drží proto vždy POSIX oddělovače i na
// Windows; až spotřebitel je přes join/resolve překládá zpět na lokální cestu.
function workspaceRelativePath(root, target) {
  return relative(root, target).replace(/\\/g, "/");
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
        packagePath: workspaceRelativePath(root, absolutePath),
        company,
      });
    }
  }
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

function validateBuilderMetadata({ app, packagePath, softWarnings, sourceLabel = "companyascode.app" }) {
  if (!softWarnings) return;
  for (const key of ["icon", "description", "group"]) {
    if (app[key] === undefined) continue;
    if (typeof app[key] !== "string" || app[key].trim() === "") {
      softWarnings.push(
        `${packagePath}: ${sourceLabel}.${key} má být neprázdný string; ignoruji a použiju fallback`,
      );
      continue;
    }
    const limit = BUILDER_METADATA_SOFT_LIMITS[key];
    if (limit && app[key].length > limit) {
      softWarnings.push(
        `${packagePath}: ${sourceLabel}.${key} je delší než ${limit} znaků; karta text zkrátí`,
      );
    }
  }
  if (app.production_url !== undefined && builderMetadataProductionUrl(app.production_url) === null) {
    softWarnings.push(
      `${packagePath}: ${sourceLabel}.production_url má být http(s) URL; ignoruji a PROD zůstane bez odkazu`,
    );
  }
}

// Exportováno pro personalspace discovery lane (CAC-0048): tato funkce drží
// pouze read-compatible validaci legacy companyascode.app. Nový
// lazurio.runtime kontrakt pro obě lane normalizuje runtime-contract-lib.
// Personalspace lane zůstává jinak úplně oddělená od organizations/* discovery.
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

export function organizationAppIdPrefix(companySlug) {
  if (typeof companySlug !== "string" || companySlug.length === 0) {
    throw new TypeError("company.slug musí být neprázdný řetězec");
  }
  return `${companySlug.toLowerCase()}-`;
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
    default_branch: company.default_branch ?? companyJson.default_branch ?? "main",
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
async function discoverOrganizations({
  companiesRoot,
  companiesConfig,
  failures,
  warnings,
  organizationPathSelector = null,
}) {
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
    // Runtime akce nad už objevenou aplikací zná přesnou Organization cestu.
    // Scoped rediscovery proto nesmí ani parsovat cizí mount: jeho rozbitý
    // marker nebo kontrakt patří do globálního Doctora, ne do start gate
    // validní aplikace jiné Organizace.
    if (organizationPathSelector && path !== organizationPathSelector) continue;
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

    const organizationKind = organizationKindFromCompanyJson(companyJson);
    if (organizationKind !== "template") {
      const declaredSlug = companyJson?.company?.slug;
      const declaredGithubOrg = companyJson?.company?.github_org;
      const placeholderIdentityFields = [
        ["company.slug", declaredSlug],
        ["company.github_org", declaredGithubOrg],
      ].filter(([, value]) => typeof value === "string" && isPlaceholderOrganization({ slug: value }));
      if (placeholderIdentityFields.length > 0) {
        failures.push(
          ...placeholderIdentityFields.map(
            ([field, value]) =>
              `${path}: company.gen3.json ${field} "${value}" je placeholder; placeholder identita je povolená jen s organization_kind "template"`,
          ),
        );
        continue;
      }
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
  warnings,
}) {
  for (const company of mounts) {
    // Scan-first: mount buď existuje (proto ho vidíme), nebo zmizel mezi skenem a
    // průchodem → prostě přeskoč. Nepřítomnost mountu NIKDY není failure (decision
    // 0042); chybějící Organizace se jednoduše neobjeví v seznamu.
    if (company.status === "planned" || !company.path) continue;
    const companyRoot = join(companiesRoot, company.path);
    if (!existsSync(companyRoot)) continue;
    const mountContractIssues = await organizationMountContractIssues({
      organizationRoot: companyRoot,
      label: company.path,
      warnings,
    });
    // Scan-first ignoruje NEPŘÍTOMNOST mountu, ne rozbitou hranici přítomného
    // mountu: namountovaná Organizace bez povinné GEN3 struktury je hard failure
    // (stejná gate jako před scan-first) a její balíčky se neprocházejí — appka
    // z nezvalidované hranice se nesmí stát spustitelnou.
    if (mountContractIssues.length > 0) {
      failures.push(...mountContractIssues);
      continue;
    }
    await walkPackageJson(companiesRoot, companyRoot, packageEntries, company);
  }
}

// Decision 0043: nevalidní app manifest izoluje jen dotčenou appku. Discovery ji
// vrací jako scoped invalid_apps záznam + warning, ne jako root failure —
// bezpečnostní invarianty (plugin read-only violation, mount boundary) zůstávají
// hard failures níže. App id kolize izoluje dotčený manifest; port musí být
// unikátní uvnitř jedné Organizace, zatímco cross-Organization overlap je
// povolená owner-aware runtime informace (founder 2026-07-22 refinement).
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
    organization_kind: company.organization_kind ?? null,
    discovery_source: company.discovery_source ?? null,
    cwd: posix.dirname(packagePath),
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

  const packageDir = dirname(join(companiesRoot, packagePath));
  const companyRoot = join(companiesRoot, company.path);
  const pluginPath = resolve(packageDir, app.plugin);
  const relativeToCompany = relative(companyRoot, pluginPath);
  const windowsDriveQualified = /^[A-Za-z]:/.test(app.plugin);
  if (
    isAbsolute(app.plugin)
    || windowsDriveQualified
    || isAbsolute(relativeToCompany)
    || relativeToCompany.startsWith("..")
  ) {
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
    manifestIssues.push(
      `${workspaceRelativePath(companiesRoot, pluginPath)}: plugin JSON nejde přečíst: ${error.message}`,
    );
    return null;
  }

  const pluginPackagePath = workspaceRelativePath(companiesRoot, pluginPath);
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
    label: workspaceRelativePath(process.cwd(), companiesRoot) || ".",
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
  const runtimeSchema = await readJson(runtimeSchemaPath);
  if (runtimeSchema?.properties?.schema_version?.const !== "lazurio.runtime.v1") {
    failures.push("launchpad/schemas/lazurio-runtime.schema.json nemá canonical lazurio.runtime.v1 schema_version");
  }
  const moduleSchema = await readJson(moduleSchemaPath);
  if (moduleSchema?.properties?.schema_version?.const !== "lazurio.module.v1") {
    failures.push("launchpad/schemas/lazurio-module.schema.json nemá canonical lazurio.module.v1 schema_version");
  }
  const portRegistrySchema = await readJson(portRegistrySchemaPath);
  if (portRegistrySchema?.properties?.schema_version?.const !== "lazurio.port_registry.v1") {
    failures.push("launchpad/schemas/lazurio-port-registry.schema.json nemá canonical lazurio.port_registry.v1 schema_version");
  }
  const portRegistryPath = join(companiesRoot, "lazurio.port-registry.json");
  let portRegistry = null;
  const portRegistryReadIssues = [];
  if (!existsSync(portRegistryPath)) {
    portRegistryReadIssues.push("Chybí centrální lazurio.port-registry.json");
  } else {
    try {
      const normalizedRegistry = normalizePortRegistry(await readJson(portRegistryPath));
      portRegistry = normalizedRegistry.registry;
      portRegistryReadIssues.push(...normalizedRegistry.issues);
    } catch (error) {
      portRegistryReadIssues.push(`lazurio.port-registry.json nejde přečíst: ${error.message}`);
    }
  }
  const pluginSchema = await readJson(pluginSchemaPath);
  const packageEntries = [];
  const templatePackageEntries = [];
  const organizationPathSelector = typeof options.organization_path === "string"
    && options.organization_path.trim() !== ""
    ? options.organization_path.trim()
    : null;
  const discovered = await discoverOrganizations({
    companiesRoot,
    companiesConfig,
    failures,
    warnings,
    organizationPathSelector,
  });
  let organizations = discovered.organizations;
  let templateMounts = discovered.templateMounts;
  // Planned sloty jsou per-machine záležitost (gitignored launchpad.gen3.local.json):
  // sdílený tracked config nesmí nést něčí plánované Organizace — na cizí mašině se
  // ukazovaly jako chybějící přístup (decision 0042, founder 2026-07-12). Planned
  // slot je informační: nemá path, nikdy nevyrábí failure a namountovaná Organizace
  // se stejným slugem vyhrává.
  const localConfig = await readLocalOverrideConfig(companiesRoot, warnings);
  appendPlannedOrganizations({ localConfig, organizations, templateMounts, warnings });
  const organizationSelector = typeof options.organization === "string"
    ? options.organization.trim().toLowerCase()
    : null;
  if (organizationSelector) {
    organizations = organizations.filter(
      (organization) => organization.slug.toLowerCase() === organizationSelector,
    );
    templateMounts = [];
  }
  const moduleTemplates = organizationSelector
    ? []
    : await discoverModuleTemplates({ companiesRoot });
  await walkMountPackages({
    mounts: organizations,
    companiesRoot,
    packageEntries,
    failures,
    warnings,
  });
  // Template mounty se validují se stejnými strukturálními gates (required paths),
  // ale jejich balíčky jdou do oddělené kolekce — nikdy se nestanou spustitelnými
  // aplikacemi (runtime/business/counts exclusion, founder 2026-07-12).
  if (!organizationSelector) {
    await walkMountPackages({
      mounts: templateMounts,
      companiesRoot,
      packageEntries: templatePackageEntries,
      failures,
      warnings,
    });
  }

  if (!organizationSelector) {
    await discoverLocalSurfacePackages({
      companiesRoot,
      companiesConfig,
      localConfig,
      packageEntries,
      failures,
      warnings,
    });
  }

  const sortedPackageEntries = packageEntries.sort((a, b) => a.packagePath.localeCompare(b.packagePath));
  const apps = [];
  const invalidApps = [];
  const portOwners = [];
  const moduleContractsByPath = new Map();
  const appIds = new Map();
  for (const { packagePath, company } of sortedPackageEntries) {
    const absolutePackagePath = join(companiesRoot, packagePath);
    const packageJson = await readJson(absolutePackagePath);
    const normalizedRuntime = normalizePackageRuntime({ packageJson, packagePath });
    if (!normalizedRuntime) continue;
    let app = normalizedRuntime.app;
    const sourceLabel = app.runtime_contract?.source ?? "runtime manifest";
    const usesLazurioRuntime = app.runtime_contract?.legacy !== true;
    const splitRuntimeIssues = usesLazurioRuntime
      ? splitRuntimeValidationIssues(normalizedRuntime.issues)
      : { authority: [], appLocal: normalizedRuntime.issues };

    const manifestIssues = [...splitRuntimeIssues.appLocal];
    const runtimeContractIssues = [...splitRuntimeIssues.authority];
    const securityIssues = [];
    const builderMetadataWarnings = [...normalizedRuntime.warnings];
    if (app.runtime_contract?.legacy === true) {
      validateAppManifest({
        app: packageJson.companyascode.app,
        packageJson,
        packagePath,
        schema: appSchema,
        failures: manifestIssues,
        softWarnings: builderMetadataWarnings,
      });
      const governingModule = await resolveRuntimeModuleContract({
        companiesRoot,
        packagePath,
        company,
        runtime: app,
      });
      if (governingModule.module) {
        runtimeContractIssues.push(
          `${packagePath}: legacy companyascode.app nesmí existovat vedle module-root lazurio.module.json; migruj runtime na lazurio.runtime.v1`,
        );
      }
    } else {
      const moduleResult = await resolveRuntimeModuleContract({
        companiesRoot,
        packagePath,
        company,
        runtime: app,
      });
      runtimeContractIssues.push(...moduleResult.issues);
      if (moduleResult.module) {
        moduleContractsByPath.set(moduleResult.module.module_path, moduleResult.module);
        const materialized = materializeRuntimeFromModule({
          runtime: app,
          module: moduleResult.module,
          packagePath,
        });
        app = materialized.app;
        runtimeContractIssues.push(...materialized.issues);
        runtimeContractIssues.push(...runtimeScriptPortAuthorityIssues({
          packageJson,
          packagePath,
          module: moduleResult.module,
        }));
        runtimeContractIssues.push(...await runtimeSourcePortAuthorityIssues({
          packageDirectory: dirname(absolutePackagePath),
          packagePath,
          module: moduleResult.module,
        }));
      }
      validateBuilderMetadata({ app, packagePath, softWarnings: builderMetadataWarnings, sourceLabel });
    }
    if (typeof app.company === "string" && app.company !== company.slug) {
      manifestIssues.push(
        `${packagePath}: ${sourceLabel}.company musí být ${company.slug}, protože package leží ve ${company.path}`,
      );
    }
    if (
      company.organization_kind === "organization"
      && typeof app.id === "string"
      && !app.id.startsWith(organizationAppIdPrefix(company.slug))
    ) {
      manifestIssues.push(
        `${packagePath}: ${sourceLabel}.id musí začínat Organization prefixem ${organizationAppIdPrefix(company.slug)}`,
      );
    }

    // Plugin security se ověřuje i tehdy, když už app manifest nese scoped
    // kvalitativní chybu (např. starý Organization prefix). Jinak by snadno
    // opravitelná identity chyba zakryla hard boundary violation v plugin cestě
    // nebo read-only kontraktu.
    const plugin = typeof app.plugin === "string" && app.plugin.trim() !== ""
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
    if (runtimeContractIssues.length > 0) {
      failures.push(...runtimeContractIssues);
      invalidApps.push(invalidAppRecord({
        app,
        packagePath,
        company,
        issues: [...runtimeContractIssues, ...manifestIssues],
      }));
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
    for (const listener of app.listeners ?? []) {
      if (listener.allocation !== "static" || !Number.isInteger(listener.port)) continue;
      portOwners.push(buildPortOwner({ app, listener, packagePath, company }));
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
      preview_script: app.preview_script ?? null,
      build_script: app.build_script ?? null,
      required_module_slots: app.required_module_slots ?? [],
      listeners: app.listeners ?? [],
      entrypoint_listener: app.entrypoint_listener ?? null,
      module_contract: app.module_contract ?? null,
      runtime_contract: app.runtime_contract ?? null,
      plugin,
      package_path: packagePath,
      organization_path: company.path,
      organization_kind: company.organization_kind ?? null,
      discovery_source: company.discovery_source ?? null,
      company_workspace_path: company.path,
      cwd: posix.dirname(packagePath),
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

  // Všechny statické listenery zůstávají viditelné i při překryvu. Uvnitř
  // Organization patří číslo jednomu module listener lease; oddělené
  // Organizations mohou zachovat stejné stabilní číslo a na jedné mašině je
  // používají po jednom. Runtime port nikdy nepřemapovává a při explicitním
  // Start/Open dosavadního live vlastníka lease nahradí.
  const listenerIndex = buildPortOwnershipIndex(portOwners);
  const portOverlaps = listenerIndex.overlaps;
  const overlapByPort = new Map(portOverlaps.map((overlap) => [overlap.port, overlap]));
  for (const app of apps) {
    app.listener_claims = (app.listeners ?? [])
      .filter((listener) => listener.allocation === "static" && Number.isInteger(listener.port))
      .map((listener) => {
        const endpoint = `${canonicalListenerHost(listener.host)}:${listener.port}`;
        const overlap = overlapByPort.get(listener.port);
        return {
          listener_id: listener.id,
          endpoint,
          overlap: overlap ?? null,
        };
      });
    const entrypointPort = app.entrypoint_listener?.allocation === "static"
      ? app.entrypoint_listener.port
      : null;
    const entrypointOverlap = Number.isInteger(entrypointPort)
      ? overlapByPort.get(entrypointPort)
      : null;
    // Legacy UI consumer uses this field as a list of safely switchable peers.
    // Conflicts remain fully visible through listener_claims/port_overlaps, but
    // must never be presented as candidates for a destructive switch.
    app.shared_port_owners = entrypointOverlap?.classification === "module-version-lease"
      ? entrypointOverlap.owners
      : [];
  }
  const moduleContracts = [...moduleContractsByPath.values()];
  if (moduleContracts.length > 0) failures.push(...portRegistryReadIssues);
  else warnings.push(...portRegistryReadIssues);
  const portRegistryIssues = portRegistry
    ? validateModuleLeasesAgainstRegistry({ modules: moduleContracts, registry: portRegistry })
    : [];
  failures.push(...portRegistryIssues);

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
    port_overlaps: portOverlaps,
    listener_overlaps: portOverlaps,
    listener_owners: listenerIndex.owners,
    module_listener_drifts: listenerIndex.module_listener_drifts,
    module_contracts: moduleContracts,
    port_registry_issues: portRegistryIssues,
    // Internal per-machine evidence for downstream readiness classification.
    // buildLaunchpadAppsResponse does not expose this object through /api/apps.
    local_config: localConfig,
    failures,
    warnings,
  };
}

// Template mount se validuje (schema manifestu + interní id/port kolize), ale
// nikdy nevrací spustitelné aplikace. Balíčky jdou do template_apps s příznakem
// organization_kind=template a manifest_state; id/port kolize jsou izolované ve
// vlastních mapách, takže vadný template NIKDY nezhavaruje runtime reálné firmy
// (žádný zápis do global failures). Runtime pole (dev_script, health, plugin)
// se úmyslně nevrací — template appka se nespouští.
async function collectTemplateApps({ companiesRoot, templatePackageEntries, appSchema, warnings }) {
  const sorted = [...templatePackageEntries].sort((a, b) => a.packagePath.localeCompare(b.packagePath));
  const templateApps = [];
  const templateAppIds = new Map();
  const templatePorts = new Map();
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
    const normalizedRuntime = normalizePackageRuntime({ packageJson, packagePath });
    if (!normalizedRuntime) continue;
    const app = normalizedRuntime.app;

    const manifestIssues = [...normalizedRuntime.issues];
    if (app.runtime_contract?.legacy === true) {
      validateAppManifest({
        app: packageJson.companyascode.app,
        packageJson,
        packagePath,
        schema: appSchema,
        softWarnings: null,
        failures: manifestIssues,
      });
    }
    // Company-slug match se u template mountu ZÁMĚRNĚ nekontroluje: slug template
    // mountu je placeholder-derived label (jméno adresáře), ne kanonická identita
    // firmy. Template app manifesty legitimně nesou generický placeholder company
    // (např. "organization-template"), který se přepíše až při forku do reálné
    // Organizace — vynucovat rovnost proti odvozenému slugu nemá smysl. Interní
    // konzistenci template (schema a app id/port kolize uvnitř jednoho
    // template mountu) hlídáme dál.
    if (typeof app.id === "string" && app.id.trim() !== "") {
      const existing = templateAppIds.get(app.id);
      if (existing) manifestIssues.push(`${packagePath}: template app id ${app.id} koliduje s ${existing}`);
      else templateAppIds.set(app.id, packagePath);
    }
    if (Number.isInteger(app.port)) {
      const key = `${company.path}\u0000${app.port}`;
      const existing = templatePorts.get(key);
      if (existing) manifestIssues.push(`${packagePath}: template port ${app.port} koliduje s ${existing}`);
      else templatePorts.set(key, packagePath);
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
      listeners: app.listeners ?? [],
      entrypoint_listener: app.entrypoint_listener ?? null,
      runtime_contract: app.runtime_contract ?? null,
      package_path: packagePath,
      organization_path: company.path,
      organization_kind: "template",
      manifest_state: manifestIssues.length === 0 ? "template" : "invalid_manifest",
      manifest_issues: manifestIssues,
    });
  }
  return templateApps;
}
