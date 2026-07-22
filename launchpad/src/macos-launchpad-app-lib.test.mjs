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
  const dockXml = dockPlist(
    dockItem({ identity: "ai.humanandmachine.launchpad.gen3", target: appPath }),
  );
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
  expect(
    dockContainsApp(
      dockPlist(dockItem({ identity: "ai.humanandmachine.launchpad.gen3", target: "/wrong.app" })),
      appPath,
    ),
  ).toBe(false);
  expect(
    dockContainsApp(
      dockPlist(dockItem({ identity: MACOS_LAUNCHPAD_APP_NAME, target: appPath })),
      appPath,
    ),
  ).toBe(true);
});

test("Dock detekce nespojí identitu a cestu ze dvou různých položek", () => {
  const appPath = "/Users/pavlalokajova/Applications/HumanAndMachine Launchpad GEN3.app";
  const xml = dockPlist(
    dockItem({ identity: "ai.humanandmachine.launchpad.gen3", target: "/Applications/Stale.app" }),
    dockItem({ identity: "com.example.other", target: appPath }),
  );

  expect(dockContainsApp(xml, appPath)).toBe(false);
});

test("installer připne přes dockutil a po úspěchu restartuje Dock", async () => {
  const fixture = await createFixture();
  const appPath = join(fixture.home, "Applications", MACOS_LAUNCHPAD_APP_NAME);
  const calls = [];
  let pinned = false;
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command.endsWith("defaults")) {
      return {
        ok: true,
        stdout: pinned
          ? dockPlist(dockItem({ identity: MACOS_LAUNCHPAD_APP_NAME, target: appPath }))
          : dockPlist(),
        stderr: "",
      };
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

test("installer po dockutil úspěchu bounded polluje pomalu obnovené Dock preferences", async () => {
  const fixture = await createFixture();
  const appPath = join(fixture.home, "Applications", MACOS_LAUNCHPAD_APP_NAME);
  const waits = [];
  let added = false;
  let exportsAfterAdd = 0;
  const runCommand = (command, args) => {
    if (command.endsWith("defaults")) {
      if (added) exportsAfterAdd += 1;
      return {
        ok: true,
        stdout: added && exportsAfterAdd >= 3
          ? dockPlist(dockItem({ identity: MACOS_LAUNCHPAD_APP_NAME, target: appPath }))
          : dockPlist(),
        stderr: "",
      };
    }
    if (command === "/opt/homebrew/bin/dockutil" && args[0] === "--version") {
      return { ok: true, stdout: "3.1.3", stderr: "" };
    }
    if (command === "/opt/homebrew/bin/dockutil" && args[0] === "--find") {
      return { ok: false, stdout: "", stderr: "not found" };
    }
    if (command === "/opt/homebrew/bin/dockutil" && args[0] === "--add") {
      added = true;
      return { ok: true, stdout: "", stderr: "" };
    }
    if (command === "/usr/bin/killall") return { ok: true, stdout: "", stderr: "" };
    return { ok: false, stdout: "", stderr: "unexpected" };
  };

  const report = await installMacosLaunchpadApp({
    companiesRoot: fixture.root,
    homeDir: fixture.home,
    platform: "darwin",
    sourceIconPath: fixture.icon,
    runCommand,
    dockVerificationAttempts: 5,
    dockVerificationDelayMs: 25,
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  expect(report.dock_status).toBe("pinned");
  expect(report.check.status).toBe("ok");
  expect(exportsAfterAdd).toBeGreaterThanOrEqual(3);
  expect(waits).toEqual([25, 25]);
});

test("Doctor odmítne chybějící nebo neexecutable root Launchpad.command", async () => {
  const fixture = await createFixture();
  const appPath = join(fixture.home, "Applications", MACOS_LAUNCHPAD_APP_NAME);
  const dockXml = dockPlist(
    dockItem({ identity: MACOS_LAUNCHPAD_APP_NAME, target: appPath }),
  );
  const runCommand = (command) =>
    command.endsWith("defaults")
      ? { ok: true, stdout: dockXml, stderr: "" }
      : { ok: false, stdout: "", stderr: "missing" };
  await installMacosLaunchpadApp({
    companiesRoot: fixture.root,
    homeDir: fixture.home,
    platform: "darwin",
    sourceIconPath: fixture.icon,
    runCommand,
  });

  const launchpadCommand = join(fixture.root, "Launchpad.command");
  await chmod(launchpadCommand, 0o644);
  const nonExecutable = inspectMacosLaunchpadApp({
    companiesRoot: fixture.root,
    homeDir: fixture.home,
    platform: "darwin",
    dockPlistXml: dockXml,
  });
  expect(nonExecutable.status).toBe("warn");
  expect(nonExecutable.details).toContain(
    `launchpad_command_missing_or_not_executable: ${launchpadCommand}`,
  );

  await rm(launchpadCommand);
  const missing = inspectMacosLaunchpadApp({
    companiesRoot: fixture.root,
    homeDir: fixture.home,
    platform: "darwin",
    dockPlistXml: dockXml,
  });
  expect(missing.details).toContain(
    `launchpad_command_missing_or_not_executable: ${launchpadCommand}`,
  );
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

function dockPlist(...items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>persistent-apps</key><array>${items.join("")}</array>
</dict></plist>`;
}

function dockItem({ identity, target }) {
  return `<dict>
  <key>tile-data</key><dict>
    <key>bundle-identifier</key><string>${identity}</string>
    <key>file-data</key><dict><key>_CFURLString</key><string>${target}</string></dict>
  </dict>
</dict>`;
}
