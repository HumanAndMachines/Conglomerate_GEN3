import { resolve } from "path";
import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitRemoteEnv,
} from "../launchpad/src/git-lib.mjs";

export async function runPrPreflight({
  repoRoot = process.cwd(),
  baseBranch = "main",
  gitRunner = runGit,
} = {}) {
  const cwd = resolve(repoRoot);
  const local = (args, timeoutMs = GIT_LOCAL_TIMEOUT_MS) => gitRunner(args, { cwd, timeoutMs });
  const remote = (args) => gitRunner(args, {
    cwd,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
  const fetch = await remote(["fetch", "origin", baseBranch, "--prune"]);
  if (!fetch.ok) return failed("fresh_base_unknown", fetch.stderr || fetch.error || "git fetch selhal");

  const [branch, status, head, baseHead, relation] = await Promise.all([
    local(["branch", "--show-current"]),
    local(["status", "--porcelain=v1", "--untracked-files=normal"]),
    local(["rev-parse", "--verify", "HEAD^{commit}"]),
    local(["rev-parse", "--verify", `origin/${baseBranch}^{commit}`]),
    local(["rev-list", "--left-right", "--count", `HEAD...origin/${baseBranch}`]),
  ]);
  const unreadable = [branch, status, head, baseHead, relation].find((result) => !result.ok);
  if (unreadable) return failed("git_state_unknown", unreadable.stderr || unreadable.error || "Git stav nejde přečíst");

  const branchName = branch.stdout;
  const dirty = status.stdout.split("\n").filter(Boolean);
  const [ahead, behind] = relation.stdout.split(/\s+/).map(Number);
  const evidence = {
    branch: branchName || null,
    base_branch: baseBranch,
    head: head.stdout,
    base_head: baseHead.stdout,
    ahead,
    behind,
    remote_branch_head: null,
  };
  if (!branchName || branchName === baseBranch) {
    return failed("invalid_pr_branch", `PR preflight vyžaduje feature branch, ne ${branchName || "detached HEAD"}.`, evidence);
  }
  if (dirty.length > 0) {
    return failed("dirty_worktree", `Worktree má ${dirty.length} lokálních změn; před pushem musí být přesný commit.`, {
      ...evidence,
      changes: dirty.slice(0, 20),
    });
  }
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return failed("git_state_unknown", "Ahead/behind stav není validní.", evidence);
  }
  if (behind > 0) {
    return failed("base_not_ancestor", `Branch neobsahuje nejnovější origin/${baseBranch} (${behind} commitů chybí).`, {
      ...evidence,
      recommended_action: `git rebase origin/${baseBranch}; spusť validace a bun run pr:preflight znovu`,
    });
  }

  const remoteHead = await remote(["ls-remote", "--heads", "origin", `refs/heads/${branchName}`]);
  if (!remoteHead.ok) return failed("remote_branch_unknown", remoteHead.stderr || remoteHead.error || "Remote branch nejde ověřit", evidence);
  const expectedRemoteHead = remoteHead.stdout.trim().split(/\s+/)[0] || null;
  return {
    ok: true,
    code: "ready_to_push",
    message: `Branch je čistá a obsahuje nejnovější origin/${baseBranch} (${baseHead.stdout.slice(0, 12)}).`,
    ...evidence,
    remote_branch_head: expectedRemoteHead,
    push_command: expectedRemoteHead
      ? `git push --force-with-lease=refs/heads/${branchName}:${expectedRemoteHead} origin ${head.stdout}:refs/heads/${branchName}`
      : `git push --set-upstream origin ${head.stdout}:refs/heads/${branchName}`,
  };
}

function failed(code, message, evidence = {}) {
  return { ok: false, code, message, ...evidence };
}

function parseArgs(args) {
  const parsed = { json: false, baseBranch: "main" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--base") {
      parsed.baseBranch = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--base=")) parsed.baseBranch = arg.slice("--base=".length);
  }
  return parsed;
}

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));
  const result = await runPrPreflight({ baseBranch: options.baseBranch });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.ok ? "ok" : "fail"} - ${result.code}: ${result.message}`);
    if (result.head) console.log(`  - HEAD: ${result.head}`);
    if (result.base_head) console.log(`  - origin/${result.base_branch}: ${result.base_head}`);
    if (result.recommended_action) console.log(`  - ${result.recommended_action}`);
    if (result.push_command) console.log(`  - ${result.push_command}`);
  }
  if (!result.ok) process.exit(1);
}
