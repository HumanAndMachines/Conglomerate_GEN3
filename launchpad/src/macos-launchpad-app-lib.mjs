import { accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { access, chmod, cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export const MACOS_LAUNCHPAD_APP_NAME = "HumanAndMachine Launchpad GEN3.app";
export const MACOS_LAUNCHPAD_BUNDLE_ID = "ai.humanandmachine.launchpad.gen3";
export const MACOS_LAUNCHPAD_EXECUTABLE = "HumanAndMachineLaunchpadGEN3";
export const MACOS_LAUNCHPAD_DISPLAY_NAME = "HumanAndMachine Launchpad GEN3";

const DEFAULT_DOCK_VERIFICATION_ATTEMPTS = 21;
const DEFAULT_DOCK_VERIFICATION_DELAY_MS = 500;

export function macosLaunchpadAppPath(homeDir = homedir()) {
  return join(homeDir, "Applications", MACOS_LAUNCHPAD_APP_NAME);
}

export function inspectMacosLaunchpadApp({
  companiesRoot,
  homeDir = homedir(),
  platform = process.platform,
  dockPlistXml,
  runCommand = runCommandSync,
} = {}) {
  if (platform !== "darwin") {
    return {
      id: "platform.macos_launchpad_dock",
      status: "skip",
      severity: "required",
      title: "macOS Launchpad v Docku",
      message: "Kontrola macOS aplikace a Docku se na tomto OS nepoužívá.",
      paths: [],
      links: [],
      details: [],
    };
  }

  const expectedRoot = resolve(companiesRoot);
  const appPath = macosLaunchpadAppPath(homeDir);
  const contents = join(appPath, "Contents");
  const infoPath = join(contents, "Info.plist");
  const executablePath = join(contents, "MacOS", MACOS_LAUNCHPAD_EXECUTABLE);
  const iconPath = join(contents, "Resources", "launchpad.icns");
  const rootPath = join(contents, "Resources", "root-path.txt");
  const launchpadCommandPath = join(expectedRoot, "Launchpad.command");
  const problems = [];

  if (!existsSync(appPath)) problems.push(`app_bundle_missing: ${appPath}`);
  if (!fileContains(infoPath, MACOS_LAUNCHPAD_BUNDLE_ID)) problems.push(`bundle_id_invalid: ${infoPath}`);
  if (!fileContains(infoPath, MACOS_LAUNCHPAD_EXECUTABLE)) problems.push(`bundle_executable_invalid: ${infoPath}`);
  if (!isExecutable(executablePath)) problems.push(`launcher_missing_or_not_executable: ${executablePath}`);
  if (!existsSync(iconPath)) problems.push(`icon_missing: ${iconPath}`);
  if (readTrimmed(rootPath) !== expectedRoot) problems.push(`launchpad_root_mismatch: expected ${expectedRoot}`);
  if (!isExecutable(launchpadCommandPath)) {
    problems.push(`launchpad_command_missing_or_not_executable: ${launchpadCommandPath}`);
  }

  const xml = dockPlistXml ?? exportDockPlist(runCommand);
  const dockPinned = problems.length === 0 && dockContainsApp(xml, appPath);
  if (problems.length === 0 && !dockPinned) problems.push(`dock_item_missing: ${appPath}`);

  const repair = "bun run doctor -- --repair-launchpad-dock";
  if (problems.length > 0) {
    return {
      id: "platform.macos_launchpad_dock",
      status: "warn",
      severity: "required",
      title: "macOS Launchpad v Docku",
      message: "Klikací Launchpad aplikace nebo její připnutí v Docku vyžaduje opravu.",
      paths: ["assets/launchpad.icns", "Launchpad.command"],
      links: [],
      details: [...problems, `repair: ${repair}`],
    };
  }

  return {
    id: "platform.macos_launchpad_dock",
    status: "ok",
    severity: "required",
    title: "macOS Launchpad v Docku",
    message: "Launchpad .app má správný cíl a ikonu a je přítomný v Docku.",
    paths: [appPath],
    links: [],
    details: [`bundle_id: ${MACOS_LAUNCHPAD_BUNDLE_ID}`, `root: ${expectedRoot}`],
  };
}

export async function installMacosLaunchpadApp({
  companiesRoot,
  homeDir = homedir(),
  platform = process.platform,
  sourceIconPath = join(companiesRoot, "assets", "launchpad.icns"),
  runCommand = runCommandSync,
  pinToDock = true,
  revealOnFallback = true,
  dockVerificationAttempts = DEFAULT_DOCK_VERIFICATION_ATTEMPTS,
  dockVerificationDelayMs = DEFAULT_DOCK_VERIFICATION_DELAY_MS,
  wait = waitFor,
} = {}) {
  if (platform !== "darwin") throw new Error("macOS Launchpad app lze instalovat pouze na macOS.");
  const root = resolve(companiesRoot);
  const launchpadCommand = join(root, "Launchpad.command");
  await access(launchpadCommand, constants.X_OK);
  await access(sourceIconPath, constants.R_OK);

  const appPath = macosLaunchpadAppPath(homeDir);
  const applicationsRoot = dirname(appPath);
  const stagingPath = join(applicationsRoot, `.${MACOS_LAUNCHPAD_APP_NAME}.staging-${randomUUID()}`);
  const backupRoot = join(homeDir, "Library", "Application Support", "HumanAndMachine", "Launchpad", "app-backups");
  let backupPath = null;
  await mkdir(join(stagingPath, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(stagingPath, "Contents", "Resources"), { recursive: true });

  try {
    await writeFile(join(stagingPath, "Contents", "Info.plist"), infoPlist(), "utf8");
    const executablePath = join(stagingPath, "Contents", "MacOS", MACOS_LAUNCHPAD_EXECUTABLE);
    await writeFile(executablePath, launcherScript(), "utf8");
    await chmod(executablePath, 0o755);
    await writeFile(join(stagingPath, "Contents", "Resources", "root-path.txt"), `${root}\n`, "utf8");
    await cp(sourceIconPath, join(stagingPath, "Contents", "Resources", "launchpad.icns"));

    if (existsSync(appPath)) {
      await mkdir(backupRoot, { recursive: true });
      backupPath = join(backupRoot, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}-${basename(appPath)}`);
      await rename(appPath, backupPath);
    }
    await rename(stagingPath, appPath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    if (backupPath && !existsSync(appPath) && existsSync(backupPath)) await rename(backupPath, appPath);
    throw error;
  }

  let dockStatus = "not_requested";
  if (pinToDock) {
    const before = exportDockPlist(runCommand);
    if (dockContainsApp(before, appPath)) {
      dockStatus = "already_pinned";
    } else {
      const dockutil = findDockutil(runCommand);
      if (dockutil) {
        const existingLabel = runCommand(dockutil, ["--find", "HumanAndMachine Launchpad GEN3"]);
        const pinArgs = existingLabel.ok
          ? ["--add", appPath, "--replacing", "HumanAndMachine Launchpad GEN3", "--no-restart"]
          : ["--add", appPath, "--no-restart"];
        const pin = runCommand(dockutil, pinArgs);
        if (pin.ok) {
          runCommand("/usr/bin/killall", ["Dock"]);
          dockStatus = await waitForDockItem({
            appPath,
            runCommand,
            attempts: dockVerificationAttempts,
            delayMs: dockVerificationDelayMs,
            wait,
          })
            ? "pinned"
            : "pin_unverified";
        } else {
          dockStatus = "pin_failed";
        }
      } else {
        dockStatus = "manual_required";
      }
    }
  }

  const check = inspectMacosLaunchpadApp({ companiesRoot: root, homeDir, platform, runCommand });
  if (dockStatus === "pin_unverified" && check.status === "ok") {
    dockStatus = "pinned";
  }
  if (["manual_required", "pin_failed", "pin_unverified"].includes(dockStatus) && revealOnFallback) {
    runCommand("/usr/bin/open", ["-R", appPath]);
  }
  return { root, app_path: appPath, backup_path: backupPath, dock_status: dockStatus, check };
}

export function dockContainsApp(xml, appPath) {
  if (!xml) return false;
  const fileUrl = pathToFileURL(appPath).href;
  return persistentDockItemBlocks(xml).some((item) => {
    const values = xmlStringValues(item);
    const exactPath = values.some((value) =>
      sameDockTarget(value, appPath, fileUrl),
    );
    const identity = values.some((value) =>
      [
        MACOS_LAUNCHPAD_BUNDLE_ID,
        MACOS_LAUNCHPAD_DISPLAY_NAME,
        MACOS_LAUNCHPAD_APP_NAME,
      ].includes(value),
    );
    return exactPath && identity;
  });
}

async function waitForDockItem({ appPath, runCommand, attempts, delayMs, wait }) {
  const safeAttempts = Number.isSafeInteger(attempts) && attempts > 0
    ? attempts
    : DEFAULT_DOCK_VERIFICATION_ATTEMPTS;
  const safeDelayMs = Number.isSafeInteger(delayMs) && delayMs >= 0
    ? delayMs
    : DEFAULT_DOCK_VERIFICATION_DELAY_MS;
  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    if (dockContainsApp(exportDockPlist(runCommand), appPath)) return true;
    if (attempt + 1 < safeAttempts) await wait(safeDelayMs);
  }
  return false;
}

function persistentDockItemBlocks(xml) {
  const key = /<key>\s*persistent-apps\s*<\/key>/u.exec(xml);
  if (!key) return [];
  const arrayStart = xml.indexOf("<array>", key.index + key[0].length);
  if (arrayStart < 0) return [];
  const arrayBlock = xmlElementBlock(xml, arrayStart, "array");
  if (!arrayBlock) return [];

  const entries = [];
  const tagPattern = /<\/?dict\b[^>]*>/gu;
  let depth = 0;
  let entryStart = -1;
  for (const match of arrayBlock.matchAll(tagPattern)) {
    const closing = match[0].startsWith("</");
    if (!closing) {
      if (depth === 0) entryStart = match.index;
      depth += 1;
      continue;
    }
    if (depth === 0) return [];
    depth -= 1;
    if (depth === 0 && entryStart >= 0) {
      entries.push(arrayBlock.slice(entryStart, match.index + match[0].length));
      entryStart = -1;
    }
  }
  return depth === 0 ? entries : [];
}

function xmlElementBlock(xml, start, tagName) {
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gu");
  tagPattern.lastIndex = start;
  let depth = 0;
  for (const match of xml.matchAll(tagPattern)) {
    const closing = match[0].startsWith("</");
    depth += closing ? -1 : 1;
    if (depth === 0) return xml.slice(start, match.index + match[0].length);
    if (depth < 0) return null;
  }
  return null;
}

function xmlStringValues(xml) {
  return [...xml.matchAll(/<string>([\s\S]*?)<\/string>/gu)]
    .map((match) => decodeXmlText(match[1]).trim());
}

function decodeXmlText(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function sameDockTarget(value, appPath, fileUrl) {
  const withoutTrailingSlash = value.replace(/\/+$/u, "");
  return (
    withoutTrailingSlash === appPath.replace(/\/+$/u, "") ||
    withoutTrailingSlash === fileUrl.replace(/\/+$/u, "")
  );
}

function waitFor(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function fileContains(path, expected) {
  try { return readFileSync(path, "utf8").includes(expected); } catch { return false; }
}

function readTrimmed(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

function isExecutable(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function exportDockPlist(runCommand) {
  const result = runCommand("/usr/bin/defaults", ["export", "com.apple.dock", "-"]);
  return result.ok ? result.stdout : "";
}

function findDockutil(runCommand) {
  for (const candidate of ["/opt/homebrew/bin/dockutil", "/usr/local/bin/dockutil", "dockutil"]) {
    const result = runCommand(candidate, ["--version"]);
    if (result.ok) return candidate;
  }
  return null;
}

function runCommandSync(command, args) {
  try {
    const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
    return {
      ok: result.exitCode === 0,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error.message };
  }
}

function launcherScript() {
  return `#!/bin/zsh\nset -eu\nCONTENTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"\nROOT_PATH="$(/bin/cat "$CONTENTS_DIR/Resources/root-path.txt")"\nexec /usr/bin/open "$ROOT_PATH/Launchpad.command"\n`;
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>HumanAndMachine Launchpad GEN3</string>
  <key>CFBundleExecutable</key><string>${MACOS_LAUNCHPAD_EXECUTABLE}</string>
  <key>CFBundleIconFile</key><string>launchpad.icns</string>
  <key>CFBundleIdentifier</key><string>${MACOS_LAUNCHPAD_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>HumanAndMachine Launchpad GEN3</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>3</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
`;
}
