import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  acquireUpdateLock,
  classifyLazurioRepoUpdate,
  readLazurioUpdateStatus,
  runLazurioUpdate,
  updateManagedRepo,
} from "./lazurio-update-lib.mjs";
import { runGit as runGitAsync } from "./git-lib.mjs";
import {
  createLaunchpadGitFixture,
  initGitRepo,
  setOrganizationRepository,
  writeJson,
} from "./git-fixture-helpers.test.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("pure classifier has only current, updated and blocked outcomes", () => {
  const cases = [
    [{}, ["current", "already_current"]],
    [{ directoryOnly: true }, ["current", "directory_only"]],
    [{ mainRelation: "behind" }, ["updated", "fast_forward_available"]],
    [{ branch: "feature" }, ["updated", "main_checkout_required"]],
    [{ dirty: true }, ["updated", "local_changes_preserved"]],
    [{ mainRelation: "ahead" }, ["blocked", "local_main_commits"]],
    [{ mainRelation: "diverged" }, ["blocked", "main_diverged"]],
    [{ operation: "merge" }, ["blocked", "merge_in_progress"]],
    [{ operation: "rebase" }, ["blocked", "rebase_in_progress"]],
    [{ operation: "am" }, ["blocked", "am_in_progress"]],
    [{ detached: true }, ["blocked", "detached_head"]],
    [{ sparseOrHiddenIndex: true }, ["blocked", "hidden_index_state"]],
    [{ expectedBranch: "v3" }, ["blocked", "managed_branch_not_main"]],
  ];
  for (const [input, expected] of cases) {
    const result = classifyLazurioRepoUpdate(input);
    expect([result.state, result.reason]).toEqual(expected);
    expect(["current", "updated", "blocked"]).toContain(result.state);
  }
});

test("clean behind checkout fast-forwards and rerun is idempotent", async () => {
  const fixture = await repositoryFixture("behind");
  await addRemoteCommit(fixture, "remote.txt", "remote\n");

  const first = await update(fixture);
  expect(first).toMatchObject({ state: "updated", actions: expect.arrayContaining(["fast_forward"]) });
  expect(await branch(fixture.working)).toBe("main");
  expect(status(fixture.working)).toBe("");
  expect(await readFile(join(fixture.working, "remote.txt"), "utf8")).toBe("remote\n");

  const second = await update(fixture);
  expect(second).toMatchObject({ state: "current", reason: "already_current" });
});

test("frozen Bun install runs only for an updated repo with package and lockfile", async () => {
  const plain = await repositoryFixture("plain-no-install");
  await addRemoteCommit(plain, "remote.txt", "remote\n");
  let plainInstalls = 0;
  const plainResult = await updateManagedRepo(descriptor(plain), {
    runId: "plain-install-check",
    deps: { installDependencies: async () => { plainInstalls += 1; return { ok: true }; } },
  });
  expect(plainResult.state).toBe("updated");
  expect(plainInstalls).toBe(0);

  const locked = await repositoryFixture("locked-install");
  await addRemoteFiles(locked, {
    "package.json": "{\"name\":\"fixture\",\"private\":true}\n",
    "bun.lock": "# fixture\n",
  }, "add frozen package");
  let lockedInstalls = 0;
  const lockedResult = await updateManagedRepo(descriptor(locked), {
    runId: "locked-install-check",
    deps: {
      installDependencies: async () => {
        lockedInstalls += 1;
        return { ok: false, detail: "simulated frozen install failure" };
      },
    },
  });
  expect(lockedInstalls).toBe(1);
  expect(lockedResult).toMatchObject({
    state: "blocked",
    reason: "dependency_install_failed",
    actions: ["fast_forward"],
    message: "simulated frozen install failure",
  });
  expect(status(locked.working)).toBe("");
  expect(runGit(locked.working, ["rev-parse", "HEAD"]))
    .toBe(runGit(locked.working, ["rev-parse", "refs/remotes/origin/main"]));
});

