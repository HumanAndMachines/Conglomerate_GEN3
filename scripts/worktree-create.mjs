#!/usr/bin/env bun
// Kanonická lane pro založení root worktree (decisions 0049/0103/0112):
// worktree + branch + schema-validní sidecar jedním příkazem, aby worktrees
// vznikaly správně už konstrukcí a Launchpad/doctor s nimi uměly pracovat.
//
// Použití:
//   bun run worktrees:create -- --plan CAC-0085 [--branch agent/<basename>]
//     [--purpose "..."] [--surface claude-code] [--agent-label "Claude Code"]
//     [--created-by <id>] [--dry-run]

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import {
  parseWorktreeCreateArgs,
  PLAN_CODE_PATTERN,
} from "./worktree-create-contract.mjs";

function fail(message) {
  console.error(`fail - worktrees:create: ${message}`);
  process.exit(1);
}

function git(cwd, args, { allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && !allowFail) {
    fail(`git ${args.join(" ")} selhalo: ${(result.stderr || "").trim()}`);
  }
  return { status: result.status, stdout: (result.stdout || "").trim() };
}

function resolveAuthorityRoot(primaryRoot) {
  if (basename(primaryRoot) === "HumanAndMachines") return primaryRoot;
  if (process.env.HUMANANDMACHINES_ROOT) {
    return resolve(process.env.HUMANANDMACHINES_ROOT);
  }
  return join(dirname(primaryRoot), "HumanAndMachines");
}

function resolveRepositoryIdentity(primaryRoot) {
  const remote = git(primaryRoot, ["remote", "get-url", "origin"]);
  const normalized = remote.stdout.replaceAll("\\", "/");
  const match = normalized.match(/github\.com(?::|\/)([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) fail(`origin remote nejde rozparsovat na identitu: ${normalized}`);
  return {
    organization: match[1],
    module: match[2].replace(/_GEN[0-9]+$/i, ""),
  };
}

async function findPlanFile(authorityRoot, planCode) {
  const planRoots = [
    join(authorityRoot, "mission-control", "db", "data", "mission-control", "plans"),
    join(authorityRoot, "mission-control", "plans"),
  ];
  for (const planRoot of planRoots) {
    if (!existsSync(planRoot)) continue;
    const stack = [planRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const entryPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.name.startsWith(`${planCode}-`) && entry.name.endsWith(".yaml")) {
          return { path: entryPath, relative: relative(authorityRoot, entryPath) };
        }
      }
    }
  }
  return null;
}

