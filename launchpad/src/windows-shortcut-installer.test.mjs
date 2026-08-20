import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const installer = join(root, "Install-LaunchpadShortcut.ps1");
const shortcutName = "Lazurio Launchpad.lnk";
const installSchema = "lazurio.launchpad.windows_install.v1";
const tempRoots = [];
const linkedWorktrees = [];
const windowsTest = process.platform === "win32" ? test : test.skip;

afterEach(async () => {
  for (const path of linkedWorktrees.splice(0)) {
    const removed = Bun.spawnSync(["git", "worktree", "remove", "--force", path], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (removed.exitCode !== 0) {
      throw new Error(`Git worktree fixture cleanup failed: ${removed.stderr.toString()}`);
    }
  }
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("Windows installer drží jediný per-user bootstrap kontrakt bez druhé runtime autority", async () => {
  const contents = await readFile(installer, "utf8");

  expect(contents).toContain("lazurio.launchpad.windows_install.v1");
  expect(contents).toContain("Publish-AtomicFile -SourcePath $sourceBootstrapPath");
  expect(contents).toContain("Write-AtomicUtf8File -DestinationPath $DestinationPath");
  expect(contents).toContain("[System.IO.File]::Replace($TemporaryPath, $DestinationPath, $backupPath)");
  expect(contents).toContain("$replaceFailure -is [System.IO.FileNotFoundException]");
  expect(contents).toContain("[datetime]$BackupTime = (Get-Date)");
  expect(contents).toContain("[guid]::NewGuid().ToString('N')");
  expect(contents).toContain("[System.Security.Cryptography.SHA256]::Create()");
  expect(contents).not.toContain("Get-FileHash");
  expect(contents).toContain("Launchpad refuses a linked Git worktree root");
  expect(contents).toContain("Join-Path $gitDirectory 'commondir'");
  expect(contents).toContain("Publish-VerifiedInstallConfig -DestinationPath $installConfigPath");
  expect(contents).toContain("Publish-AtomicTemporaryFile -TemporaryPath $rollbackPath -DestinationPath $DestinationPath");
  expect(contents).toContain("Previous config recovery file: $rollbackPath");
  expect(contents).toContain("Restore-ShortcutSnapshot -ShortcutPath $startMenuShortcut");
  const dualSeparatorSplit = "-split '[\\\\/]'";
  expect(contents.split(dualSeparatorSplit)).toHaveLength(3);
  expect(contents).toContain("$shortcut.Arguments -eq $expectedArguments");
  expect(contents).not.toContain("$shortcut.Arguments -like");
  expect(contents).not.toContain("ScheduledTask");
  expect(contents).not.toMatch(/\bport\b/i);
  expect(contents.indexOf("Publish-AtomicFile -SourcePath $sourceBootstrapPath"))
    .toBeLessThan(contents.indexOf("Publish-VerifiedInstallConfig -DestinationPath $installConfigPath"));
  expect(contents.indexOf("Publish-AtomicFile -SourcePath $sourceIconPath"))
    .toBeLessThan(contents.indexOf("Publish-VerifiedInstallConfig -DestinationPath $installConfigPath"));
  expect(contents.indexOf("Test-LaunchpadShortcut -ShortcutPath $startMenuShortcut"))
    .toBeLessThan(contents.indexOf("Publish-VerifiedInstallConfig -DestinationPath $installConfigPath"));
});

windowsTest("Windows installer publikuje stabilní bootstrap idempotentně a bez temp zbytků", async () => {
  const fixture = await shortcutFixture("happy");

  const first = runInstaller(fixture, ["-StartMenuOnly", "-SkipShellPin"]);
  expectSuccessfulProcess(first);
  const firstReport = JSON.parse(first.stdout.toString());
  expect(firstReport.install_config_valid).toBe(true);
  expect(firstReport.bootstrap_valid).toBe(true);
  expect(firstReport.start_menu_valid).toBe(true);

  const config = JSON.parse(await readFile(join(fixture.install, "install.json"), "utf8"));
  expect(config.schema_version).toBe(installSchema);
  expect(config.root.toLowerCase()).toBe(fixture.root.toLowerCase());
  expect(await Bun.file(join(fixture.install, "Launchpad-Bootstrap.ps1")).exists()).toBe(true);

  const second = runInstaller(fixture, ["-StartMenuOnly", "-SkipShellPin"]);
  expectSuccessfulProcess(second);
  const secondReport = JSON.parse(second.stdout.toString());
  expect(secondReport.install_config_valid).toBe(true);
  expect(secondReport.bootstrap_valid).toBe(true);
  expect(secondReport.backups).toHaveLength(1);
  expect(await findAtomicTemps(fixture.install)).toEqual([]);
}, 30_000);

windowsTest("Windows installer odmítne checkout pod .worktrees bez aktivace instalace", async () => {
  const fixture = await shortcutFixture("worktree");
  const worktreeRoot = join(fixture.fixtureRoot, ".worktrees", "draft");
  await mkdir(worktreeRoot, { recursive: true });

  const result = runInstaller(fixture, ["-RootPath", worktreeRoot]);
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("refuses to install from a worktree root");
  expect(await Bun.file(join(fixture.install, "install.json")).exists()).toBe(false);
}, 30_000);

windowsTest("Windows installer odmítne linked worktree mimo .worktrees", async () => {
  const fixture = await shortcutFixture("linked-worktree");
  const worktreeRoot = join(fixture.fixtureRoot, "temporary-checkout");
  const created = Bun.spawnSync(["git", "worktree", "add", "--detach", worktreeRoot, "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (created.exitCode !== 0) {
    throw new Error(`Git worktree fixture failed: ${created.stderr.toString()}`);
  }
  linkedWorktrees.push(worktreeRoot);

  const result = runInstaller(fixture, ["-RootPath", worktreeRoot]);
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("refuses a linked Git worktree root");
  expect(await Bun.file(join(fixture.install, "install.json")).exists()).toBe(false);
}, 30_000);

windowsTest("Windows installer přijme primary checkout se separate Git directory", async () => {
  const fixture = await shortcutFixture("separate-git-dir");
  const separateGitDirectory = join(fixture.fixtureRoot, "primary.git");
  const initialized = Bun.spawnSync([
    "git",
    "init",
    "--separate-git-dir",
    separateGitDirectory,
    fixture.root,
  ], {
    cwd: fixture.fixtureRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (initialized.exitCode !== 0) {
    throw new Error(`Separate Git directory fixture failed: ${initialized.stderr.toString()}`);
  }

  const result = runInstaller(fixture, ["-StartMenuOnly", "-SkipShellPin"]);
  expectSuccessfulProcess(result);
  expect(JSON.parse(await readFile(join(fixture.install, "install.json"), "utf8")).root.toLowerCase())
    .toBe(fixture.root.toLowerCase());
}, 30_000);

windowsTest("Windows installer odmítne root přes junction bez zápisu", async () => {
  const fixture = await shortcutFixture("junction");
  const junctionRoot = join(fixture.fixtureRoot, "root-junction");
  await symlink(root, junctionRoot, "junction");

  const result = runInstaller(fixture, ["-RootPath", junctionRoot]);
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("refuses a root through a reparse point");
  expect(await Bun.file(join(fixture.install, "install.json")).exists()).toBe(false);
}, 30_000);

windowsTest("selhání asset publish zachová předchozí aktivní root", async () => {
  const fixture = await shortcutFixture("asset-failure");
  await mkdir(fixture.install, { recursive: true });
  const previousConfig = {
    schema_version: installSchema,
    root: "C:\\previous-lazurio",
    installed_at: "2026-08-18T00:00:00.000Z",
  };
  await writeFile(join(fixture.install, "install.json"), JSON.stringify(previousConfig), "utf8");
  await writeFile(join(fixture.install, "assets"), "blocks the assets directory", "utf8");

  const result = runInstaller(fixture, ["-StartMenuOnly", "-SkipShellPin"]);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(await readFile(join(fixture.install, "install.json"), "utf8"))).toEqual(previousConfig);
  expect(await findAtomicTemps(fixture.install)).toEqual([]);
}, 30_000);

windowsTest("selhání shortcutu zachová předchozí aktivační pointer", async () => {
  const fixture = await shortcutFixture("shortcut-failure");
  await mkdir(fixture.install, { recursive: true });
  const previousConfig = {
    schema_version: installSchema,
    root: "C:\\previous-lazurio",
    installed_at: "2026-08-18T00:00:00.000Z",
  };
  await writeFile(join(fixture.install, "install.json"), JSON.stringify(previousConfig), "utf8");
  await mkdir(join(fixture.startMenu, shortcutName));

  const result = runInstaller(fixture, ["-StartMenuOnly", "-SkipShellPin"]);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(await readFile(join(fixture.install, "install.json"), "utf8"))).toEqual(previousConfig);
  expect(await findAtomicTemps(fixture.install)).toEqual([]);
}, 30_000);

windowsTest("selhání první aktivace vrátí přesnou legacy zkratku", async () => {
  const fixture = await shortcutFixture("legacy-shortcut-rollback");
  const startMenuShortcut = join(fixture.startMenu, shortcutName);
  await createLegacyShortcut(startMenuShortcut, fixture.root);
  const legacyBytes = await readFile(startMenuShortcut);
  await mkdir(join(fixture.install, "install.json"), { recursive: true });

  const result = runInstaller(fixture, ["-StartMenuOnly", "-SkipShellPin"]);
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("install config path is not a regular file");
  expect(await readFile(startMenuShortcut)).toEqual(legacyBytes);
  expect(await findAtomicTemps(fixture.install)).toEqual([]);
}, 30_000);

windowsTest("Windows installer zachová dva backupy ze stejné sekundy bez kolize", async () => {
  const fixture = await shortcutFixture("same-second-backups");
  const startMenuShortcut = join(fixture.startMenu, shortcutName);
  const backupTime = "2026-07-18T12:34:56";
  await writeFile(startMenuShortcut, "first-original", "utf8");

  const firstResult = runInstaller(fixture, ["-StartMenuOnly", "-SkipShellPin", "-BackupTime", backupTime]);
  expectSuccessfulProcess(firstResult);
  const firstReport = JSON.parse(firstResult.stdout.toString());
  const firstBackup = firstReport.backups[0];
  expect(await readFile(firstBackup, "utf8")).toBe("first-original");

  await writeFile(startMenuShortcut, "second-original", "utf8");
  const secondResult = runInstaller(fixture, ["-StartMenuOnly", "-SkipShellPin", "-BackupTime", backupTime]);
  expectSuccessfulProcess(secondResult);
  const secondReport = JSON.parse(secondResult.stdout.toString());
  const secondBackup = secondReport.backups[0];

  expect(secondBackup).not.toBe(firstBackup);
  expect(firstBackup).toContain("20260718-123456");
  expect(secondBackup).toContain("20260718-123456");
  expect(await readFile(firstBackup, "utf8")).toBe("first-original");
  expect(await readFile(secondBackup, "utf8")).toBe("second-original");
}, 30_000);

windowsTest("Windows installer zachová Start Menu a taskbar zkratky v oddělených zálohách", async () => {
  const fixture = await shortcutFixture("backups");
  const startMenuShortcut = join(fixture.startMenu, shortcutName);
  const taskbarShortcut = join(fixture.taskbar, shortcutName);
  await writeFile(startMenuShortcut, "start-menu-original", "utf8");
  await writeFile(taskbarShortcut, "taskbar-original", "utf8");

  const result = runInstaller(fixture, ["-SkipShellPin"]);
  expectSuccessfulProcess(result);
  const report = JSON.parse(result.stdout.toString());
  expect(report.backups).toHaveLength(2);
  expect(report.backups.some((path) => path.includes("\\start-menu\\"))).toBe(true);
  expect(report.backups.some((path) => path.includes("\\taskbar\\"))).toBe(true);

  const startBackup = report.backups.find((path) => path.includes("\\start-menu\\"));
  const taskbarBackup = report.backups.find((path) => path.includes("\\taskbar\\"));
  expect(await readFile(startBackup, "utf8")).toBe("start-menu-original");
  expect(await readFile(taskbarBackup, "utf8")).toBe("taskbar-original");
}, 30_000);

windowsTest("Windows installer -WhatIf nevytvoří bootstrap, icon, config ani zkratky", async () => {
  const fixture = await shortcutFixture("what-if", { createShortcutRoots: false });
  const result = runInstaller(fixture, ["-WhatIf"]);

  expect(result.exitCode).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("installation validation failed");
  expect(await Bun.file(join(fixture.startMenu, shortcutName)).exists()).toBe(false);
  expect(await Bun.file(join(fixture.taskbar, shortcutName)).exists()).toBe(false);
  expect(await Bun.file(join(fixture.install, "Launchpad-Bootstrap.ps1")).exists()).toBe(false);
  expect(await Bun.file(join(fixture.install, "assets", "launchpad.ico")).exists()).toBe(false);
  expect(await Bun.file(join(fixture.install, "install.json")).exists()).toBe(false);
}, 30_000);

async function shortcutFixture(name, { createShortcutRoots = true } = {}) {
  const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), `launchpad-shortcut-${name}-`));
  tempRoots.push(fixtureRoot);
  const canonicalRoot = join(fixtureRoot, "canonical-root");
  await mkdir(canonicalRoot);
  await copyFile(join(root, "Launchpad.ps1"), join(canonicalRoot, "Launchpad.ps1"));
  const fixture = {
    fixtureRoot,
    root: canonicalRoot,
    startMenu: join(fixtureRoot, "start-menu"),
    taskbar: join(fixtureRoot, "taskbar"),
    install: join(fixtureRoot, "install"),
  };
  if (createShortcutRoots) {
    await Promise.all([mkdir(fixture.startMenu), mkdir(fixture.taskbar)]);
  }
  return fixture;
}

function runInstaller(fixture, extraArgs) {
  const powershell = windowsPowerShell();
  const usesExplicitRoot = extraArgs.includes("-RootPath");
  return Bun.spawnSync([
    powershell,
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installer,
    ...(usesExplicitRoot ? [] : ["-RootPath", fixture.root]),
    "-StartMenuRoot",
    fixture.startMenu,
    "-TaskbarRoot",
    fixture.taskbar,
    "-InstallRoot",
    fixture.install,
    ...extraArgs,
  ], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LOCALAPPDATA: join(fixture.fixtureRoot, "local-app-data"),
    },
  });
}