test("successful frozen install may not leave the checkout dirty", async () => {
  const fixture = await repositoryFixture("install-dirties-checkout");
  await addRemoteFiles(fixture, {
    "package.json": "{\"name\":\"fixture\",\"private\":true}\n",
    "bun.lock": "# fixture\n",
  }, "add package");

  const result = await updateManagedRepo(descriptor(fixture), {
    runId: "dirty-install-check",
    deps: {
      installDependencies: async ({ cwd }) => {
        await writeFile(join(cwd, "tracked.txt"), "postinstall mutation\n");
        return { ok: true };
      },
    },
  });

  expect(result).toMatchObject({
    state: "blocked",
    reason: "dependency_install_changed_checkout",
    actions: ["fast_forward", "frozen_bun_install"],
  });
  expect(status(fixture.working)).toContain("tracked.txt");
});

test("dirty tracked, untracked and binary work is verified in a recovery stash and never restored", async () => {
  const fixture = await repositoryFixture("dirty");
  await addRemoteCommit(fixture, "remote.txt", "remote\n");
  await writeFile(join(fixture.working, "tracked.txt"), "local draft\n");
  await writeFile(join(fixture.working, "untracked.bin"), Buffer.from([0, 1, 2, 255]));

  const result = await update(fixture);
  expect(result).toMatchObject({
    state: "updated",
    reason: "local_changes_preserved",
    actions: expect.arrayContaining(["recovery_stash", "fast_forward"]),
  });
  expect(result.recovery_stash).toMatch(/^[0-9a-f]{40}$/);
  expect(status(fixture.working)).toBe("");
  expect(await readFile(join(fixture.working, "tracked.txt"), "utf8")).toBe("tracked\n");
  expect(runGit(fixture.working, ["stash", "show", "--include-untracked", "--name-only", result.recovery_stash]))
    .toContain("untracked.bin");
  expect(runGit(fixture.working, ["stash", "list", "--format=%H"]))
    .toContain(result.recovery_stash);
});

test("foreign stashes survive and the engine never uses destructive Git commands", async () => {
  const fixture = await repositoryFixture("foreign-stash");
  await writeFile(join(fixture.working, "foreign.txt"), "foreign draft\n");
  runGit(fixture.working, ["stash", "push", "--include-untracked", "--message", "foreign"]);
  const foreignStash = runGit(fixture.working, ["rev-parse", "refs/stash"]);
  await addRemoteCommit(fixture, "remote.txt", "remote\n");
  await writeFile(join(fixture.working, "tracked.txt"), "new local draft\n");
  const commands = [];

  const result = await updateManagedRepo(descriptor(fixture), {
    runId: "audit-run",
    deps: {
      runGit: async (args, options) => {
        commands.push(args);
        return runGitAsync(args, options);
      },
      installDependencies: async () => ({ ok: true }),
    },
  });

  expect(result.state).toBe("updated");
  const stashList = runGit(fixture.working, ["stash", "list", "--format=%H"]);
  expect(stashList).toContain(result.recovery_stash);
  expect(stashList).toContain(foreignStash);
  expect(commands.some(([command]) => ["push", "reset", "rebase", "merge"].includes(command))).toBe(false);
  expect(commands.some(([command, action]) => command === "stash" && ["pop", "apply", "drop", "clear"].includes(action))).toBe(false);
  const pull = commands.find(([command]) => command === "pull");
  expect(pull).toEqual(expect.arrayContaining(["--ff-only", "--no-rebase"]));
});

