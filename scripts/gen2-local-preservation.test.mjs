import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPreservation,
  probeCloneCapability,
} from "./gen2-local-preservation.mjs";

const scriptPath = fileURLToPath(new URL("./gen2-local-preservation.mjs", import.meta.url));
const tempRoots = [];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Preservation Test",
      GIT_AUTHOR_EMAIL: "preservation@example.invalid",
      GIT_COMMITTER_NAME: "Preservation Test",
      GIT_COMMITTER_EMAIL: "preservation@example.invalid",
    },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function gitStatusCodes(cwd) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, 2))
    .sort();
}

function cli(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  });
}

async function makeTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "gen2-preservation-test-"));
  tempRoots.push(root);
  return root;
}

async function makeSource(root, name = "source") {
  const source = join(root, name);
  await mkdir(join(source, "data"), { recursive: true });
  await writeFile(join(source, "data", "customer.txt"), "customer data\n", { mode: 0o640 });
  await writeFile(join(source, ".ignored-secret"), "fixture-secret-value\n", { mode: 0o600 });
  await symlink("data/customer.txt", join(source, "customer-link"));
  return source;
}

async function makeGitRepo(path) {
  await mkdir(path, { recursive: true });
  run("git", ["init", "-b", "main"], path);
  await writeFile(join(path, "tracked.txt"), "tracked baseline\n");
  run("git", ["add", "tracked.txt"], path);
  run("git", ["commit", "-m", "initial"], path);
  run("git", ["branch", "private-local"], path);
  await writeFile(join(path, "tracked.txt"), "stashed local work\n");
  run("git", ["stash", "push", "-m", "message-must-not-leak"], path);
  run("git", ["remote", "add", "origin", "https://user:embedded-secret@example.invalid/repo.git"], path);
}

function applyArgs(source, destination, personalspaceRoot) {
  const args = [
    "apply",
    "--source",
    source,
    "--destination",
    destination,
    "--personalspace-root",
    personalspaceRoot,
  ];
  if (process.platform !== "darwin") args.push("--allow-full-copy");
  return args;
}

function verifyArgs(source, destination, personalspaceRoot) {
  return [
    "verify",
    "--source",
    source,
    "--destination",
    destination,
    "--personalspace-root",
    personalspaceRoot,
  ];
}

