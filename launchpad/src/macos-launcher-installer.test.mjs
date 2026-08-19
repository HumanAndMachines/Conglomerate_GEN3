import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sourceRoot = join(import.meta.dirname, "..", "..");
const tempRoots = [];
const macTest = process.platform === "darwin" ? test : test.skip;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureRoot({ git = "directory" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lazurio-macos-install-root-"));
  tempRoots.push(root);
  await mkdir(join(root, "scripts", "macos"), { recursive: true });
  await mkdir(join(root, "launchpad"), { recursive: true });
  await copyFile(join(sourceRoot, "scripts", "install-launchpad-macos.sh"), join(root, "scripts", "install-launchpad-macos.sh"));
  await copyFile(join(sourceRoot, "scripts", "macos", "launchpad-bootstrap.sh"), join(root, "scripts", "macos", "launchpad-bootstrap.sh"));
  await copyFile(join(sourceRoot, "scripts", "macos", "replace-app.jxa"), join(root, "scripts", "macos", "replace-app.jxa"));
  await copyFile(join(sourceRoot, "scripts", "macos", "Info.plist"), join(root, "scripts", "macos", "Info.plist"));
  await writeFile(join(root, "package.json"), '{"private":true}\n');
  await writeFile(join(root, "launchpad", ".fixture"), "fixture\n");
  await writeFile(join(root, "Launchpad.command"), "#!/bin/bash\nexit 0\n");
  await chmod(join(root, "Launchpad.command"), 0o755);
  await chmod(join(root, "scripts", "install-launchpad-macos.sh"), 0o755);
  await chmod(join(root, "scripts", "macos", "launchpad-bootstrap.sh"), 0o755);

  if (git === "directory") {
    expect(spawn(["git", "init", "--quiet", root]).exitCode).toBe(0);
  } else if (git === "separate") {
    const gitDir = `${root}.git-data`;
    tempRoots.push(gitDir);
    expect(spawn(["git", "init", "--quiet", "--separate-git-dir", gitDir, root]).exitCode).toBe(0);
  }
  return root;
}

function spawn(argv, options = {}) {
  return Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "pipe",
    ...options,
  });
}

async function install(root, home) {
  return spawn(["/bin/bash", join(root, "scripts", "install-launchpad-macos.sh")], {
    cwd: root,
    env: { ...process.env, HOME: home },
  });
}

test("macOS app is only a per-user bootstrap to the canonical human launcher", async () => {
  const installer = await readFile(join(sourceRoot, "scripts", "install-launchpad-macos.sh"), "utf8");
  const bootstrap = await readFile(join(sourceRoot, "scripts", "macos", "launchpad-bootstrap.sh"), "utf8");
  const replacement = await readFile(join(sourceRoot, "scripts", "macos", "replace-app.jxa"), "utf8");

  expect(installer).toContain('TARGET_PARENT="$HOME_CANONICAL/Applications"');
  expect(installer).toContain("lazurio.launchpad.macos_install.v1");
  expect(bootstrap).toContain('LAUNCHER="$CANONICAL_ROOT/Launchpad.command"');
  expect(bootstrap).toContain('/usr/bin/open "$LAUNCHER"');
  expect(bootstrap).not.toContain("launchctl");
  expect(installer).not.toContain("launchctl");
  expect(bootstrap).not.toContain("LaunchAgent");
  expect(installer).not.toContain("LaunchAgent");
  expect(bootstrap).not.toContain("/api/launchpad/identity");
  expect(installer).not.toContain("/api/launchpad/identity");
  expect(installer).not.toContain('mv "$TARGET" "$BACKUP_PATH"');
  expect(replacement).toContain("replaceItemAtURLWithItemAtURLBackupItemNameOptionsResultingItemURLError");
});