test("a remote redirected immediately before pull cannot inject a foreign descendant", async () => {
  const fixture = await repositoryFixture("remote-race");
  await addRemoteCommit(fixture, "expected.txt", "expected\n");
  const wrongRemote = join(fixture.sandbox, "wrong.git");
  const wrongContributor = join(fixture.sandbox, "wrong-contributor");
  runGit(fixture.sandbox, ["clone", fixture.remote, wrongContributor]);
  configure(wrongContributor);
  await writeFile(join(wrongContributor, "foreign.txt"), "foreign\n");
  runGit(wrongContributor, ["add", "foreign.txt"]);
  runGit(wrongContributor, ["commit", "-m", "foreign descendant"]);
  runGit(fixture.sandbox, ["init", "--bare", wrongRemote]);
  runGit(wrongContributor, ["remote", "set-url", "origin", wrongRemote]);
  runGit(wrongContributor, ["push", "-u", "origin", "main"]);
  let redirected = false;

  const result = await updateManagedRepo(descriptor(fixture), {
    runId: "remote-race",
    deps: {
      runGit: async (args, options) => {
        if (!redirected && args[0] === "pull") {
          redirected = true;
          runGit(fixture.working, ["remote", "set-url", "origin", wrongRemote]);
        }
        return runGitAsync(args, options);
      },
      installDependencies: async () => ({ ok: true }),
    },
  });

  expect(result).toMatchObject({ state: "blocked", reason: "post_update_verification_failed" });
  expect(await readFile(join(fixture.working, "expected.txt"), "utf8")).toBe("expected\n");
  expect(existsSync(join(fixture.working, "foreign.txt"))).toBe(false);
});

test("a remote advance after fetch waits for the next run instead of changing the verified target", async () => {
  const fixture = await repositoryFixture("remote-advance");
  await addRemoteCommit(fixture, "expected.txt", "expected\n");
  let advanced = false;

  const result = await updateManagedRepo(descriptor(fixture), {
    runId: "remote-advance",
    deps: {
      runGit: async (args, options) => {
        if (!advanced && args[0] === "pull") {
          advanced = true;
          await writeFile(join(fixture.contributor, "later.txt"), "later\n");
          runGit(fixture.contributor, ["add", "later.txt"]);
          runGit(fixture.contributor, ["commit", "-m", "later remote advance"]);
          runGit(fixture.contributor, ["push", "origin", "main"]);
        }
        return runGitAsync(args, options);
      },
      installDependencies: async () => ({ ok: true }),
    },
  });

  expect(result.state).toBe("updated");
  expect(await readFile(join(fixture.working, "expected.txt"), "utf8")).toBe("expected\n");
  expect(existsSync(join(fixture.working, "later.txt"))).toBe(false);
  const next = await update(fixture);
  expect(next.state).toBe("updated");
  expect(await readFile(join(fixture.working, "later.txt"), "utf8")).toBe("later\n");
});

test("crash after verified stash preserves recovery and a rerun completes", async () => {
  const fixture = await repositoryFixture("crash-after-stash");
  await addRemoteCommit(fixture, "remote.txt", "remote\n");
  await writeFile(join(fixture.working, "tracked.txt"), "interrupted draft\n");
  const first = await runLazurioUpdate({
    rootPath: fixture.working,
    runtimeRoot: join(fixture.sandbox, "runtime"),
    deps: {
      runId: "crash-run",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => ({ repos: [], warnings: [] }),
      installDependencies: async () => ({ ok: true }),
      checkpoint: async (name) => {
        if (name === "after_stash") throw new Error("simulated crash");
      },
    },
  });
  expect(first).toMatchObject({ state: "blocked", results: [{ reason: "update_internal_error" }] });
  const preserved = runGit(fixture.working, ["rev-parse", "refs/stash"]);
  expect(preserved).toMatch(/^[0-9a-f]{40}$/);
  expect(status(fixture.working)).toBe("");

  const second = await runLazurioUpdate({
    rootPath: fixture.working,
    runtimeRoot: join(fixture.sandbox, "runtime"),
    deps: {
      runId: "retry-run",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => ({ repos: [], warnings: [] }),
      installDependencies: async () => ({ ok: true }),
    },
  });
  expect(second.state).toBe("updated");
  expect(runGit(fixture.working, ["stash", "list", "--format=%H"])).toContain(preserved);
  expect(await readFile(join(fixture.working, "remote.txt"), "utf8")).toBe("remote\n");
});

