import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { abortRepoRebase, createGitStatusService, pullRepoWithAutostash, readGitRepoStatus } from "./git-status-lib.mjs";
import { initGitRepo, normalizeLineEndings, runGit, startConflictingRebase } from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("repo status detects clean main checkout as up_to_date", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-clean-"));
  tempRoots.push(root);
  await initGitRepo(root);

  const status = await readGitRepoStatus({ key: "Fixture::root", absolute_path: root, expected_branch: "main" });

  expect(status.status).toBe("up_to_date");
  expect(status.severity).toBe("ok");
  expect(status.branch).toBe("main");
  expect(status.counts.changed_files).toBe(0);
  expect(status.head.short_sha).toHaveLength(7);
});

test("repo status treats untracked files as local drafts that need packaging", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-draft-"));
  tempRoots.push(root);
  await initGitRepo(root);
  await writeFile(join(root, "draft.md"), "local draft\n");

  const status = await readGitRepoStatus({ key: "Fixture::root", absolute_path: root, expected_branch: "main" });

  expect(status.status).toBe("draft_changes");
  expect(status.severity).toBe("warn");
  expect(status.counts.changed_files).toBe(1);
  expect(status.counts.untracked_files).toBe(1);
  expect(status.recommended_action).toContain("Zabalit");
});

test("repo status flags main checkout on the wrong branch before treating it as normal work", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-branch-"));
  tempRoots.push(root);
  await initGitRepo(root);
  runGit(["checkout", "-b", "CAC-0042-feature"], root);

  const status = await readGitRepoStatus({ key: "Fixture::root", absolute_path: root, expected_branch: "main" });

  expect(status.status).toBe("wrong_branch");
  expect(status.severity).toBe("warn");
  expect(status.message).toContain("main");
});

test("repo status reports missing checkout without running Git in the parent folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-missing-"));
  tempRoots.push(root);

  const status = await readGitRepoStatus({
    key: "Fixture::missing",
    absolute_path: join(root, "missing"),
    expected_branch: "main",
  });

  expect(status.status).toBe("repo_missing");
  expect(status.severity).toBe("fail");
});

test("repo status exposes a conflicting rebase and guarded abort restores the original branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-rebase-"));
  tempRoots.push(root);
  await initGitRepo(root);
  await startConflictingRebase(root);

  const repo = { key: "Fixture::root", absolute_path: root, expected_branch: "main" };
  const blocked = await readGitRepoStatus(repo);
  expect(blocked.status).toBe("rebase_in_progress");
  expect(blocked.severity).toBe("fail");
  expect(blocked.operation).toMatchObject({ kind: "rebase", can_abort_rebase: true });

  const aborted = await abortRepoRebase(repo);
  expect(aborted.ok).toBe(true);
  expect(aborted.before.status).toBe("rebase_in_progress");
  expect(aborted.after.status).toBe("up_to_date");
  expect(aborted.after.branch).toBe("main");
  expect(normalizeLineEndings(await readFile(join(root, "README.md"), "utf8"))).toBe("# local draft\n");

  const repeated = await abortRepoRebase(repo);
  expect(repeated.ok).toBe(false);
  expect(repeated.code).toBe("rebase_not_in_progress");
});

test("shared status service deduplicates remote refreshes and respects the freshness window", async () => {
  let currentTime = Date.UTC(2026, 6, 14, 10, 0, 0);
  let localReads = 0;
  let remoteRefreshes = 0;
  let finishRefresh;
  const repo = { key: "Fixture::app", absolute_path: "/tmp/fixture-app", expected_branch: "main" };
  const service = createGitStatusService({
    now: () => currentTime,
    localTtlMs: 10_000,
    remoteRefreshIntervalMs: 300_000,
    remoteJitterMs: 0,
    readStatus: async () => {
      localReads += 1;
      return fixtureStatus(repo);
    },
    refreshRemote: async () => {
      remoteRefreshes += 1;
      await new Promise((resolveRefresh) => {
        finishRefresh = resolveRefresh;
      });
      return { ok: true };
    },
  });

  const [first, second] = await Promise.all([
    service.readStatus(repo),
    service.readStatus(repo),
  ]);
  expect(localReads).toBe(1);
  expect(remoteRefreshes).toBe(1);
  expect(first.freshness.remote_refresh_state).toBe("refreshing");
  expect(second.freshness.remote_refresh_state).toBe("refreshing");

  finishRefresh();
  await service.waitForIdle();
  currentTime += 1;
  const fresh = await service.readStatus(repo);
  expect(localReads).toBe(2);
  expect(remoteRefreshes).toBe(1);
  expect(fresh.freshness.remote_refresh_state).toBe("fresh");
  expect(fresh.freshness.remote_stale).toBe(false);

  currentTime += 299_998;
  await service.readStatus(repo);
  expect(remoteRefreshes).toBe(1);
});

