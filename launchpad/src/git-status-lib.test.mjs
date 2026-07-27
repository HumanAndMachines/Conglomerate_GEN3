import { afterAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  abortRepoRebase,
  createGitStatusService,
  pullRepoFastForward,
  pullRepoWithAutostash,
  readGitRepoStatus,
  refreshGitRepoRemote,
} from "./git-status-lib.mjs";
import {
  initGitRepo,
  normalizeLineEndings,
  runGit,
  startConflictingApplyRebase,
  startConflictingGitAm,
  startConflictingRebase,
} from "./git-fixture-helpers.test.mjs";

const tempRoots = [];
const posixTest = test.if(process.platform !== "win32");

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

posixTest("repo status never executes a checkout-local core.fsmonitor helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-fsmonitor-"));
  tempRoots.push(root);
  await initGitRepo(root);
  await writeFile(join(root, ".git", "info", "exclude"), "fsmonitor-*\n");
  const marker = join(root, "fsmonitor-ran");
  const helper = join(root, "fsmonitor-marker.sh");
  await writeFile(helper, `#!/bin/sh\nprintf fsmonitor > ${JSON.stringify(marker)}\n`);
  await chmod(helper, 0o755);
  runGit(["config", "core.fsmonitor", helper], root);

  const status = await readGitRepoStatus({ key: "Fixture::root", absolute_path: root, expected_branch: "main" });

  expect(status.status).toBe("up_to_date");
  expect(existsSync(marker)).toBe(false);
});

posixTest("remote refresh never executes a checkout-local core.sshCommand", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-ssh-command-"));
  tempRoots.push(root);
  await initGitRepo(root);
  const marker = join(root, "ssh-command-ran");
  const helper = join(root, "ssh-command-marker.sh");
  await writeFile(helper, `#!/bin/sh\nprintf ssh > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(helper, 0o755);
  runGit(["remote", "add", "origin", "ssh://git@127.0.0.1:1/private/repo.git"], root);
  runGit(["config", "branch.main.remote", "origin"], root);
  runGit(["config", "branch.main.merge", "refs/heads/main"], root);
  runGit(["config", "core.sshCommand", helper], root);

  const result = await refreshGitRepoRemote({
    key: "Fixture::root",
    absolute_path: root,
    expected_branch: "main",
    repo: "ssh://git@127.0.0.1:1/private/repo.git",
  });

  expect(result.ok).toBe(false);
  expect(existsSync(marker)).toBe(false);
});

posixTest("remote refresh blocks git protocol before a checkout-local core.gitProxy runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-git-proxy-"));
  tempRoots.push(root);
  await initGitRepo(root);
  const marker = join(root, "git-proxy-ran");
  const helper = join(root, "git-proxy-marker.sh");
  await writeFile(helper, `#!/bin/sh\nprintf proxy > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(helper, 0o755);
  runGit(["remote", "add", "origin", "git://127.0.0.1:1/private/repo.git"], root);
  runGit(["config", "branch.main.remote", "origin"], root);
  runGit(["config", "branch.main.merge", "refs/heads/main"], root);
  runGit(["config", "core.gitProxy", helper], root);

  const result = await refreshGitRepoRemote({
    key: "Fixture::root",
    absolute_path: root,
    expected_branch: "main",
    repo: "git://127.0.0.1:1/private/repo.git",
  });

  expect(result.ok).toBe(false);
  expect(existsSync(marker)).toBe(false);
});

test("remote refresh treats a checkout-local URL rewrite as a source mismatch before fetching", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-url-rewrite-"));
  tempRoots.push(root);
  const manifestRemote = "https://example.invalid/manifest.git";
  await initGitRepo(root);
  runGit(["remote", "add", "origin", manifestRemote], root);
  runGit(["config", "branch.main.remote", "origin"], root);
  runGit(["config", "branch.main.merge", "refs/heads/main"], root);
  runGit(["config", "url.file:///attacker/.insteadOf", manifestRemote], root);

  const result = await refreshGitRepoRemote({
    key: "Fixture::root",
    absolute_path: root,
    expected_branch: "main",
    repo: manifestRemote,
  });

  expect(result).toMatchObject({
    ok: false,
    code: "pull_source_invalid",
    error: "pull_source_identity_mismatch",
  });
});