test("crashes after switch or fast-forward remain recoverable by a plain rerun", async () => {
  for (const checkpointName of ["after_switch_main", "after_fast_forward"]) {
    const fixture = await repositoryFixture(`crash-${checkpointName}`);
    await addRemoteCommit(fixture, "remote.txt", "remote\n");
    if (checkpointName === "after_switch_main") runGit(fixture.working, ["switch", "-c", "agent/task"]);
    const first = await runLazurioUpdate({
      rootPath: fixture.working,
      runtimeRoot: join(fixture.sandbox, "runtime"),
      deps: {
        runId: checkpointName,
        acquireLock: async () => ({ release: async () => {} }),
        buildInventory: async () => ({ repos: [], warnings: [] }),
        installDependencies: async () => ({ ok: true }),
        checkpoint: async (name) => {
          if (name === checkpointName) throw new Error(`simulated ${name} crash`);
        },
      },
    });
    expect(first).toMatchObject({ state: "blocked", results: [{ reason: "update_internal_error" }] });

    const second = await runLazurioUpdate({
      rootPath: fixture.working,
      runtimeRoot: join(fixture.sandbox, "runtime"),
      deps: {
        runId: `${checkpointName}-retry`,
        acquireLock: async () => ({ release: async () => {} }),
        buildInventory: async () => ({ repos: [], warnings: [] }),
        installDependencies: async () => ({ ok: true }),
      },
    });
    expect(second.state).toBe(checkpointName === "after_fast_forward" ? "current" : "updated");
    expect(await branch(fixture.working)).toBe("main");
    expect(status(fixture.working)).toBe("");
    expect(await readFile(join(fixture.working, "remote.txt"), "utf8")).toBe("remote\n");
  }
});

test("wrong primary branch returns to main without losing its commit", async () => {
  const fixture = await repositoryFixture("branch");
  runGit(fixture.working, ["switch", "-c", "agent/task"]);
  await writeFile(join(fixture.working, "feature.txt"), "feature\n");
  runGit(fixture.working, ["add", "feature.txt"]);
  runGit(fixture.working, ["commit", "-m", "feature"]);
  const featureHead = runGit(fixture.working, ["rev-parse", "HEAD"]);

  const result = await update(fixture);
  expect(result).toMatchObject({ state: "updated", actions: expect.arrayContaining(["switch_main"]) });
  expect(await branch(fixture.working)).toBe("main");
  expect(runGit(fixture.working, ["rev-parse", "agent/task"])).toBe(featureHead);
  expect(status(fixture.working)).toBe("");
});

test("local main commits and diverged history block with a Codex prompt", async () => {
  const ahead = await repositoryFixture("ahead");
  await writeFile(join(ahead.working, "ahead.txt"), "ahead\n");
  runGit(ahead.working, ["add", "ahead.txt"]);
  runGit(ahead.working, ["commit", "-m", "ahead"]);
  await writeFile(join(ahead.working, "unfinished.txt"), "unfinished\n");
  const aheadHead = runGit(ahead.working, ["rev-parse", "HEAD"]);
  const aheadResult = await update(ahead);
  const aheadStash = aheadResult.recovery_stash;
  expect(aheadResult).toMatchObject({
    state: "blocked",
    reason: "local_main_commits",
    actions: ["recovery_stash"],
    next_action: { kind: "codex" },
  });
  expect(aheadStash).toMatch(/^[0-9a-f]{40}$/);
  expect(aheadResult.next_action.prompt).toContain(ahead.working);
  expect(runGit(ahead.working, ["rev-parse", "HEAD"])).toBe(aheadHead);
  expect(status(ahead.working)).toBe("");
  expect(runGit(ahead.working, ["stash", "show", "--include-untracked", "--name-only", aheadStash]))
    .toContain("unfinished.txt");

  const diverged = await repositoryFixture("diverged");
  await writeFile(join(diverged.working, "local.txt"), "local\n");
  runGit(diverged.working, ["add", "local.txt"]);
  runGit(diverged.working, ["commit", "-m", "local"]);
  await addRemoteCommit(diverged, "remote.txt", "remote\n");
  const divergedResult = await update(diverged);
  expect(divergedResult).toMatchObject({ state: "blocked", reason: "main_diverged" });
});

