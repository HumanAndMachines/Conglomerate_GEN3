import { join } from "node:path";

export function launchpadTestGroups({
  platform,
  requestedTests,
  discoveredTests,
  testRoot,
}) {
  if (platform !== "win32" || requestedTests.length > 0) {
    return [requestedTests];
  }

  const testGroups = discoveredTests
    .filter((path) => path.endsWith(".test.mjs"))
    .sort()
    .map((path) => [join(testRoot, path)]);
  if (testGroups.length === 0) {
    throw new Error(`No Launchpad test files were discovered under ${testRoot}`);
  }
  return testGroups;
}
