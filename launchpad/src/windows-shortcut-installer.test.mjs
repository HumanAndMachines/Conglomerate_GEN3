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

function runInstaller(fixture, extraArgs) {
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return Bun.spawnSync([
    powershell,
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