macTest("unsupported target arguments fail with the intended diagnostic", async () => {
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-argument-home-"));
  tempRoots.push(home);
  const result = spawn(
    ["/bin/bash", join(root, "scripts", "install-launchpad-macos.sh"), "/Applications/Launchpad GEN3.app"],
    { cwd: root, env: { ...process.env, HOME: home } },
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("nepřijímá vlastní cíl");
  expect(result.stderr.toString()).not.toContain("unbound variable");
});

macTest("default install succeeds without admin rights and produces a verified user app", async () => {
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-install-home-"));
  tempRoots.push(home);

  const result = await install(root, home);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const app = join(home, "Applications", "HumanAndMachine Launchpad.app");
  expect(await readFile(join(app, "Contents", "Resources", "root-path"), "utf8")).toBe(`${await realpath(root)}\n`);
  expect(await readFile(join(app, "Contents", "Resources", "install-schema"), "utf8")).toBe("lazurio.launchpad.macos_install.v1\n");

  const bundleId = spawn(["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", join(app, "Contents", "Info.plist")]);
  expect(bundleId.exitCode).toBe(0);
  expect(bundleId.stdout.toString().trim()).toBe("com.humanandmachine.launchpad");
  const signature = spawn(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
  expect(signature.exitCode, signature.stderr.toString()).toBe(0);
});

macTest("reinstall preserves the previous app as a rollback backup", async () => {
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-reinstall-home-"));
  tempRoots.push(home);
  expect((await install(root, home)).exitCode).toBe(0);
  expect((await install(root, home)).exitCode).toBe(0);
  expect((await install(root, home)).exitCode).toBe(0);

  const apps = await readdir(join(home, "Applications"));
  expect(apps).toContain("HumanAndMachine Launchpad.app");
  expect(apps.filter((name) => name === ".humanandmachine-launchpad-rollback").length).toBe(1);
  expect(apps.filter((name) => name.includes("backup-")).length).toBe(0);
});

macTest("native replacement primitive restores the prior app without removing the live path", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lazurio-macos-atomic-replace-"));
  tempRoots.push(parent);
  const target = join(parent, "HumanAndMachine Launchpad.app");
  const replacement = join(parent, "replacement.app");
  const rollback = join(parent, ".rollback");
  await mkdir(target);
  await mkdir(replacement);
  await writeFile(join(target, "generation"), "old\n");
  await writeFile(join(replacement, "generation"), "new\n");

  const helper = join(sourceRoot, "scripts", "macos", "replace-app.jxa");
  let result = spawn(["/usr/bin/osascript", "-l", "JavaScript", helper, target, replacement, ".rollback"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(await readFile(join(target, "generation"), "utf8")).toBe("new\n");
  expect(await readFile(join(rollback, "generation"), "utf8")).toBe("old\n");

  result = spawn(["/usr/bin/osascript", "-l", "JavaScript", helper, target, rollback, ".failed"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(await readFile(join(target, "generation"), "utf8")).toBe("old\n");
  expect(await readFile(join(parent, ".failed", "generation"), "utf8")).toBe("new\n");
});

macTest("linked worktree cannot become the installed canonical root", async () => {
  const root = await fixtureRoot();
  expect(spawn(["git", "-C", root, "config", "user.email", "fixture@example.invalid"]).exitCode).toBe(0);
  expect(spawn(["git", "-C", root, "config", "user.name", "Fixture"]).exitCode).toBe(0);
  expect(spawn(["git", "-C", root, "add", "."]).exitCode).toBe(0);
  expect(spawn([
    "git", "-C", root,
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "-m", "fixture",
  ]).exitCode).toBe(0);
  const linked = `${root}-linked`;
  tempRoots.push(linked);
  expect(spawn(["git", "-C", root, "worktree", "add", "--quiet", "-b", "fixture-linked", linked]).exitCode).toBe(0);
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-linked-home-"));
  tempRoots.push(home);

  const result = await install(linked, home);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("linked worktree");
  expect(await Bun.file(join(home, "Applications", "HumanAndMachine Launchpad.app")).exists()).toBe(false);
});

macTest("primary checkout with a separate Git directory remains installable", async () => {
  const root = await fixtureRoot({ git: "separate" });
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-separate-home-"));
  tempRoots.push(home);
  const result = await install(root, home);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

macTest("directory-only AI colleague root remains installable", async () => {
  const root = await fixtureRoot({ git: "none" });
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-directory-home-"));
  tempRoots.push(home);
  const result = await install(root, home);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

macTest("a symlink target is rejected without touching its destination", async () => {
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-symlink-home-"));
  tempRoots.push(home);
  const external = join(home, "external-app");
  await mkdir(external);
  await writeFile(join(external, "sentinel"), "keep\n");
  const target = join(home, "Applications", "HumanAndMachine Launchpad.app");
  await mkdir(dirname(target), { recursive: true });
  await symlink(external, target);

  const result = await install(root, home);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("nesmí být symlink");
  expect(await readFile(join(external, "sentinel"), "utf8")).toBe("keep\n");
});

macTest("a symlinked user Applications directory cannot redirect installation", async () => {
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-parent-symlink-home-"));
  tempRoots.push(home);
  const external = join(home, "external-apps");
  await mkdir(external);
  await writeFile(join(external, "sentinel"), "keep\n");
  await symlink(external, join(home, "Applications"));

  const result = await install(root, home);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Applications adresář nesmí být symlink");
  expect(await readFile(join(external, "sentinel"), "utf8")).toBe("keep\n");
  expect(await Bun.file(join(external, "HumanAndMachine Launchpad.app")).exists()).toBe(false);
});