test("shared status service preserves status and retries later when remote refresh fails", async () => {
  let currentTime = Date.UTC(2026, 6, 14, 10, 0, 0);
  let remoteRefreshes = 0;
  const repo = { key: "Fixture::app", absolute_path: "/tmp/fixture-app-error", expected_branch: "main" };
  const service = createGitStatusService({
    now: () => currentTime,
    remoteRetryMs: 60_000,
    remoteJitterMs: 0,
    readStatus: async () => fixtureStatus(repo),
    refreshRemote: async () => {
      remoteRefreshes += 1;
      return { ok: false };
    },
  });

  await service.readStatus(repo);
  await service.waitForIdle();
  const failed = await service.readStatus(repo, { allowRemoteRefresh: false });
  expect(failed.status).toBe("up_to_date");
  expect(failed.freshness.remote_refresh_state).toBe("error");
  expect(failed.freshness.remote_error).toContain("nepodařilo ověřit");
  expect(remoteRefreshes).toBe(1);

  currentTime += 59_999;
  await service.readStatus(repo);
  expect(remoteRefreshes).toBe(1);
});

test("Git mutations are serialized and pause request-driven background fetches", async () => {
  const repo = { key: "Fixture::serialized", absolute_path: "/tmp/fixture-serialized", expected_branch: "main" };
  let remoteRefreshes = 0;
  let releaseFirst;
  const order = [];
  const service = createGitStatusService({
    readStatus: async () => fixtureStatus(repo),
    refreshRemote: async () => {
      remoteRefreshes += 1;
      return { ok: true };
    },
  });

  const first = service.withRemoteRefreshPaused(async () => {
    order.push("first:start");
    await new Promise((resolveFirst) => {
      releaseFirst = resolveFirst;
    });
    order.push("first:end");
  });
  await Promise.resolve();
  const second = service.withRemoteRefreshPaused(async () => {
    order.push("second:start");
    order.push("second:end");
  });
  await service.readStatus(repo);
  expect(remoteRefreshes).toBe(0);
  expect(order).toEqual(["first:start"]);

  releaseFirst();
  await Promise.all([first, second]);
  expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
});

test("explicit refresh reports check_failed when git fetch cannot verify the remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-fetch-failure-"));
  tempRoots.push(root);
  await initGitRepo(root);
  runGit(["remote", "add", "origin", join(root, "missing-remote.git")], root);

  const status = await readGitRepoStatus(
    { key: "Fixture::root", absolute_path: root, expected_branch: "main" },
    { refresh: true },
  );

  expect(status.status).toBe("check_failed");
  expect(status.details).toEqual(["Vzdálenou verzi se nepodařilo ověřit pomocí git fetch."]);
});

test("autostash pull preserves staged and untracked local changes across a non-conflicting fast-forward", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-autostash-success-"));
  tempRoots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await initGitRepo(repo, { remotePath: remote });
  const contributor = join(root, "contributor");
  runGit(["clone", remote, contributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  runGit(["config", "user.email", "fixture@example.com"], contributor);
  runGit(["config", "user.name", "Fixture"], contributor);
  await writeFile(join(contributor, "remote.md"), "remote change\n");
  runGit(["add", "remote.md"], contributor);
  runGit(["commit", "-m", "remote change"], contributor);
  runGit(["push", "origin", "main"], contributor);
  await writeFile(join(repo, "README.md"), "# local staged draft\n");
  await writeFile(join(repo, "local-untracked.md"), "untracked draft\n");
  runGit(["add", "README.md"], repo);

  const result = await pullRepoWithAutostash({
    key: "Fixture::repo",
    absolute_path: repo,
    expected_branch: "main",
  });

  expect(result.ok).toBe(true);
  expect(result.autostash).toBe(true);
  expect(result.after.status).toBe("draft_changes");
  expect(normalizeLineEndings(await readFile(join(repo, "README.md"), "utf8"))).toBe("# local staged draft\n");
  expect(normalizeLineEndings(await readFile(join(repo, "local-untracked.md"), "utf8"))).toBe("untracked draft\n");
  expect(normalizeLineEndings(await readFile(join(repo, "remote.md"), "utf8"))).toBe("remote change\n");
  expect(runGit(["diff", "--cached", "--name-only"], repo)).toBe("README.md");
  expect(runGit(["stash", "list"], repo)).toBe("");
});

test("autostash pull keeps its stash and reports a conflict instead of hiding it", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-autostash-conflict-"));
  tempRoots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await initGitRepo(repo, { remotePath: remote });
  const contributor = join(root, "contributor");
  runGit(["clone", remote, contributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  runGit(["config", "user.email", "fixture@example.com"], contributor);
  runGit(["config", "user.name", "Fixture"], contributor);
  await writeFile(join(contributor, "README.md"), "# remote version\n");
  runGit(["add", "README.md"], contributor);
  runGit(["commit", "-m", "remote README"], contributor);
  runGit(["push", "origin", "main"], contributor);
  await writeFile(join(repo, "README.md"), "# local version\n");

  const result = await pullRepoWithAutostash({
    key: "Fixture::repo",
    absolute_path: repo,
    expected_branch: "main",
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe("autostash_conflict");
  expect(result.pulled).toBe(true);
  expect(result.stash_preserved).toBe(true);
  expect(runGit(["status", "--porcelain=v1"], repo)).toContain("UU README.md");
  expect(runGit(["stash", "list"], repo)).toContain("launchpad-autostash");
});

function fixtureStatus(repo) {
  return {
    key: repo.key,
    branch: "main",
    expected_branch: "main",
    head: null,
    remote: null,
    upstream: null,
    counts: { incoming: 0, outgoing: 0, changed_files: 0, untracked_files: 0 },
    status: "up_to_date",
    severity: "ok",
    title: "Repo je aktuální",
    message: "Repo je aktuální.",
    recommended_action: null,
    details: [],
  };
}
