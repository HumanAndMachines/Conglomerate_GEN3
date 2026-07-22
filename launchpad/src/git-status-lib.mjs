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

  if (refresh && operation?.kind !== "rebase") {
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
      return {
        kind: "rebase",
        backend,
        can_abort_rebase: true,
      };
    }
  }
  return null;
}

export async function abortRepoRebase(repo) {
  const before = await readGitRepoStatus(repo);
  if (before.operation?.kind !== "rebase") {
    return {
      ok: false,
      code: "rebase_not_in_progress",
      message: "V tomto repozitáři teď neprobíhá rebase, takže není co abortnout.",
      before,
    };
  }

  const abort = await runGit(["rebase", "--abort"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
  if (!abort.ok) {
    return {
      ok: false,
      code: "rebase_abort_failed",
      message: abort.stderr || abort.error || "Rebase se nepodařilo bezpečně abortnout.",
      before,
    };
  }

  const after = await readGitRepoStatus(repo);
  if (after.operation?.kind === "rebase") {
    return {
      ok: false,
      code: "rebase_abort_verification_failed",
      message: "Git příkaz doběhl, ale rebase je stále aktivní. Stav musí zkontrolovat Agent.",
      before,
      after,
    };
  }

  return {
    ok: true,
    before,
    after,
    stdout: abort.stdout,
    stderr: abort.stderr,
  };
}

export async function refreshGitRepoRemote(repo) {
  const remotes = await runGit(["remote"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!remotes.ok || !remotes.stdout) {
    return { ...remotes, ok: false, error: remotes.error ?? "git_remote_missing" };
  }
  return runGit(["fetch", "--all", "--prune"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
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

export async function pullRepoFastForward(repo, { preflight = null } = {}) {
  if (preflight) return pullFastForwardAfterPreflight(repo, preflight);
  // Cheap local guards come first so a dirty/wrong checkout gets the useful
  // explanation even when its remote is unavailable. A clean candidate must
  // still pass a fresh remote fetch before Launchpad allows the pull.
  const local = await readGitRepoStatus(repo);
  if (["draft_changes", "wrong_branch", "push_required", "diverged", "rebase_in_progress"].includes(local.status)) {
    return {
      ok: false,
      code: "pull_not_safe",
      message: pullGuardMessage(local),
      before: local,
    };
  }
  const before = await readGitRepoStatus(repo, { refresh: true });
  return pullFastForwardAfterPreflight(repo, before);
}

async function pullFastForwardAfterPreflight(repo, before) {
  if (before.status !== "pull_available") {
    return {
      ok: false,
      code: "pull_not_safe",
      message: pullGuardMessage(before),
      before,
    };
  }
  const pull = await runGit(["pull", "--ff-only"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
  if (!pull.ok) {
    return {
      ok: false,
      code: "pull_failed",
      message: pull.stderr || pull.error || "Stáhnout novější verzi se nepovedlo.",
      before,
    };
  }
  const after = await readGitRepoStatus(repo);
  return {
    ok: true,
    before,
    after,
    stdout: pull.stdout,
    stderr: pull.stderr,
  };
}

export async function pullRepoWithAutostash(repo, { preflight = null } = {}) {
  const before = preflight ?? await readGitRepoStatus(repo, { refresh: true });
  if (before.status !== "draft_changes" || before.counts.incoming < 1 || before.counts.outgoing > 0) {
    return {
      ok: false,
      code: "autostash_pull_not_safe",
      message: autostashGuardMessage(before),
      before,
    };
  }

  const stash = await runGit(
    ["stash", "push", "--include-untracked", "--message", `launchpad-autostash-${new Date().toISOString()}`],
    { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (!stash.ok) {
    return {
      ok: false,
      code: "autostash_create_failed",
      message: "Lokální změny se nepodařilo bezpečně odložit. Repo zůstalo bez pullu.",
      before,
    };
  }

  const stashRef = await runGit(["rev-parse", "refs/stash"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!stashRef.ok || !stashRef.stdout) {
    const restored = await runGit(["stash", "apply", "--index", "stash@{0}"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    return {
      ok: false,
      code: restored.ok ? "autostash_create_failed" : "autostash_restore_failed",
      message: restored.ok
        ? "Git nepotvrdil identitu autostashe. Pull se nespustil, lokální změny jsou obnovené a bezpečnostní kopie zůstala ve stash stacku."
        : "Git nepotvrdil identitu autostashe ani automatické obnovení. Bezpečnostní kopie zůstala ve stash stacku.",
      before,
      stash_preserved: true,
    };
  }

  const stashedStatus = await readGitRepoStatus(repo);
  if (stashedStatus.status !== "pull_available") {
    const restored = await restoreCreatedStash(repo, stashRef.stdout);
    return {
      ok: false,
      code: restored.ok ? "autostash_precondition_changed" : "autostash_restore_failed",
      message: restored.ok
        ? "Po odložení změn už repo nebylo bezpečně fast-forwardovatelné. Lokální změny jsou obnovené."
        : "Pull se nespustil, ale automatické obnovení změn selhalo. Autostash zůstal zachovaný pro ruční obnovu.",
      before,
      stash_preserved: !restored.dropped,
    };
  }

  const pull = await runGit(["pull", "--ff-only"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
  if (!pull.ok) {
    const restored = await restoreCreatedStash(repo, stashRef.stdout);
    return {
      ok: false,
      code: restored.ok ? "pull_failed" : "autostash_restore_failed",
      message: restored.ok
        ? "Fast-forward pull selhal; lokální změny jsou obnovené."
        : "Fast-forward pull selhal a změny nešlo automaticky obnovit. Autostash zůstal zachovaný pro ruční obnovu.",
      before,
      stash_preserved: !restored.dropped,
    };
  }

  const restored = await restoreCreatedStash(repo, stashRef.stdout);
  const after = await readGitRepoStatus(repo);
  if (!restored.ok) {
    return {
      ok: false,
      code: "autostash_conflict",
      message: "Nová verze je stažená, ale lokální změny se po pullu střetly. Autostash zůstal zachovaný; vyřeš konflikt s Agentem.",
      before,
      after,
      pulled: true,
      stash_preserved: true,
    };
  }

  return {
    ok: true,
    before,
    after,
    pulled: true,
    autostash: true,
    stash_preserved: !restored.dropped,
    stdout: pull.stdout,
    stderr: pull.stderr,
  };
}

async function restoreCreatedStash(repo, stashSha) {
  const apply = await runGit(["stash", "apply", "--index", stashSha], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!apply.ok) return { ok: false, dropped: false };

  const currentStash = await runGit(["rev-parse", "refs/stash"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!currentStash.ok || currentStash.stdout !== stashSha) {
    // Změny jsou obnovené, ale mezitím se změnil stash stack. Nic nemažeme,
    // abychom nesmazali cizí práci; zůstane jen bezpečná duplicitní kopie.
    return { ok: true, dropped: false };
  }
  const drop = await runGit(["stash", "drop", "stash@{0}"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return { ok: true, dropped: drop.ok };
}

function autostashGuardMessage(status) {
  if (status.status === "wrong_branch") return pullGuardMessage(status);
  if (status.counts?.outgoing > 0) return "Repo má lokální commity k odeslání; autostash pull je zablokovaný.";
  if (status.status === "draft_changes" && status.counts?.incoming < 1) {
    return "Repo má lokální změny, ale vzdálená větev nemá novější commity ke stažení.";
  }
  if (status.status === "pull_available") return "Repo je čisté; použij běžný bezpečný pull.";
  return pullGuardMessage(status);
}

function pullGuardMessage(status) {
  if (status.status === "rebase_in_progress") {
    return "Repo má rozpracovaný rebase. Abortni ho, nebo vlož screenshot této chyby agentovi do Codexu.";
  }
  if (status.status === "draft_changes") {
    return "Repo má rozepsaná práce; nejdřív ji zabal do commitu nebo vědomě ukliď.";
  }
  if (status.status === "wrong_branch") {
    return "Repo není na očekávané branchi; bezpečné stažení novější verze je zablokované.";
  }
  if (status.status === "diverged") {
    return "Repo má změny lokálně i ve sdílené verzi; potřebuje pomocníka místo automatického stažení.";
  }
  if (status.status === "push_required") {
    return "Repo má lokální commity k odeslání; nejdřív je publikuj nebo vyřeš s pomocníkem.";
  }
  if (status.status === "up_to_date") {
    return "Repo už je aktuální; není co stahovat.";
  }
  return status.message || "Repo není ve stavu, který jde bezpečně stáhnout.";
}

export function deriveGitRepoStatus({ branch, expected_branch, counts, operation }) {
  if (operation?.kind === "rebase") return "rebase_in_progress";
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
  return !["repo_missing", "git_unavailable", "check_failed", "rebase_in_progress"].includes(status?.status);
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
    recommended_action: "Abortnout rebase, nebo předat screenshot a stav agentovi do Codexu.",
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