async function archiveFixture({ withGit = false } = {}) {
  const root = await makeTempRoot();
  const source = await makeSource(root);
  if (withGit) await makeGitRepo(join(source, "nested-repo"));
  const personalspaceRoot = join(root, "personalspace", "owner_GEN3");
  const destination = join(personalspaceRoot, "migration-archive", "source");
  await mkdir(personalspaceRoot, { recursive: true });
  const result = cli(applyArgs(source, destination, personalspaceRoot));
  expect(result.status).toBe(0);
  return { root, source, personalspaceRoot, destination, result };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("metadata-only inventory", () => {
  test("default command is a read-only JSON inventory and leaks no content, env value, stash message, or credential URL", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    await makeGitRepo(join(source, "nested-repo"));
    const forbidden = [
      "fixture-secret-value",
      "message-must-not-leak",
      "embedded-secret",
      "ENV_VALUE_MUST_NOT_LEAK",
    ];

    const before = await readFile(join(source, ".ignored-secret"), "utf8");
    const result = cli(["--source", source], {
      env: { PRESERVATION_TEST_SECRET: "ENV_VALUE_MUST_NOT_LEAK" },
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.command).toBe("inventory");
    expect(report.dry_run).toBe(true);
    expect(report.files.count).toBeGreaterThan(0);
    expect(report.files.logical_bytes).toBeGreaterThan(0);
    expect(report.git.repositories).toEqual([
      expect.objectContaining({
        root: "nested-repo",
        branch: "main",
        stash_count: 1,
        ref_count: expect.any(Number),
      }),
    ]);
    expect(report.classification.client_companies).toContain("quarantined archive");
    expect(report.classification.activated_organization).toBe(false);
    for (const marker of forbidden) {
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(marker);
    }
    expect(await readFile(join(source, ".ignored-secret"), "utf8")).toBe(before);
  });
});

describe("fail-closed preflight", () => {
  test("refuses a missing source", async () => {
    const root = await makeTempRoot();
    const personalspaceRoot = join(root, "personalspace");
    await mkdir(personalspaceRoot);
    const result = cli(applyArgs(join(root, "missing"), join(personalspaceRoot, "archive"), personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("source must exist and be a directory");
  });

  test("refuses an existing destination", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    const personalspaceRoot = join(root, "personalspace");
    const destination = join(personalspaceRoot, "archive");
    await mkdir(destination, { recursive: true });
    const result = cli(applyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("destination must not exist");
  });

  test("refuses destination inside source after path normalization", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    const personalspaceRoot = join(source, "private", "..", "personalspace");
    await mkdir(personalspaceRoot, { recursive: true });
    const destination = join(personalspaceRoot, "archive");
    const result = cli(applyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("destination must not be inside source");
  });

  test("refuses any organizations destination", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    const personalspaceRoot = join(root, "personalspace");
    const destination = join(root, "organizations", "Rozjedeme-ai_GEN3", "archive");
    await mkdir(personalspaceRoot);
    const result = cli(applyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("organizations");
  });

  test("refuses a destination that escapes personalspace through a symlinked parent", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    const personalspaceRoot = join(root, "personalspace");
    const outside = join(root, "outside");
    await mkdir(personalspaceRoot);
    await mkdir(outside);
    await symlink(outside, join(personalspaceRoot, "escape"));
    const destination = join(personalspaceRoot, "escape", "archive");
    const result = cli(applyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("destination must stay under the explicit personalspace root");
  });

  test("refuses a resolved personalspace root inside an organizations boundary", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    const organizationsRoot = join(root, "organizations", "PrivateOrg_GEN3");
    const personalspaceLink = join(root, "personalspace-link");
    await mkdir(organizationsRoot, { recursive: true });
    await symlink(organizationsRoot, personalspaceLink);
    const destination = join(personalspaceLink, "migration-archive", "source");
    const result = cli(applyArgs(source, destination, personalspaceLink));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("organizations");
  });

  test("refuses a linked Git worktree whose gitdir escapes the source tree", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    const externalRepo = join(root, "external-repo");
    await makeGitRepo(externalRepo);
    run("git", ["worktree", "add", "--detach", join(source, "linked-worktree"), "HEAD"], externalRepo);
    const personalspaceRoot = join(root, "personalspace", "owner_GEN3");
    await mkdir(personalspaceRoot, { recursive: true });
    const destination = join(personalspaceRoot, "migration-archive", "source");
    const result = cli(applyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("external gitdir");
  });

  test("refuses an absolute symlink outside rebuildable caches before creating destination", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    await symlink(join(source, "data", "customer.txt"), join(source, "absolute-user-link"));
    const personalspaceRoot = join(root, "personalspace", "owner_GEN3");
    const destination = join(personalspaceRoot, "migration-archive", "source");
    await mkdir(personalspaceRoot, { recursive: true });
    const result = cli(applyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("non-portable symlink");
    await expect(lstat(destination)).rejects.toThrow();
  });

  test("refuses a user-data symlink whose transitive chain crosses a non-portable cache link", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    await mkdir(join(source, "node_modules"));
    await symlink(join(source, "data", "customer.txt"), join(source, "node_modules", "cache-link"));
    await symlink("node_modules/cache-link", join(source, "user-data-link"));
    const personalspaceRoot = join(root, "personalspace", "owner_GEN3");
    const destination = join(personalspaceRoot, "migration-archive", "source");
    await mkdir(personalspaceRoot, { recursive: true });

    const result = cli(applyArgs(source, destination, personalspaceRoot));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("non-portable symlink");
    await expect(lstat(destination)).rejects.toThrow();
  });

  test("refuses a source that already contains the reserved evidence directory", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    await mkdir(join(source, ".gen2-preservation"));
    await writeFile(join(source, ".gen2-preservation", "original-evidence.json"), "must not be overwritten\n");
    const personalspaceRoot = join(root, "personalspace", "owner_GEN3");
    const destination = join(personalspaceRoot, "migration-archive", "source");
    await mkdir(personalspaceRoot, { recursive: true });

    const inventory = cli(["inventory", "--source", source]);
    const applied = cli(applyArgs(source, destination, personalspaceRoot));

    expect(inventory.status).not.toBe(0);
    expect(applied.status).not.toBe(0);
    expect(`${inventory.stderr}\n${applied.stderr}`).toContain("reserved .gen2-preservation");
    await expect(lstat(destination)).rejects.toThrow();
  });
});