test("an actual merge in progress blocks without changing Git state", async () => {
  const fixture = await repositoryFixture("merge-in-progress");
  runGit(fixture.working, ["switch", "-c", "conflict"]);
  await writeFile(join(fixture.working, "tracked.txt"), "branch version\n");
  runGit(fixture.working, ["add", "tracked.txt"]);
  runGit(fixture.working, ["commit", "-m", "branch conflict"]);
  runGit(fixture.working, ["switch", "main"]);
  await writeFile(join(fixture.working, "tracked.txt"), "main version\n");
  runGit(fixture.working, ["add", "tracked.txt"]);
  runGit(fixture.working, ["commit", "-m", "main conflict"]);
  const merge = runGitResult(fixture.working, ["merge", "conflict"]);
  expect(merge.status).not.toBe(0);
  const mergeHead = runGit(fixture.working, ["rev-parse", "MERGE_HEAD"]);

  const result = await update(fixture);
  expect(result).toMatchObject({ state: "blocked", reason: "merge_in_progress", next_action: { kind: "codex" } });
  expect(runGit(fixture.working, ["rev-parse", "MERGE_HEAD"])).toBe(mergeHead);
  expect(status(fixture.working)).toContain("UU tracked.txt");
});

test("actual rebase and git am operations stay blocked and untouched", async () => {
  const rebasing = await repositoryFixture("rebase-in-progress");
  await writeFile(join(rebasing.working, "tracked.txt"), "local main version\n");
  runGit(rebasing.working, ["add", "tracked.txt"]);
  runGit(rebasing.working, ["commit", "-m", "local main conflict"]);
  await addRemoteCommit(rebasing, "tracked.txt", "remote main version\n");
  const rebase = runGitResult(rebasing.working, ["pull", "--rebase", "origin", "main"]);
  expect(rebase.status).not.toBe(0);
  const rebaseHead = runGit(rebasing.working, ["rev-parse", "HEAD"]);
  const rebaseResult = await update(rebasing);
  expect(rebaseResult).toMatchObject({ state: "blocked", reason: "rebase_in_progress" });
  expect(runGit(rebasing.working, ["rev-parse", "HEAD"])).toBe(rebaseHead);

  const applying = await repositoryFixture("am-in-progress");
  await writeFile(join(applying.contributor, "tracked.txt"), "patch version\n");
  runGit(applying.contributor, ["add", "tracked.txt"]);
  runGit(applying.contributor, ["commit", "-m", "patch conflict"]);
  const patch = runGitResult(applying.contributor, ["format-patch", "-1", "--stdout"]);
  expect(patch.status).toBe(0);
  const patchPath = join(applying.sandbox, "conflict.patch");
  await writeFile(patchPath, patch.stdout);
  await writeFile(join(applying.working, "tracked.txt"), "working version\n");
  runGit(applying.working, ["add", "tracked.txt"]);
  runGit(applying.working, ["commit", "-m", "working conflict"]);
  const am = runGitResult(applying.working, ["am", patchPath]);
  expect(am.status).not.toBe(0);
  const amHead = runGit(applying.working, ["rev-parse", "HEAD"]);
  const amResult = await update(applying);
  expect(amResult).toMatchObject({ state: "blocked", reason: "am_in_progress" });
  expect(runGit(applying.working, ["rev-parse", "HEAD"])).toBe(amHead);
});

test("hierarchy is sequential and excludes root-space db and productionspace", async () => {
  const calls = [];
  const inventory = {
    repos: [
      repo("beta::root", "organization_root", "beta", "root"),
      repo("alpha::root", "organization_root", "alpha", "root"),
      repo("alpha::module", "module", "alpha", "module", "workspace"),
      repo("alpha::db", "root_repo", "alpha", "db", null),
      repo("alpha::production", "module", "alpha", "production", "productionspace"),
    ],
    warnings: [],
  };
  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "hierarchy",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => inventory,
      updateRepo: async (item) => {
        calls.push(item.key);
        return { ...identity(item), state: "current", reason: "already_current", message: "current" };
      },
    },
  });
  expect(report.state).toBe("current");
  expect(calls).toEqual(["lazurio::root", "alpha::root", "alpha::module", "beta::root"]);
  expect(JSON.stringify(report)).not.toContain("alpha::db");
  expect(JSON.stringify(report)).not.toContain("alpha::production");
});

