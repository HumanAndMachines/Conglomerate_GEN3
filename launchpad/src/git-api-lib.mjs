import { existsSync } from "fs";
import { basename } from "path";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import { buildMissionControlPlanIndex } from "./mission-control-plan-lib.mjs";
import {
  readGitRepoStatuses,
  readRepoChanges,
} from "./git-status-lib.mjs";
import { buildWorktreeIndex } from "./worktree-lib.mjs";
import { organizationSlotProjectsToLocalMachine } from "../../lazurio/core/organization-slot-scope-lib.mjs";

export class GitApiError extends Error {
  constructor(message, { status = 500, code = "git_api_error", metadata = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.metadata = metadata;
  }
}

export async function buildGitApiResponse({
  companiesRoot,
  refresh = false,
  organization = null,
  statusService = null,
  allowRemoteRefresh = true,
} = {}) {
  const inventory = await buildGitInventory({ companiesRoot });
  const projection = projectGitInventory(inventory, { organization });
  const [statuses, rawWorktreeIndex] = await Promise.all([
    statusService
      ? statusService.readStatuses(projection.repos, { refresh, allowRemoteRefresh })
      : readGitRepoStatuses(projection.repos, { refresh }),
    buildWorktreeIndex({ companiesRoot, organization }),
  ]);
  const worktreeIndex = projectPublicWorktreeIndex({
    worktreeIndex: rawWorktreeIndex,
    inventoryRecords: projection.records,
    projectedRepos: projection.repos,
    hiddenPaths: projection.hiddenPaths,
  });
  const statusByKey = new Map(statuses.map((status) => [status.key, status]));
  const worktreesByRepo = groupWorktreesByRepo(worktreeIndex.worktrees, projection.repos);
  const repos = projection.repos.map((repo) => {
    const worktrees = worktreesByRepo.get(repo.key) ?? [];
    const status = statusByKey.get(repo.key);
    return publicRepo({ repo, status, worktrees });
  });

  return {
    schema_version: "companiesascode.launchpad.git.v1",
    generated_at: new Date().toISOString(),
    summary: {
      repo_count: repos.length,
      attention_count: repos.filter((repo) => repo.severity !== "ok").length,
      worktree_count: worktreeIndex.worktrees.length,
      stale_worktree_count: worktreeIndex.worktrees.filter((worktree) => worktree.status === "stale").length,
      invalid_worktree_location_count: worktreeIndex.invalid_locations.length,
    },
    repos,
    worktrees: worktreeIndex.worktrees,
    invalid_worktree_locations: worktreeIndex.invalid_locations,
    planned: projection.planned,
    warnings: [
      ...projectGitDiagnosticMessages(inventory.warnings, projection.hiddenPaths),
      ...worktreeIndex.warnings,
    ],
  };
}

export async function buildRepoResponse({ companiesRoot, repoKey, refresh = false, statusService = null } = {}) {
  const response = await buildGitApiResponse({ companiesRoot, refresh, statusService });
  const repo = response.repos.find((item) => item.key === repoKey);
  if (!repo) throw new GitApiError(`Repo ${repoKey} nebylo nalezeno.`, { status: 404, code: "repo_not_found" });
  return {
    schema_version: "companiesascode.launchpad.git_repo.v1",
    generated_at: response.generated_at,
    repo,
  };
}

export async function buildRepoChangesResponse({ companiesRoot, repoKey } = {}) {
  const inventory = await buildGitInventory({ companiesRoot });
  const repo = projectGitInventory(inventory).repos.find((item) => item.key === repoKey);
  if (!repo) throw new GitApiError(`Repo ${repoKey} nebylo nalezeno.`, { status: 404, code: "repo_not_found" });
  const { status, changes } = await readRepoChanges(repo);
  return {
    schema_version: "companiesascode.launchpad.git_changes.v1",
    generated_at: new Date().toISOString(),
    repo_key: repoKey,
    repo: {
      key: repo.key,
      organization: repo.organization,
      module: repo.module,
      repo_path: repo.repo_path,
      status: status.status,
      severity: status.severity,
    },
    changes,
  };
}

export async function buildWorktreesResponse({ companiesRoot, organization = null, module = null } = {}) {
  const inventory = await buildGitInventory({ companiesRoot });
  const projection = projectGitInventory(inventory, { organization, module });
  const worktreeIndex = await buildWorktreeIndex({ companiesRoot, organization, module });
  return projectPublicWorktreeIndex({
    worktreeIndex,
    inventoryRecords: projection.records,
    projectedRepos: projection.repos,
    hiddenPaths: projection.hiddenPaths,
    module,
  });
}

export async function buildPlansResponse({ companiesRoot, organization = null, module = null } = {}) {
  const inventory = await buildGitInventory({ companiesRoot });
  const records = [...inventory.repos, ...inventory.planned]
    .filter((record) => !organization || record.organization === organization);
  const selectedRecord = module ? resolveInventoryModuleRecord(records, module) : null;
  if (module && (!selectedRecord || !repoProjectsToLocalMachine(selectedRecord))) {
    return emptyMissionControlPlanIndex();
  }

  const planIndex = await buildMissionControlPlanIndex({ companiesRoot, organization });
  const projectedPlans = planIndex.plans.filter((plan) => {
    const planRecords = resolvePlanInventoryRecords(
      plan,
      records.filter((record) => record.organization === plan.organization),
    );
    if (planRecords.length === 0 || planRecords.some((record) => !repoProjectsToLocalMachine(record))) {
      return false;
    }
    return !selectedRecord || planRecords.some((record) => record.key === selectedRecord.key);
  });
  return {
    ...planIndex,
    plans: selectedRecord
      ? projectedPlans.map((plan) => ({ ...plan, module_match: "direct" }))
      : projectedPlans,
  };
}

export function compactGitSummaryForApp(repo) {
  if (!repo) return null;
  return {
    repo_key: repo.key,
    status: repo.status,
    severity: repo.severity,
    title: repo.title,
    message: repo.message,
    recommendedAction: repo.recommended_action,
    operation: repo.operation ?? null,
    incomingCommitCount: repo.counts.incoming,
    outgoingCommitCount: repo.counts.outgoing,
    changedFiles: repo.counts.changed_files,
    freshness: repo.freshness ?? null,
    activeWorktreeCount: repo.worktrees.length,
    staleWorktreeCount: repo.worktree_details.filter((worktree) => worktree.status === "stale").length,
    missionControlOwnership: compactMissionControlOwnership(repo.mission_control_ownership),
    worktrees: repo.worktree_details.map(compactWorktreeSummary),
  };
}

function compactMissionControlOwnership(ownership = {}) {
  return {
    required: Boolean(ownership.required),
    ownerPlanCode: ownership.owner_plan_code ?? null,
    ownerPlanPath: ownership.owner_plan_path ?? null,
    ownerPlanTitle: ownership.owner_plan_title ?? null,
    orphan: Boolean(ownership.orphan),
  };
}

function compactWorktreeSummary(worktree) {
  return {
    slug: worktree.slug,
    branch: worktree.branch,
    status: worktree.status,
    path: worktree.path,
    ownershipStatus: worktree.ownership_status,
    message: worktree.message,
    ownerPlan: worktree.owner_plan
      ? {
          code: worktree.owner_plan.code,
          path: worktree.owner_plan.path,
          title: worktree.owner_plan.title,
          status: worktree.owner_plan.status,
        }
      : null,
  };
}

function repoProjectsToLocalMachine(repo) {
  return organizationSlotProjectsToLocalMachine(repo, {
    materialized: typeof repo?.absolute_path === "string" && existsSync(repo.absolute_path),
  });
}

function projectGitInventory(inventory, { organization = null, module = null } = {}) {
  const inScope = (record) =>
    (!organization || record.organization === organization)
    && (!module || inventoryRecordMatchesModule(record, module));
  const reposInScope = inventory.repos.filter(inScope);
  const plannedInScope = inventory.planned.filter(inScope);
  const repos = reposInScope.filter(repoProjectsToLocalMachine);
  const planned = plannedInScope.filter(repoProjectsToLocalMachine);
  const hiddenPaths = [...reposInScope, ...plannedInScope]
    .filter((record) => !repoProjectsToLocalMachine(record))
    .flatMap((record) => [record.slot_path, record.repo_path])
    .filter((path) => typeof path === "string" && path !== "");
  return { repos, planned, records: [...reposInScope, ...plannedInScope], hiddenPaths };
}

function inventoryRecordMatchesModule(record, module) {
  if (record.module === module) return true;
  return typeof record.slot_path === "string" && basename(record.slot_path) === module;
}

function resolveInventoryModuleRecord(records, module) {
  const exactMatches = records.filter((record) => record.module === module);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) return null;

