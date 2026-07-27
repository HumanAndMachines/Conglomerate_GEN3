import { afterAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initGitRepo, runGit } from "./git-fixture-helpers.test.mjs";
import { safeGitRemoteArgs, safeGitRuntimeArgs } from "./git-lib.mjs";
import { taskPreflightGitCheck } from "./task-preflight-lib.mjs";

const tempRoots = [];
const posixTest = test.if(process.platform !== "win32");

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("task preflight fail-closed doporučí guarded update lane, když je main pozadu", async () => {
  const check = await taskPreflightGitCheck("/workspace", {
    gitRunner: fixtureGit({ relation: "0 3" }),
  });

  expect(check.status).toBe("fail");
  expect(check.message).toContain("3 commitů za origin/main");
  expect(check.details.join("\n")).toContain("bun run update");
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

test("task preflight applies runtime and remote Git policies before every subcommand", async () => {
  const calls = [];
  const runner = fixtureGit();
  const check = await taskPreflightGitCheck("/workspace", {
    gitRunner: async (args, options) => {
      calls.push({ args, options });
      return runner(args, options);
    },
  });

  expect(check.status).toBe("ok");
  expect(calls[0].args).toEqual(safeGitRuntimeArgs(["rev-parse", "--show-toplevel"]));
  expect(calls[1].args).toEqual(safeGitRemoteArgs(["fetch", "origin", "main", "--prune"]));
  expect(calls[1].options.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0" });
  const runtimePrefix = safeGitRuntimeArgs([]);
  expect(calls.slice(2).every(({ args }) => (
    JSON.stringify(args.slice(0, runtimePrefix.length)) === JSON.stringify(runtimePrefix)
  ))).toBe(true);
});

posixTest("task preflight never executes checkout-local core.fsmonitor during status", async () => {
  const { checkout } = await createTaskPreflightFixture();
  const marker = join(checkout, ".git", "fsmonitor-ran");
  const helper = join(checkout, ".git", "fsmonitor-marker.sh");
  await writeFile(helper, `#!/bin/sh\nprintf fsmonitor > ${JSON.stringify(marker)}\n`);
  await chmod(helper, 0o755);
  runGit(["config", "core.fsmonitor", helper], checkout);

  const check = await taskPreflightGitCheck(checkout);

  expect(check.status).toBe("ok");
  expect(existsSync(marker)).toBe(false);
});

posixTest("task preflight never executes checkout-local core.sshCommand during fetch", async () => {
  const { checkout } = await createTaskPreflightFixture();
  const marker = join(checkout, ".git", "ssh-command-ran");
  const helper = join(checkout, ".git", "ssh-command-marker.sh");
  await writeFile(helper, `#!/bin/sh\nprintf ssh > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(helper, 0o755);
  runGit(["remote", "set-url", "origin", "ssh://git@127.0.0.1:1/private/repo.git"], checkout);
  runGit(["config", "core.sshCommand", helper], checkout);

  const check = await taskPreflightGitCheck(checkout);

  expect(check.status).toBe("fail");
  expect(existsSync(marker)).toBe(false);
});

posixTest("task preflight blocks git protocol before checkout-local core.gitProxy runs", async () => {
  const { checkout } = await createTaskPreflightFixture();
  const marker = join(checkout, ".git", "git-proxy-ran");
  const helper = join(checkout, ".git", "git-proxy-marker.sh");
  await writeFile(helper, `#!/bin/sh\nprintf proxy > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(helper, 0o755);
  runGit(["remote", "set-url", "origin", "git://127.0.0.1:1/private/repo.git"], checkout);
  runGit(["config", "core.gitProxy", helper], checkout);

  const check = await taskPreflightGitCheck(checkout);

  expect(check.status).toBe("fail");
  expect(existsSync(marker)).toBe(false);
});

async function createTaskPreflightFixture() {
  const root = await mkdtemp(join(tmpdir(), "launchpad-task-preflight-"));
  tempRoots.push(root);
  const checkout = join(root, "checkout");
  await initGitRepo(checkout, { remotePath: join(root, "origin.git") });
  return { checkout };
}

function fixtureGit({
  fetchOk = true,
  branch = "main",
  status = "",
  relation = "0 0",
  upstream = "origin/main",
} = {}) {
  return async (args) => {
    const command = stripGitPolicyArgs(args).join(" ");
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

function stripGitPolicyArgs(args) {
  for (const prefix of [safeGitRemoteArgs([]), safeGitRuntimeArgs([])]) {
    if (prefix.every((value, index) => args[index] === value)) return args.slice(prefix.length);
  }
  return args;
}

function ok(stdout) {
  return { ok: true, stdout, stderr: "", error: null };
}
