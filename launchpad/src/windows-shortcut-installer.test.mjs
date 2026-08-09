import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const installer = join(root, "Install-LaunchpadShortcut.ps1");
const shortcutName = "HumanAndMachine Launchpad GEN3.lnk";
const tempRoots = [];
const windowsTest = process.platform === "win32" ? test : test.skip;
const windowsCiTest = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted" ? test : test.skip;

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

test("Windows installer publikuje bootstrap a config atomickým přejmenováním", async () => {
  const contents = await readFile(installer, "utf8");

  expect(contents).toContain("Publish-AtomicFile");
  expect(contents).toContain("Write-AtomicUtf8File");
  expect(contents).toContain("$backupPath = New-AtomicTemporaryPath -DestinationPath $DestinationPath");
  expect(contents).toContain("[System.IO.File]::Replace($TemporaryPath, $DestinationPath, $backupPath)");
  expect(contents).toContain("$replaceFailure = $_.Exception.GetBaseException()");
  expect(contents).toContain("$replaceFailure -is [System.IO.FileNotFoundException]");
  expect(contents).not.toContain("[System.IO.File]::Replace($TemporaryPath, $DestinationPath, $null)");
  expect(contents).not.toContain("if (Test-Path -LiteralPath $DestinationPath -PathType Leaf)");
  expect(contents).toContain("-SourcePath $sourceBootstrapPath -DestinationPath $installedBootstrapPath");
  expect(contents).toContain("Write-AtomicUtf8File -DestinationPath $installConfigPath");
});

test("Windows installer používá stabilní bootstrap a quarantinuje jen vlastní worktree scheduled task", async () => {
  const contents = await readFile(installer, "utf8");
  const bootstrap = await readFile(join(root, "assets", "Launchpad-Bootstrap.ps1"), "utf8");

  expect(contents).toContain("Launchpad-Bootstrap.ps1");
  expect(contents).toContain("humanandmachine.launchpad.windows_install.v1");
  expect(contents).toContain("[int]$LaunchpadPort = 4174");
  expect(contents).toContain("port = $LaunchpadPort");
  expect(contents).toContain("Disable-TemporaryLaunchpadScheduledTasks");
  expect(contents).toContain("Test-ManagedLaunchpadScheduledTask");
  expect(contents).toContain("[string[]]$managedLegacyLaunchpadTaskNames = @(");
  expect(contents).toContain("'HumanAndMachine Launchpad GEN3'");
  expect(contents).toContain("[string]$managedLegacyLaunchpadTaskPath = '\\'");
  expect(contents).toContain("$taskPath -eq $managedLegacyLaunchpadTaskPath");
  expect(contents).toContain(".worktrees");
  expect(contents).toContain("Microsoft\\Windows\\Start Menu\\Programs");
  expect(bootstrap).toContain("$pathSegments -contains '.worktrees'");
  expect(bootstrap).toContain("Test-PathContainsReparsePoint");
  expect(bootstrap).toContain("[System.IO.FileAttributes]::ReparsePoint");
  expect(bootstrap).toContain("launchpad.gen3.json");
  expect(bootstrap).toContain("Get-Command bun -All -CommandType Application");
  expect(bootstrap).toContain("run launchpad -- --port $port");
});

test("Mutační Windows Scheduled Task fixture vyžaduje GitHub-hosted runner", async () => {
  const contents = await readFile(import.meta.filename, "utf8");
  const runnerGate = contents.split(/\r?\n/).slice(0, 15).join("\n");

  expect(runnerGate).toContain('process.env.GITHUB_ACTIONS === "true"');
  expect(runnerGate).toContain('process.env.RUNNER_ENVIRONMENT === "github-hosted"');
});

