import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  buildLaunchpadInstallInvocation,
  runLaunchpadInstall,
} from "./launchpad-install-lib.mjs";

test("macOS dispatchuje přesně existující Bash adapter", () => {
  expect(buildLaunchpadInstallInvocation({
    root: "/Users/colleague/Lazurio",
    platform: "darwin",
  })).toEqual({
    argv: ["/bin/bash", "/Users/colleague/Lazurio/scripts/install-launchpad-macos.sh"],
    cwd: "/Users/colleague/Lazurio",
  });
});

test("Windows dispatchuje přesně existující PowerShell adapter portable cestou", () => {
  expect(buildLaunchpadInstallInvocation({
    root: "C:\\Users\\Colleague\\Lazurio",
    platform: "win32",
  })).toEqual({
    argv: [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Users\\Colleague\\Lazurio\\Install-LaunchpadShortcut.ps1",
    ],
    cwd: "C:\\Users\\Colleague\\Lazurio",
  });
});

test("nepodporovaná platforma končí před mutací čitelnou runtime chybou", () => {
  expect(() => buildLaunchpadInstallInvocation({ root: "/srv/lazurio", platform: "linux" }))
    .toThrow("podporuje pouze macOS a Windows");
  try {
    buildLaunchpadInstallInvocation({ root: "/srv/lazurio", platform: "linux" });
  } catch (error) {
    expect(error.lazurioExitCode).toBe(1);
  }
});

test("CLI fasáda dědí stdio a vrací exit code adapteru beze změny", async () => {
  let captured;
  const exitCode = await runLaunchpadInstall({
    root: "/Users/colleague/Lazurio",
    platform: "darwin",
    spawn(argv, options) {
      captured = { argv, options };
      return { exited: Promise.resolve(37) };
    },
  });

  expect(exitCode).toBe(37);
  expect(captured).toEqual({
    argv: ["/bin/bash", "/Users/colleague/Lazurio/scripts/install-launchpad-macos.sh"],
    options: {
      cwd: "/Users/colleague/Lazurio",
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  });
});

test("launchpad parser přijímá pouze přesný install kontrakt bez JSON protokolu", async () => {
  const cli = join(import.meta.dirname, "cli.mjs");
  const help = Bun.spawnSync([process.execPath, "run", cli, "launchpad", "install", "--help"]);
  const missing = Bun.spawnSync([process.execPath, "run", cli, "launchpad"]);
  const unknown = Bun.spawnSync([process.execPath, "run", cli, "launchpad", "repair"]);
  const json = Bun.spawnSync([process.execPath, "run", cli, "launchpad", "install", "--json"]);
  const searchFlag = Bun.spawnSync([process.execPath, "run", cli, "launchpad", "install", "--scope", "lazurio"]);

  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("lazurio launchpad install [--root <cesta>]");
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr.toString()).toContain("launchpad vyžaduje jedinou akci `install`");
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr.toString()).toContain("launchpad vyžaduje jedinou akci `install`");
  expect(json.exitCode).toBe(2);
  expect(json.stderr.toString()).toContain("nepodporuje --json");
  expect(searchFlag.exitCode).toBe(2);
  expect(searchFlag.stderr.toString()).toContain("--scope lze použít pouze s příkazem search");
});
