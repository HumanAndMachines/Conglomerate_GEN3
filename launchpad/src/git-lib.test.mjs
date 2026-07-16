import { expect, test } from "bun:test";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { mapWithConcurrency, runGit, safeGitRemoteEnv } from "./git-lib.mjs";
import { initGitRepo } from "./git-fixture-helpers.test.mjs";

test("mapWithConcurrency never runs more than the requested number of workers", async () => {
  let active = 0;
  let maxActive = 0;
  const output = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 10;
  });

  expect(output).toEqual([10, 20, 30, 40, 50]);
  expect(maxActive).toBeLessThanOrEqual(2);
});

test("runGit returns stdout and protects remote probes from interactive credential prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-runner-"));
  await initGitRepo(root);

  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });

  expect(result.ok).toBe(true);
  expect(result.stdout).toBe("main");
  expect(safeGitRemoteEnv()).toMatchObject({
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  });
});
