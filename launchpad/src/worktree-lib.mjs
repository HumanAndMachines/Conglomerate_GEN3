import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { basename, join, relative } from "path";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import { readGitRepoStatus } from "./git-status-lib.mjs";
import { readMissionControlPlanAt } from "./mission-control-plan-lib.mjs";
import { inspectCanonicalPathBoundary } from "./path-boundary-lib.mjs";

const invalidWorktreeLocations = [
  ".claude/worktrees",
  ".codex-tmp",
  ".pr-worktrees",
  ".worktrees/modules",
  ".worktrees/root-repos",
];

export async function buildWorktreeIndex({ companiesRoot, organization = null, module = null } = {}) {
  if (!companiesRoot) throw new Error("buildWorktreeIndex requires companiesRoot");
  const inventory = await buildGitInventory({ companiesRoot });
  const organizations = uniqueOrganizations(inventory.repos).filter((org) => !organization || org.slug === organization);
  const worktrees = [];
  const invalid_locations = [];
  const warnings = [];

  for (const org of organizations) {
    const organizationRoot = join(companiesRoot, org.path);
    if (!existsSync(organizationRoot)) continue;
    for (const invalidLocation of invalidWorktreeLocations) {
      const absolutePath = join(organizationRoot, invalidLocation);
      if (existsSync(absolutePath)) {
        invalid_locations.push({
          organization: org.slug,
          path: relative(companiesRoot, absolutePath).replace(/\\/g, "/"),
          status: "invalid",
          message: "Neplatné umístění worktree podle decision 0049.",
        });
      }
    }
    const scanned = await scanCanonicalOrganizationWorktrees({ companiesRoot, organization: org });
    for (const worktree of scanned) {
      if (module && worktree.module !== module) continue;
      worktrees.push(worktree);
    }
  }

  for (const worktree of worktrees) {
    if (!worktree.metadata) continue;
    for (const message of detectNonCanonicalSidecarFields(worktree.metadata)) {
      warnings.push({
        organization: worktree.organization,
        slug: worktree.slug,
        path: worktree.sidecar_path,
        level: "warning",
        message,
      });
    }
  }

  return {
    schema_version: "companiesascode.launchpad.worktrees.v1",
    generated_at: new Date().toISOString(),
    worktrees,
    invalid_locations,
    warnings,
  };
}

async function scanCanonicalOrganizationWorktrees({ companiesRoot, organization }) {
  const organizationRoot = join(companiesRoot, organization.path);
  const output = [];
  let realOrganizationRoot = null;
  let scanResult = await scanTwoLevelWorktrees({
    companiesRoot,
    organization,
    organizationRoot,
    rootRealPath: realOrganizationRoot,
    base: join(organizationRoot, ".worktrees", "workspace"),
    workspace: "workspace",
    repoKind: "module",
    output,
  });
  realOrganizationRoot = scanResult.realOrganizationRoot;
  scanResult = await scanTwoLevelWorktrees({
    companiesRoot,
    organization,
    organizationRoot,
    rootRealPath: realOrganizationRoot,
    base: join(organizationRoot, ".worktrees", "productionspace"),
    workspace: "productionspace",
    repoKind: "productionspace",
    output,
  });
  realOrganizationRoot = scanResult.realOrganizationRoot;
  await scanRootWorktrees({
    companiesRoot,
    organization,
    organizationRoot,
    rootRealPath: realOrganizationRoot,
    base: join(organizationRoot, ".worktrees", "root"),
    output,
  });
  return output;
}

