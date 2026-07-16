import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initGitRepo, runGit, writeJson } from "./git-fixture-helpers.test.mjs";
import {
  deriveUpdateState,
  performRootUpdate,
  readRootUpdateStatus,
  readUpdateChannelConfig,
  selectHighestStableTag,
} from "./update-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("update channel config defaultuje na stable a neplatnou hodnotu viditelně varuje", async () => {
  const root = await temporaryRoot("launchpad-update-config-");
  expect(await readUpdateChannelConfig({ rootPath: root })).toMatchObject({
    channel: "stable",
    state: "defaulted",
    valid: true,
    warning: null,
  });

  await writeJson(join(root, "launchpad.gen3.local.json"), { update_channel: "preview" });
  expect(await readUpdateChannelConfig({ rootPath: root })).toMatchObject({
    channel: "stable",
    configured_value: "preview",
    state: "invalid",
    valid: false,
  });
  expect((await readUpdateChannelConfig({ rootPath: root })).warning).toContain("Neplatný update_channel");

  await writeJson(join(root, "launchpad.gen3.local.json"), { update_channel: "nightly" });
  expect(await readUpdateChannelConfig({ rootPath: root })).toMatchObject({
    channel: "nightly",
    state: "configured",
    valid: true,
  });
});

test("stable target vybírá nejvyšší čistý semver numericky a ignoruje prerelease", () => {
  expect(selectHighestStableTag([
    "v1.9.0",
    "v1.10.0",
    "v2.0.0-rc.1",
    "release-9",
    "v2.0.0",
    "v999999999999999999999.0.0",
  ])).toBe("v999999999999999999999.0.0");
  expect(selectHighestStableTag(["v1.0.0-beta.1", "latest"])).toBeNull();
});

test("update state machine pokrývá všechny bezpečnostní stavy a tracked dirty prioritu", () => {
  const cases = [
    [{ fetch_ok: false, branch: "main", channel: "stable" }, "fetch_failed"],
    [{ branch: "feature", channel: "stable" }, "wrong_branch"],
    [{ branch: "main", channel: "stable", target_available: false }, "no_release_tag"],
    [{ branch: "main", channel: "nightly", target_available: false }, "fetch_failed"],
    [{ branch: "main", channel: "stable", ahead: 2, behind: 1 }, "diverged"],
    [{ branch: "main", channel: "stable", ahead: 2, behind: 0 }, "ahead_of_channel_target"],
    [{ branch: "main", channel: "stable", tracked_changes: 1, behind: 2 }, "dirty_worktree"],
    [{ branch: "main", channel: "stable", behind: 2 }, "update_available"],
    [{ branch: "main", channel: "stable", ahead: 0, behind: 0 }, "up_to_date"],
  ];
  for (const [input, expected] of cases) {
    expect(deriveUpdateState(input).state).toBe(expected);
    expect(deriveUpdateState(input).message.length).toBeGreaterThan(10);
  }
  expect(deriveUpdateState({
    branch: "main",
    channel: "stable",
    tracked_changes: 1,
    behind: 2,
  }).can_update_with_autostash).toBe(true);
});

test("readRootUpdateStatus fetchne stable tag, zobrazí verzi a neblokuje untracked soubor", async () => {
  const fixture = await createUpdateFixture({ channel: "stable", targetTag: "v1.10.0" });
  await writeFile(join(fixture.repo, "local-note.txt"), "untracked draft\n");

  const status = await readRootUpdateStatus({ rootPath: fixture.repo });

  expect(status.state).toBe("update_available");
  expect(status.channel).toBe("stable");
  expect(status.target).toMatchObject({ ref: "v1.10.0", sha: fixture.targetCommit, version: "v1.10.0" });
  expect(status.version).toMatchObject({ head_sha: fixture.fromCommit, channel: "stable" });
  expect(status.counts).toMatchObject({ tracked_changes: 0, untracked_files: 1, ahead: 0, behind: 1 });
  expect(status.binary).toEqual({ state: "not_available" });
});

test("nightly target je origin/main a update provede jen ff-only i s untracked draftem", async () => {
  const fixture = await createUpdateFixture({ channel: "nightly", targetTag: null });
  await writeFile(join(fixture.repo, "local-note.txt"), "untracked draft\n");

  const result = await performRootUpdate({ rootPath: fixture.repo });

  expect(result.ok).toBe(true);
  expect(result.updated).toBe(true);
  expect(result.action).toBe("update_ff_only");
  expect(result.from_commit).toBe(fixture.fromCommit);
  expect(result.to_commit).toBe(fixture.targetCommit);
  expect(result.after.state).toBe("up_to_date");
  expect(await readFile(join(fixture.repo, "local-note.txt"), "utf8")).toBe("untracked draft\n");
});