describe("apply and evidence", () => {
  test("allows explicitly counted non-portable symlinks only inside rebuildable caches", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    await mkdir(join(source, "node_modules"));
    await symlink(join(source, "data", "customer.txt"), join(source, "node_modules", "cache-link"));
    const personalspaceRoot = join(root, "personalspace", "owner_GEN3");
    const destination = join(personalspaceRoot, "migration-archive", "source");
    await mkdir(personalspaceRoot, { recursive: true });

    const result = cli(applyArgs(source, destination, personalspaceRoot));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).files.nonportable_rebuildable_symlinks).toBe(1);
  });

  test("preserves ignored files, symlinks, modes, nested Git refs/stash, and leaves source unchanged", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    const sourceRepo = join(source, "nested-repo");
    await makeGitRepo(sourceRepo);
    const personalspaceRoot = join(root, "personalspace", "owner_GEN3");
    const destination = join(personalspaceRoot, "migration-archive", "Rozjedeme-ai");
    await mkdir(personalspaceRoot, { recursive: true });

    const sourceBefore = {
      content: await readFile(join(source, "data", "customer.txt"), "utf8"),
      mode: (await lstat(join(source, "data", "customer.txt"))).mode & 0o777,
      link: await readlink(join(source, "customer-link")),
      head: run("git", ["rev-parse", "HEAD"], sourceRepo),
      refs: run("git", ["for-each-ref", "--format=%(refname) %(objectname)"], sourceRepo),
      stash: run("git", ["stash", "list", "--format=%H"], sourceRepo),
      status: run("git", ["status", "--porcelain=v1", "--untracked-files=all"], sourceRepo),
    };

    const result = cli(applyArgs(source, destination, personalspaceRoot));

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.command).toBe("apply");
    expect(report.verified).toBe(true);
    expect(report.classification.activated_organization).toBe(false);
    expect(await readFile(join(destination, ".ignored-secret"), "utf8")).toBe("fixture-secret-value\n");
    expect(await readlink(join(destination, "customer-link"))).toBe("data/customer.txt");
    expect((await lstat(join(destination, "data", "customer.txt"))).mode & 0o777).toBe(0o640);
    expect((await lstat(destination)).mode & 0o777).toBe(0o700);

    const evidenceDir = join(destination, ".gen2-preservation");
    const manifestPath = join(evidenceDir, "manifest.json");
    const successPath = join(evidenceDir, "SUCCESS.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const success = JSON.parse(await readFile(successPath, "utf8"));
    expect(manifest.source).toBe(await realpath(source));
    expect(manifest.destination).toBe(await realpath(destination));
    expect(manifest.files.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".ignored-secret", type: "file", sha256: expect.any(String) }),
      expect.objectContaining({ path: "customer-link", type: "symlink", target: "data/customer.txt" }),
    ]));
    expect(manifest.git.repositories).toEqual([
      expect.objectContaining({
        root: "nested-repo",
        branch: "main",
        status_hash: expect.any(String),
        object_connectivity: "ok",
        refs: expect.arrayContaining([
          expect.objectContaining({ name: "refs/heads/private-local" }),
          expect.objectContaining({ name: "refs/stash" }),
        ]),
        stashes: [expect.objectContaining({ object: expect.any(String), selector: "stash@{0}" })],
      }),
    ]);
    expect(JSON.stringify(manifest)).not.toContain("embedded-secret");
    expect(JSON.stringify(manifest)).not.toContain("message-must-not-leak");
    expect(success).toMatchObject({
      status: "verified",
      verification_contract: "files-git-connectivity-v2",
      manifest_sha256: expect.any(String),
    });
    expect((await lstat(manifestPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(successPath)).mode & 0o777).toBe(0o600);
    await expect(lstat(join(evidenceDir, "INCOMPLETE.json"))).rejects.toThrow();

    expect({
      content: await readFile(join(source, "data", "customer.txt"), "utf8"),
      mode: (await lstat(join(source, "data", "customer.txt"))).mode & 0o777,
      link: await readlink(join(source, "customer-link")),
      head: run("git", ["rev-parse", "HEAD"], sourceRepo),
      refs: run("git", ["for-each-ref", "--format=%(refname) %(objectname)"], sourceRepo),
      stash: run("git", ["stash", "list", "--format=%H"], sourceRepo),
      status: run("git", ["status", "--porcelain=v1", "--untracked-files=all"], sourceRepo),
    }).toEqual(sourceBefore);
  });

  test("leaves a clear incomplete marker and no success marker after a partial copy failure", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    const personalspaceRoot = join(root, "personalspace", "owner_GEN3");
    const destination = join(personalspaceRoot, "migration-archive", "partial");
    await mkdir(personalspaceRoot, { recursive: true });

    await expect(applyPreservation({ source, destination, personalspaceRoot }, {
      platform: "darwin",
      cloneProbe: async () => true,
      copyTree: async () => {
        await writeFile(join(destination, "partial-file"), "partial\n");
        throw new Error("injected copy failure");
      },
    })).rejects.toThrow("injected copy failure");

    const incomplete = JSON.parse(await readFile(join(destination, ".gen2-preservation", "INCOMPLETE.json"), "utf8"));
    expect(incomplete.status).toBe("incomplete");
    await expect(lstat(join(destination, ".gen2-preservation", "SUCCESS.json"))).rejects.toThrow();
  });
});