  const pathMatches = records.filter((record) =>
    typeof record.slot_path === "string" && basename(record.slot_path) === module,
  );
  return pathMatches.length === 1 ? pathMatches[0] : null;
}

function resolvePlanInventoryRecords(plan, records) {
  const resolved = new Map();
  for (const path of Array.isArray(plan.linked_paths) ? plan.linked_paths : []) {
    const exactMatches = records
      .filter((record) => typeof record.slot_path === "string" && planPathBelongsToSlot(path, record.slot_path))
      .sort((left, right) => right.slot_path.length - left.slot_path.length);
    if (exactMatches.length > 0) {
      const longest = exactMatches.filter((record) => record.slot_path.length === exactMatches[0].slot_path.length);
      if (longest.length === 1) resolved.set(longest[0].key, longest[0]);
      continue;
    }

    const [space, physicalName] = path.split("/");
    if (!physicalName || (space !== "modules" && space !== "workspace")) continue;
    const legacyMatches = records.filter((record) =>
      typeof record.slot_path === "string" && basename(record.slot_path) === physicalName,
    );
    if (legacyMatches.length === 1) resolved.set(legacyMatches[0].key, legacyMatches[0]);
  }
  return [...resolved.values()];
}

function planPathBelongsToSlot(path, slotPath) {
  return path === slotPath || path.startsWith(`${slotPath}/`);
}