test("git status routes every checkout Git child through the safe policy wrappers", async () => {
  const source = await readFile(join(import.meta.dir, "git-status-lib.mjs"), "utf8");
  expect(source).not.toContain("runGit([");
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

test("repo status recognizes an apply-backend rebase and allows only its guarded rebase abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-apply-rebase-"));
  tempRoots.push(root);
  await initGitRepo(root);
  await startConflictingApplyRebase(root);

  const repo = { key: "Fixture::root", absolute_path: root, expected_branch: "main" };
  const blocked = await readGitRepoStatus(repo);
  expect(blocked.status).toBe("rebase_in_progress");
  expect(blocked.operation).toEqual({ kind: "rebase", backend: "apply", can_abort_rebase: true });

  const aborted = await abortRepoRebase(repo);
  expect(aborted.ok).toBe(true);
  expect(aborted.after.operation).toBeNull();
});

test("repo status classifies git am separately and never offers rebase abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-status-git-am-"));
  tempRoots.push(root);
  await initGitRepo(root);
  await startConflictingGitAm(root);

  const repo = { key: "Fixture::root", absolute_path: root, expected_branch: "main" };
  const blocked = await readGitRepoStatus(repo);
  expect(blocked.status).toBe("git_am_in_progress");
  expect(blocked.operation).toEqual({ kind: "am", backend: "apply", can_abort_rebase: false });

  const refused = await abortRepoRebase(repo);
  expect(refused.ok).toBe(false);
  expect(refused.code).toBe("rebase_not_in_progress");
  expect((await readGitRepoStatus(repo)).status).toBe("git_am_in_progress");
  runGit(["am", "--abort"], root);
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

test("fast-forward pull rejects a remote redirected after preflight and never applies the foreign descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-pull-source-race-"));
  tempRoots.push(root);
  const repoPath = join(root, "repo");
  const expectedRemote = join(root, "expected.git");
  const wrongRemote = join(root, "wrong.git");
  await initGitRepo(repoPath, { remotePath: expectedRemote });

  const expectedContributor = join(root, "expected-contributor");
  runGit(["clone", expectedRemote, expectedContributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], expectedContributor);
  configureFixtureUser(expectedContributor);
  await writeFile(join(expectedContributor, "expected.md"), "expected payload\n");
  runGit(["add", "expected.md"], expectedContributor);
  runGit(["commit", "-m", "expected update"], expectedContributor);
  runGit(["push", "origin", "main"], expectedContributor);

  const wrongContributor = join(root, "wrong-contributor");
  runGit(["clone", expectedRemote, wrongContributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], wrongContributor);
  configureFixtureUser(wrongContributor);
  await writeFile(join(wrongContributor, "foreign.md"), "foreign payload\n");
  runGit(["add", "foreign.md"], wrongContributor);
  runGit(["commit", "-m", "foreign descendant"], wrongContributor);
  runGit(["init", "--bare", wrongRemote], root);
  runGit(["remote", "set-url", "origin", wrongRemote], wrongContributor);
  runGit(["push", "-u", "origin", "main"], wrongContributor);

  const originalHead = runGit(["rev-parse", "HEAD"], repoPath);
  const result = await pullRepoFastForward(
    {
      key: "Fixture::repo",
      absolute_path: repoPath,
      expected_branch: "main",
      repo: expectedRemote,
    },
    {
      beforeMutation: async () => {
        runGit(["remote", "set-url", "origin", wrongRemote], repoPath);
      },
    },
  );

  expect(result.ok).toBe(false);
  expect(result.code).toBe("pull_source_changed");
  expect(runGit(["rev-parse", "HEAD"], repoPath)).toBe(originalHead);
  expect(await Bun.file(join(repoPath, "foreign.md")).exists()).toBe(false);
});