async function scanTwoLevelWorktrees({
  companiesRoot,
  organization,
  organizationRoot,
  rootRealPath,
  base,
  workspace,
  repoKind,
  output,
}) {
  const baseBoundary = await existingWorktreePathBoundary({
    organizationRoot,
    rootRealPath,
    path: base,
  });
  if (!baseBoundary.ok) return { realOrganizationRoot: baseBoundary.rootRealPath };
  for (const moduleEntry of await safeReaddir(base)) {
    if (!moduleEntry.isDirectory()) continue;
    const module = moduleEntry.name;
    const moduleRoot = join(base, module);
    const moduleBoundary = await existingWorktreePathBoundary({
      organizationRoot,
      rootRealPath: baseBoundary.rootRealPath,
      path: moduleRoot,
    });
    if (!moduleBoundary.ok) continue;
    for (const worktreeEntry of await safeReaddir(moduleRoot)) {
      if (!worktreeEntry.isDirectory()) continue;
      const absolutePath = join(moduleRoot, worktreeEntry.name);
      const worktreeBoundary = await existingWorktreePathBoundary({
        organizationRoot,
        rootRealPath: moduleBoundary.rootRealPath,
        path: absolutePath,
      });
      if (!worktreeBoundary.ok) continue;
      output.push(await buildWorktreeRecord({
        companiesRoot,
        organization,
        organizationRoot,
        rootRealPath: worktreeBoundary.rootRealPath,
        absolutePath,
        sidecarPath: join(moduleRoot, `${worktreeEntry.name}.worktree.json`),
        workspace,
        module,
        repoKind,
      }));
    }
  }
  return { realOrganizationRoot: baseBoundary.rootRealPath };
}

async function scanRootWorktrees({
  companiesRoot,
  organization,
  organizationRoot,
  rootRealPath,
  base,
  output,
}) {
  const baseBoundary = await existingWorktreePathBoundary({
    organizationRoot,
    rootRealPath,
    path: base,
  });
  if (!baseBoundary.ok) return { realOrganizationRoot: baseBoundary.rootRealPath };
  for (const entry of await safeReaddir(base)) {
    if (!entry.isDirectory()) continue;
    const path = join(base, entry.name);
    const pathBoundary = await existingWorktreePathBoundary({
      organizationRoot,
      rootRealPath: baseBoundary.rootRealPath,
      path,
    });
    if (!pathBoundary.ok) continue;
    if (await isGitCheckout(path)) {
      output.push(await buildWorktreeRecord({
        companiesRoot,
        organization,
        organizationRoot,
        rootRealPath: pathBoundary.rootRealPath,
        absolutePath: path,
        sidecarPath: join(base, `${entry.name}.worktree.json`),
        workspace: "root",
        module: "root",
        repoKind: "organization_root",
      }));
      continue;
    }
    for (const child of await safeReaddir(path)) {
      if (!child.isDirectory()) continue;
      const childPath = join(path, child.name);
      const childBoundary = await existingWorktreePathBoundary({
        organizationRoot,
        rootRealPath: pathBoundary.rootRealPath,
        path: childPath,
      });
      if (!childBoundary.ok) continue;
      output.push(await buildWorktreeRecord({
        companiesRoot,
        organization,
        organizationRoot,
        rootRealPath: childBoundary.rootRealPath,
        absolutePath: childPath,
        sidecarPath: join(path, `${child.name}.worktree.json`),
        workspace: "root",
        module: entry.name,
        repoKind: "root_repo",
      }));
    }
  }
  return { realOrganizationRoot: baseBoundary.rootRealPath };
}

