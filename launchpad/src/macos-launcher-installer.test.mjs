import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sourceRoot = join(import.meta.dirname, "..", "..");
const tempRoots = [];
const macTest = process.platform === "darwin" ? test : test.skip;
const lockfTest = process.platform === "darwin" && existsSync("/usr/bin/lockf") ? test : test.skip;

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

function installAsync(root, home) {
  return Bun.spawn(["/bin/bash", join(root, "scripts", "install-launchpad-macos.sh")], {
    cwd: root,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForChildCommand(parentPid, commandName, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawn(["/bin/ps", "-axo", "pid=,ppid=,comm="]);
    if (result.exitCode === 0) {
      const found = result.stdout.toString().split("\n").some((line) => {
        const fields = line.trim().split(/\s+/, 3);
        return Number(fields[1]) === parentPid && (fields[2] === commandName || fields[2]?.endsWith(`/${commandName}`));
      });
      if (found) return true;
    }
    await Bun.sleep(20);
  }
  return false;
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
  expect(installer).toContain("/usr/bin/shlock");
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

macTest("failed reinstall restores both the live app and the previously retained rollback", async () => {
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-failed-reinstall-home-"));
  tempRoots.push(home);
  expect((await install(root, home)).exitCode).toBe(0);
  expect((await install(root, home)).exitCode).toBe(0);

  const apps = join(home, "Applications");
  const target = join(apps, "HumanAndMachine Launchpad.app");
  const rollback = join(apps, ".humanandmachine-launchpad-rollback");
  await writeFile(join(target, "current-generation"), "keep-current\n");
  await writeFile(join(rollback, "older-generation"), "keep-older\n");

  const installerPath = join(root, "scripts", "install-launchpad-macos.sh");
  const installer = await readFile(installerPath, "utf8");
  expect(installer.match(/PUBLISHED_TARGET=true/g)?.length).toBe(1);
  await writeFile(installerPath, installer.replace("PUBLISHED_TARGET=true\n", "PUBLISHED_TARGET=true\nfalse # injected post-publication failure\n"));

  const result = await install(root, home);
  expect(result.exitCode).not.toBe(0);
  expect(await readFile(join(target, "current-generation"), "utf8")).toBe("keep-current\n");
  expect(await readFile(join(rollback, "older-generation"), "utf8")).toBe("keep-older\n");
  expect((await readdir(apps)).filter((name) => (name.startsWith(".humanandmachine-launchpad-install.") && name !== ".humanandmachine-launchpad-install.lock") || name === ".humanandmachine-launchpad-failed")).toEqual([]);
});

macTest("failure before native replacement never promotes an older rollback over the live app", async () => {
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-pre-replace-failure-home-"));
  tempRoots.push(home);
  expect((await install(root, home)).exitCode).toBe(0);
  expect((await install(root, home)).exitCode).toBe(0);

  const apps = join(home, "Applications");
  const target = join(apps, "HumanAndMachine Launchpad.app");
  const rollback = join(apps, ".humanandmachine-launchpad-rollback");
  await writeFile(join(target, "current-generation"), "keep-current\n");
  await writeFile(join(rollback, "older-generation"), "keep-older\n");

  const installerPath = join(root, "scripts", "install-launchpad-macos.sh");
  const installer = await readFile(installerPath, "utf8");
  const moveLine = '    mv "$BACKUP_PATH" "$PREVIOUS_BACKUP_PATH"\n';
  expect(installer.split(moveLine).length - 1).toBe(1);
  await writeFile(installerPath, installer.replace(moveLine, "    false # injected pre-replacement failure\n"));

  const result = await install(root, home);
  expect(result.exitCode).not.toBe(0);
  expect(await readFile(join(target, "current-generation"), "utf8")).toBe("keep-current\n");
  expect(await readFile(join(rollback, "older-generation"), "utf8")).toBe("keep-older\n");
  expect((await readdir(apps)).filter((name) => (name.startsWith(".humanandmachine-launchpad-install.") && name !== ".humanandmachine-launchpad-install.lock") || name === ".humanandmachine-launchpad-failed")).toEqual([]);
});

for (const partialState of ["target-missing", "swap-reported-failed"]) {
  macTest(`partial native replacement recovers live and retained rollback: ${partialState}`, async () => {
    const root = await fixtureRoot();
    const home = await mkdtemp(join(tmpdir(), `lazurio-macos-partial-${partialState}-home-`));
    tempRoots.push(home);
    expect((await install(root, home)).exitCode).toBe(0);
    expect((await install(root, home)).exitCode).toBe(0);

    const apps = join(home, "Applications");
    const target = join(apps, "HumanAndMachine Launchpad.app");
    const rollback = join(apps, ".humanandmachine-launchpad-rollback");
    await writeFile(join(target, "current-generation"), "keep-current\n");
    await writeFile(join(rollback, "older-generation"), "keep-older\n");

    const helperPath = join(root, "scripts", "macos", "replace-app.jxa");
    if (partialState === "target-missing") {
      await writeFile(helperPath, `
ObjC.import("Foundation");
function run(argv) {
  const target = $.NSURL.fileURLWithPath(argv[0]);
  const backup = target.URLByDeletingLastPathComponent.URLByAppendingPathComponent(argv[2]);
  const error = Ref();
  if (!$.NSFileManager.defaultManager.moveItemAtURLToURLError(target, backup, error)) {
    throw new Error("fixture could not create partial backup");
  }
  throw new Error("injected failure with missing target");
}
`);
    } else {
      const helper = await readFile(helperPath, "utf8");
      const returnLine = "  return argv[0];\n";
      expect(helper.split(returnLine).length - 1).toBe(1);
      await writeFile(helperPath, helper.replace(
        returnLine,
        '  if (backupName === ".humanandmachine-launchpad-rollback") { throw new Error("injected failure after swap"); }\n  return argv[0];\n',
      ));
    }

    const result = await install(root, home);
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(join(target, "current-generation"), "utf8")).toBe("keep-current\n");
    expect(await readFile(join(rollback, "older-generation"), "utf8")).toBe("keep-older\n");
    expect((await readdir(apps)).filter((name) => (name.startsWith(".humanandmachine-launchpad-install.") && name !== ".humanandmachine-launchpad-install.lock") || name === ".humanandmachine-launchpad-failed")).toEqual([]);
  });
}

lockfTest("concurrent installers serialize one shared per-user target", async () => {
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-concurrent-home-"));
  tempRoots.push(home);
  const processes = [installAsync(root, home), installAsync(root, home), installAsync(root, home)];
  const exits = await Promise.all(processes.map((process) => process.exited));
  const errors = await Promise.all(processes.map((process) => new Response(process.stderr).text()));
  expect(exits, errors.join("\n")).toEqual([0, 0, 0]);

  const apps = join(home, "Applications");
  expect(await Bun.file(join(apps, "HumanAndMachine Launchpad.app", "Contents", "Resources", "root-path")).exists()).toBe(true);
  expect((await readdir(apps)).filter((name) => name === ".humanandmachine-launchpad-rollback").length).toBe(1);
  expect(spawn(["/usr/bin/codesign", "--verify", "--deep", "--strict", join(apps, "HumanAndMachine Launchpad.app")]).exitCode).toBe(0);
});

lockfTest("installer waits for an externally held native lock before publishing", async () => {
  const root = await fixtureRoot();
  const home = await mkdtemp(join(tmpdir(), "lazurio-macos-lock-wait-home-"));
  tempRoots.push(home);
  const apps = join(home, "Applications");
  await mkdir(apps);
  const lockPath = join(apps, ".humanandmachine-launchpad-install.lock");
  const holder = Bun.spawn(["/usr/bin/lockf", "-k", "-t", "0", lockPath, "/bin/sleep", "1"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(100);
  expect(holder.exitCode).toBe(null);

  const installer = installAsync(root, home);
  expect(await waitForChildCommand(installer.pid, "lockf")).toBe(true);
  expect(await Bun.file(join(apps, "HumanAndMachine Launchpad.app")).exists()).toBe(false);

  expect(await holder.exited, await new Response(holder.stderr).text()).toBe(0);
  expect(await installer.exited, await new Response(installer.stderr).text()).toBe(0);
  expect(await Bun.file(join(apps, "HumanAndMachine Launchpad.app", "Contents", "Resources", "root-path")).exists()).toBe(true);
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