function windowsPowerShell() {
  return join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createLegacyShortcut(shortcutPath, canonicalRoot) {
  const launchpadPath = join(canonicalRoot, "Launchpad.ps1");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut(${quotePowerShellLiteral(shortcutPath)})`,
    `$shortcut.TargetPath = ${quotePowerShellLiteral(windowsPowerShell())}`,
    `$shortcut.Arguments = ${quotePowerShellLiteral(`-NoProfile -ExecutionPolicy Bypass -File "${launchpadPath}"`)}`,
    `$shortcut.WorkingDirectory = ${quotePowerShellLiteral(canonicalRoot)}`,
    "$shortcut.Description = 'Legacy Launchpad shortcut'",
    "$shortcut.Save()",
  ].join("; ");
  const result = Bun.spawnSync([
    windowsPowerShell(),
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSuccessfulProcess(result);
}

async function findAtomicTemps(path) {
  if (!(await Bun.file(path).exists())) return [];
  const entries = await readdir(path, { recursive: true });
  return entries.filter((entry) => /\.tmp$/i.test(entry));
}

function expectSuccessfulProcess(result) {
  if (result.exitCode === 0) return;
  throw new Error([
    `Expected Windows PowerShell exit 0, received ${result.exitCode}.`,
    `stdout:\n${result.stdout.toString()}`,
    `stderr:\n${result.stderr.toString()}`,
  ].join("\n"));
}
