import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolveHelper } from "./git-materialization-helper-lib.mjs";

test("helper resolution nabízí jen atomický Windows create-handle primitive", () => {
  expect(resolveHelper({ platform: "darwin", pathExists: () => true })).toBeNull();
  expect(resolveHelper({ platform: "linux", pathExists: () => true })).toBeNull();

  const windows = resolveHelper({
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    pathExists: () => true,
  });
  expect(windows.command[0]).toBe(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  expect(windows.command.at(-1).endsWith("git-materialization-windows.ps1")).toBe(true);

  expect(resolveHelper({ platform: "aix", pathExists: () => true })).toBeNull();
});

test("Windows helper retains no-follow anchors for every materialization write", async () => {
  const windows = await readFile(
    new URL("./git-materialization-windows.ps1", import.meta.url),
    "utf8",
  );

  expect(windows).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
  expect(windows).toContain("organization_anchor_changed");
  expect(windows).toContain("core.sshCommand=");
  expect(windows).toContain("protocol.ext.allow=never");
  expect(windows).toContain("$expectedLockStatus");
  expect(windows).toContain("device = [string]$targetAnchor.Information.VolumeSerialNumber");
  expect(windows).toContain("NtCreateFile");
  expect(windows).toContain("RootDirectory = parent.DangerousGetHandle()");
  expect(windows).toContain("FILE_DELETE_ON_CLOSE");
  expect(windows).toContain("FILE_SHARE_WRITE");
  expect(windows).not.toContain("FILE_SHARE_DELETE");
  expect(windows).not.toContain("CreateDirectoryW");
  expect(windows).toContain("$anchors.Add($targetAnchor.Handle)");
  expect(windows).not.toContain("Remove-Item");
  expect(/^[\x00-\x7F]*$/.test(windows)).toBe(true);
});
