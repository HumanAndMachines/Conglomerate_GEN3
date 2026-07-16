import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { buildRecentModuleChanges } from "./recent-changes-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function git(args, cwd) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Autor",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Autor",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  await child.exited;
}

async function makeModuleRepo(companiesRoot, relativePath, commitSubjects) {
  const abs = join(companiesRoot, relativePath);
  await mkdir(abs, { recursive: true });
  await git(["init"], abs);
  await git(["checkout", "-b", "main"], abs);
  for (const [index, subject] of commitSubjects.entries()) {
    await writeFile(join(abs, `file-${index}.txt`), `obsah ${index}\n`, "utf8");
    await git(["add", "."], abs);
    await git(["commit", "-m", subject], abs);
  }
}

test("recent changes vrátí per-modul commity seřazené podle poslední změny", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-recent-"));
  tempRoots.push(root);
  await makeModuleRepo(root, "organizations/Acme/workspace/alpha", ["feat: první", "feat: druhý"]);
  await makeModuleRepo(root, "organizations/Acme/workspace/beta", ["docs: beta"]);

  const apps = [
    { id: "acme-alpha-v1", company: "acme", company_display_name: "Acme", module: "alpha", cwd: "organizations/Acme/workspace/alpha", icon: "control", tags: ["operations"] },
    { id: "acme-beta-v1", company: "acme", company_display_name: "Acme", module: "beta", cwd: "organizations/Acme/workspace/beta" },
  ];

  const result = await buildRecentModuleChanges({ companiesRoot: root, apps });
  expect(result.git_available).toBe(true);
  expect(result.recent_modules).toHaveLength(2);
  const alpha = result.recent_modules.find((entry) => entry.module === "alpha");
  const beta = result.recent_modules.find((entry) => entry.module === "beta");
  expect(alpha.commit_count).toBe(2);
  expect(beta.commit_count).toBe(1);
  // Nejnovější commit modulu je první v seznamu.
  expect(alpha.commits[0].subject).toBe("feat: druhý");
  expect(alpha.commits[1].subject).toBe("feat: první");
  expect(alpha.commits[0].hash).toBeTruthy();
  expect(alpha.commits[0].author).toBe("Test Autor");
  expect(alpha.last_commit_at).toBe(alpha.commits[0].committed_at);
  expect(alpha.tags).toEqual(["operations"]);
});

test("recent changes řadí moduly podle nejnovějšího commitu", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-recent-order-"));
  tempRoots.push(root);
  await makeModuleRepo(root, "organizations/Acme/workspace/older", ["feat: staré"]);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await makeModuleRepo(root, "organizations/Acme/workspace/newer", ["feat: nové"]);

  const apps = [
    { id: "acme-older-v1", company: "acme", module: "older", cwd: "organizations/Acme/workspace/older" },
    { id: "acme-newer-v1", company: "acme", module: "newer", cwd: "organizations/Acme/workspace/newer" },
  ];

  const result = await buildRecentModuleChanges({ companiesRoot: root, apps });
  expect(result.recent_modules.map((entry) => entry.module)).toEqual(["newer", "older"]);
});

test("recent changes dedupe modul s víc app variantami na jeden repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-recent-dedupe-"));
  tempRoots.push(root);
  await makeModuleRepo(root, "organizations/Acme/workspace/alpha", ["feat: jedna"]);
  await mkdir(join(root, "organizations/Acme/workspace/alpha/app/v1"), { recursive: true });
  await mkdir(join(root, "organizations/Acme/workspace/alpha/app/v2"), { recursive: true });

  const apps = [
    { id: "acme-alpha-v1", company: "acme", module: "alpha", cwd: "organizations/Acme/workspace/alpha/app/v1" },
    { id: "acme-alpha-v2", company: "acme", module: "alpha", cwd: "organizations/Acme/workspace/alpha/app/v2" },
  ];

  const result = await buildRecentModuleChanges({ companiesRoot: root, apps });
  expect(result.recent_modules).toHaveLength(1);
});

test("recent changes přeskočí modul bez git repa", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-recent-nogit-"));
  tempRoots.push(root);
  await mkdir(join(root, "organizations/Acme/workspace/plain"), { recursive: true });

  const apps = [
    { id: "acme-plain-v1", company: "acme", module: "plain", cwd: "organizations/Acme/workspace/plain" },
  ];

  const result = await buildRecentModuleChanges({ companiesRoot: root, apps });
  expect(result.recent_modules).toEqual([]);
});

test("recent changes drží globální limit odpovědi", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-recent-per-company-"));
  tempRoots.push(root);
  await makeModuleRepo(root, "organizations/Acme/workspace/alpha", ["feat: alpha"]);
  await makeModuleRepo(root, "organizations/Acme/workspace/beta", ["feat: beta"]);
  await makeModuleRepo(root, "organizations/Beta/workspace/gamma", ["feat: gamma"]);
  await makeModuleRepo(root, "organizations/Beta/workspace/delta", ["feat: delta"]);

  const apps = [
    { id: "acme-alpha", company: "acme", module: "alpha", cwd: "organizations/Acme/workspace/alpha" },
    { id: "acme-beta", company: "acme", module: "beta", cwd: "organizations/Acme/workspace/beta" },
    { id: "beta-gamma", company: "beta", module: "gamma", cwd: "organizations/Beta/workspace/gamma" },
    { id: "beta-delta", company: "beta", module: "delta", cwd: "organizations/Beta/workspace/delta" },
  ];

  const result = await buildRecentModuleChanges({ companiesRoot: root, apps, moduleLimit: 1 });
  expect(result.recent_modules).toHaveLength(1);
});