test("fast-forward pull refuses a draft introduced after verified preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-pull-clean-race-"));
  tempRoots.push(root);
  const repoPath = join(root, "repo");
  const remote = join(root, "remote.git");
  await initGitRepo(repoPath, { remotePath: remote });

  const contributor = join(root, "contributor");
  runGit(["clone", remote, contributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  configureFixtureUser(contributor);
  await writeFile(join(contributor, "remote.md"), "remote payload\n");
  runGit(["add", "remote.md"], contributor);
  runGit(["commit", "-m", "remote update"], contributor);
  runGit(["push", "origin", "main"], contributor);

  const originalHead = runGit(["rev-parse", "HEAD"], repoPath);
  const result = await pullRepoFastForward(
    {
      key: "Fixture::repo",
      absolute_path: repoPath,
      expected_branch: "main",
      repo: remote,
    },
    {
      beforeMutation: async () => {
        await writeFile(join(repoPath, "local-draft.md"), "preserve this draft\n");
      },
    },
  );

  expect(result).toMatchObject({ ok: false, code: "pull_checkout_changed" });
  expect(runGit(["rev-parse", "HEAD"], repoPath)).toBe(originalHead);
  expect(await Bun.file(join(repoPath, "remote.md")).exists()).toBe(false);
  expect(normalizeLineEndings(await readFile(join(repoPath, "local-draft.md"), "utf8"))).toBe("preserve this draft\n");
});

test("autostash pull restores local work when the manifest source changes before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-autostash-source-race-"));
  tempRoots.push(root);
  const repoPath = join(root, "repo");
  const expectedRemote = join(root, "expected.git");
  const wrongRemote = join(root, "wrong.git");
  await initGitRepo(repoPath, { remotePath: expectedRemote });

  const contributor = join(root, "contributor");
  runGit(["clone", expectedRemote, contributor], root);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  configureFixtureUser(contributor);
  await writeFile(join(contributor, "expected.md"), "expected payload\n");
  runGit(["add", "expected.md"], contributor);
  runGit(["commit", "-m", "expected update"], contributor);
  runGit(["push", "origin", "main"], contributor);
  runGit(["init", "--bare", wrongRemote], root);
  await writeFile(join(repoPath, "local.md"), "preserve local work\n");

  const originalHead = runGit(["rev-parse", "HEAD"], repoPath);
  const result = await pullRepoWithAutostash(
    {
      key: "Fixture::repo",
      absolute_path: repoPath,
      expected_branch: "main",
      repo: expectedRemote,
    },
    {
      beforeMutation: async () => {
        runGit(["remote", "set-url", "origin", wrongRemote], repoPath);
      },
    },
  );

  expect(result.ok).toBe(false);
  expect(result.code).toBe("pull_source_changed");
  expect(runGit(["rev-parse", "HEAD"], repoPath)).toBe(originalHead);
  expect(normalizeLineEndings(await readFile(join(repoPath, "local.md"), "utf8"))).toBe("preserve local work\n");
  expect(runGit(["stash", "list"], repoPath)).toBe("");
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
    repo: remote,
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

posixTest("pull never executes a post-merge hook planted in the checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-pull-hooks-"));
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
  const marker = join(repo, "hook-ran");
  const hook = join(repo, ".git", "hooks", "post-merge");
  await mkdir(join(repo, ".git", "hooks"), { recursive: true });
  await writeFile(hook, `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`);
  await chmod(hook, 0o755);
  await writeFile(join(repo, "local-draft.md"), "draft\n");

  const result = await pullRepoWithAutostash({
    key: "Fixture::repo",
    absolute_path: repo,
    expected_branch: "main",
    repo: remote,
  });

  expect(result.ok).toBe(true);
  expect(normalizeLineEndings(await readFile(join(repo, "remote.md"), "utf8"))).toBe("remote change\n");
  expect(existsSync(marker)).toBe(false);
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
    repo: remote,
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

function configureFixtureUser(repo) {
  runGit(["config", "user.email", "fixture@example.com"], repo);
  runGit(["config", "user.name", "Fixture"], repo);
}
