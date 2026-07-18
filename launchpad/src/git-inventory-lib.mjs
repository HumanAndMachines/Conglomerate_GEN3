import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { basename, dirname, join } from "path";
import { organizationMountStructureIssues } from "./discovery-lib.mjs";
import {
  isCanonicalOrganizationRepositorySlotPath,
  isOrganizationRootSlotDescendantPath,
  isOrganizationSlotContainerPath,
  normalizeOrganizationSlotPath,
  organizationSlotScope,
  organizationSlotWorkspace,
} from "./organization-slot-scope-lib.mjs";
import {
  inspectCanonicalPathBoundary,
  isSamePath,
} from "./path-boundary-lib.mjs";

export async function buildGitInventory({ companiesRoot, organizations = null } = {}) {
  if (!companiesRoot) throw new Error("buildGitInventory requires companiesRoot");
  // Scan-first (decision 0042): default seznam Organizací je sken namountovaných
  // organizations/*/company.gen3.json, ne registry v launchpad.gen3.json. Explicitní
  // `organizations` (např. z discovery výstupu nebo z testu) má přednost.
  const repos = [];
  const planned = [];
  const warnings = [];
  const orgs = organizations ?? (await discoverMountedOrganizations(companiesRoot, warnings));
  let realCompaniesRoot = null;

  for (const organization of orgs) {
    const normalized = normalizeOrganization(organization);
    if (!normalized) continue;
    const organizationRoot = join(companiesRoot, normalized.path);
    let realOrganizationRoot = null;
    // Strukturální gate platí i pro explicitně předané organizations (např.
    // discovery výstup): přítomný mount, který app discovery hard-failuje, se
    // nesmí objevit jako akční repo. Chybějící mount si nechává původní chování
    // (root repo záznam + warning) — nepřítomnost není rozbitá hranice.
    if (existsSync(organizationRoot)) {
      const organizationMountRoot = dirname(organizationRoot);
      const mountBoundary = await inspectCanonicalPathBoundary({
        rootPath: companiesRoot,
        rootRealPath: realCompaniesRoot,
        targetPath: organizationMountRoot,
      });
      realCompaniesRoot = mountBoundary.rootRealPath;
      const rootBoundary = mountBoundary.ok
        ? await inspectCanonicalPathBoundary({
            rootPath: organizationMountRoot,
            rootRealPath: mountBoundary.targetRealPath,
            targetPath: organizationRoot,
          })
        : { ok: false, targetRealPath: null };
      const expectedRealOrganizationRoot = mountBoundary.targetRealPath
        ? join(mountBoundary.targetRealPath, basename(organizationRoot))
        : null;
      if (
        !rootBoundary.ok
        || !expectedRealOrganizationRoot
        || !isSamePath(expectedRealOrganizationRoot, rootBoundary.targetRealPath)
      ) {
        warnings.push(
          `${normalized.path}: mount vynechán z git inventáře — kanonická cesta se přes symlink/junction dostává mimo Conglomerate root nebo ji nejde bezpečně ověřit`,
        );
        continue;
      }
      realOrganizationRoot = rootBoundary.targetRealPath;
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
      const pathBoundaryIssue = slotPathBoundaryInventoryIssue(rawSlot);
      if (pathBoundaryIssue) {
        warnings.push(
          `${normalized.path}: slot ${String(rawSlot?.path ?? "<missing>")} vynechán z git/worktree inventáře — ${pathBoundaryIssue}`,
        );
        continue;
      }
      const slot = normalizeModuleSlot(rawSlot, normalized);
      if (!slot) continue;
      const rootInventoryIssue = rootSlotInventoryIssue(rawSlot, slot);
      if (rootInventoryIssue) {
        warnings.push(
          `${normalized.path}: root slot ${slot.path} vynechán z git/worktree inventáře — ${rootInventoryIssue}`,
        );
        continue;
      }
      if (!slot.repo) {
        planned.push(slotRecord({ organization: normalized, slot, companiesRoot }));
        continue;
      }
      const absoluteSlotPath = join(organizationRoot, slot.path);
      if (existsSync(absoluteSlotPath)) {
        const slotBoundary = await inspectCanonicalPathBoundary({
          rootPath: organizationRoot,
          rootRealPath: realOrganizationRoot,
          targetPath: absoluteSlotPath,
        });
        realOrganizationRoot = slotBoundary.rootRealPath;
        if (!slotBoundary.ok) {
          warnings.push(
            `${normalized.path}: slot ${slot.path} vynechán z git/worktree inventáře — existující checkout se přes symlink/junction dostává mimo root Organizace nebo jeho kanonickou cestu nejde bezpečně ověřit`,
          );
          continue;
        }
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
    expected_branch:
      slot.space === "root"
        ? slot.branch
        : slot.branch ?? organization.default_branch ?? "main",
    remote: sanitizeRemote(slot.repo),
  };
}

function slotRecord({ organization, slot, companiesRoot }) {
  return {
    key: `${organization.slug}::${slot.module}`,
    organization: organization.slug,
    organization_display_name: organization.display_name,
    organization_path: organization.path,
    space: slot.space,
    workspace: slot.workspace,
    module: slot.module,
    name: slot.name,
    repo_kind: repoKindForSlot(slot),
    repo_path: `${organization.path}/${slot.path}`,
    absolute_path: join(companiesRoot, organization.path, slot.path),
    expected_branch:
      slot.space === "root"
        ? slot.branch
        : slot.branch ?? organization.default_branch ?? "main",
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
  const path = normalizeOrganizationSlotPath(slot.path);
  if (!path) return null;
  const module = basename(path);
  const space = organizationSlotScope(slot, path);
  const rootRepo =
    typeof slot.git?.url === "string" && slot.git.url.trim() !== ""
      ? slot.git.url.trim()
      : null;
  const rootBranch =
    typeof slot.git?.branch === "string" && slot.git.branch.trim() !== ""
      ? slot.git.branch.trim()
      : null;
  const repo =
    space === "root" ? rootRepo : slot.repo ?? slot.git?.url ?? null;
  const branch =
    space === "root"
      ? rootBranch
      : slot.branch ?? slot.git?.branch ?? organization.default_branch ?? "main";
  return {
    path,
    module,
    name: slot.name ?? humanizeSlug(module),
    space,
    workspace: organizationSlotWorkspace(slot, path),
    category: slot.category ?? null,
    status: slot.status ?? null,
    repo,
    branch,
  };
}

function slotPathBoundaryInventoryIssue(slot) {
  if (!slot || typeof slot.path !== "string" || slot.path.trim() === "") {
    return "slot path chybí";
  }
  const normalizedPath = normalizeOrganizationSlotPath(slot.path);
  if (isOrganizationSlotContainerPath(normalizedPath)) {
    return "Organization kontejner není repozitářový slot; použij workspace/<slug>, modules/<slug> nebo productionspace/<slug>";
  }
  if (isOrganizationRootSlotDescendantPath(normalizedPath)) {
    return "cesta je uvnitř rezervované Organization root boundary a není samostatný root slot";
  }
  if (!isCanonicalOrganizationRepositorySlotPath(slot.path)) {
    return "cesta není kanonická podporovaná Organization-relative repo boundary";
  }
  return null;
}

function rootSlotInventoryIssue(rawSlot, normalizedSlot) {
  if (normalizedSlot.space !== "root") return null;
  if (rawSlot.space !== "root") {
    return 'musí explicitně deklarovat space: "root"';
  }
  const forbiddenFields = [
    "workspace",
    "workspaces",
    "teams",
    "repo",
    "repository",
    "branch",
  ].filter((field) => Object.prototype.hasOwnProperty.call(rawSlot, field));
  if (forbiddenFields.length > 0) {
    return `nesmí deklarovat root-neplatná pole (${forbiddenFields.join(", ")})`;
  }
  if (normalizedSlot.status === "planned_slot") {
    return rawSlot.git === undefined ? null : "planned_slot nesmí deklarovat git";
  }
  if (!normalizedSlot.repo || !normalizedSlot.branch) {
    return "aktivní root slot musí mít úplné git.url i git.branch";
  }
  if (
    normalizedSlot.path === "mission-control/db" &&
    normalizedSlot.branch !== "v3"
  ) {
    return 'mission-control/db musí používat přesnou větev "v3"';
  }
  return null;
}

function repoKindForSlot(slot) {
  if (slot.space === "root") return "root_repo";
  if (slot.space === "productionspace") return "productionspace";
  if (slot.space === "workspace") return "module";
  return "root_repo";
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
