import { expect, test } from "bun:test";
import { taskPreflightGitCheck } from "./task-preflight-lib.mjs";

test("task preflight fail-closed doporučí ff-only pull, když je main pozadu", async () => {
  const check = await taskPreflightGitCheck("/workspace", {
    gitRunner: fixtureGit({ relation: "0 3" }),
  });

  expect(check.status).toBe("fail");
  expect(check.message).toContain("3 commitů za origin/main");
  expect(check.details.join("\n")).toContain("git pull --ff-only");
});

test("task preflight nepovolí dirty main ani automatický autostash", async () => {
  const check = await taskPreflightGitCheck("/workspace", {
    gitRunner: fixtureGit({ status: " M AGENTS.md", relation: "0 2" }),
  });

  expect(check.status).toBe("fail");
  expect(check.message).toContain("automatický autostash není bezpečný default");
  expect(check.details.join("\n")).toContain("plan-owned worktree");
});

test("task preflight projde jen na čistém mainu shodném s čerstvým origin/main", async () => {
  const check = await taskPreflightGitCheck("/workspace", {
    gitRunner: fixtureGit({}),
  });

  expect(check.status).toBe("ok");
  expect(check.message).toContain("čerstvě ověřenému origin/main");
});

test("task preflight fail-closed při fetch chybě", async () => {
  const check = await taskPreflightGitCheck("/workspace", {
    gitRunner: fixtureGit({ fetchOk: false }),
  });

  expect(check.status).toBe("fail");
  expect(check.message).toContain("nejde ověřit");
});

test("task preflight vyžaduje exact origin/main upstream", async () => {
  const check = await taskPreflightGitCheck("/workspace", {
    gitRunner: fixtureGit({ upstream: "fork/main" }),
  });

  expect(check.status).toBe("fail");
  expect(check.message).toContain("fork/main");
});

function fixtureGit({
  fetchOk = true,
  branch = "main",
  status = "",
  relation = "0 0",
  upstream = "origin/main",
} = {}) {
  return async (args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return ok("/workspace");
    if (command === "fetch origin main --prune") {
      return fetchOk ? ok("") : { ...ok(""), ok: false, stderr: "offline" };
    }
    if (command === "branch --show-current") return ok(branch);
    if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") return ok(upstream);
    if (command === "status --porcelain=v1 --untracked-files=normal") return ok(status);
    if (command === "rev-parse --verify HEAD^{commit}") return ok("a".repeat(40));
    if (command === "rev-parse --verify origin/main^{commit}") return ok("b".repeat(40));
    if (command === "rev-list --left-right --count HEAD...origin/main") return ok(relation);
    throw new Error(`Unexpected git command: ${command}`);
  };
}

function ok(stdout) {
  return { ok: true, stdout, stderr: "", error: null };
}
