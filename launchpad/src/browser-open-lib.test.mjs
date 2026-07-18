import { expect, test } from "bun:test";
import { browserOpenCommand, openBrowser } from "./browser-open-lib.mjs";

const url = "http://127.0.0.1:4174";

test("Windows browser open používá cmd.exe ze SystemRoot a ignoruje cizí ComSpec", () => {
  expect(browserOpenCommand(url, {
    platform: "win32",
    env: {
      ComSpec: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      SystemRoot: "C:\\Windows",
    },
  })).toEqual([
    "C:\\Windows\\System32\\cmd.exe",
    "/d",
    "/c",
    "start",
    "",
    url,
  ]);
});

test("browser open nehlásí úspěch, když systémový opener selže", async () => {
  const commands = [];
  await expect(openBrowser(url, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawn: (command, options) => {
      commands.push({ command, options });
      return {
        stderr: new Response("browser unavailable").body,
        exited: Promise.resolve(1),
      };
    },
  })).rejects.toMatchObject({
    code: "browser_open_failed",
    message: "Otevření prohlížeče selhalo: browser unavailable",
  });
  expect(commands).toEqual([{
    command: [
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/c",
      "start",
      "",
      url,
    ],
    options: {
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    },
  }]);
});
