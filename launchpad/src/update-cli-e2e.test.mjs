import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initGitRepo, runGit, writeJson } from "./git-fixture-helpers.test.mjs";
import { platformTestTimeout } from "./test-platform-setup.mjs";
import { runUpdateLane } from "./update-cli-lib.mjs";

// End-to-end smoke test guarded update lane (CAC-0083) nad skutečnými git
// repozitáři: žádné mocky — přesně to, co spustí agent v task-start rutině.

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createBehindRoot() {
  const base = await mkdtemp(join(tmpdir(), "update-cli-e2e-"));
  tempRoots.push(base);
  const repo = join(base, "root");
  const remote = join(base, "remote.git");
  await initGitRepo(repo, { remotePath: remote });
  await writeFile(join(repo, ".gitignore"), "launchpad.gen3.local.json\n");
  runGit(["add", ".gitignore"], repo);
  runGit(["commit", "-m", "root baseline"], repo);
  runGit(["push", "origin", "main"], repo);
  await writeJson(join(repo, "launchpad.gen3.local.json"), { update_channel: "nightly" });
  const fromCommit = runGit(["rev-parse", "HEAD"], repo);

  const contributor = join(base, "contributor");
  runGit(["clone", remote, contributor], base);
  runGit(["checkout", "-B", "main", "origin/main"], contributor);
  runGit(["config", "user.email", "fixture@example.com"], contributor);
  runGit(["config", "user.name", "Fixture"], contributor);
  await writeFile(join(contributor, "release.txt"), "nova verze\n");
  runGit(["add", "release.txt"], contributor);
  runGit(["commit", "-m", "nová verze rootu"], contributor);
  const targetCommit = runGit(["rev-parse", "HEAD"], contributor);
  runGit(["push", "origin", "main"], contributor);
  return { repo, fromCommit, targetCommit };
}

const laneOptions = (overrides = {}) => ({
  orgs: [],
  allOrgs: false,
  check: false,
  preserve: false,
  json: false,
  ...overrides,
});

test("e2e: čistý behind root se přes update lane fast-forwardne na cíl", async () => {
  const { repo, fromCommit, targetCommit } = await createBehindRoot();

  const checked = await runUpdateLane({ rootPath: repo, options: laneOptions({ check: true }) });
  expect(checked.root.state).toBe("update_available");
  expect(checked.root.behind).toBe(1);
  expect(runGit(["rev-parse", "HEAD"], repo)).toBe(fromCommit);

  const result = await runUpdateLane({ rootPath: repo, options: laneOptions() });
  expect(result.ok).toBe(true);
  expect(result.root.updated).toBe(true);
  expect(runGit(["rev-parse", "HEAD"], repo)).toBe(targetCommit);

  const again = await runUpdateLane({ rootPath: repo, options: laneOptions() });
  expect(again.ok).toBe(true);
  expect(again.root.updated).toBe(false);
  expect(again.root.state).toBe("up_to_date");
}, platformTestTimeout(30_000));

test("e2e: rozdělané změny default blokují a --preserve je přes autostash zachová", async () => {
  const { repo, fromCommit, targetCommit } = await createBehindRoot();
  await writeFile(join(repo, ".gitignore"), "launchpad.gen3.local.json\ndraft.local\n");
  await writeFile(join(repo, "draft.txt"), "untracked rozdělaná práce\n");

  const blocked = await runUpdateLane({ rootPath: repo, options: laneOptions() });
  expect(blocked.ok).toBe(false);
  expect(blocked.root.updated).toBe(false);
  expect(blocked.root.code).toBe("explicit_preserve_required");
  expect(runGit(["rev-parse", "HEAD"], repo)).toBe(fromCommit);

  const preserved = await runUpdateLane({ rootPath: repo, options: laneOptions({ preserve: true }) });
  expect(preserved.ok).toBe(true);
  expect(preserved.root.updated).toBe(true);
  expect(runGit(["rev-parse", "HEAD"], repo)).toBe(targetCommit);
  expect(await readFile(join(repo, ".gitignore"), "utf8")).toContain("draft.local");
  expect(await readFile(join(repo, "draft.txt"), "utf8")).toContain("untracked rozdělaná práce");
  expect(await readFile(join(repo, "release.txt"), "utf8")).toContain("nova verze");
  expect(runGit(["stash", "list"], repo)).toBe("");
}, platformTestTimeout(30_000));

test("e2e: bun run update binárně vrací exit 0 při úspěchu a 1 při blokaci", async () => {
  const { repo, targetCommit } = await createBehindRoot();
  const entry = join(import.meta.dirname, "update-cli.mjs");

  const success = Bun.spawnSync([process.execPath, entry, "--root", repo, "--json"], {
    cwd: import.meta.dirname,
  });
  expect(success.exitCode).toBe(0);
  const payload = JSON.parse(success.stdout.toString());
  expect(payload.ok).toBe(true);
  expect(payload.root.updated).toBe(true);
  expect(runGit(["rev-parse", "HEAD"], repo)).toBe(targetCommit);

  runGit(["reset", "--hard", "HEAD~1"], repo);
  await writeFile(join(repo, ".gitignore"), "launchpad.gen3.local.json\nzmena\n");
  const blocked = Bun.spawnSync([process.execPath, entry, "--root", repo, "--json"], {
    cwd: import.meta.dirname,
  });
  expect(blocked.exitCode).toBe(1);
  const blockedPayload = JSON.parse(blocked.stdout.toString());
  expect(blockedPayload.ok).toBe(false);
  expect(blockedPayload.root.code).toBe("explicit_preserve_required");
}, platformTestTimeout(30_000));
