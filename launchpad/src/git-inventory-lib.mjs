import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { basename, join } from "path";
import { organizationMountStructureIssues } from "./discovery-lib.mjs";

export async function buildGitInventory({ companiesRoot, organizations = null } = {}) {
  if (!companiesRoot) throw new Error("buildGitInventory requires companiesRoot");
  // Scan-first (decision 0042): default seznam Organizací je sken namountovaných
  // organizations/*/company.gen3.json, ne registry v launchpad.gen3.json. Explicitní
  // `organizations` (např. z discovery výstupu nebo z testu) má přednost.
  const repos = [];
  const planned = [];
  const warnings = [];
  const orgs = organizations ?? (await discoverMountedOrganizations(companiesRoot, warnings));

  for (const organization of orgs) {
    const normalized = normalizeOrganization(organization);
    if (!normalized) continue;
    const organizationRoot = join(companiesRoot, normalized.path);
    // Strukturální gate platí i pro explicitně předané organizations (např.
    // discovery výstup): přítomný mount, který app discovery hard-failuje, se
    // nesmí objevit jako akční repo. Chybějící mount si nechává původní chování
    // (root repo záznam + warning) — nepřítomnost není rozbitá hranice.
    if (existsSync(organizationRoot)) {
      const structureIssues = organizationMountStructureIssues({
        organizationRoot,
        label: normalized.path,
      });
      if (structureIssues.length > 0) {
        warnings.push(`${normalized.path}: mount vynechán z git inventáře — chybí povinná GEN3 struktura (${structureIssues.join("; ")})`);
        continue;
      }
    }
    addOrganizationRootRepo(repos, normalized, companiesRoot);
    if (!existsSync(organizationRoot)) {
      warnings.push(`${normalized.path}: organization mount chybí`);
      continue;
    }
    const manifest = await readOrganizationModuleManifest(organizationRoot);
    if (!manifest) {
      warnings.push(`${normalized.path}: modules.manifest.json chybí nebo nejde přečíst`);
      continue;
    }
    for (const rawSlot of Array.isArray(manifest.module_slots) ? manifest.module_slots : []) {
      const slot = normalizeModuleSlot(rawSlot, normalized);
      if (!slot) continue;
      if (!slot.repo) {
        planned.push(slotRecord({ organization: normalized, slot, companiesRoot }));
        continue;
      }
      repos.push(repoRecord({ organization: normalized, slot, companiesRoot }));
    }
  }

  return {
    schema_version: "companiesascode.launchpad.git_inventory.v1",
    generated_at: new Date().toISOString(),
    repos,
    planned,
    warnings,
  };
}

export async function readLaunchpadConfig(companiesRoot) {
  const path = join(companiesRoot, "launchpad.gen3.json");
  if (!existsSync(path)) return {};
  return readJson(path);
}

const ignoredMountDirs = new Set([".git", ".worktrees", "node_modules"]);

// Scan-first (decision 0042): jediná autorita jsou namountované
// organizations/*/company.gen3.json, ne registry v launchpad.gen3.json. Slug,
// display_name a Git metadata (repository/git_url/default_branch) čteme z
// company.gen3.json. Mount s markerem organization_kind=template je z inventáře
// vyloučený úplně (decision 0077): git inventory krmí /api/git/repos, mission
// control plan indexing a worktree create/publish — template mount se nesmí
// stát akčním repozitářem Organizace na builder surfaces.
export async function discoverMountedOrganizations(companiesRoot, warnings = null) {
  const config = await readLaunchpadConfig(companiesRoot);
  const mountpoint = config.organization_mountpoint ?? "organizations";
  const mountRoot = join(companiesRoot, mountpoint);
  if (!existsSync(mountRoot)) return [];
  const organizations = [];
  const seen = new Set();
  for (const entry of (await readdir(mountRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || ignoredMountDirs.has(entry.name)) continue;
    const path = `${mountpoint}/${entry.name}`;
    const companyConfigPath = join(companiesRoot, path, "company.gen3.json");
    if (!existsSync(companyConfigPath)) continue;
    let companyConfig;
    try {
      companyConfig = await readJson(companyConfigPath);
    } catch {
      // Ignore malformed auto-discovery candidates; diagnostics owns config validation.
      continue;
    }
    // Stejný strojový marker jako discovery-lib (organizationKind): template mount
    // zůstává mimo git/worktree akční plochy.
    if (companyConfig?.organization_kind === "template") continue;
    // Stejný strukturální gate jako app discovery: mount, který tam hard-failuje,
    // nesmí zůstat akční v git/worktree APIs.
    const structureIssues = organizationMountStructureIssues({
      organizationRoot: join(companiesRoot, path),
      label: path,
    });
    if (structureIssues.length > 0) {
      warnings?.push(`${path}: mount vynechán z git inventáře — chybí povinná GEN3 struktura (${structureIssues.join("; ")})`);
      continue;
    }
    const organization = mountedOrganizationFromCompanyConfig({ companyConfig, path, directoryName: entry.name });
    if (!organization || seen.has(organization.slug)) continue;
    organizations.push(organization);
    seen.add(organization.slug);
  }
  return organizations;
}

function mountedOrganizationFromCompanyConfig({ companyConfig, path, directoryName }) {
  const company = companyConfig.company ?? {};
  const directorySlug = directoryName.replace(/_GEN3$/, "");
  const declaredSlug = typeof company.slug === "string" ? company.slug : null;
  // Zrcadlí placeholder guard discovery-lib (autoOrganizationFromCompanyJson):
  // placeholder slug = nedokončený scaffold, nesmí se stát akční Organizací na
  // git/worktree plochách. Fallback na jméno adresáře platí jen pro CHYBĚJÍCÍ slug.
  if (isPlaceholderSlug(declaredSlug ?? directorySlug)) return null;
  const slug = declaredSlug ?? directorySlug;
  return normalizeOrganization({
    slug,
    display_name: nonPlaceholderText(company.display_name) ?? slug,
    path,
    default_branch: company.default_branch ?? companyConfig.default_branch,
    repository: company.repository ?? null,
    git_url: company.git_url ?? null,
  });
}

function isPlaceholderSlug(slug) {
  const normalized = String(slug ?? "").trim().toLowerCase();
  return !normalized || normalized.includes("<") || normalized.includes("vyplnit") || normalized === "example";
}

function nonPlaceholderText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.includes("<") ? null : trimmed;
}

