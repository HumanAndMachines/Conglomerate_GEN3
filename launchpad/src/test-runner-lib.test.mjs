import { expect, test } from "bun:test";
import { join } from "node:path";
import { launchpadTestGroups } from "./test-runner-lib.mjs";

test("Windows full check isolates every test file in its own Bun process", () => {
  expect(launchpadTestGroups({
    platform: "win32",
    requestedTests: [],
    discoveredTests: ["z.test.mjs", "helpers.mjs", "nested/a.test.mjs"],
    testRoot: "C:\\launchpad\\src",
  })).toEqual([
    [join("C:\\launchpad\\src", "nested/a.test.mjs")],
    [join("C:\\launchpad\\src", "z.test.mjs")],
  ]);
});

test("focused and non-Windows test runs preserve one invocation", () => {
  expect(launchpadTestGroups({
    platform: "win32",
    requestedTests: ["src/runtime-lib.test.mjs", "--test-name-pattern", "Stop"],
    discoveredTests: ["ignored.test.mjs"],
    testRoot: "/launchpad/src",
  })).toEqual([["src/runtime-lib.test.mjs", "--test-name-pattern", "Stop"]]);
  expect(launchpadTestGroups({
    platform: "linux",
    requestedTests: [],
    discoveredTests: ["ignored.test.mjs"],
    testRoot: "/launchpad/src",
  })).toEqual([[]]);
});

test("Windows full check fails closed when test discovery is empty", () => {
  expect(() => launchpadTestGroups({
    platform: "win32",
    requestedTests: [],
    discoveredTests: ["helper.mjs"],
    testRoot: "C:\\launchpad\\src",
  })).toThrow("No Launchpad test files were discovered");
});
