import { expect, test } from "bun:test";
import {
  trustedWindowsSystemExecutable,
  trustedWindowsSystemRoot,
} from "./windows-system-path-lib.mjs";

test("trusted Windows root accepts a local drive and WINDIR fallback", () => {
  expect(trustedWindowsSystemRoot({ SystemRoot: "C:/Windows/" })).toBe("C:\\Windows\\");
  expect(trustedWindowsSystemRoot({ WINDIR: "D:\\WinNT" })).toBe("D:\\WinNT");
  expect(trustedWindowsSystemExecutable(["System32", "netstat.exe"], { SystemRoot: "C:\\Windows" }))
    .toBe("C:\\Windows\\System32\\netstat.exe");
});

test("trusted Windows root rejects missing, relative, traversal, UNC and unsafe segments", () => {
  for (const env of [
    {},
    { SystemRoot: "Windows" },
    { SystemRoot: "C:\\Windows\\..\\Temp" },
    { SystemRoot: "\\\\server\\share\\Windows" },
    { SystemRoot: "C:\\Win*dows" },
  ]) {
    expect(() => trustedWindowsSystemRoot(env)).toThrow("SystemRoot/WINDIR");
  }
  expect(() => trustedWindowsSystemExecutable(["..", "powershell.exe"], { SystemRoot: "C:\\Windows" }))
    .toThrow("unsafe segment");
});