test("fresh Organization manifest materializes its new Workspace Module while excluded scopes stay byte-identical", async () => {
  const root = await createLaunchpadGitFixture();
  cleanup.push(root);
  await rm(join(root, "organizations", "OmegaCo_GEN3"), { recursive: true, force: true });
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const organizationRemote = join(root, "remotes", "beta-root.git");
  const moduleRemote = join(root, "remotes", "new-module.git");
  const excludedSlots = [
    {
      path: "productionspace/firmware",
      repo: join(root, "remotes", "firmware.git"),
      branch: "main",
    },
    {
      path: "mission-control/db",
      space: "root",
      git: { url: join(root, "remotes", "mission-control-data.git"), branch: "v3" },
    },
  ];
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: excludedSlots,
  });
  await writeFile(
    join(organizationRoot, ".gitignore"),
    "/workspace/*/\n/productionspace/\n/mission-control/db/\n/.worktrees/\n",
  );
  await initGitRepo(organizationRoot, { remotePath: organizationRemote });
  await setOrganizationRepository({
    root,
    orgPath: "organizations/BetaCo_GEN3",
    repo: organizationRemote,
  });
  runGit(organizationRoot, ["add", "."]);
  runGit(organizationRoot, ["commit", "-m", "organization baseline"]);
  runGit(organizationRoot, ["push", "origin", "main"]);
  runGit(root, ["--git-dir", organizationRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const source = join(root, "sources", "new-module");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(source, { remotePath: moduleRemote });
  const contributor = join(root, "contributors", "beta-root");
  await mkdir(join(root, "contributors"), { recursive: true });
  runGit(root, ["clone", organizationRemote, contributor]);
  configure(contributor);
  await writeJson(join(contributor, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [
      ...excludedSlots,
      {
        path: "workspace/new-module",
        teams: ["builders"],
        git: { url: moduleRemote, branch: "main" },
      },
    ],
  });
  runGit(contributor, ["add", "modules.manifest.json"]);
  runGit(contributor, ["commit", "-m", "declare new Workspace Module"]);
  runGit(contributor, ["push", "origin", "main"]);

  const excludedPaths = [
    join(organizationRoot, "productionspace", "firmware"),
    join(organizationRoot, "mission-control", "db"),
    join(organizationRoot, ".worktrees", "task"),
    join(root, "personalspace", "owner"),
  ];
  await initGitRepo(excludedPaths[0]);
  await initGitRepo(excludedPaths[1], { branch: "v3" });
  await mkdir(excludedPaths[2], { recursive: true });
  await mkdir(excludedPaths[3], { recursive: true });
  await writeFile(join(excludedPaths[2], "marker.bin"), Buffer.from([0, 7, 255]));
  await writeFile(join(excludedPaths[3], "marker.bin"), Buffer.from([1, 8, 254]));
  const beforeExcluded = await Promise.all(excludedPaths.map(snapshotPath));

  const report = await runLazurioUpdate({
    rootPath: root,
    runtimeRoot: join(root, "..", "runtime"),
    deps: {
      runId: "fresh-manifest",
      acquireLock: async () => ({ release: async () => {} }),
      updateRepo: async (item, context) => item.key === "lazurio::root"
        ? { ...identity(item), state: "current", reason: "already_current", message: "current" }
        : updateManagedRepo(item, context),
      installDependencies: async () => ({ ok: true }),
    },
  });

  expect(report.state).toBe("updated");
  expect(report.results.find((item) => item.repo_key === "BetaCo::root").state).toBe("updated");
  expect(report.results.find((item) => item.repo_key === "BetaCo::new-module"))
    .toMatchObject({ state: "updated", reason: "module_materialized" });
  expect(await readFile(join(organizationRoot, "workspace", "new-module", "README.md"), "utf8"))
    .toContain("# main");
  expect(await Promise.all(excludedPaths.map(snapshotPath))).toEqual(beforeExcluded);
  expect(JSON.stringify(report)).not.toContain("mission-control-data");
  expect(JSON.stringify(report)).not.toContain("firmware");
});

