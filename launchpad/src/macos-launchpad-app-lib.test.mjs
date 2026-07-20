import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MACOS_LAUNCHPAD_APP_NAME,
  dockContainsApp,
  inspectMacosLaunchpadApp,
  installMacosLaunchpadApp,
} from "./macos-launchpad-app-lib.mjs";

const tempRoots = [];
afterEach(async () => Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

test("macOS installer vytvoří validní klikací app bundle se správnou ikonou a rootem", async () => {
  const fixture = await createFixture();
  const calls = [];
  const appPath = join(fixture.home, "Applications", MACOS_LAUNCHPAD_APP_NAME);
  const dockXml = `<string>ai.humanandmachine.launchpad.gen3</string><string>${appPath}</string>`;
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command.endsWith("defaults")) return { ok: true, stdout: dockXml, stderr: "" };
    return { ok: false, stdout: "", stderr: "not installed" };
  };

  const report = await installMacosLaunchpadApp({
    companiesRoot: fixture.root,
    homeDir: fixture.home,
    platform: "darwin",
    sourceIconPath: fixture.icon,
    runCommand,
    revealOnFallback: false,
  });

  expect(report.dock_status).toBe("already_pinned");
  expect(report.check.status).toBe("ok");
  expect(await Bun.file(join(appPath, "Contents", "Resources", "root-path.txt")).text()).toBe(`${fixture.root}\n`);
  expect(await Bun.file(join(appPath, "Contents", "Resources", "launchpad.icns")).text()).toBe("icon");
  expect(await Bun.file(join(appPath, "Contents", "Info.plist")).text()).toContain("ai.humanandmachine.launchpad.gen3");
  expect(calls.some(([command]) => command.endsWith("dockutil"))).toBe(false);
});

test("installer bez dockutil otevře Finder a Doctor zůstane ve varování do ručního připnutí", async () => {
  const fixture = await createFixture();
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command.endsWith("defaults")) return { ok: true, stdout: "<plist/>", stderr: "" };
    if (command === "/usr/bin/open") return { ok: true, stdout: "", stderr: "" };
    return { ok: false, stdout: "", stderr: "missing" };
  };
  const report = await installMacosLaunchpadApp({
    companiesRoot: fixture.root,
    homeDir: fixture.home,
    platform: "darwin",
    sourceIconPath: fixture.icon,
    runCommand,
  });

  expect(report.dock_status).toBe("manual_required");
  expect(report.check.status).toBe("warn");
  expect(report.check.details).toContain(`dock_item_missing: ${report.app_path}`);
  expect(calls).toContainEqual(["/usr/bin/open", "-R", report.app_path]);
});

test("Dock detekce vyžaduje bundle identity nebo název spolu s přesnou app URL", () => {
  const appPath = "/Users/pavlalokajova/Applications/HumanAndMachine Launchpad GEN3.app";
  expect(dockContainsApp(`<string>ai.humanandmachine.launchpad.gen3</string>`, appPath)).toBe(false);
  expect(dockContainsApp(`<string>${MACOS_LAUNCHPAD_APP_NAME}</string><string>file:///wrong.app</string>`, appPath)).toBe(false);
  expect(dockContainsApp(`<string>${MACOS_LAUNCHPAD_APP_NAME}</string><string>${appPath}</string>`, appPath)).toBe(true);
});

test("installer připne přes dockutil a po úspěchu restartuje Dock", async () => {
  const fixture = await createFixture();
  const appPath = join(fixture.home, "Applications", MACOS_LAUNCHPAD_APP_NAME);
  const calls = [];
  let pinned = false;
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command.endsWith("defaults")) {
      return { ok: true, stdout: pinned ? `<string>${MACOS_LAUNCHPAD_APP_NAME}</string><string>${appPath}</string>` : "<plist/>", stderr: "" };
    }
    if (command === "/opt/homebrew/bin/dockutil" && args[0] === "--version") return { ok: true, stdout: "3.1.3", stderr: "" };
    if (command === "/opt/homebrew/bin/dockutil" && args[0] === "--find") return { ok: false, stdout: "", stderr: "not found" };
    if (command === "/opt/homebrew/bin/dockutil" && args[0] === "--add") { pinned = true; return { ok: true, stdout: "", stderr: "" }; }
    if (command === "/usr/bin/killall") return { ok: true, stdout: "", stderr: "" };
    return { ok: false, stdout: "", stderr: "unexpected" };
  };

  const report = await installMacosLaunchpadApp({
    companiesRoot: fixture.root,
    homeDir: fixture.home,
    platform: "darwin",
    sourceIconPath: fixture.icon,
    runCommand,
  });

  expect(report.dock_status).toBe("pinned");
  expect(report.check.status).toBe("ok");
  expect(calls).toContainEqual(["/usr/bin/killall", "Dock"]);
  expect(calls.some(([command]) => command === "/usr/bin/open")).toBe(false);
});

test("Doctor na jiném OS macOS launcher pouze přeskočí", () => {
  expect(inspectMacosLaunchpadApp({ companiesRoot: "/tmp/root", platform: "linux" }).status).toBe("skip");
});

async function createFixture() {
  const base = await mkdtemp(join(tmpdir(), "macos-launchpad-app-"));
  tempRoots.push(base);
  const root = join(base, "Conglomerate_GEN3");
  const home = join(base, "home");
  const icon = join(base, "launchpad.icns");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(root, "Launchpad.command"), "#!/bin/zsh\n", "utf8");
  await chmod(join(root, "Launchpad.command"), 0o755);
  await writeFile(icon, "icon", "utf8");
  return { root, home, icon };
}
