import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const tempRoots = [];
const windowsTest = process.platform === "win32" ? test : test.skip;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("Launchpad.ps1 má právě jeden UTF-8 BOM pro Windows PowerShell 5.1", async () => {
  const contents = await readFile(join(root, "Launchpad.ps1"));

  expect(contents.subarray(0, utf8Bom.length).equals(utf8Bom)).toBe(true);
  expect(contents.subarray(utf8Bom.length, utf8Bom.length * 2).equals(utf8Bom)).toBe(false);
  expect(contents.subarray(utf8Bom.length, utf8Bom.length + 1).toString("utf8")).toBe("$");
  expect(contents.toString("utf8").match(/\uFEFF/g)).toHaveLength(1);
});

test("Windows bootstrap a installer mají právě jeden UTF-8 BOM pro PowerShell 5.1", async () => {
  for (const filename of ["Launchpad-Bootstrap.ps1", "Install-LaunchpadShortcut.ps1"]) {
    const contents = await readFile(join(root, filename));

    expect(contents.subarray(0, utf8Bom.length).equals(utf8Bom)).toBe(true);
    expect(contents.subarray(utf8Bom.length, utf8Bom.length * 2).equals(utf8Bom)).toBe(false);
    expect(contents.toString("utf8").match(/\uFEFF/g)).toHaveLength(1);
  }
});

test("Launchpad.cmd přepne konzoli na UTF-8 před českým výstupem", async () => {
  const contents = await readFile(join(root, "Launchpad.cmd"), "utf8");

  expect(contents).toContain("chcp 65001 >nul");
  expect(contents).toContain("%USERPROFILE%\\.bun\\bin\\bun.exe");
  expect(contents).toContain("%LOCALAPPDATA%\\bun\\bin\\bun.exe");
  expect(contents).toContain("--version >nul 2>nul");
});

test("Launchpad.ps1 validuje Bun kandidáta před spuštěním Launchpadu", async () => {
  const contents = await readFile(join(root, "Launchpad.ps1"), "utf8");

  expect(contents).toContain("Get-Command bun -All -CommandType Application");
  expect(contents).toContain("& $candidate --version");
  expect(contents).toContain("$LASTEXITCODE -eq 0");
});

test("Launchpad.ps1 zachová neúspěšný exit code a nechá upgrade zprávu čitelnou", async () => {
  const contents = await readFile(join(root, "Launchpad.ps1"), "utf8");

  expect(contents).toContain("$launchpadExitCode = $LASTEXITCODE");
  expect(contents).toContain('Read-Host "Stiskni Enter pro zavření"');
  expect(contents).toContain("exit $launchpadExitCode");
});

test("Windows bootstrap čte pouze canonical root config a deleguje na Launchpad.ps1", async () => {
  const contents = await readFile(join(root, "Launchpad-Bootstrap.ps1"), "utf8");

  expect(contents).toContain("lazurio.launchpad.windows_install.v1");
  expect(contents).toContain("Join-Path $root 'Launchpad.ps1'");
  expect(contents).toContain("Push-Location -LiteralPath $root");
  expect(contents).toContain("Set-StrictMode -Off");
  expect(contents).toContain("& $launcher");
  expect(contents).toContain("exit $launchpadExitCode");
  expect(contents).not.toContain("Get-Command bun");
  expect(contents).not.toContain("bun.exe");
  expect(contents).not.toContain(".bun");
  expect(contents).not.toMatch(/\bport\b/i);
});

windowsTest("Windows bootstrap zachová canonical cwd a exit code root launcheru", async () => {
  const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), "launchpad-bootstrap-"));
  tempRoots.push(fixtureRoot);
  const marker = join(fixtureRoot, "marker.txt");
  const config = join(fixtureRoot, "install.json");
  await writeFile(join(fixtureRoot, "Launchpad.ps1"), [
    "[System.IO.File]::WriteAllText($env:LAZURIO_BOOTSTRAP_MARKER, (Get-Location).Path)",
    "exit [int]$env:LAZURIO_STUB_EXIT",
  ].join("\r\n"), "utf8");
  await writeFile(config, JSON.stringify({
    schema_version: "lazurio.launchpad.windows_install.v1",
    root: fixtureRoot,
  }), "utf8");

  for (const expectedExit of [0, 7]) {
    const result = runBootstrap(config, {
      LAZURIO_BOOTSTRAP_MARKER: marker,
      LAZURIO_STUB_EXIT: String(expectedExit),
    });
    expect(result.exitCode).toBe(expectedExit);
    expect((await readFile(marker, "utf8")).toLowerCase()).toBe(fixtureRoot.toLowerCase());
  }
}, 30_000);

windowsTest("Windows bootstrap fail-closed odmítne chybějící config i root", async () => {
  const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), "launchpad-bootstrap-invalid-"));
  tempRoots.push(fixtureRoot);
  const missingConfig = runBootstrap(join(fixtureRoot, "missing.json"));
  expect(missingConfig.exitCode).toBe(1);
  expect(`${missingConfig.stdout}\n${missingConfig.stderr}`).toContain("installation config is missing");

  const config = join(fixtureRoot, "install.json");
  await writeFile(config, JSON.stringify({
    schema_version: "lazurio.launchpad.windows_install.v1",
    root: join(fixtureRoot, "missing-root"),
  }), "utf8");
  const missingRoot = runBootstrap(config);
  expect(missingRoot.exitCode).toBe(1);
  expect(`${missingRoot.stdout}\n${missingRoot.stderr}`).toContain("Configured Launchpad root is not available");
}, 30_000);

function runBootstrap(configPath, extraEnv = {}) {
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
    join(root, "Launchpad-Bootstrap.ps1"),
    "-ConfigPath",
    configPath,
  ], {
    cwd: root,
    stdin: Buffer.from("\n"),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
}