async function main() {
  let options;
  try {
    options = parseWorktreeCreateArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const planCode = options.plan;
  if (!planCode || !PLAN_CODE_PATTERN.test(planCode)) {
    fail("--plan <KOD-XXXX> je povinný (kód vlastnického Mission Control plánu).");
  }

  const primaryRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]).stdout;
  if (!existsSync(join(primaryRoot, "launchpad.gen3.json"))) {
    fail(`${primaryRoot} nevypadá jako Conglomerate root (chybí launchpad.gen3.json).`);
  }
  if (primaryRoot.split("/").includes(".worktrees")) {
    fail("spouštěj z primárního checkoutu, ne z linked worktree.");
  }

  const authorityRoot = resolveAuthorityRoot(primaryRoot);
  const plan = await findPlanFile(authorityRoot, planCode);
  if (!plan) {
    fail(
      `plán ${planCode} nebyl nalezen v authority checkoutu ${authorityRoot}; `
      + "worktree bez vlastnického Mission Control plánu je orphan/invalid (decision 0049).",
    );
  }
  const planBasename = basename(plan.path, ".yaml");
  const worktreePath = join(primaryRoot, ".worktrees", "root", planBasename);
  const sidecarPath = join(primaryRoot, ".worktrees", "root", `${planBasename}.worktree.json`);
  const branch = options.branch ?? `agent/${planBasename}`;
  if (!branch.includes(planCode)) {
    fail(`branch ${branch} neobsahuje kód plánu ${planCode}.`);
  }

  if (existsSync(worktreePath)) fail(`worktree už existuje: ${worktreePath}`);
  // Osiřelý sidecar bez worktree může nést recovery handoff přerušené práce —
  // nikdy ho tiše nepřepisuj.
  if (existsSync(sidecarPath)) fail(`sidecar už existuje: ${sidecarPath}; zkontroluj jeho recovery_handoff a odstraň ho vědomě.`);
  if (git(primaryRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).status === 0) {
    fail(`branch ${branch} už existuje.`);
  }

  const identity = resolveRepositoryIdentity(primaryRoot);
  const now = new Date().toISOString();
  const threadId = options["thread-id"]
    ?? process.env.CODEX_THREAD_ID
    ?? process.env.CLAUDE_SESSION_ID
    ?? null;
  const sidecar = {
    schema_version: "companiesascode.worktree.v1",
    organization: identity.organization,
    organization_path: ".",
    workspace: "root",
    module: identity.module,
    module_path: ".",
    repo_kind: "root_repo",
    base_branch: "main",
    branch,
    mission_control_plan_code: planCode,
    mission_control_plan_path: plan.relative,
    worktree_path: `.worktrees/root/${planBasename}`,
    created_at: now,
    created_by: options["created-by"] ?? `${options.surface ?? "agent"}-for-${userInfo().username}@${hostname()}`,
    last_touched: now,
    status: "active",
    pr_url: null,
    purpose: options.purpose ?? `Práce na plánu ${planCode} (${planBasename}).`,
    conversation_origin: {
      surface: options.surface ?? "claude-code",
      agent_label: options["agent-label"] ?? "Worker Agent",
      thread_id: threadId,
      thread_locator_status: threadId ? "captured" : "unavailable",
      local_only: true,
      captured_at: now,
    },
    recovery_handoff: {
      state: "in_progress",
      summary: `Worktree založen lane worktrees:create pro plán ${planCode}.`,
      blocker: null,
      next_action: "Pracuj podle skillu worktree-development-discipline: průběžně commituj a pushuj, po prvním pushi otevři Draft PR.",
      updated_at: now,
    },
    cleanup_rule:
      "Remove only after the pull request is merged or explicitly abandoned, the tree is clean, the exact HEAD is preserved remotely, no runtime uses the path, and no active writer remains.",
  };

  if (options.dryRun) {
    console.log(`ok - dry-run: plán ${plan.relative}`);
    console.log(`ok - dry-run: worktree ${worktreePath}`);
    console.log(`ok - dry-run: branch ${branch} z origin/main`);
    console.log(`ok - dry-run: sidecar ${sidecarPath}`);
    return;
  }

  git(primaryRoot, ["fetch", "origin", "main", "--prune"]);
  await mkdir(dirname(worktreePath), { recursive: true });
  git(primaryRoot, ["worktree", "add", worktreePath, "-b", branch, "origin/main"]);
  try {
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  } catch (error) {
    // Bez sidecaru by worktree zůstal orphan a blokoval čistý retry —
    // čerstvý worktree i branch (== origin/main, bez commitů) vrať zpět.
    // Rollback může taky selhat; výsledek reportuj poctivě, ne optimisticky.
    const worktreeRemoved =
      git(primaryRoot, ["worktree", "remove", "--force", worktreePath], { allowFail: true }).status === 0;
    const branchRemoved =
      git(primaryRoot, ["branch", "-D", branch], { allowFail: true }).status === 0;
    const leftovers = [
      ...(worktreeRemoved ? [] : [`worktree ${worktreePath}`]),
      ...(branchRemoved ? [] : [`branch ${branch}`]),
    ];
    const rollbackReport = leftovers.length === 0
      ? "worktree i branch vráceny"
      : `rollback neúplný, zůstává ${leftovers.join(" a ")} — dokonči úklid ručně (git worktree remove + git branch -D)`;
    fail(`zápis sidecaru selhal (${error instanceof Error ? error.message : error}); ${rollbackReport}.`);
  }

  console.log(`ok - worktree: ${worktreePath}`);
  console.log(`ok - branch: ${branch} (base origin/main)`);
  console.log(`ok - sidecar: ${sidecarPath}`);
  console.log("next - ověř `bun run worktrees:check`; pracuj podle skillu worktree-development-discipline.");
}

await main();