async function readOrganizationModuleManifest(organizationRoot) {
  for (const relativePath of ["modules.manifest.json", "company/scripts/modules.manifest.json"]) {
    const path = join(organizationRoot, relativePath);
    if (!existsSync(path)) continue;
    try {
      return await readJson(path);
    } catch {
      return null;
    }
  }
  return null;
}

function addOrganizationRootRepo(repos, organization, companiesRoot) {
  repos.push({
    key: `${organization.slug}::root`,
    organization: organization.slug,
    organization_display_name: organization.display_name,
    organization_path: organization.path,
    workspace: "root",
    module: "root",
    name: `${organization.display_name} root`,
    repo_kind: "organization_root",
    repo_path: organization.path,
    absolute_path: join(companiesRoot, organization.path),
    expected_branch: organization.default_branch ?? "main",
    repo: organization.repository ?? organization.git_url ?? null,
    remote: sanitizeRemote(organization.repository ?? organization.git_url),
  });
}

function repoRecord({ organization, slot, companiesRoot }) {
  const key = `${organization.slug}::${slot.module}`;
  return {
    ...slotRecord({ organization, slot, companiesRoot }),
    key,
    repo_kind: repoKindForSlot(slot),
    absolute_path: join(companiesRoot, organization.path, slot.path),
    expected_branch: slot.branch ?? organization.default_branch ?? "main",
    remote: sanitizeRemote(slot.repo),
  };
}

function slotRecord({ organization, slot, companiesRoot }) {
  return {
    key: `${organization.slug}::${slot.module}`,
    organization: organization.slug,
    organization_display_name: organization.display_name,
    organization_path: organization.path,
    workspace: slot.workspace,
    module: slot.module,
    name: slot.name,
    repo_kind: repoKindForSlot(slot),
    repo_path: `${organization.path}/${slot.path}`,
    absolute_path: join(companiesRoot, organization.path, slot.path),
    expected_branch: slot.branch ?? organization.default_branch ?? "main",
    repo: slot.repo,
    slot_path: slot.path,
    category: slot.category ?? null,
  };
}

function normalizeOrganization(organization) {
  if (!organization || typeof organization !== "object") return null;
  if (organization.status === "planned") return null;
  if (typeof organization.slug !== "string" || typeof organization.path !== "string") return null;
  return {
    ...organization,
    display_name: organization.display_name ?? organization.slug,
    default_branch: organization.default_branch ?? "main",
  };
}

function normalizeModuleSlot(slot, organization) {
  if (!slot || typeof slot !== "object" || typeof slot.path !== "string" || slot.path.trim() === "") return null;
  const path = slot.path.replace(/\\/g, "/");
  const module = basename(path);
  return {
    path,
    module,
    name: slot.name ?? humanizeSlug(module),
    workspace: slot.workspace ?? inferWorkspace(path),
    category: slot.category ?? null,
    repo: slot.repo ?? slot.git?.url ?? null,
    branch: slot.branch ?? slot.git?.branch ?? organization.default_branch ?? "main",
  };
}

function repoKindForSlot(slot) {
  if (slot.path.startsWith("productionspace/")) return "productionspace";
  if (slot.path.startsWith("workspace/") || slot.path.startsWith("modules/")) return "module";
  return "root_repo";
}

function inferWorkspace(path) {
  if (path.startsWith("productionspace/")) return "productionspace";
  return "workspace";
}

function sanitizeRemote(remote) {
  if (!remote || typeof remote !== "string") return null;
  const github = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (github) return { url_kind: "github", owner_repo: github[1] };
  const ownerRepo = remote.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  if (ownerRepo) return { url_kind: "github", owner_repo: remote };
  return { url_kind: "other" };
}

function humanizeSlug(slug) {
  return String(slug ?? "")
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
