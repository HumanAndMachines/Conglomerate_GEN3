import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const installer = join(root, "Install-LaunchpadShortcut.ps1");
const shortcutName = "HumanAndMachine Launchpad GEN3.lnk";
const tempRoots = [];
const windowsTest = process.platform === "win32" ? test : test.skip;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("Windows installer kontrakt atomicky vlastní unikátní backup run bez přepisování", async () => {
  const contents = await readFile(installer, "utf8");

  expect(contents).toContain("[datetime]$BackupTime = (Get-Date)");
  expect(contents).toContain("[guid]::NewGuid().ToString('N')");
  expect(contents).toContain("New-Item -ItemType Directory -Path $candidateRoot -ErrorAction Stop");
  expect(contents).toContain("[System.IO.File]::Copy($ShortcutPath, $backupPath, $false)");
});

test("Windows installer používá stabilní bootstrap a zneškodní worktree scheduled task", async () => {
  const contents = await readFile(installer, "utf8");
  const bootstrap = await readFile(join(root, "assets", "Launchpad-Bootstrap.ps1"), "utf8");

  expect(contents).toContain("Launchpad-Bootstrap.ps1");
  expect(contents).toContain("humanandmachine.launchpad.windows_install.v1");
  expect(contents).toContain("Disable-TemporaryLaunchpadScheduledTasks");
  expect(contents).toContain(".worktrees");
  expect(contents).toContain("Microsoft\\Windows\\Start Menu\\Programs");
  expect(bootstrap).toContain("$pathSegments -contains '.worktrees'");
  expect(bootstrap).toContain("launchpad.gen3.json");
});

windowsTest("Windows installer zachová dva backupy ze stejné sekundy bez kolize", async () => {
  const fixture = await shortcutFixture("same-second-backups");
  const startMenuShortcut = join(fixture.startMenu, shortcutName);
  const backupTime = "2026-07-18T12:34:56";
  await writeFile(startMenuShortcut, "first-original", "utf8");

  const firstResult = runInstaller(fixture, ["-StartMenuOnly", "-BackupTime", backupTime]);
  expect(firstResult.exitCode).toBe(0);
  const firstReport = JSON.parse(firstResult.stdout.toString());
  expect(firstReport.installed_bootstrap).toContain("Launchpad-Bootstrap.ps1");
  expect(firstReport.install_config).toContain("install.json");
  expect(firstReport.backups).toHaveLength(1);
  const firstBackup = firstReport.backups[0];
  expect(await readFile(firstBackup, "utf8")).toBe("first-original");

  await writeFile(startMenuShortcut, "second-original", "utf8");
  const secondResult = runInstaller(fixture, ["-StartMenuOnly", "-BackupTime", backupTime]);
  expect(secondResult.exitCode).toBe(0);
  const secondReport = JSON.parse(secondResult.stdout.toString());
  expect(secondReport.backups).toHaveLength(1);
  const secondBackup = secondReport.backups[0];

  expect(secondBackup).not.toBe(firstBackup);
  expect(firstBackup).toContain("20260718-123456");
  expect(secondBackup).toContain("20260718-123456");
  expect(await readFile(firstBackup, "utf8")).toBe("first-original");
  expect(await readFile(secondBackup, "utf8")).toBe("second-original");
}, 30_000);

windowsTest("Windows bootstrap odmítne dočasný worktree jako instalaci", async () => {
  const fixture = await shortcutFixture("bootstrap-worktree");
  const configPath = join(fixture.root, "install.json");
  await writeFile(configPath, JSON.stringify({
    schema_version: "humanandmachine.launchpad.windows_install.v1",
    root: join(fixture.root, ".worktrees", "root", "temporary-launchpad"),
  }), "utf8");

  const result = Bun.spawnSync([
    powershellPath(),
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(root, "assets", "Launchpad-Bootstrap.ps1"),
    "-ConfigPath",
    configPath,
  ], { stdout: "pipe", stderr: "pipe" });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("refuses to start from a temporary worktree");
}, 30_000);