async function buildWorktreeRecord({
  companiesRoot,
  organization,
  organizationRoot,
  rootRealPath,
  absolutePath,
  sidecarPath,
  workspace,
  module,
  repoKind,
}) {
  const slug = basename(absolutePath);
  const base = {
    slug,
    organization: organization.slug,
    organization_path: organization.path,
    workspace,
    module,
    repo_kind: repoKind,
    path: relative(companiesRoot, absolutePath).replace(/\\/g, "/"),
    sidecar_path: relative(companiesRoot, sidecarPath).replace(/\\/g, "/"),
    branch: null,
    plan_code: null,
    owner_plan: null,
  };

  if (!existsSync(sidecarPath)) {
    return {
      ...base,
      ownership_status: "orphan_missing_plan",
      status: "orphan_missing_plan",
      message: "Worktree nemá sidecar metadata s Mission Control vlastníkem.",
    };
  }
  const sidecarBoundary = await existingWorktreePathBoundary({
    organizationRoot,
    rootRealPath,
    path: sidecarPath,
  });
  if (!sidecarBoundary.ok) {
    return {
      ...base,
      ownership_status: "invalid",
      status: "invalid",
      message: "Worktree sidecar se přes symlink/junction dostává mimo root Organizace.",
    };
  }

  let metadata;
  try {
    metadata = JSON.parse(await readFile(sidecarPath, "utf8"));
  } catch (error) {
    return {
      ...base,
      ownership_status: "invalid",
      status: "invalid",
      message: `Sidecar metadata nejdou přečíst: ${error.message}`,
    };
  }

  const validationErrors = validateWorktreeMetadata(metadata);
  if (validationErrors.length > 0) {
    return {
      ...base,
      metadata,
      branch: metadata.branch ?? null,
      plan_code: metadata.mission_control_plan_code ?? metadata.plan_code ?? null,
      ownership_status: "orphan_missing_plan",
      status: "orphan_missing_plan",
      message: validationErrors.join("; "),
    };
  }

  const planPath = metadata.mission_control_plan_path;
  const ownerPlan = await readMissionControlPlanAt({ companiesRoot, organizationPath: organization.path, planPath });
  if (!ownerPlan) {
    return {
      ...base,
      metadata,
      branch: metadata.branch,
      plan_code: metadata.mission_control_plan_code,
      ownership_status: "orphan_missing_file",
      status: "orphan_missing_file",
      message: `Mission Control plán neexistuje: ${planPath}`,
    };
  }

  const lifecycleStatus = await deriveWorktreeLifecycleStatus({ absolutePath, metadata });
  return {
    ...base,
    metadata,
    branch: metadata.branch,
    plan_code: metadata.mission_control_plan_code,
    owner_plan: {
      code: ownerPlan.code,
      path: ownerPlan.organization_relative_path,
      title: ownerPlan.title,
      status: ownerPlan.status,
    },
    ownership_status: "owned",
    status: lifecycleStatus,
    message: `Owned by ${ownerPlan.code} — ${ownerPlan.title}`,
  };
}

async function existingWorktreePathBoundary({
  organizationRoot,
  rootRealPath,
  path,
}) {
  if (!existsSync(path)) {
    return { ok: false, rootRealPath };
  }
  return inspectCanonicalPathBoundary({
    rootPath: organizationRoot,
    rootRealPath,
    targetPath: path,
  });
}

// Kanonické enumy z schemas/worktree.schema.json (companiesascode.worktree.v1).
// Držené inline (stejně jako schema_version const níže), aby runtime scan
// nemusel načítat/parsovat JSON schema při každém indexu.
const CANONICAL_REPO_KINDS = new Set(["module", "organization_root", "root_repo", "productionspace"]);
const CANONICAL_STATUSES = new Set([
  "active",
  "draft",
  "published_branch",
  "pr_open",
  "merged_cleanup_needed",
  "stale",
  "orphan_missing_plan",
  "invalid",
]);

// Schema-shape warning (decision 0049 kanonický kontrakt): non-fatal signál, že
// sidecar používá nekanonická / legacy pole (např. plan_code místo
// mission_control_plan_code, repo_kind "root" mimo enum). Jen upozorní
// buildera/Doctor, ať sidecar sladí — NIKDY neblokuje ownership resolve
// (na to je fail-closed validateWorktreeMetadata níže).
export function detectNonCanonicalSidecarFields(metadata) {
  const warnings = [];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return warnings;
  if (metadata.plan_code && !metadata.mission_control_plan_code) {
    warnings.push("Nekanonické pole plan_code — kanonický klíč je mission_control_plan_code.");
  }
  if (metadata.owner && !metadata.created_by) {
    warnings.push("Nekanonické pole owner bez created_by — kanonický autor je created_by.");
  }
  if (metadata.repo_kind && !CANONICAL_REPO_KINDS.has(metadata.repo_kind)) {
    warnings.push(`repo_kind "${metadata.repo_kind}" není v kanonickém enumu (${[...CANONICAL_REPO_KINDS].join(", ")}).`);
  }
  if (metadata.status && !CANONICAL_STATUSES.has(metadata.status)) {
    warnings.push(`status "${metadata.status}" není v kanonickém enumu (${[...CANONICAL_STATUSES].join(", ")}).`);
  }
  if (!metadata.conversation_origin) {
    warnings.push("Sidecar nemá conversation_origin; doplň lokální agent surface a thread locator při nejbližším bezpečném dotyku.");
  } else if (
    typeof metadata.conversation_origin.surface !== "string"
    || typeof metadata.conversation_origin.agent_label !== "string"
    || !["captured", "unavailable", "not_applicable"].includes(metadata.conversation_origin.thread_locator_status)
    || metadata.conversation_origin.local_only !== true
  ) {
    warnings.push("conversation_origin nemá kanonický tvar.");
  }
  if (!metadata.recovery_handoff) {
    warnings.push("Sidecar nemá recovery_handoff; doplň stav, summary, blocker a next action před pauzou nebo předáním.");
  } else if (
    typeof metadata.recovery_handoff.state !== "string"
    || typeof metadata.recovery_handoff.summary !== "string"
    || typeof metadata.recovery_handoff.next_action !== "string"
  ) {
    warnings.push("recovery_handoff nemá kanonický tvar.");
  }
  return warnings;
}