test("Windows instalační authority chain drží stejnou integrity hranici", async () => {
  const [readme, rawIssues, incident] = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "ISSUES.open.json"), "utf8"),
    readFile(join(root, "manual", "incidents", "2026-08-09-windows-launchpad-startup-reliability.md"), "utf8"),
  ]);
  const windowsIssue = JSON.parse(rawIssues).issues.find((issue) => issue.id === "issue-2026-08-09-001");
  expect(windowsIssue).toBeTruthy();
  const authoritySurfaces = [readme, windowsIssue.implemented_mitigation.join("\n"), incident];

  const rootTaskPath = String.fromCharCode(92);
  const authorityClaims = [
    "Pracovní složka zástupce zůstává ve stabilním LocalAppData adresáři `%LOCALAPPDATA%\\HumanAndMachine\\Launchpad`; fallback na jiný Git checkout se nikdy nepoužije.",
    "Legacy Scheduled Task se vypne jen při exact tuple: TaskName `HumanAndMachine Launchpad GEN3`, root TaskPath `" + rootTaskPath + "` a akce míří do `.worktrees`; prefix i non-root task zůstávají aktivní.",
    "Reparse ochrana je trusted-local integrity guard proti přetrvalému aliasu, ne o TOCTOU sandbox proti souběžnému zásahu stejného uživatele.",
    "Každý asset se nejdřív dokončí v unikátním staging souboru stejného adresáře a atomicky publikuje; config jde až jako poslední.",
  ];
  for (const surface of authoritySurfaces) {
    const normalizedSurface = surface.replace(/\s+/g, " ");
    for (const authorityClaim of authorityClaims) {
      expect(normalizedSurface).toContain(authorityClaim);
    }
  }
});

test("Windows GitHub-hosted runtime matrix kryje exact task name mimo root TaskPath", async () => {
  const contents = await readFile(import.meta.filename, "utf8");
  const runtimeFixtureStart = contents.lastIndexOf('windowsCiTest("Windows installer skutečně vypne');
  expect(runtimeFixtureStart).toBeGreaterThan(0);
  const runtimeFixtures = contents.slice(runtimeFixtureStart);

  expect(runtimeFixtures).toContain("scheduled-task-same-name-nonroot");
  expect(runtimeFixtures).toContain("scheduled-task-root-nonworktree");
  expect(runtimeFixtures).toContain("-TaskPath");
  expect(runtimeFixtures).toContain("same-name nonroot task was disabled");
  expect(runtimeFixtures).toContain("root nonworktree task was disabled");
});

