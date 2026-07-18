import { expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";

const root = join(import.meta.dirname, "..", "..");
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

test("Launchpad.ps1 má právě jeden UTF-8 BOM pro Windows PowerShell 5.1", async () => {
  const contents = await readFile(join(root, "Launchpad.ps1"));

  expect(contents.subarray(0, utf8Bom.length).equals(utf8Bom)).toBe(true);
  expect(contents.subarray(utf8Bom.length, utf8Bom.length * 2).equals(utf8Bom)).toBe(false);
  expect(contents.subarray(utf8Bom.length, utf8Bom.length + 1).toString("utf8")).toBe("$");
  expect(contents.toString("utf8").match(/\uFEFF/g)).toHaveLength(1);
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
