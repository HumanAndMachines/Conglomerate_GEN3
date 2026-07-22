import { expect, test } from "bun:test";
import { runPrPreflight } from "./pr-preflight.mjs";

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

function fixtureGit({ relation = "3 0", status = "", remoteHead = "c".repeat(40) } = {}) {
  return async (args) => {
    const command = args.join(" ");
    if (command === "fetch origin main --prune") return ok("");
    if (command === "branch --show-current") return ok("feature");
    if (command === "status --porcelain=v1 --untracked-files=normal") return ok(status);
    if (command === "rev-parse --verify HEAD^{commit}") return ok("a".repeat(40));
    if (command === "rev-parse --verify origin/main^{commit}") return ok("b".repeat(40));
    if (command === "rev-list --left-right --count HEAD...origin/main") return ok(relation);
    if (command === "ls-remote --heads origin refs/heads/feature") {
      return ok(remoteHead ? `${remoteHead}\trefs/heads/feature` : "");
    }
    throw new Error(`Unexpected git command: ${command}`);
  };
}

function ok(stdout) {
  return { ok: true, stdout, stderr: "", error: null };
}