test("blocked parent defers descendants while safe sibling continues", async () => {
  const inventory = {
    repos: [
      repo("alpha::root", "organization_root", "alpha", "root"),
      repo("alpha::module", "module", "alpha", "module", "workspace"),
      repo("beta::root", "organization_root", "beta", "root"),
      repo("beta::module", "module", "beta", "module", "workspace"),
    ],
    warnings: [],
  };
  const calls = [];
  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "parents",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => inventory,
      updateRepo: async (item) => {
        calls.push(item.key);
        if (item.key === "alpha::root") return { ...identity(item), state: "blocked", reason: "main_diverged", message: "blocked" };
        return { ...identity(item), state: "updated", reason: "checkout_updated", message: "updated" };
      },
    },
  });
  expect(calls).toEqual(["lazurio::root", "alpha::root", "beta::root", "beta::module"]);
  expect(report.results.find((item) => item.repo_key === "alpha::module"))
    .toMatchObject({ state: "blocked", reason: "parent_blocked" });
  expect(report.results.find((item) => item.repo_key === "beta::module").state).toBe("updated");
  expect(report.state).toBe("blocked");
});

test("inventory failure blocks instead of silently reporting current", async () => {
  const calls = [];
  const report = await runLazurioUpdate({
    rootPath: "/working",
    runtimeRoot: "/runtime",
    deps: {
      runId: "inventory-failure",
      acquireLock: async () => ({ release: async () => {} }),
      buildInventory: async () => { throw new Error("invalid manifest"); },
      updateRepo: async (item) => {
        calls.push(item.key);
        return { ...identity(item), state: "current", reason: "already_current", message: "current" };
      },
    },
  });
  expect(calls).toEqual(["lazurio::root"]);
  expect(report).toMatchObject({ state: "blocked", summary: { blocked: 1 } });
  expect(report.results.at(-1)).toMatchObject({ repo_key: "lazurio::inventory", reason: "inventory_unavailable" });
  expect(report.warnings.join(" ")).toContain("invalid manifest");
});

test("a dead-process lock is recovered once so the same command can be rerun", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "lazurio-stale-lock-root-"));
  cleanup.push(rootPath);
  const digest = createHash("sha256").update(rootPath).digest("hex").slice(0, 20);
  const lockPath = join(tmpdir(), `lazurio-update-${digest}.lock`);
  cleanup.push(lockPath);
  await writeFile(lockPath, JSON.stringify({
    root: rootPath,
    run_id: "dead-run",
    pid: 2_147_483_647,
    started_at: "2026-08-20T00:00:00.000Z",
  }));

  const lock = await acquireUpdateLock({
    rootPath,
    runId: "rerun",
    now: () => new Date("2026-08-20T12:00:00.000Z"),
  });
  expect(lock.path).toBe(lockPath);
  await lock.release();
  expect(existsSync(lockPath)).toBe(false);
});

test("runtime inside the working root blocks before lock or Git mutation", async () => {
  let locked = false;
  const report = await runLazurioUpdate({
    rootPath: "/workspace/Lazurio",
    runtimeRoot: "/workspace/Lazurio",
    deps: { acquireLock: async () => { locked = true; return { release: async () => {} }; } },
  });
  expect(report).toMatchObject({ state: "blocked", results: [{ reason: "runtime_not_isolated" }] });
  expect(locked).toBe(false);
});