test("tracked změny blokují default a explicitní autostash je po ff-only obnoví", async () => {
  const fixture = await createUpdateFixture({ channel: "stable", targetTag: "v1.1.0" });
  await writeFile(join(fixture.repo, "README.md"), "# lokální tracked draft\n");
  runGit(["add", "README.md"], fixture.repo);
  await writeFile(join(fixture.repo, "local-note.txt"), "untracked draft\n");

  const blocked = await performRootUpdate({ rootPath: fixture.repo });
  expect(blocked.ok).toBe(false);
  expect(blocked.state).toBe("dirty_worktree");
  expect(blocked.code).toBe("explicit_preserve_required");
  expect(runGit(["rev-parse", "HEAD"], fixture.repo)).toBe(fixture.fromCommit);

  const result = await performRootUpdate({ rootPath: fixture.repo, mode: "preserve_changes" });
  expect(result.ok).toBe(true);
  expect(result.autostash).toBe(true);
  expect(result.action).toBe("update_ff_only_with_autostash");
  expect(result.from_commit).toBe(fixture.fromCommit);
  expect(result.to_commit).toBe(fixture.targetCommit);
  expect(result.after.state).toBe("dirty_worktree");
  expect(await readFile(join(fixture.repo, "README.md"), "utf8")).toBe("# lokální tracked draft\n");
  expect(await readFile(join(fixture.repo, "local-note.txt"), "utf8")).toBe("untracked draft\n");
  expect(runGit(["diff", "--cached", "--name-only"], fixture.repo)).toBe("README.md");
  expect(runGit(["stash", "list"], fixture.repo)).toBe("");
});

test("stable bez release tagu nic nemění a vysvětlí nightly možnost", async () => {
  const fixture = await createUpdateFixture({ channel: "stable", targetTag: null });
  const status = await readRootUpdateStatus({ rootPath: fixture.repo });
  const result = await performRootUpdate({ rootPath: fixture.repo });

  expect(status.state).toBe("no_release_tag");
  expect(status.message).toContain("nightly");
  expect(result.ok).toBe(false);
  expect(result.state).toBe("no_release_tag");
  expect(runGit(["rev-parse", "HEAD"], fixture.repo)).toBe(fixture.fromCommit);
});

test("ahead target se nikdy nedowngradne a chybějící remote skončí fetch_failed", async () => {
  const fixture = await createUpdateFixture({ channel: "stable", targetTag: "v1.0.0", targetAhead: false });
  await writeFile(join(fixture.repo, "ahead.txt"), "ahead\n");
  runGit(["add", "ahead.txt"], fixture.repo);
  runGit(["commit", "-m", "lokální commit před kanálem"], fixture.repo);
  const aheadHead = runGit(["rev-parse", "HEAD"], fixture.repo);

  const ahead = await performRootUpdate({ rootPath: fixture.repo });
  expect(ahead.ok).toBe(false);
  expect(ahead.state).toBe("ahead_of_channel_target");
  expect(runGit(["rev-parse", "HEAD"], fixture.repo)).toBe(aheadHead);

  runGit(["remote", "set-url", "origin", join(fixture.base, "missing.git")], fixture.repo);
  const failed = await readRootUpdateStatus({ rootPath: fixture.repo });
  expect(failed.state).toBe("fetch_failed");
  expect(failed.fetch.ok).toBe(false);
});

async function temporaryRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function createUpdateFixture({ channel, targetTag, targetAhead = true }) {
  const base = await temporaryRoot("launchpad-root-update-");
  const repo = join(base, "root");
  const remote = join(base, "remote.git");
  await initGitRepo(repo, { remotePath: remote });
  await writeFile(join(repo, ".gitignore"), "launchpad.gen3.local.json\n");
  runGit(["add", ".gitignore"], repo);
  runGit(["commit", "-m", "ExampleOrg root config"], repo);
  runGit(["push", "origin", "main"], repo);
  await writeJson(join(repo, "launchpad.gen3.local.json"), { update_channel: channel });
  const fromCommit = runGit(["rev-parse", "HEAD"], repo);

  if (!targetAhead) {
    if (targetTag) {
      runGit(["tag", targetTag, fromCommit], repo);
      runGit(["push", "origin", targetTag], repo);
    }
    return { base, repo, remote, fromCommit, targetCommit: fromCommit };
  }

  const contributor = join(base, "contributor");
  runGit(["clone", remote, contributor], base);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  runGit(["config", "user.email", "fixture@example.com"], contributor);
  runGit(["config", "user.name", "ExampleOrg Fixture"], contributor);
  await writeFile(join(contributor, "release.txt"), `target ${targetTag ?? "nightly"}\n`);
  runGit(["add", "release.txt"], contributor);
  runGit(["commit", "-m", "nová ExampleOrg verze"], contributor);
  const targetCommit = runGit(["rev-parse", "HEAD"], contributor);
  if (targetTag) runGit(["tag", targetTag, targetCommit], contributor);
  runGit(["push", "origin", "main"], contributor);
  if (targetTag) runGit(["push", "origin", targetTag], contributor);
  return { base, repo, remote, fromCommit, targetCommit };
}