function emptyMissionControlPlanIndex() {
  return {
    schema_version: "companiesascode.launchpad.mission_control_plans.v1",
    generated_at: new Date().toISOString(),
    plans: [],
  };
}

function projectPublicWorktreeIndex({
  worktreeIndex,
  inventoryRecords,
  projectedRepos,
  hiddenPaths,
  module = null,
}) {
  const projectedRepoKeys = new Set(projectedRepos.map((repo) => repo.key));
  const worktrees = worktreeIndex.worktrees.filter((worktree) =>
    projectedRepoKeys.has(findRepoForWorktree(worktree, inventoryRecords)?.key),
  );
  const visibleSidecars = new Set(worktrees.map((worktree) => worktree.sidecar_path));
  const warnings = (worktreeIndex.warnings ?? []).filter((warning) => {
    if (warning && typeof warning === "object" && typeof warning.path === "string") {
      return visibleSidecars.has(warning.path);
    }
    return projectGitDiagnosticMessages([warning], hiddenPaths).length > 0;
  });
  return {
    ...worktreeIndex,
    worktrees,
    // Invalid legacy bases belong to the Organization, not to a module. A
    // module-scoped public response therefore must not attach them to a
    // predictable protected module query.
    invalid_locations: module ? [] : projectGitDiagnosticMessages(worktreeIndex.invalid_locations, hiddenPaths),
    warnings,
  };
}

function projectGitDiagnosticMessages(messages = [], hiddenPaths = []) {
  return (messages ?? []).filter((message) =>
    !hiddenPaths.some((path) => gitDiagnosticSearchText(message).includes(path)),
  );
}