windowsTest("Windows installer skutečně vypne worktree scheduled task a zachová audit", async () => {
  const fixture = await shortcutFixture("scheduled-task-quarantine");
  const taskName = `HumanAndMachine Launchpad Worktree Test ${crypto.randomUUID()}`;
  const fakeWorktreeAction = join(fixture.root, ".worktrees", "root", "temporary-launchpad", "launchpad.exe");

  try {
    const registered = runPowerShell([
      `$action = New-ScheduledTaskAction -Execute '${psLiteral(fakeWorktreeAction)}'`,
      "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddDays(1)",
      `Register-ScheduledTask -TaskName '${psLiteral(taskName)}' -Action $action -Trigger $trigger -Description 'Launchpad quarantine regression fixture' -Force | Out-Null`,
    ].join("; "));
    expect(registered.exitCode).toBe(0);

    const result = runInstaller(fixture, [], { auditLegacyTasks: true });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    const quarantined = report.legacy_scheduled_tasks.find((task) => task.task?.includes(taskName));
    expect(quarantined).toMatchObject({ state: "disabled" });

    const state = runPowerShell(`(Get-ScheduledTask -TaskName '${psLiteral(taskName)}').State`);
    expect(state.exitCode).toBe(0);
    expect(state.stdout.toString().trim()).toBe("Disabled");
  } finally {
    runPowerShell(`Unregister-ScheduledTask -TaskName '${psLiteral(taskName)}' -Confirm:$false -ErrorAction SilentlyContinue`);
  }
}, 60_000);

windowsTest("Windows installer zachová Start Menu a taskbar zkratky v oddělených zálohách", async () => {
  const fixture = await shortcutFixture("backups");
  const startMenuShortcut = join(fixture.startMenu, shortcutName);
  const taskbarShortcut = join(fixture.taskbar, shortcutName);
  await writeFile(startMenuShortcut, "start-menu-original", "utf8");
  await writeFile(taskbarShortcut, "taskbar-original", "utf8");

  const result = runInstaller(fixture, ["-SkipShellPin"]);
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString());
  expect(report.backups).toHaveLength(2);
  expect(report.backups.some((path) => path.includes("\\start-menu\\"))).toBe(true);
  expect(report.backups.some((path) => path.includes("\\taskbar\\"))).toBe(true);

  const startBackup = report.backups.find((path) => path.includes("\\start-menu\\"));
  const taskbarBackup = report.backups.find((path) => path.includes("\\taskbar\\"));
  expect(await readFile(startBackup, "utf8")).toBe("start-menu-original");
  expect(await readFile(taskbarBackup, "utf8")).toBe("taskbar-original");
}, 30_000);

windowsTest("Windows installer -WhatIf neprovádí zápis ani falešnou následnou validaci", async () => {
  const fixture = await shortcutFixture("what-if", { createShortcutRoots: false });
  const result = runInstaller(fixture, ["-WhatIf"]);

  expect(result.exitCode).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("Launchpad shortcut validation failed");
  expect(await Bun.file(join(fixture.startMenu, shortcutName)).exists()).toBe(false);
  expect(await Bun.file(join(fixture.taskbar, shortcutName)).exists()).toBe(false);
  expect(await Bun.file(join(fixture.assets, "launchpad.ico")).exists()).toBe(false);
}, 30_000);

async function shortcutFixture(name, { createShortcutRoots = true } = {}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), `launchpad-shortcut-${name}-`));
  tempRoots.push(fixtureRoot);
  const fixture = {
    root: fixtureRoot,
    startMenu: join(fixtureRoot, "start-menu"),
    taskbar: join(fixtureRoot, "taskbar"),
    assets: join(fixtureRoot, "assets"),
  };
  if (createShortcutRoots) {
    await Promise.all([mkdir(fixture.startMenu), mkdir(fixture.taskbar)]);
  }
  return fixture;
}

function runInstaller(fixture, extraArgs, { auditLegacyTasks = false } = {}) {
  return Bun.spawnSync([
    powershellPath(),
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installer,
    "-RootPath",
    root,
    "-StartMenuRoot",
    fixture.startMenu,
    "-TaskbarRoot",
    fixture.taskbar,
    "-InstalledAssetRoot",
    fixture.assets,
    "-InstalledRoot",
    join(fixture.root, "installed"),
    ...(auditLegacyTasks ? [] : ["-SkipLegacyTaskAudit"]),
    ...extraArgs,
  ], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LOCALAPPDATA: join(fixture.root, "local-app-data"),
    },
  });
}

function runPowerShell(command) {
  return Bun.spawnSync([
    powershellPath(),
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], { stdout: "pipe", stderr: "pipe" });
}

function psLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function powershellPath() {
  return join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}
