import { existsSync } from "fs";
import { realpath } from "fs/promises";
import { isAbsolute, resolve } from "path";
import {
  GIT_FETCH_CONCURRENCY,
  GIT_FETCH_TIMEOUT_MS,
  GIT_LOCAL_TIMEOUT_MS,
  mapWithConcurrency,
  resolveGitExecutable,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";

export const GIT_STATUS_VALUES = [
  "up_to_date",
  "pull_available",
  "draft_changes",
  "push_required",
  "diverged",
  "wrong_branch",
  "rebase_in_progress",
  "git_am_in_progress",
  "repo_missing",
  "git_unavailable",
  "check_failed",
];

export const GIT_STATUS_LOCAL_TTL_MS = 10_000;
export const GIT_REMOTE_REFRESH_INTERVAL_MS = 5 * 60_000;
export const GIT_REMOTE_RETRY_MS = 60_000;
export const GIT_REMOTE_JITTER_MS = 60_000;
export const GIT_REMOTE_REFRESH_CONCURRENCY = 2;

// Server-scoped cache: browser polls may be frequent, but local Git inspection is
// reused briefly and remote fetches are request-driven, deduplicated across tabs
// and bounded globally. There is intentionally no background timer — if no
// focused Launchpad window asks for data, Launchpad does no remote Git traffic.
export function createGitStatusService({
  now = () => Date.now(),
  readStatus = (repo) => readGitRepoStatus(repo),
  refreshRemote = refreshGitRepoRemote,
  localTtlMs = GIT_STATUS_LOCAL_TTL_MS,
  remoteRefreshIntervalMs = GIT_REMOTE_REFRESH_INTERVAL_MS,
  remoteRetryMs = GIT_REMOTE_RETRY_MS,
  remoteJitterMs = GIT_REMOTE_JITTER_MS,
  remoteConcurrency = GIT_REMOTE_REFRESH_CONCURRENCY,
} = {}) {
  const entries = new Map();
  const queue = [];
  let activeRemoteRefreshes = 0;
  let remotePauseCount = 0;
  let mutationTail = Promise.resolve();
  const idleWaiters = new Set();

  async function readStatuses(repos, { refresh = false, allowRemoteRefresh = true } = {}) {
    return mapWithConcurrency(repos, GIT_FETCH_CONCURRENCY, (repo) =>
      readStatusForRepo(repo, { refresh, allowRemoteRefresh }),
    );
  }

  async function readStatusForRepo(repo, { refresh = false, allowRemoteRefresh = true } = {}) {
    const entry = entryFor(repo);
    let status = await readLocalStatus(repo, entry);
    if (refresh && remoteRefreshEligible(status)) {
      await enqueueRemoteRefresh(repo, entry, { force: true });
      status = await readLocalStatus(repo, entry, { force: true });
    }
    if (!refresh && allowRemoteRefresh && remoteRefreshEligible(status) && remoteRefreshDue(entry)) {
      void enqueueRemoteRefresh(repo, entry);
    }
    return withFreshness(status, entry);
  }

  function invalidate(repo) {
    const entry = entries.get(cacheKey(repo));
    if (entry) entry.localCheckedAt = 0;
  }

  function markRemoteChecked(repo) {
    const entry = entryFor(repo);
    const checkedAt = now();
    entry.remoteAttemptedAt = checkedAt;
    entry.remoteCheckedAt = checkedAt;
    entry.remoteError = null;
    entry.nextRemoteRefreshAt = checkedAt + remoteRefreshIntervalMs + stableJitter(repo, remoteJitterMs);
    entry.localCheckedAt = 0;
  }

  async function waitForIdle() {
    if (queue.length === 0 && activeRemoteRefreshes === 0) return;
    await new Promise((resolveIdle) => idleWaiters.add(resolveIdle));
  }

  async function withRemoteRefreshPaused(callback) {
    remotePauseCount += 1;
    const previousMutation = mutationTail;
    let releaseMutation;
    mutationTail = new Promise((resolveMutation) => {
      releaseMutation = resolveMutation;
    });
    await previousMutation;
    try {
      await waitForIdle();
      return await callback();
    } finally {
      remotePauseCount -= 1;
      releaseMutation();
    }
  }

  function entryFor(repo) {
    const key = cacheKey(repo);
    if (!entries.has(key)) {
      entries.set(key, {
        status: null,
        localCheckedAt: 0,
        localPromise: null,
        remoteCheckedAt: null,
        remoteAttemptedAt: null,
        nextRemoteRefreshAt: 0,
        remoteError: null,
        remotePromise: null,
        remoteQueued: false,
      });
    }
    return entries.get(key);
  }

  async function readLocalStatus(repo, entry, { force = false } = {}) {
    if (!force && entry.status && now() - entry.localCheckedAt < localTtlMs) return entry.status;
    if (entry.localPromise) return entry.localPromise;
    entry.localPromise = Promise.resolve(readStatus(repo))
      .then((status) => {
        entry.status = status;
        entry.localCheckedAt = now();
        return status;
      })
      .finally(() => {
        entry.localPromise = null;
      });
    return entry.localPromise;
  }

  function remoteRefreshDue(entry) {
    return remotePauseCount === 0
      && !entry.remotePromise
      && !entry.remoteQueued
      && now() >= entry.nextRemoteRefreshAt;
  }

  function enqueueRemoteRefresh(repo, entry, { force = false } = {}) {
    if (entry.remotePromise) return entry.remotePromise;
    if (entry.remoteQueued) return entry.remotePromise;
    if (remotePauseCount > 0) return Promise.resolve();
    if (!force && !remoteRefreshDue(entry)) return Promise.resolve();
    entry.remoteQueued = true;
    entry.remotePromise = new Promise((resolveRefresh) => {
      queue.push({ repo, entry, resolveRefresh });
      drainQueue();
    });
    return entry.remotePromise;
  }

  function drainQueue() {
    while (activeRemoteRefreshes < remoteConcurrency && queue.length > 0) {
      const job = queue.shift();
      activeRemoteRefreshes += 1;
      job.entry.remoteQueued = false;
      void runRemoteRefresh(job.repo, job.entry)
        .finally(() => {
          job.entry.remotePromise = null;
          activeRemoteRefreshes -= 1;
          job.resolveRefresh();
          drainQueue();
          resolveIdleWaitersIfIdle();
        });
    }
  }

  async function runRemoteRefresh(repo, entry) {
    entry.remoteAttemptedAt = now();
    try {
      const result = await refreshRemote(repo);
      if (result?.ok === false) throw new Error("git_fetch_failed");
      const completedAt = now();
      entry.remoteCheckedAt = completedAt;
      entry.remoteError = null;
      entry.nextRemoteRefreshAt = completedAt + remoteRefreshIntervalMs + stableJitter(repo, remoteJitterMs);
      entry.localCheckedAt = 0;
    } catch {
      entry.remoteError = "Vzdálenou verzi se nepodařilo ověřit.";
      entry.nextRemoteRefreshAt = now() + remoteRetryMs + stableJitter(repo, Math.min(remoteJitterMs, 10_000));
    }
  }

  function withFreshness(status, entry) {
    const currentTime = now();
    const refreshing = Boolean(entry.remotePromise || entry.remoteQueued);
    const remoteState = refreshing
      ? "refreshing"
      : entry.remoteError
        ? "error"
        : entry.remoteCheckedAt
          ? "fresh"
          : "pending";
    return {
      ...status,
      freshness: {
        local_checked_at: isoTime(entry.localCheckedAt),
        remote_checked_at: isoTime(entry.remoteCheckedAt),
        remote_attempted_at: isoTime(entry.remoteAttemptedAt),
        next_remote_refresh_at: isoTime(entry.nextRemoteRefreshAt),
        remote_refresh_state: remoteState,
        remote_stale: !entry.remoteCheckedAt || currentTime >= entry.nextRemoteRefreshAt,
        remote_error: entry.remoteError,
        remote_refresh_interval_ms: remoteRefreshIntervalMs,
      },
    };
  }

  function resolveIdleWaitersIfIdle() {
    if (queue.length > 0 || activeRemoteRefreshes > 0) return;
    for (const resolveIdle of idleWaiters) resolveIdle();
    idleWaiters.clear();
  }

  return {
    readStatuses,
    readStatus: readStatusForRepo,
    invalidate,
    markRemoteChecked,
    waitForIdle,
    withRemoteRefreshPaused,
  };
}

export async function readGitRepoStatuses(repos, { refresh = false } = {}) {
  return mapWithConcurrency(repos, GIT_FETCH_CONCURRENCY, (repo) => readGitRepoStatus(repo, { refresh }));
}

export async function readGitRepoStatus(repo, { refresh = false } = {}) {
  const base = {
    key: repo.key,
    branch: null,
    expected_branch: repo.expected_branch ?? "main",
    head: null,
    remote: repo.remote ?? null,
    upstream: null,
    operation: null,
    counts: {
      incoming: 0,
      outgoing: 0,
      changed_files: 0,
      untracked_files: 0,
    },
  };

  if (!repo.absolute_path || !existsSync(repo.absolute_path)) {
    return withDescriptor(base, "repo_missing");
  }
  if (!(await resolveGitExecutable())) {
    return withDescriptor(base, "git_unavailable");
  }

  const topLevel = await runGit(["rev-parse", "--show-toplevel"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  const topLevelPath = await canonicalPath(topLevel.stdout);
  const repoPath = await canonicalPath(repo.absolute_path);
  if (!topLevel.ok || topLevelPath !== repoPath) {
    return withDescriptor(base, "repo_missing", { details: [topLevel.stderr || topLevel.error].filter(Boolean) });
  }

  const operation = await readGitOperationState(repo);
  base.operation = operation;

  if (refresh && !operation) {
    const fetchResult = await refreshGitRepoRemote(repo);
    if (!fetchResult.ok) {
      return withDescriptor(base, "check_failed", {
        details: ["Vzdálenou verzi se nepodařilo ověřit pomocí git fetch."],
      });
    }
  }

  const [branchResult, headResult, porcelainResult, upstreamResult] = await Promise.all([
    runGit(["branch", "--show-current"], { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["log", "-1", "--format=%H%x00%s"], { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);

  if (!branchResult.ok || !headResult.ok || !porcelainResult.ok) {
    return withDescriptor(base, "check_failed", {
      details: [branchResult.stderr, headResult.stderr, porcelainResult.stderr].filter(Boolean),
    });
  }

  const statusRows = porcelainResult.stdout.split("\n").filter(Boolean);
  const counts = {
    incoming: 0,
    outgoing: 0,
    changed_files: statusRows.length,
    untracked_files: statusRows.filter((line) => line.startsWith("??")).length,
  };
  let upstream = null;
  if (upstreamResult.ok && upstreamResult.stdout) {
    upstream = upstreamResult.stdout;
    const revList = await runGit(["rev-list", "--left-right", "--count", `HEAD...${upstream}`], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (!revList.ok) {
      return withDescriptor(base, "check_failed", { details: [revList.stderr || revList.error].filter(Boolean) });
    }
    const [outgoing, incoming] = revList.stdout.split(/\s+/).map((value) => Number(value));
    counts.incoming = Number.isFinite(incoming) ? incoming : 0;
    counts.outgoing = Number.isFinite(outgoing) ? outgoing : 0;
  }

  const [sha, subject] = headResult.stdout.split("\0");
  const enriched = {
    ...base,
    branch: branchResult.stdout || null,
    head: sha
      ? {
          sha,
          short_sha: sha.slice(0, 7),
          subject: subject ?? "",
        }
      : null,
    upstream,
    operation,
    counts,
  };

  return withDescriptor(enriched, deriveGitRepoStatus(enriched));
}

export async function readGitOperationState(repo) {
  for (const [marker, backend] of [["rebase-merge", "merge"], ["rebase-apply", "apply"]]) {
    const gitPath = await runGit(["rev-parse", "--git-path", marker], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (!gitPath.ok || !gitPath.stdout) continue;
    const markerPath = isAbsolute(gitPath.stdout)
      ? gitPath.stdout
      : resolve(repo.absolute_path, gitPath.stdout);
    if (existsSync(markerPath)) {
      if (marker === "rebase-apply" && existsSync(resolve(markerPath, "applying"))) {
        return {
          kind: "am",
          backend,
        };
      }
      return {
        kind: "rebase",
        backend,
      };
    }
  }
  return null;
}

export async function refreshGitRepoRemote(repo) {
  const source = await verifyPullSourceIdentity(repo);
  if (!source.ok) return source;

  const fetch = await runGit(
    [
      "fetch",
      "--no-tags",
      "--prune",
      "--force",
      "--",
      source.fetch_url,
      `+refs/heads/${source.branch}:${source.tracking_ref}`,
    ],
    {
      cwd: repo.absolute_path,
      timeoutMs: GIT_FETCH_TIMEOUT_MS,
      env: safeGitRemoteEnv(),
    },
  );
  if (!fetch.ok) return fetch;

  // Fail closed if origin/upstream changed while the controlled fetch was
  // running. The fetched bytes still came from the manifest URL, but Launchpad
  // must not advertise the checkout as safe while its local source identity is
  // inconsistent.
  const verified = await verifyPullSourceIdentity(repo);
  if (!verified.ok || verified.fingerprint !== source.fingerprint) {
    return {
      ok: false,
      code: "pull_source_changed",
      error: "pull_source_changed",
    };
  }
  return {
    ...fetch,
    source: verified,
  };
}

async function verifyPullSourceIdentity(repo) {
  const branch = repo.expected_branch ?? "main";
  const manifestUrl = typeof repo.repo === "string" ? repo.repo.trim() : "";
  if (!manifestUrl) {
    return {
      ok: false,
      code: "pull_source_invalid",
      error: "pull_manifest_remote_missing",
    };
  }

  const branchCheck = await runGit(["check-ref-format", "--branch", branch], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!branchCheck.ok) {
    return { ok: false, code: "pull_source_invalid", error: "pull_manifest_branch_invalid" };
  }

  const [remoteUrls, upstream] = await Promise.all([
    runGit(["remote", "get-url", "--all", "origin"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  const configuredUrls = remoteUrls.stdout.split("\n").filter(Boolean);
  const expectedUpstream = `origin/${branch}`;
  if (
    !remoteUrls.ok
    || configuredUrls.length !== 1
    || normalizeGitRemote(configuredUrls[0]) !== normalizeGitRemote(manifestUrl)
    || !upstream.ok
    || upstream.stdout !== expectedUpstream
  ) {
    return {
      ok: false,
      code: "pull_source_invalid",
      error: "pull_source_identity_mismatch",
    };
  }

  return {
    ok: true,
    manifest_url: manifestUrl,
    fetch_url: configuredUrls[0],
    branch,
    upstream: expectedUpstream,
    tracking_ref: `refs/remotes/origin/${branch}`,
    fingerprint: `${normalizeGitRemote(manifestUrl)}\0${expectedUpstream}`,
  };
}

export async function readRepoChanges(repo) {
  const status = await readGitRepoStatus(repo);
  if (status.status === "repo_missing" || status.status === "git_unavailable") {
    return { status, changes: [] };
  }
  const result = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!result.ok) return { status: withDescriptor(status, "check_failed"), changes: [] };
  return {
    status,
    changes: result.stdout.split("\n").filter(Boolean).map(parsePorcelainLine),
  };
}

export function deriveGitRepoStatus({ branch, expected_branch, counts, operation }) {
  if (operation?.kind === "rebase") return "rebase_in_progress";
  if (operation?.kind === "am") return "git_am_in_progress";
  if (branch && expected_branch && branch !== expected_branch) return "wrong_branch";
  if (counts.changed_files > 0) return "draft_changes";
  if (counts.incoming > 0 && counts.outgoing > 0) return "diverged";
  if (counts.incoming > 0) return "pull_available";
  if (counts.outgoing > 0) return "push_required";
  return "up_to_date";
}

function parsePorcelainLine(line) {
  const porcelain = line.slice(0, 2);
  const path = line.slice(3);
  return {
    porcelain,
    path,
    change: porcelain.trim() || "modified",
  };
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function withDescriptor(base, status, extra = {}) {
  const descriptor = descriptors[status] ?? descriptors.check_failed;
  return {
    ...base,
    status,
    severity: descriptor.severity,
    title: descriptor.title,
    message: descriptor.message(base),
    recommended_action: descriptor.recommended_action,
    details: extra.details ?? base.details ?? [],
  };
}

function cacheKey(repo) {
  return `${resolve(repo.absolute_path ?? repo.key ?? "unknown")}\0${repo.expected_branch ?? "main"}`;
}

function isoTime(value) {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

function remoteRefreshEligible(status) {
  return !["repo_missing", "git_unavailable", "check_failed", "rebase_in_progress", "git_am_in_progress"]
    .includes(status?.status);
}

function normalizeGitRemote(remote) {
  const value = String(remote ?? "").trim().replace(/\/+$/, "");
  const github = value.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  );
  return github
    ? `github:${github[1].toLowerCase()}/${github[2].toLowerCase()}`
    : value;
}

function stableJitter(repo, maxMs) {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return 0;
  const input = `${repo.key ?? ""}:${repo.absolute_path ?? ""}`;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  return hash % (Math.floor(maxMs) + 1);
}

const descriptors = {
  up_to_date: {
    severity: "ok",
    title: "Repo je aktuální",
    message: () => "Lokální repo je synchronizované s remote nebo nemá upstream drift.",
    recommended_action: null,
  },
  pull_available: {
    severity: "warn",
    title: "Pull dostupný",
    message: ({ counts }) => `Remote má ${counts.incoming} novější commitů.`,
    recommended_action: "Aktualizovat main checkout bezpečným pull flow.",
  },
  draft_changes: {
    severity: "warn",
    title: "Lokální draft změny",
    message: ({ counts }) => `Repo má ${counts.changed_files} lokálních změn včetně ${counts.untracked_files} untracked souborů.`,
    recommended_action: "Zabalit draft do commitu, nebo vědomě uklidit podle plánu.",
  },
  push_required: {
    severity: "warn",
    title: "Push potřebný",
    message: ({ counts }) => `Lokální branch má ${counts.outgoing} commitů navíc.`,
    recommended_action: "Publikovat branch pushnutím commitů.",
  },
  diverged: {
    severity: "fail",
    title: "Branch divergovala",
    message: ({ counts }) => `Branch má ${counts.incoming} incoming a ${counts.outgoing} outgoing commitů.`,
    recommended_action: "Vyžaduje bezpečný rebase/merge podle vlastníka práce.",
  },
  wrong_branch: {
    severity: "warn",
    title: "Checkout není na očekávané branchi",
    message: ({ branch, expected_branch }) => `Checkout je na ${branch || "detached HEAD"}, očekává se ${expected_branch}.`,
    recommended_action: "Přesuň práci do worktree nebo vrať referenční checkout na očekávanou branch.",
  },
  rebase_in_progress: {
    severity: "fail",
    title: "Rebase je rozpracovaný",
    message: () => "Git čeká na dokončení nebo abortnutí rozpracovaného rebase.",
    recommended_action: "Předat screenshot a stav agentovi do Codexu; Launchpad rebase automaticky neopravuje.",
  },
  git_am_in_progress: {
    severity: "fail",
    title: "Aplikování patchů je rozpracované",
    message: () => "Git čeká na dokončení nebo abortnutí rozpracovaného git am.",
    recommended_action: "Předat screenshot a stav agentovi do Codexu; Launchpad git am automaticky neabortuje.",
  },
  repo_missing: {
    severity: "fail",
    title: "Repo chybí",
    message: () => "Deklarovaná cesta neexistuje nebo není samostatný Git checkout.",
    recommended_action: "Doplnit přístup/checkout nebo opravit manifest.",
  },
  git_unavailable: {
    severity: "fail",
    title: "Git není dostupný",
    message: () => "Launchpad nemůže spustit git.",
    recommended_action: "Nainstalovat Git nebo opravit PATH.",
  },
  check_failed: {
    severity: "fail",
    title: "Git kontrola selhala",
    message: () => "Git stav nejde spolehlivě přečíst.",
    recommended_action: "Ověřit checkout ručně a opravit git stav.",
  },
};