test("GET-first status is no-fetch and exposes a Codex prompt for cached ahead main", async () => {
  const fixture = await repositoryFixture("local-status");
  await writeFile(join(fixture.working, "ahead.txt"), "ahead\n");
  runGit(fixture.working, ["add", "ahead.txt"]);
  runGit(fixture.working, ["commit", "-m", "ahead"]);
  const commands = [];

  const report = await readLazurioUpdateStatus({
    rootPath: fixture.working,
    deps: {
      buildInventory: async () => ({ repos: [], warnings: [] }),
      runGit: async (args, options) => {
        commands.push(args);
        return runGitAsync(args, options);
      },
    },
  });

  expect(report).toMatchObject({
    state: "blocked",
    checked_remote: false,
    reason: "local_main_commits",
    next_action: { kind: "codex", prompt: expect.stringContaining(fixture.working) },
  });
  expect(commands.some(([command]) => ["fetch", "pull", "push"].includes(command))).toBe(false);
});

async function repositoryFixture(name) {
  const sandbox = await mkdtemp(join(tmpdir(), `lazurio-update-${name}-`));
  cleanup.push(sandbox);
  const remote = join(sandbox, "remote.git");
  const seed = join(sandbox, "seed");
  const working = join(sandbox, "working");
  const contributor = join(sandbox, "contributor");
  runGit(sandbox, ["init", "--bare", remote]);
  runGit(sandbox, ["clone", remote, seed]);
  configure(seed);
  runGit(seed, ["switch", "-c", "main"]);
  await writeFile(join(seed, "tracked.txt"), "tracked\n");
  runGit(seed, ["add", "tracked.txt"]);
  runGit(seed, ["commit", "-m", "initial"]);
  runGit(seed, ["push", "-u", "origin", "main"]);
  runGit(sandbox, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  runGit(sandbox, ["clone", remote, working]);
  runGit(sandbox, ["clone", remote, contributor]);
  configure(working);
  configure(contributor);
  return { sandbox, remote, seed, working, contributor };
}

async function addRemoteCommit(fixture, path, content) {
  await writeFile(join(fixture.contributor, path), content);
  runGit(fixture.contributor, ["add", path]);
  runGit(fixture.contributor, ["commit", "-m", `remote ${path}`]);
  runGit(fixture.contributor, ["push", "origin", "main"]);
}

async function addRemoteFiles(fixture, files, message) {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(fixture.contributor, path), content);
  }
  runGit(fixture.contributor, ["add", ...Object.keys(files)]);
  runGit(fixture.contributor, ["commit", "-m", message]);
  runGit(fixture.contributor, ["push", "origin", "main"]);
}

async function update(fixture) {
  return updateManagedRepo(descriptor(fixture), { runId: "test-run", deps: { installDependencies: async () => ({ ok: true }) } });
}

function descriptor(fixture) {
  return {
    key: "test::root",
    repo_kind: "organization_root",
    organization: "test",
    module: "root",
    repo_path: "organizations/Test",
    absolute_path: fixture.working,
    expected_branch: "main",
    repo: fixture.remote,
  };
}

function repo(key, repoKind, organization, module, workspace = null) {
  return {
    key,
    repo_kind: repoKind,
    organization,
    module,
    workspace,
    repo_path: `/working/${key}`,
    absolute_path: process.cwd(),
    expected_branch: "main",
  };
}

function identity(item) {
  return {
    repo_key: item.key,
    repo_kind: item.repo_kind,
    organization: item.organization,
    module: item.module,
    path: item.repo_path,
  };
}

function configure(cwd) {
  runGit(cwd, ["config", "user.name", "Lazurio Test"]);
  runGit(cwd, ["config", "user.email", "lazurio@example.test"]);
}

function status(cwd) {
  return runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

async function snapshotPath(path) {
  if (existsSync(join(path, ".git"))) {
    return {
      head: runGit(path, ["rev-parse", "HEAD"]),
      status: status(path),
      marker: await readFile(join(path, "README.md"), "utf8"),
    };
  }
  return { marker: Buffer.from(await readFile(join(path, "marker.bin"))).toString("hex") };
}

async function branch(cwd) {
  return runGit(cwd, ["branch", "--show-current"]);
}

function runGit(cwd, args) {
  const result = runGitResult(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runGitResult(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
}
