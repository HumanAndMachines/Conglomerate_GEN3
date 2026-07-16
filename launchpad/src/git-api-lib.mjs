import { buildGitInventory } from "./git-inventory-lib.mjs";
import { mapWithConcurrency } from "./git-lib.mjs";
import { buildMissionControlPlanIndex } from "./mission-control-plan-lib.mjs";
import {
  GIT_REMOTE_REFRESH_CONCURRENCY,
  pullRepoFastForward,
  pullRepoWithAutostash,
  readGitRepoStatus,
  readGitRepoStatuses,
  readRepoChanges,
} from "./git-status-lib.mjs";
import { buildWorktreeIndex } from "./worktree-lib.mjs";

export class GitApiError extends Error {
  constructor(message, { status = 500, code = "git_api_error" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
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
  const inventoryRepos = organization
    ? inventory.repos.filter((repo) => repo.organization === organization)
    : inventory.repos;
  const [statuses, worktreeIndex] = await Promise.all([
    statusService
      ? statusService.readStatuses(inventoryRepos, { refresh, allowRemoteRefresh })
      : readGitRepoStatuses(inventoryRepos, { refresh }),
    buildWorktreeIndex({ companiesRoot, organization }),
  ]);
  const statusByKey = new Map(statuses.map((status) => [status.key, status]));
  const worktreesByRepo = groupWorktreesByRepo(worktreeIndex.worktrees);
  const repos = inventoryRepos.map((repo) => {
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
    planned: inventory.planned,
    warnings: [...inventory.warnings, ...worktreeIndex.warnings],
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
  const repo = inventory.repos.find((item) => item.key === repoKey);
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
  const result = await pullRepoFastForward(repo);
  if (!result.ok) {
    throw new GitApiError(result.message, { status: 409, code: result.code });
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
    throw new GitApiError(result.message, { status: 409, code: result.code });
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

export async function buildPullAllResponse({ companiesRoot, statusService = null } = {}) {
  const inventory = await buildGitInventory({ companiesRoot });
  const results = await mapWithConcurrency(
    inventory.repos,
    GIT_REMOTE_REFRESH_CONCURRENCY,
    async (repo) => {
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
      if (!["repo_missing", "git_unavailable", "check_failed"].includes(preflight.status)) {
        statusService?.markRemoteChecked(repo);
      }
      if (preflight.status === "up_to_date") {
        return { ...identity, outcome: "up_to_date", message: "Repo už je aktuální.", before: compactPullStatus(preflight) };
      }

      let result;
      if (preflight.status === "pull_available") {
        result = await pullRepoFastForward(repo, { preflight });
      } else if (
        preflight.status === "draft_changes"
        && preflight.counts.incoming > 0
        && preflight.counts.outgoing === 0
      ) {
        result = await pullRepoWithAutostash(repo, { preflight });
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
    },
  );

  const count = (outcome) => results.filter((result) => result.outcome === outcome).length;
  return {
    schema_version: "companiesascode.launchpad.git_pull_all.v1",
    generated_at: new Date().toISOString(),
    summary: {
      repo_count: results.length,
      updated_count: count("pulled") + count("autostash_pulled"),
      autostash_count: count("autostash_pulled"),
      up_to_date_count: count("up_to_date"),
      skipped_count: count("skipped") + count("policy_skipped"),
      conflict_count: count("conflict"),
      failed_count: count("failed"),
    },
    results,
  };
}

function assertBuilderPullScope(repo) {
  if (builderPullScopeAllowed(repo)) return;
  throw new GitApiError(
    "Stáhnout novější verzi z Launchpadu je povolené pro Organization root a workspace moduly; productionspace zůstává read-only.",
    { status: 403, code: "pull_scope_forbidden" },
  );
}

function builderPullScopeAllowed(repo) {
  return repo.repo_kind === "organization_root"
    || (repo.repo_kind === "module" && repo.workspace !== "productionspace");
}

function pullAllSkipMessage(status) {
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
    counts: status.counts,
  };
}

export async function buildWorktreesResponse({ companiesRoot, organization = null, module = null } = {}) {
  return buildWorktreeIndex({ companiesRoot, organization, module });
}

export async function buildPlansResponse({ companiesRoot, organization = null, module = null } = {}) {
  return buildMissionControlPlanIndex({ companiesRoot, organization, module });
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

function groupWorktreesByRepo(worktrees) {
  const byRepo = new Map();
  for (const worktree of worktrees) {
    const key = `${worktree.organization}::${worktree.module}`;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(worktree);
  }
  return byRepo;
}
