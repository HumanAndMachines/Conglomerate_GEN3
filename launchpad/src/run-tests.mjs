import { readdir } from "node:fs/promises";
import { launchpadTestGroups } from "./test-runner-lib.mjs";

const defaultTimeoutMs = process.platform === "win32" ? 15_000 : 5_000;
const requestedTests = process.argv.slice(2);
const testGroups = launchpadTestGroups({
  platform: process.platform,
  requestedTests,
  discoveredTests: process.platform === "win32" && requestedTests.length === 0
    ? await readdir(import.meta.dir, { recursive: true })
    : [],
  testRoot: import.meta.dir,
});

let failedExitCode = 0;
for (const tests of testGroups) {
  const child = Bun.spawn(
    [process.execPath, "test", "--timeout", String(defaultTimeoutMs), ...tests],
    {
      cwd: process.cwd(),
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    failedExitCode ||= exitCode ?? 1;
  }
}
process.exitCode = failedExitCode;