test("Windows root Scheduler fixtures svážou registraci, čtení i úklid s explicitním TaskPath", async () => {
  const contents = await readFile(import.meta.filename, "utf8");
  const rootPathArgument = "-TaskPath '${psLiteral(rootTaskPath)}'";
  const fixtureTitles = [
    "Windows installer skutečně vypne worktree scheduled task a zachová audit",
    "Windows installer ponechá cizí worktree scheduled task aktivní",
    "Windows installer ponechá root legacy task s akcí mimo worktree aktivní",
  ];

  for (const fixtureTitle of fixtureTitles) {
    const fixtureStart = contents.indexOf(`windowsCiTest(\"${fixtureTitle}\"`);
    expect(fixtureStart).toBeGreaterThan(0);
    const fixtureEnd = contents.indexOf("}, 60_000);", fixtureStart);
    expect(fixtureEnd).toBeGreaterThan(fixtureStart);
    const fixture = contents.slice(fixtureStart, fixtureEnd);

    expect(fixture).toContain('const rootTaskPath = "\\\\";');
    expect(fixture.split(rootPathArgument).length - 1).toBe(3);
  }
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
  expect(firstReport.launchpad_port).toBe(4174);
  expect(JSON.parse((await readFile(firstReport.install_config, "utf8")).replace(/^\uFEFF/, "")).port).toBe(4174);
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

windowsTest("Windows atomic publish zachová starý obsah, publikuje nový a uklidí staging", async () => {
  const fixture = await shortcutFixture("atomic-publish");
  const atomicRoot = join(fixture.root, "atomic");
  const sourcePath = join(atomicRoot, "source.txt");
  const firstDestinationPath = join(atomicRoot, "first.txt");
  const existingDestinationPath = join(atomicRoot, "existing.txt");
  const missingSourcePath = join(atomicRoot, "missing.txt");
  await mkdir(atomicRoot);
  await writeFile(sourcePath, "new-content", "utf8");
  await writeFile(existingDestinationPath, "old-content", "utf8");

  const result = runPowerShell([
    `$env:LOCALAPPDATA = '${psLiteral(join(fixture.root, "local-app-data"))}'`,
    `. '${psLiteral(installer)}' -WhatIf -RootPath '${psLiteral(root)}' -StartMenuRoot '${psLiteral(fixture.startMenu)}' -TaskbarRoot '${psLiteral(fixture.taskbar)}' -InstalledAssetRoot '${psLiteral(fixture.assets)}' -InstalledRoot '${psLiteral(join(fixture.root, "installed"))}' -SkipLegacyTaskAudit`,
    `Publish-AtomicFile -SourcePath '${psLiteral(sourcePath)}' -DestinationPath '${psLiteral(firstDestinationPath)}'`,
    `if ([System.IO.File]::ReadAllText('${psLiteral(firstDestinationPath)}') -ne 'new-content') { throw 'first-install publish did not write the new content' }`,
    `Publish-AtomicFile -SourcePath '${psLiteral(sourcePath)}' -DestinationPath '${psLiteral(existingDestinationPath)}'`,
    `if ([System.IO.File]::ReadAllText('${psLiteral(existingDestinationPath)}') -ne 'new-content') { throw 'replace publish did not write the new content' }`,
    `$publishFailed = $false; try { Publish-AtomicFile -SourcePath '${psLiteral(missingSourcePath)}' -DestinationPath '${psLiteral(existingDestinationPath)}' } catch { $publishFailed = $true }`,
    `if (-not $publishFailed) { throw 'missing source unexpectedly published' }`,
    `if ([System.IO.File]::ReadAllText('${psLiteral(existingDestinationPath)}') -ne 'new-content') { throw 'failed publish changed existing content' }`,
    `$temporary = @(Get-ChildItem -LiteralPath '${psLiteral(atomicRoot)}' -Force -Filter '.*.tmp')`,
    `if ($temporary.Count -ne 0) { throw 'temporary staging files remained after publish' }`,
  ].join("; "));

  expect(result.exitCode).toBe(0);
}, 30_000);

windowsTest("Windows bootstrap odmítne dočasný worktree jako instalaci", async () => {
  const fixture = await shortcutFixture("bootstrap-worktree");
  const configPath = join(fixture.root, "install.json");
  await writeFile(configPath, JSON.stringify({
    schema_version: "humanandmachine.launchpad.windows_install.v1",
    root: join(fixture.root, ".worktrees", "root", "temporary-launchpad"),
    port: 4174,
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

windowsTest("Windows bootstrap odmítne junction alias do dočasného worktree", async () => {
  const fixture = await shortcutFixture("bootstrap-worktree-junction");
  const temporaryRoot = join(fixture.root, ".worktrees", "root", "temporary-launchpad");
  const junctionRoot = join(fixture.root, "canonical-root-alias");
  const configPath = join(fixture.root, "install.json");
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(join(temporaryRoot, "launchpad.gen3.json"), "{}", "utf8");
  await writeFile(join(temporaryRoot, "package.json"), "{}", "utf8");
  await symlink(temporaryRoot, junctionRoot, "junction");
  await writeFile(configPath, JSON.stringify({
    schema_version: "humanandmachine.launchpad.windows_install.v1",
    root: junctionRoot,
    port: 4174,
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
  expect(result.stdout.toString()).toContain("refuses a configured root through a reparse point");
}, 30_000);

windowsTest("Windows bootstrap spustí kanonický Launchpad na pevném portu", async () => {
  const fixture = await shortcutFixture("bootstrap-fixed-port");
  const canonicalRoot = join(fixture.root, "canonical-root");
  const configPath = join(fixture.root, "install.json");
  await mkdir(canonicalRoot);
  await writeFile(join(canonicalRoot, "launchpad.gen3.json"), "{}", "utf8");
  await writeFile(join(canonicalRoot, "package.json"), JSON.stringify({
    scripts: { launchpad: "bun record-args.mjs" },
  }), "utf8");
  await writeFile(join(canonicalRoot, "record-args.mjs"), [
    "await Bun.write(new URL('observed-args.json', import.meta.url), JSON.stringify(Bun.argv.slice(2)));",
    "process.exit(0);",
  ].join("\n"), "utf8");
  await writeFile(configPath, JSON.stringify({
    schema_version: "humanandmachine.launchpad.windows_install.v1",
    root: canonicalRoot,
    port: 4174,
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

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(canonicalRoot, "observed-args.json"), "utf8"))).toEqual([
    "--port",
    "4174",
  ]);
}, 30_000);

windowsCiTest("Windows installer skutečně vypne worktree scheduled task a zachová audit", async () => {
  const fixture = await shortcutFixture("scheduled-task-quarantine");
  const taskName = "HumanAndMachine Launchpad GEN3";
  const rootTaskPath = "\\";
  const fakeWorktreeAction = join(fixture.root, ".worktrees", "root", "temporary-launchpad", "launchpad.exe");

  try {
    const registered = runPowerShell([
      `$action = New-ScheduledTaskAction -Execute '${psLiteral(fakeWorktreeAction)}'`,
      "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddDays(1)",
      `Register-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(rootTaskPath)}' -Action $action -Trigger $trigger -Description 'Launchpad quarantine regression fixture' -Force | Out-Null`,
    ].join("; "));
    expect(registered.exitCode).toBe(0);

    const result = runInstaller(fixture, [], { auditLegacyTasks: true });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    const quarantined = report.legacy_scheduled_tasks.find((task) => task.task?.includes(taskName));
    expect(quarantined).toMatchObject({ state: "disabled" });

    const state = runPowerShell(`(Get-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(rootTaskPath)}').State`);
    expect(state.exitCode).toBe(0);
    expect(state.stdout.toString().trim()).toBe("Disabled");
  } finally {
    runPowerShell(`Unregister-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(rootTaskPath)}' -Confirm:$false -ErrorAction SilentlyContinue`);
  }
}, 60_000);

windowsCiTest("Windows installer ponechá cizí worktree scheduled task aktivní", async () => {
  const fixture = await shortcutFixture("scheduled-task-unrelated");
  const taskName = `HumanAndMachine Launchpad GEN3 - third-party ${crypto.randomUUID()}`;
  const rootTaskPath = "\\";
  const fakeWorktreeAction = join(fixture.root, ".worktrees", "root", "temporary-launchpad", "launchpad.exe");

  try {
    const registered = runPowerShell([
      `$action = New-ScheduledTaskAction -Execute '${psLiteral(fakeWorktreeAction)}'`,
      "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddDays(1)",
      `Register-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(rootTaskPath)}' -Action $action -Trigger $trigger -Description 'Unrelated worktree fixture' -Force | Out-Null`,
    ].join("; "));
    expect(registered.exitCode).toBe(0);

    const result = runInstaller(fixture, [], { auditLegacyTasks: true });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report.legacy_scheduled_tasks.some((task) => task.task?.includes(taskName))).toBe(false);

    const state = runPowerShell(`(Get-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(rootTaskPath)}').State`);
    expect(state.exitCode).toBe(0);
    expect(state.stdout.toString().trim()).not.toBe("Disabled");
  } finally {
    runPowerShell(`Unregister-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(rootTaskPath)}' -Confirm:$false -ErrorAction SilentlyContinue`);
  }
}, 60_000);

windowsCiTest("Windows installer ponechá exact legacy task mimo root TaskPath aktivní", async () => {
  const fixture = await shortcutFixture("scheduled-task-same-name-nonroot");
  const taskName = "HumanAndMachine Launchpad GEN3";
  const taskFolderName = `HumanAndMachineRegression${crypto.randomUUID().replaceAll("-", "")}`;
  const taskPath = `\\${taskFolderName}\\`;
  const fakeWorktreeAction = join(fixture.root, ".worktrees", "root", "temporary-launchpad", "launchpad.exe");

  try {
    const registered = runPowerShell([
      "$scheduleService = New-Object -ComObject 'Schedule.Service'",
      "$scheduleService.Connect()",
      "$rootFolder = $scheduleService.GetFolder('\\')",
      `$rootFolder.CreateFolder('${psLiteral(taskFolderName)}', $null) | Out-Null`,
      `$action = New-ScheduledTaskAction -Execute '${psLiteral(fakeWorktreeAction)}'`,
      "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddDays(1)",
      `Register-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(taskPath)}' -Action $action -Trigger $trigger -Description 'Same-name nonroot TaskPath regression fixture' -Force | Out-Null`,
    ].join("; "));
    expect(registered.exitCode).toBe(0);

    const result = runInstaller(fixture, [], { auditLegacyTasks: true });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report.legacy_scheduled_tasks.some((task) => task.task?.includes(taskName))).toBe(false);

    const state = runPowerShell(`(Get-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(taskPath)}').State`);
    expect(state.exitCode).toBe(0);
    const stateText = state.stdout.toString().trim();
    if (stateText === "Disabled") {
      throw new Error("same-name nonroot task was disabled");
    }
    expect(stateText).not.toBe("Disabled");
  } finally {
    runPowerShell([
      `Unregister-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(taskPath)}' -Confirm:$false -ErrorAction SilentlyContinue`,
      "$scheduleService = New-Object -ComObject 'Schedule.Service'",
      "$scheduleService.Connect()",
      "$rootFolder = $scheduleService.GetFolder('\\')",
      `try { $rootFolder.DeleteFolder('${psLiteral(taskFolderName)}', 0) } catch { }`,
    ].join("; "));
  }
}, 60_000);

windowsCiTest("Windows installer ponechá root legacy task s akcí mimo worktree aktivní", async () => {
  const fixture = await shortcutFixture("scheduled-task-root-nonworktree");
  const taskName = "HumanAndMachine Launchpad GEN3";
  const rootTaskPath = "\\";
  const canonicalAction = join(fixture.root, "canonical-root", "launchpad.exe");

  try {
    const registered = runPowerShell([
      `$action = New-ScheduledTaskAction -Execute '${psLiteral(canonicalAction)}'`,
      "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddDays(1)",
      `Register-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(rootTaskPath)}' -Action $action -Trigger $trigger -Description 'Root non-worktree action regression fixture' -Force | Out-Null`,
    ].join("; "));
    expect(registered.exitCode).toBe(0);

    const result = runInstaller(fixture, [], { auditLegacyTasks: true });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report.legacy_scheduled_tasks.some((task) => task.task?.includes(taskName))).toBe(false);

    const state = runPowerShell(`(Get-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(rootTaskPath)}').State`);
    expect(state.exitCode).toBe(0);
    const stateText = state.stdout.toString().trim();
    if (stateText === "Disabled") {
      throw new Error("root nonworktree task was disabled");
    }
    expect(stateText).not.toBe("Disabled");
  } finally {
    runPowerShell(`Unregister-ScheduledTask -TaskName '${psLiteral(taskName)}' -TaskPath '${psLiteral(rootTaskPath)}' -Confirm:$false -ErrorAction SilentlyContinue`);
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
