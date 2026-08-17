import { existsSync } from "fs";
import { basename } from "path";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import { materializeRepoCheckout } from "./git-materialization-lib.mjs";
import { mapWithConcurrency } from "./git-lib.mjs";
import { buildMissionControlPlanIndex } from "./mission-control-plan-lib.mjs";
import {
  GIT_REMOTE_REFRESH_CONCURRENCY,
  abortRepoRebase,
  pullRepoFastForward,
  pullRepoWithAutostash,
  readGitRepoStatus,
  readGitRepoStatuses,
  readRepoChanges,
} from "./git-status-lib.mjs";
import { buildWorktreeIndex } from "./worktree-lib.mjs";
import { organizationSlotProjectsToLocalMachine } from "./organization-slot-scope-lib.mjs";

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

export async function buildRepoPullResponse({ companiesRoot, repoKey, statusService = null } = {}) {
  const inventory = await buildGitInventory({ companiesRoot });
  const repo = inventory.repos.find((item) => item.key === repoKey);
  if (!repo) throw new GitApiError(`Repo ${repoKey} nebylo nalezeno.`, { status: 404, code: "repo_not_found" });
  assertBuilderPullScope(repo);
  // Chybějící target poznáme z levného lokálního guardu. U existujícího
  // checkoutu necháme pullRepoFastForward zachovat jeho pořadí kontrol:
  // dirty/wrong-branch vysvětlí ještě před případným nedostupným remotem.
  const localStatus = await readGitRepoStatus(repo);
  if (localStatus.status === "repo_missing") {
    const materialization = await materializeRepoCheckout({ companiesRoot, repo });
    if (!materialization.ok) {
      throw new GitApiError(materialization.message, {
        status: materialization.outcome === "missing_access" ? 403 : 409,
        code: materialization.code,
      });
    }
    statusService?.markRemoteChecked(repo);
    return {
      schema_version: "companiesascode.launchpad.git_pull.v1",
      generated_at: new Date().toISOString(),
      repo_key: repoKey,
      action: "materialize_clone",
      pulled: false,
      materialized: true,
      branch: materialization.branch,
      head: materialization.head,
    };
  }
  const result = await pullRepoFastForward(repo);
  if (!result.ok) {
    throw new GitApiError(result.message, {
      status: 409,
      code: result.code,
      metadata: pullRecoveryMetadata(repoKey, result),
    });
  }
  statusService?.markRemoteChecked(repo);
  return {
    schema_version: "companiesascode.launchpad.git_pull.v1",
    generated_at: new Date().toISOString(),
    repo_key: repoKey,
    action: "pull_ff_only",
    pulled: true,
    before: result.before,
    after: result.after,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function buildRepoAutostashPullResponse({ companiesRoot, repoKey, statusService = null } = {}) {
  const inventory = await buildGitInventory({ companiesRoot });
  const repo = inventory.repos.find((item) => item.key === repoKey);
  if (!repo) throw new GitApiError(`Repo ${repoKey} nebylo nalezeno.`, { status: 404, code: "repo_not_found" });
  assertBuilderPullScope(repo);
  const result = await pullRepoWithAutostash(repo);
  if (result.pulled) statusService?.markRemoteChecked(repo);
  if (!result.ok) {
    throw new GitApiError(result.message, {
      status: 409,
      code: result.code,
      metadata: pullRecoveryMetadata(repoKey, result),
    });
  }
  statusService?.markRemoteChecked(repo);
  return {
    schema_version: "companiesascode.launchpad.git_pull.v1",
    generated_at: new Date().toISOString(),
    repo_key: repoKey,
    action: "pull_ff_only_with_autostash",
    pulled: true,
    autostash: true,
    stash_preserved: result.stash_preserved,
    before: result.before,
    after: result.after,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function buildRepoRebaseAbortResponse({ companiesRoot, repoKey, statusService = null } = {}) {
  const inventory = await buildGitInventory({ companiesRoot });
  const repo = inventory.repos.find((item) => item.key === repoKey);
  if (!repo) throw new GitApiError(`Repo ${repoKey} nebylo nalezeno.`, { status: 404, code: "repo_not_found" });
  assertBuilderPullScope(repo);
  const result = await abortRepoRebase(repo);
  statusService?.invalidate(repo);
  if (!result.ok) {
    throw new GitApiError(result.message, {
      status: 409,
      code: result.code,
      metadata: pullRecoveryMetadata(repoKey, result),
    });
  }
  return {
    schema_version: "companiesascode.launchpad.git_rebase_abort.v1",
    generated_at: new Date().toISOString(),
    repo_key: repoKey,
    action: "rebase_abort",
    aborted: true,
    before: result.before,
    after: result.after,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function pullRecoveryMetadata(repoKey, result) {
  const status = result?.after ?? result?.before ?? null;
  const canAbortRebase =
    status?.operation?.kind === "rebase"
    && status?.operation?.can_abort_rebase === true;
  return {
    repo_key: repoKey,
    recovery: {
      operation: canAbortRebase ? "rebase" : null,
      can_abort_rebase: canAbortRebase,
    },
  };
}

export async function buildPullAllResponse({ companiesRoot, organization = null, statusService = null } = {}) {
  // Dvě fáze jsou podstata manifest-driven syncu: nejdřív stáhneme root
  // Organizace, potom inventář sestavíme znovu z právě aktualizovaného
  // modules.manifest.json. Jinak by nově přidaný modul vyžadoval druhé kliknutí.
  // Launchpad může akci omezit na právě otevřenou Organizaci; CLI bez filtru
  // dál zachovává globální synchronizační kontrakt.
  const inScope = (repo) => !organization || repo.organization === organization;
  const initialInventory = await buildGitInventory({ companiesRoot });
  const rootResults = await mapWithConcurrency(
    initialInventory.repos.filter((repo) => repo.repo_kind === "organization_root" && inScope(repo)),
    GIT_REMOTE_REFRESH_CONCURRENCY,
    (repo) => pullAllRepo({ companiesRoot, repo, statusService }),
  );
  const refreshedInventory = await buildGitInventory({ companiesRoot });
  const nestedResults = await mapWithConcurrency(
    refreshedInventory.repos.filter((repo) => repo.repo_kind !== "organization_root" && inScope(repo)),
    GIT_REMOTE_REFRESH_CONCURRENCY,
    (repo) => pullAllRepo({ companiesRoot, repo, statusService }),
  );
  const reposByKey = new Map(
    [...initialInventory.repos, ...refreshedInventory.repos].map((repo) => [repo.key, repo]),
  );
  const results = [...rootResults, ...nestedResults].filter((result) => {
    const repo = reposByKey.get(result.repo_key);
    return !repo || repoProjectsToLocalMachine(repo);
  });

  const count = (outcome) => results.filter((result) => result.outcome === outcome).length;
  return {
    schema_version: "companiesascode.launchpad.git_pull_all.v1",
    generated_at: new Date().toISOString(),
    organization,
    summary: {
      repo_count: results.length,
      updated_count: count("pulled") + count("autostash_pulled"),
      materialized_count: count("materialized"),
      missing_access_count: count("missing_access"),
      autostash_count: count("autostash_pulled"),
      up_to_date_count: count("up_to_date"),
      skipped_count: count("skipped") + count("policy_skipped") + count("missing_access"),
      conflict_count: count("conflict"),
      failed_count: count("failed"),
    },
    results,
  };
}

async function pullAllRepo({ companiesRoot, repo, statusService }) {
  const identity = {
    repo_key: repo.key,
    organization: repo.organization,
    module: repo.module,
    repo_kind: repo.repo_kind,
  };
  if (!builderPullScopeAllowed(repo)) {
    return {
      ...identity,
      outcome: "policy_skipped",
      message: "Productionspace zůstává podle Organization policy read-only.",
    };
  }

  const preflight = await readGitRepoStatus(repo, { refresh: true });
  if (preflight.status === "repo_missing" && repo.repo_kind !== "organization_root") {
    const materialization = await materializeRepoCheckout({ companiesRoot, repo });
    if (materialization.ok) {
      statusService?.markRemoteChecked(repo);
      return {
        ...identity,
        outcome: "materialized",
        message: materialization.message,
        branch: materialization.branch,
        head: materialization.head,
      };
    }
    return {
      ...identity,
      outcome: materialization.outcome === "missing_access"
        ? "missing_access"
        : materialization.outcome === "target_exists"
          ? "skipped"
          : "failed",
      message: materialization.message,
    };
  }
  if (
    !["repo_missing", "git_unavailable", "check_failed", "rebase_in_progress", "git_am_in_progress"]
      .includes(preflight.status)
  ) {
    statusService?.markRemoteChecked(repo);
  }
  if (preflight.status === "up_to_date") {
    return { ...identity, outcome: "up_to_date", message: "Repo už je aktuální.", before: compactPullStatus(preflight) };
  }

  let result;
  if (preflight.status === "pull_available") {
    result = await pullRepoFastForward(repo);
  } else if (
    preflight.status === "draft_changes"
    && preflight.counts.incoming > 0
    && preflight.counts.outgoing === 0
  ) {
    result = await pullRepoWithAutostash(repo);
  } else {
    return {
      ...identity,
      outcome: preflight.status === "check_failed" ? "failed" : "skipped",
      message: pullAllSkipMessage(preflight),
      before: compactPullStatus(preflight),
    };
  }

  if (result.pulled) statusService?.markRemoteChecked(repo);
  if (!result.ok) {
    return {
      ...identity,
      outcome: result.code === "autostash_conflict" ? "conflict" : "failed",
      message: result.message,
      before: compactPullStatus(result.before),
      after: compactPullStatus(result.after),
      stash_preserved: Boolean(result.stash_preserved),
    };
  }
  statusService?.markRemoteChecked(repo);
  return {
    ...identity,
    outcome: result.autostash ? "autostash_pulled" : "pulled",
    message: result.autostash
      ? "Nová verze stažená a lokální změny obnovené."
      : "Nová verze stažená fast-forwardem.",
    before: compactPullStatus(result.before),
    after: compactPullStatus(result.after),
    stash_preserved: Boolean(result.stash_preserved),
  };
}

function assertBuilderPullScope(repo) {
  if (builderPullScopeAllowed(repo)) return;
  throw new GitApiError(
    "Stáhnout novější verzi z Launchpadu je povolené pro Organization root, org root-space sloty a workspace moduly; productionspace zůstává read-only.",
    { status: 403, code: "pull_scope_forbidden" },
  );
}

// Jediná autorita builder pull scope — UI kind guard i CLI update lane ji
// zrcadlí. Org root-space sloty (`space: "root"`, např. mission-control a
// jeho repository-db child) jsou doctor-managed pinned checkouty a ff-only
// inbound pull je pro ně bezpečný a žádoucí (runtime freshness);
// productionspace zůstává z Launchpadu read-only.
export function builderPullScopeAllowed(repo) {
  return repo.repo_kind === "organization_root"
    || repo.repo_kind === "root_repo"
    || (repo.repo_kind === "module" && repo.workspace !== "productionspace");
}

function pullAllSkipMessage(status) {
  if (status.status === "rebase_in_progress") return "Repo má rozpracovaný rebase; abortni ho nebo předej screenshot Agentovi.";
  if (status.status === "git_am_in_progress") return "Repo má rozpracované git am; předej screenshot Agentovi.";
  if (status.status === "wrong_branch") return "Repo není na očekávané branchi.";
  if (status.status === "push_required") return "Repo má lokální commity k odeslání.";
  if (status.status === "diverged") return "Lokální a vzdálená branch divergovaly.";
  if (status.status === "draft_changes") return "Lokální změny teď nejdou bezpečně zkombinovat s pull flow.";
  if (status.status === "repo_missing") return "Lokální checkout chybí.";
  if (status.status === "git_unavailable") return "Git není dostupný.";
  if (status.status === "check_failed") return "Git nebo vzdálenou verzi se nepodařilo spolehlivě ověřit.";
  return status.message || "Repo se nepodařilo bezpečně aktualizovat.";
}

function compactPullStatus(status) {
  if (!status) return null;
  return {
    status: status.status,
    severity: status.severity,
    branch: status.branch,
    expected_branch: status.expected_branch,
    head: status.head,
    operation: status.operation ?? null,
    counts: status.counts,
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
  const planIndex = await buildMissionControlPlanIndex({ companiesRoot, organization, module });
  if (!module) return planIndex;

  const inventory = await buildGitInventory({ companiesRoot });
  const projection = projectGitInventory(inventory, { organization, module });
  const visibleOrganizations = new Set(
    [...projection.repos, ...projection.planned].map((record) => record.organization),
  );
  return {
    ...planIndex,
    plans: planIndex.plans.filter((plan) => visibleOrganizations.has(plan.organization)),
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
  if (worktree.repo_kind === "organization_root") {
    return organizationRepos.find((repo) => repo.repo_kind === "organization_root") ?? null;
  }

  const expectedRepoKind = worktree.repo_kind === "productionspace" ? "productionspace" : worktree.repo_kind;
  const candidates = organizationRepos.filter((repo) => {
    if (repo.repo_kind !== expectedRepoKind) return false;
    // `repo.workspace` is a logical Team classification for workspace
    // modules and null for root slots. `worktree.workspace` is the physical
    // canonical lane (workspace/root/productionspace), so it is not an
    // identity field and must not participate in this join.
    return repo.module === worktree.module
      || (typeof repo.slot_path === "string" && basename(repo.slot_path) === worktree.module);
  });
  const metadataModule = worktree.metadata?.module;
  if (typeof metadataModule === "string" && metadataModule !== "") {
    const declaredMatches = candidates.filter((repo) => repo.module === metadataModule);
    return declaredMatches.length === 1 ? declaredMatches[0] : null;
  }
  // A basename fallback is legacy compatibility only. Resolve it against the
  // complete inventory and fail closed when two declared boundaries could own
  // the same physical worktree directory.
  return candidates.length === 1 ? candidates[0] : null;
}
