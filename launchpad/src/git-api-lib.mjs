import { buildGitInventory } from "./git-inventory-lib.mjs";
import { createHash, randomUUID } from "crypto";
import { realpath } from "fs/promises";
import { isAbsolute, relative, resolve } from "path";
import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_LOCAL_TIMEOUT_MS,
  mapWithConcurrency,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";
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

export function createGitPublishAuthorizationStore({
  ttlMs = 120_000,
  maxEntries = 128,
  now = () => Date.now(),
} = {}) {
  const authorizations = new Map();
  const purge = () => {
    const currentTime = now();
    for (const [token, authorization] of authorizations) {
      if (authorization.expiresAt < currentTime) authorizations.delete(token);
    }
    while (authorizations.size >= maxEntries) {
      authorizations.delete(authorizations.keys().next().value);
    }
  };
  return {
    issue(intent) {
      purge();
      const token = randomUUID();
      const expiresAt = now() + ttlMs;
      authorizations.set(token, { ...intent, expiresAt });
      return { token, expiresAt };
    },
    consume({ token, intentHash, repoKey, expectedSha }) {
      purge();
      const authorization = typeof token === "string" ? authorizations.get(token) : null;
      if (typeof token === "string") authorizations.delete(token);
      if (
        !authorization
        || authorization.expiresAt < now()
        || authorization.intentHash !== intentHash
        || authorization.repoKey !== repoKey
        || authorization.expectedSha !== expectedSha
      ) {
        throw new GitApiError("Potvrzení odeslání chybí, vypršelo nebo patří jiné změně.", {
          status: 409,
          code: "publish_authorization_invalid",
        });
      }
      return authorization;
    },
  };
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

// Action contract „Odeslat změny":
// - intent/source: explicitně publikovat stav kanonického Git checkoutu z inventáře;
// - preconditions: už existující commit na očekávané branchi, žádné incoming
//   změny a Organization/workspace scope;
// - side effects: pushne se přesně aktuální HEAD; pracovní soubory ani index se nemění;
// - failure/access: productionspace je zakázaný a po chybě zůstává commit lokálně;
// - verification: po push se stav repozitáře znovu načte a vrátí klientovi.
export async function buildRepoPublishIntentResponse({
  companiesRoot,
  repoKey,
  authorizationStore,
} = {}) {
  if (!authorizationStore) throw new Error("buildRepoPublishIntentResponse requires authorizationStore");
  const { repo, status } = await prepareRepoPublish({ companiesRoot, repoKey });
  const intent = await readRepoPublishIntent(repo, status, repoKey);
  const intentHash = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
  const destinationHash = await publishDestinationHash(repo, status);
  const authorization = authorizationStore.issue({
    intentHash,
    destinationHash,
    repoKey,
    expectedSha: status.head.sha,
  });
  return {
    schema_version: "companiesascode.launchpad.git_publish_intent.v1",
    generated_at: new Date().toISOString(),
    intent,
    intent_hash: intentHash,
    authorization_token: authorization.token,
    authorization_expires_at: new Date(authorization.expiresAt).toISOString(),
  };
}

async function readRepoPublishIntent(repo, status, repoKey) {
  const [log, diff] = await Promise.all([
    runGit(["log", "--format=%H%x00%s", "@{u}..HEAD"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    runGit(["diff", "--name-status", "@{u}..HEAD"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  if (!log.ok || !diff.ok) {
    throw new GitApiError("Změny k odeslání se nepodařilo bezpečně načíst.", {
      status: 409,
      code: "publish_intent_unavailable",
    });
  }
  const commits = log.stdout.split("\n").filter(Boolean).map((line) => {
    const [sha, subject = "Bez popisu"] = line.split("\0");
    return { sha, short_sha: sha.slice(0, 7), subject };
  });
  const changes = diff.stdout.split("\n").filter(Boolean).map((line) => {
    const [statusCode, ...paths] = line.split("\t");
    return { status: statusCode, paths };
  });
  const intent = {
    repo_key: repoKey,
    branch: status.branch,
    expected_sha: status.head.sha,
    commits,
    changes,
  };
  return intent;
}

export async function buildRepoPublishResponse({
  companiesRoot,
  repoKey,
  expectedSha = null,
  intentHash = null,
  authorizationToken = null,
  authorizationStore,
  statusService = null,
} = {}) {
  if (!authorizationStore) throw new Error("buildRepoPublishResponse requires authorizationStore");
  const authorization = authorizationStore.consume({
    token: authorizationToken,
    intentHash,
    repoKey,
    expectedSha,
  });
  const { repo, status: before } = await prepareRepoPublish({ companiesRoot, repoKey });
  const [currentIntent, destinationHash] = await Promise.all([
    readRepoPublishIntent(repo, before, repoKey),
    publishDestinationHash(repo, before),
  ]);
  const currentIntentHash = createHash("sha256").update(JSON.stringify(currentIntent)).digest("hex");
  if (currentIntentHash !== intentHash || destinationHash !== authorization.destinationHash) {
    throw new GitApiError("Odesílané změny nebo jejich cíl se od potvrzení změnily. Zkontrolujte je prosím znovu.", {
      status: 409,
      code: "publish_authorization_changed",
    });
  }
  if (typeof expectedSha !== "string" || !/^[0-9a-f]{40}$/i.test(expectedSha) || before.head?.sha !== expectedSha) {
    throw new GitApiError("Potvrzená změna už neodpovídá aktuálnímu stavu. Zkontrolujte ji prosím znovu.", {
      status: 409,
      code: "publish_commit_changed",
    });
  }

  const branch = before.branch;
  const push = await runGit(["push", "origin", `${expectedSha}:refs/heads/${branch}`], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
  if (!push.ok) {
    const verification = await verifyRemotePublishOutcome(repo, branch, expectedSha);
    if (verification === "rejected") {
      throw new GitApiError("Změny se nepodařilo odeslat. Zůstaly bezpečně na tomto počítači.", {
        status: 409,
        code: "git_push_failed",
      });
    }
    if (verification === "indeterminate") {
      throw new GitApiError("Výsledek odeslání se nepodařilo ověřit. Před opakováním nejdřív obnovte stav repozitáře.", {
        status: 503,
        code: "git_push_indeterminate",
      });
    }
  }

  statusService?.markRemoteChecked(repo);
  const after = await readGitRepoStatus(repo, { refresh: true });
  return {
    schema_version: "companiesascode.launchpad.git_publish.v1",
    generated_at: new Date().toISOString(),
    repo_key: repoKey,
    action: "push",
    committed: false,
    pushed: true,
    branch,
    before: compactPullStatus(before),
    after: compactPullStatus(after),
  };
}

async function prepareRepoPublish({ companiesRoot, repoKey }) {
  const inventory = await buildGitInventory({ companiesRoot });
  const repo = inventory.repos.find((item) => item.key === repoKey);
  if (!repo) throw new GitApiError(`Repo ${repoKey} nebylo nalezeno.`, { status: 404, code: "repo_not_found" });
  assertBuilderPublishScope(repo);
  await assertPublishRepositoryBoundary(companiesRoot, repo);
  await assertPublishRemoteTarget(repo);
  const refresh = await runGit([
    "fetch",
    "--prune",
    "origin",
    `+refs/heads/${repo.expected_branch}:refs/remotes/origin/${repo.expected_branch}`,
  ], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
  if (!refresh.ok) {
    throw new GitApiError("Sdílenou větev se nepodařilo ověřit. Změny zatím nelze bezpečně odeslat.", {
      status: 409,
      code: "publish_remote_refresh_failed",
    });
  }
  const status = await readGitRepoStatus(repo);
  const onExpectedBranch = status.branch === repo.expected_branch;
  if (status.status !== "push_required" || !onExpectedBranch) {
    throw new GitApiError(publishGuardMessage(status, repo), { status: 409, code: "publish_not_safe" });
  }
  return { repo, status };
}

async function publishDestinationHash(repo, status) {
  const [checkoutPath, pushUrls] = await Promise.all([
    realpath(repo.absolute_path),
    runGit(["remote", "get-url", "--push", "--all", "origin"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  if (!pushUrls.ok) {
    throw new GitApiError("Cíl odeslání se nepodařilo ověřit.", {
      status: 409,
      code: "publish_remote_unverified",
    });
  }
  const destination = {
    checkout_path: checkoutPath,
    branch: status.branch,
    expected_branch: repo.expected_branch,
    repo_kind: repo.repo_kind,
    push_remotes: pushUrls.stdout
      .split("\n")
      .filter(Boolean)
      .map((url) => remoteIdentityForPublish(url, repo.absolute_path))
      .sort(),
  };
  return createHash("sha256").update(JSON.stringify(destination)).digest("hex");
}

async function verifyRemotePublishOutcome(repo, branch, expectedSha) {
  const refresh = await runGit([
    "fetch",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
  if (!refresh.ok) return "indeterminate";
  const remoteHead = await runGit(["rev-parse", `refs/remotes/origin/${branch}`], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!remoteHead.ok) return "indeterminate";
  const containsPublishedCommit = await runGit([
    "merge-base",
    "--is-ancestor",
    expectedSha,
    remoteHead.stdout,
  ], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (containsPublishedCommit.ok) return "published";
  return containsPublishedCommit.exitCode === 1 ? "rejected" : "indeterminate";
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

function assertBuilderPublishScope(repo) {
  if (builderPullScopeAllowed(repo)) return;
  throw new GitApiError(
    "Odeslat změny z Launchpadu je povolené pro Organization root a workspace moduly; productionspace zůstává jen pro čtení.",
    { status: 403, code: "publish_scope_forbidden" },
  );
}

async function assertPublishRepositoryBoundary(companiesRoot, repo) {
  let organizationRoot;
  let checkoutRoot;
  try {
    [organizationRoot, checkoutRoot] = await Promise.all([
      realpath(resolve(companiesRoot, repo.organization_path)),
      realpath(repo.absolute_path),
    ]);
  } catch {
    throw new GitApiError("Repozitář se nepodařilo bezpečně ověřit.", {
      status: 409,
      code: "publish_checkout_unverified",
    });
  }
  const organizationRelativePath = relative(organizationRoot, checkoutRoot);
  if (organizationRelativePath.startsWith("..") || isAbsolute(organizationRelativePath)) {
    throw new GitApiError("Repozitář leží mimo povolený prostor Organizace.", {
      status: 403,
      code: "publish_scope_forbidden",
    });
  }
  const commonDir = await runGit(["rev-parse", "--git-common-dir"], {
    cwd: checkoutRoot,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  let canonicalCommonDir;
  let checkoutGitDir;
  try {
    canonicalCommonDir = commonDir.ok
      ? await realpath(resolve(checkoutRoot, commonDir.stdout))
      : null;
    checkoutGitDir = await realpath(resolve(checkoutRoot, ".git"));
  } catch {
    canonicalCommonDir = null;
    checkoutGitDir = null;
  }
  if (!canonicalCommonDir || canonicalCommonDir !== checkoutGitDir) {
    throw new GitApiError("Odeslat lze jen canonical checkout, ne linked worktree nebo cizí Git hranici.", {
      status: 403,
      code: "publish_checkout_unverified",
    });
  }
  if (repo.repo_kind === "organization_root" && checkoutRoot !== organizationRoot) {
    throw new GitApiError("Root repozitář neodpovídá kořeni Organizace.", {
      status: 403,
      code: "publish_scope_forbidden",
    });
  }
  if (repo.repo_kind === "module") {
    const allowedWorkspaceRoots = [];
    for (const directory of ["workspace", "modules"]) {
      try {
        allowedWorkspaceRoots.push(await realpath(resolve(organizationRoot, directory)));
      } catch {
        // Chybějící canonical/legacy workspace root není povolená hranice.
      }
    }
    const insideWorkspace = allowedWorkspaceRoots.some((workspaceRoot) => {
      const workspaceRelativePath = relative(workspaceRoot, checkoutRoot);
      return workspaceRelativePath !== ""
        && !workspaceRelativePath.startsWith("..")
        && !isAbsolute(workspaceRelativePath);
    });
    if (!insideWorkspace) {
      throw new GitApiError("Workspace modul leží mimo povolenou pracovní vrstvu Organizace.", {
        status: 403,
        code: "publish_scope_forbidden",
      });
    }
  }
}

async function assertPublishRemoteTarget(repo) {
  if (typeof repo.repo !== "string" || !repo.repo.trim()) {
    throw new GitApiError("Repozitář nemá deklarovanou vzdálenou adresu.", {
      status: 409,
      code: "publish_remote_unverified",
    });
  }
  const [origin, pushUrls, upstream] = await Promise.all([
    runGit(["remote", "get-url", "origin"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    runGit(["remote", "get-url", "--push", "--all", "origin"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  const expectedUpstream = `origin/${repo.expected_branch}`;
  const declaredRemote = remoteIdentityForPublish(repo.repo, repo.absolute_path, { allowGithubShorthand: true });
  const effectivePushUrls = pushUrls.stdout.split("\n").filter(Boolean);
  if (
    !origin.ok
    || remoteIdentityForPublish(origin.stdout, repo.absolute_path) !== declaredRemote
    || !pushUrls.ok
    || effectivePushUrls.length === 0
    || effectivePushUrls.some((url) => remoteIdentityForPublish(url, repo.absolute_path) !== declaredRemote)
    || !upstream.ok
    || upstream.stdout !== expectedUpstream
  ) {
    throw new GitApiError("Vzdálený repozitář nebo větev neodpovídá nastavení aplikace.", {
      status: 409,
      code: "publish_remote_unverified",
    });
  }
}

export function remoteIdentityForPublish(remote, cwd, { allowGithubShorthand = false } = {}) {
  const value = String(remote ?? "").trim().replace(/\.git$/, "");
  if (allowGithubShorthand && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    return `github:${value.toLowerCase()}`;
  }
  const githubScp = value.match(/^(?:[^@/]+@)?github\.com:([^/]+\/[^/]+)$/i);
  if (githubScp) return `github:${githubScp[1].toLowerCase()}`;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() === "github.com") {
      const ownerRepo = url.pathname.replace(/^\/+/, "");
      if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo)) {
        return `github:${ownerRepo.toLowerCase()}`;
      }
    }
  } catch {
    // Non-URL Git remotes continue to local-path/raw normalization below.
  }
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return `path:${resolve(cwd, value)}`;
  }
  return `raw:${value}`;
}

function publishGuardMessage(status, repo) {
  if (status.branch !== repo.expected_branch) {
    return "Změny lze odeslat jen z hlavní větve aplikace.";
  }
  if (Number(status.counts?.incoming) > 0) {
    return "Nejdřív stáhněte novější změny, teprve potom lze vaše změny odeslat.";
  }
  if (status.status === "wrong_branch") return "Změny lze odeslat jen z hlavní větve aplikace.";
  if (status.status === "diverged") return "Lokální a sdílenou verzi je potřeba nejdřív porovnat.";
  if (status.status === "up_to_date") return "Nejsou tu žádné změny k odeslání.";
  return status.message || "Změny teď nejde bezpečně odeslat.";
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
