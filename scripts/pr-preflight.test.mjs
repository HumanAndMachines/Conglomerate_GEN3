import { afterAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initGitRepo, runGit } from "../launchpad/src/git-fixture-helpers.test.mjs";
import { safeGitRemoteArgs, safeGitRuntimeArgs } from "../launchpad/src/git-lib.mjs";
import { runPrPreflight } from "./pr-preflight.mjs";

const tempRoots = [];
const posixTest = test.if(process.platform !== "win32");

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("PR preflight blokuje branch bez nejnovějšího mainu", async () => {
  const result = await runPrPreflight({
    repoRoot: "/repo",
    gitRunner: fixtureGit({ relation: "4 2" }),
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe("base_not_ancestor");
  expect(result.recommended_action).toContain("git rebase origin/main");
});

test("PR preflight vrátí exact remote head pro force-with-lease", async () => {
  const remoteHead = "c".repeat(40);
  const result = await runPrPreflight({
    repoRoot: "/repo",
    gitRunner: fixtureGit({ remoteHead }),
  });

  expect(result.ok).toBe(true);
  expect(result.remote_branch_head).toBe(remoteHead);
  expect(result.push_command).toContain(`--force-with-lease=refs/heads/feature:${remoteHead}`);
});

test("PR preflight vyžaduje clean feature branch", async () => {
  const result = await runPrPreflight({
    repoRoot: "/repo",
    gitRunner: fixtureGit({ status: "?? draft.txt" }),
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe("dirty_worktree");
});

test("PR preflight odmítne shell metaznaky v branchi před vytvořením příkazu", async () => {
  const result = await runPrPreflight({
    repoRoot: "/repo",
    gitRunner: fixtureGit({ branch: "feature;touch-pwned" }),
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe("unsafe_branch_name");
  expect(result.push_command).toBeUndefined();
});

test("PR preflight applies shared runtime and remote Git policy before every subcommand", async () => {
  const calls = [];
  const runner = fixtureGit();
  const result = await runPrPreflight({
    repoRoot: "/repo",
    gitRunner: async (args, options) => {
      calls.push({ args, options });
      return runner(args, options);
    },
  });

  expect(result.ok).toBe(true);
  for (const { args, options } of calls) {
    const command = stripGitPolicyArgs(args);
    const remote = command[0] === "fetch" || command[0] === "ls-remote";
    const prefix = remote ? safeGitRemoteArgs([]) : safeGitRuntimeArgs([]);
    expect(args.slice(0, prefix.length)).toEqual(prefix);
    if (remote) expect(options.env).toMatchObject({ NO_PROXY: "*", no_proxy: "*" });
  }
});

posixTest("PR preflight CLI never executes checkout-local core.sshCommand during fetch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pr-preflight-ssh-command-"));
  tempRoots.push(root);
  const checkout = join(root, "checkout");
  await initGitRepo(checkout, { remotePath: join(root, "origin.git") });
  const marker = join(checkout, ".git", "ssh-command-ran");
  const helper = join(checkout, ".git", "ssh-command-marker.sh");
  await writeFile(helper, `#!/bin/sh\nprintf ssh > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(helper, 0o755);
  runGit(["remote", "set-url", "origin", "ssh://git@127.0.0.1:1/private/repo.git"], checkout);
  runGit(["config", "core.sshCommand", helper], checkout);

  const child = Bun.spawnSync([process.execPath, join(import.meta.dirname, "pr-preflight.mjs"), "--base", "main", "--json"], {
    cwd: checkout,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(child.exitCode).toBe(1);
  expect(existsSync(marker)).toBe(false);
});

function fixtureGit({
  branch = "feature",
  relation = "3 0",
  status = "",
  remoteHead = "c".repeat(40),
} = {}) {
  return async (args) => {
    const command = stripGitPolicyArgs(args).join(" ");
    if (command === "fetch origin main --prune") return ok("");
    if (command === "branch --show-current") return ok(branch);
    if (command === "status --porcelain=v1 --untracked-files=normal") return ok(status);
    if (command === "rev-parse --verify HEAD^{commit}") return ok("a".repeat(40));
    if (command === "rev-parse --verify origin/main^{commit}") return ok("b".repeat(40));
    if (command === "rev-list --left-right --count HEAD...origin/main") return ok(relation);
    if (command === `ls-remote --heads origin refs/heads/${branch}`) {
      return ok(remoteHead ? `${remoteHead}\trefs/heads/${branch}` : "");
    }
    throw new Error(`Unexpected git command: ${command}`);
  };
}

function stripGitPolicyArgs(args) {
  for (const prefix of [safeGitRemoteArgs([]), safeGitRuntimeArgs([])]) {
    if (prefix.every((value, index) => args[index] === value)) return args.slice(prefix.length);
  }
  return args;
}

function ok(stdout) {
  return { ok: true, stdout, stderr: "", error: null };
}