// Runtime záměrně validuje jen minimum kanonického kontraktu (schema_version,
// branch, mission_control_plan_code, mission_control_plan_path), NE celý JSON
// schema z schemas/worktree.schema.json. Důvod: (1) tolerance vůči starším /
// ručně psaným sidecarům, které ještě nemají všechna kanonická pole — nechceme
// je celé shodit z indexu jen kvůli chybějícímu module_path/base_branch;
// (2) tato čtveřice je přesně to, co drží fail-closed ownership resolve
// (bez branch + plan code/path nejde bezpečně dohledat vlastnický Mission
// Control plán, takže bez nich je worktree orphan a runtime se z něj nespustí).
// Úplnou schema-shape kontrolu dělá schema (writer path createWorktreeFromPlan +
// test) a non-fatal detectNonCanonicalSidecarFields() výše; kontrakt (enumy,
// nové statusy) se mění jen přes decision, ne tichým zpřísněním tady.
function validateWorktreeMetadata(metadata) {
  const errors = [];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return ["Sidecar metadata musí být object."];
  }
  if (metadata.schema_version !== "companiesascode.worktree.v1") errors.push("schema_version musí být companiesascode.worktree.v1");
  if (typeof metadata.branch !== "string" || metadata.branch.trim() === "") errors.push("branch chybí");
  if (typeof metadata.mission_control_plan_code !== "string" || metadata.mission_control_plan_code.trim() === "") {
    errors.push("mission_control_plan_code chybí");
  }
  if (typeof metadata.mission_control_plan_path !== "string" || metadata.mission_control_plan_path.trim() === "") {
    errors.push("mission_control_plan_path chybí");
  }
  return errors;
}

async function deriveWorktreeLifecycleStatus({ absolutePath, metadata }) {
  const explicitStatus = metadata.status ?? "active";
  if (explicitStatus && explicitStatus !== "active") return explicitStatus;
  const touched = Date.parse(metadata.last_touched ?? metadata.created_at ?? "");
  if (!Number.isFinite(touched) || Date.now() - touched <= 7 * 24 * 60 * 60 * 1000 || metadata.pr_url) {
    return explicitStatus || "active";
  }
  const gitStatus = await readGitRepoStatus({
    key: metadata.worktree_path ?? absolutePath,
    absolute_path: absolutePath,
    expected_branch: metadata.branch,
  });
  if (gitStatus.counts?.changed_files > 0 || gitStatus.counts?.outgoing > 0) return explicitStatus || "active";
  return "stale";
}

async function isGitCheckout(path) {
  return existsSync(join(path, ".git"));
}

async function safeReaddir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function uniqueOrganizations(repos) {
  const bySlug = new Map();
  for (const repo of repos) {
    if (!bySlug.has(repo.organization)) bySlug.set(repo.organization, { slug: repo.organization, path: repo.organization_path });
  }
  return [...bySlug.values()];
}