describe("verification drift detection", () => {
  test("refuses to refresh success when archive or evidence directory permissions become public", async () => {
    for (const target of ["archive", "evidence"]) {
      const fixture = await archiveFixture();
      const successPath = join(fixture.destination, ".gen2-preservation", "SUCCESS.json");
      const successBefore = await readFile(successPath, "utf8");
      const targetPath = target === "archive"
        ? fixture.destination
        : join(fixture.destination, ".gen2-preservation");
      await chmod(targetPath, 0o755);

      const result = cli(verifyArgs(fixture.source, fixture.destination, fixture.personalspaceRoot));

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("mode must be 0700");
      expect(await readFile(successPath, "utf8")).toBe(successBefore);
    }
  });

  test("fails on changed file content", async () => {
    const { source, destination, personalspaceRoot } = await archiveFixture();
    await writeFile(join(destination, "data", "customer.txt"), "changed but same archive\n");
    const result = cli(verifyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("file inventory drift");
  });

  test("fails on changed mode", async () => {
    const { source, destination, personalspaceRoot } = await archiveFixture();
    await chmod(join(destination, "data", "customer.txt"), 0o600);
    const result = cli(verifyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mode changed");
  });

  test("fails on changed symlink target", async () => {
    const { source, destination, personalspaceRoot } = await archiveFixture();
    await rm(join(destination, "customer-link"));
    await symlink(".ignored-secret", join(destination, "customer-link"));
    const result = cli(verifyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("symlink target changed");
  });

  test("fails on nested Git local-ref drift", async () => {
    const { source, destination, personalspaceRoot } = await archiveFixture({ withGit: true });
    run("git", ["branch", "archive-only"], join(destination, "nested-repo"));
    const result = cli(verifyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Git repository inventory drift");
  });

  test("fails on nested Git stash drift", async () => {
    const { source, destination, personalspaceRoot } = await archiveFixture({ withGit: true });
    const archiveRepo = join(destination, "nested-repo");
    await writeFile(join(archiveRepo, "tracked.txt"), "new archive-only stash\n");
    run("git", ["stash", "push", "-m", "archive-only"], archiveRepo);
    const result = cli(verifyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Git repository inventory drift");
  });

  test("fails when an archived Git object referenced by a stash is missing", async () => {
    const { source, destination, personalspaceRoot } = await archiveFixture({ withGit: true });
    const archiveRepo = join(destination, "nested-repo");
    const blob = run("git", ["rev-parse", "stash@{0}:tracked.txt"], archiveRepo);
    await rm(join(archiveRepo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const result = cli(verifyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("git fsck");
  });

  test("fails when private Git config metadata changes without changing refs or worktree files", async () => {
    const { source, destination, personalspaceRoot } = await archiveFixture({ withGit: true });
    const archiveRepo = join(destination, "nested-repo");
    run("git", ["config", "local.preservation-test", "archive-only"], archiveRepo);
    const result = cli(verifyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Git metadata drift");
  });

  test("fails when staged and unstaged path identities change but status counts stay equal", async () => {
    const root = await makeTempRoot();
    const source = await makeSource(root);
    const sourceRepo = join(source, "nested-repo");
    await makeGitRepo(sourceRepo);
    await writeFile(join(sourceRepo, "a.txt"), "a baseline\n");
    await writeFile(join(sourceRepo, "b.txt"), "b baseline\n");
    run("git", ["add", "a.txt", "b.txt"], sourceRepo);
    run("git", ["commit", "-m", "add status fixtures"], sourceRepo);
    await writeFile(join(sourceRepo, "a.txt"), "a changed\n");
    await writeFile(join(sourceRepo, "b.txt"), "b changed\n");
    run("git", ["add", "a.txt"], sourceRepo);

    const personalspaceRoot = join(root, "personalspace", "owner_GEN3");
    const destination = join(personalspaceRoot, "migration-archive", "source");
    await mkdir(personalspaceRoot, { recursive: true });
    const applied = cli(applyArgs(source, destination, personalspaceRoot));
    expect(applied.status).toBe(0);

    const archiveRepo = join(destination, "nested-repo");
    run("git", ["restore", "--staged", "--", "a.txt"], archiveRepo);
    run("git", ["add", "--", "b.txt"], archiveRepo);
    const sourceSummary = gitStatusCodes(sourceRepo);
    const archiveSummary = gitStatusCodes(archiveRepo);
    expect(archiveSummary).toEqual(sourceSummary);

    const result = cli(verifyArgs(source, destination, personalspaceRoot));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Git repository inventory drift");
  });
});

test.skipIf(process.platform !== "darwin")("macOS clone probe proves clone-on-write support on the destination filesystem", async () => {
  const root = await makeTempRoot();
  const destinationParent = join(root, "personalspace");
  await mkdir(destinationParent);
  await expect(probeCloneCapability(destinationParent)).resolves.toBe(true);
});