function gitDiagnosticSearchText(message) {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return String(message ?? "");
  return [
    message.organization,
    message.slug,
    message.path,
    message.repo_path,
    message.message,
  ].filter((value) => typeof value === "string").join(" ");
}

function publicRepo({ repo, status, worktrees }) {
  const ownedWorktrees = worktrees.filter((worktree) => worktree.ownership_status === "owned");
  const orphan = worktrees.some((worktree) => worktree.ownership_status !== "owned");
  const ownerPlan = ownedWorktrees[0]?.owner_plan ?? null;
  return {
    key: repo.key,
    organization: repo.organization,
    organization_display_name: repo.organization_display_name,
    organization_path: repo.organization_path,
    workspace: repo.workspace,
    module: repo.module,
    name: repo.name,
    repo_kind: repo.repo_kind,
    repo_path: repo.repo_path,
    expected_branch: repo.expected_branch,
    branch: status.branch,
    head: status.head,
    remote: repo.remote,
    upstream: status.upstream,
    operation: status.operation ?? null,
    counts: status.counts,
    status: status.status,
    severity: status.severity,
    title: status.title,
    message: status.message,
    recommended_action: status.recommended_action,
    freshness: status.freshness ?? null,
    worktrees: worktrees.map((worktree) => worktree.slug),
    worktree_details: worktrees,
    mission_control_ownership: {
      required: worktrees.length > 0,
      owner_plan_code: ownerPlan?.code ?? null,
      owner_plan_path: ownerPlan?.path ?? null,
      owner_plan_title: ownerPlan?.title ?? null,
      orphan,
    },
  };
}

function groupWorktreesByRepo(worktrees, repos) {
  const byRepo = new Map();
  for (const worktree of worktrees) {
    const repo = findRepoForWorktree(worktree, repos);
    if (!repo) continue;
    const key = repo.key;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(worktree);
  }
  return byRepo;
}

function findRepoForWorktree(worktree, repos) {
  const organizationRepos = repos.filter((repo) => repo.organization === worktree.organization);
  const metadataRepoKind = worktree.metadata?.repo_kind;
  if (
    typeof metadataRepoKind === "string"
    && metadataRepoKind !== ""
    && metadataRepoKind !== worktree.repo_kind
  ) {
    return null;
  }
  if (worktree.repo_kind === "organization_root") {
    return organizationRepos.find((repo) => repo.repo_kind === "organization_root") ?? null;
  }

  const expectedRepoKind = worktree.repo_kind === "productionspace" ? "productionspace" : worktree.repo_kind;
  const candidates = organizationRepos.filter((repo) => {
    if (repo.repo_kind !== expectedRepoKind) return false;
    // Worktree.module comes from the physical canonical directory. Stable
    // declaration IDs may differ, so they are checked separately below.
    return typeof repo.slot_path === "string" && basename(repo.slot_path) === worktree.module;
  });
  const metadataModule = worktree.metadata?.module;
  const metadataModulePath = worktree.metadata?.module_path;
  if (typeof metadataModulePath === "string" && metadataModulePath !== "") {
    const pathMatches = candidates.filter((repo) => repo.slot_path === metadataModulePath);
    if (pathMatches.length !== 1) return null;
    const pathMatch = pathMatches[0];
    if (
      typeof metadataModule === "string"
      && metadataModule !== ""
      && pathMatch.module !== metadataModule
    ) {
      return null;
    }
    return pathMatch;
  }
  if (typeof metadataModule === "string" && metadataModule !== "") {
    const declaredMatches = candidates.filter((repo) => repo.module === metadataModule);
    return declaredMatches.length === 1 ? declaredMatches[0] : null;
  }
  // A basename fallback is legacy compatibility only. Resolve it against the
  // complete inventory and fail closed when two declared boundaries could own
  // the same physical worktree directory.
  return candidates.length === 1 ? candidates[0] : null;
}
