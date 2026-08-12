#!/usr/bin/env bun
// Kanonická lane pro založení root worktree (decisions 0049/0103/0112):
// worktree + branch + schema-validní sidecar jedním příkazem, aby worktrees
// vznikaly správně už konstrukcí a Launchpad/doctor s nimi uměly pracovat.
//
// Použití:
//   bun run worktrees:create -- --plan CAC-0085 [--branch agent/<basename>]
//     [--purpose "..."] [--surface claude-code] [--agent-label "Claude Code"]
//     [--created-by <id>] [--dry-run]

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { trustedGitExecutable } from "./agent-skills-entrypoint.mjs";
import {
  parseWorktreeCreateArgs,
  PLAN_CODE_PATTERN,
} from "./worktree-create-contract.mjs";
import {
  allocateOwnedWorktreeBranch,
  rollbackCreatedWorktree,
  writeSidecarAtomically,
} from "./worktree-create-lib.mjs";
import {
  CHECKOUT_TRANSPORT_OVERRIDE_PATTERN,
  SAFE_WORKTREE_GIT_CONFIG,
  safeWorktreeGitEnvironment,
} from "./worktree-create-git-policy.mjs";
import {
  acquireCreateLock,
  releaseCreateLock,
} from "./worktree-create-lock.mjs";
import {
  resolveAuthorityRoot,
  validateCanonicalMissionControlPlan,
} from "../.agents/skills/worktree-development-discipline/scripts/worktree-inventory.mjs";

let activeCreateLock = null;

function canonicalOwnedWorktreePath(path) {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink() ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function fail(message) {
  throw new Error(message);
}

function git(cwd, args, { allowFail = false, useSafetyConfig = true } = {}) {
  const executable = trustedGitExecutable();
  if (!executable) fail("důvěryhodný Git executable nebyl nalezen.");
  const result = spawnSync(executable, [...(useSafetyConfig ? SAFE_WORKTREE_GIT_CONFIG : []), ...args], {
    cwd,
    encoding: "utf8",
    env: safeWorktreeGitEnvironment(),
    shell: false,
  });
  if (result.status !== 0 && !allowFail) {
    fail(`git ${args.join(" ")} selhalo: ${(result.stderr || "").trim()}`);
  }
  return {
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function resolveRepositoryIdentity(primaryRoot) {
  // Čti deklarovaný remote bez `insteadOf` expanze: identita repozitáře je
  // kontrakt checkoutu, ne výsledek lokální transportní optimalizace.
  const remote = git(primaryRoot, ["config", "--local", "--get", "remote.origin.url"]);
  const normalized = remote.stdout.replaceAll("\\", "/");
  const match = normalized.match(/github\.com(?::|\/)([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) fail(`origin remote nejde rozparsovat na identitu: ${normalized}`);
  return {
    remoteUrl: remote.stdout,
    organization: match[1],
    module: match[2].replace(/_GEN[0-9]+$/i, ""),
  };
}

function checkoutTransportOverrideKeys(primaryRoot) {
  const keys = [];
  const worktreeConfig = git(
    primaryRoot,
    ["config", "--local", "--get", "extensions.worktreeConfig"],
    { allowFail: true, useSafetyConfig: false },
  );
  const scopes = ["--local"];
  if (worktreeConfig.status === 0 && worktreeConfig.stdout.toLowerCase() === "true") {
    scopes.push("--worktree");
  }
  for (const scope of scopes) {
    const overrides = git(primaryRoot, [
      "config", scope,
      "--name-only",
      "--get-regexp",
      CHECKOUT_TRANSPORT_OVERRIDE_PATTERN,
    ], { allowFail: true, useSafetyConfig: false });
    if (overrides.status === 1) continue;
    if (overrides.status !== 0) {
      fail(`${scope} transportní konfiguraci nelze bezpečně ověřit: ${overrides.stderr}`);
    }
    keys.push(...overrides.stdout.split("\n").filter(Boolean));
  }
  return [...new Set(keys)];
}

async function findPlanFile(authorityRoot, planCode) {
  const planRoots = [
    join(authorityRoot, "mission-control", "db", "data", "mission-control", "plans"),
  ];
  const matches = [];
  for (const planRoot of planRoots) {
    if (!existsSync(planRoot)) continue;
    const stack = [planRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (
          entry.name.endsWith(".yaml")
          && (entry.name === `${planCode}.yaml` || entry.name.startsWith(`${planCode}-`))
        ) {
          matches.push(entryPath);
        }
      }
    }
  }
  matches.sort((left, right) => left.localeCompare(right));
  if (matches.length > 1) {
    throw new Error(
      `plán ${planCode} má více kanonických kandidátů: ${matches.join(", ")}`,
    );
  }
  if (matches.length === 0) return null;
  return {
    path: matches[0],
    relative: relative(authorityRoot, matches[0]).split(sep).join("/"),
  };
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
  let plan;
  try {
    plan = await findPlanFile(authorityRoot, planCode);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!plan) {
    fail(
      `plán ${planCode} nebyl nalezen v HumanAndMachine-ai authority checkoutu ${authorityRoot}; `
      + "worktree bez vlastnického Mission Control plánu je orphan/invalid (decision 0049).",
    );
  }
  let planSource;
  let planData;
  try {
    planSource = await readFile(plan.path, "utf8");
    planData = Bun.YAML.parse(planSource);
  } catch (error) {
    fail(`plán ${plan.relative} nejde načíst: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!planData || typeof planData !== "object" || Array.isArray(planData)) {
    fail(`plán ${plan.relative} nemá objektový YAML kořen.`);
  }
  const planValidation = await validateCanonicalMissionControlPlan(
    authorityRoot,
    plan.path,
    planData,
  );
  if (!planValidation.valid) {
    fail(`plán ${plan.relative} neprošel kanonickou validací: ${planValidation.error}`);
  }
  if (planData.dev_code !== planCode) {
    fail(`plán ${plan.relative} deklaruje dev_code ${String(planData.dev_code)}, očekáváno ${planCode}.`);
  }
  const planBasename = basename(plan.path, ".yaml");
  const worktreePath = join(primaryRoot, ".worktrees", "root", planBasename);
  const sidecarPath = join(primaryRoot, ".worktrees", "root", `${planBasename}.worktree.json`);
  const branch = options.branch ?? `agent/${planBasename}`;
  if (!branch.includes(planCode)) {
    fail(`branch ${branch} neobsahuje kód plánu ${planCode}.`);
  }

  const createLockPath = join(primaryRoot, ".worktrees", ".worktree-create.lock");
  await mkdir(dirname(createLockPath), { recursive: true });
  const acquiredLock = await acquireCreateLock({
    lockPath: createLockPath,
    primaryRoot,
    branch,
    planCode,
  });
  if (!acquiredLock.ok) {
    fail(`jiná worktree create operace blokuje create lane: ${acquiredLock.message}.`);
  }
  activeCreateLock = acquiredLock.lock;

  if (existsSync(worktreePath)) fail(`worktree už existuje: ${worktreePath}`);
  // Osiřelý sidecar bez worktree může nést recovery handoff přerušené práce —
  // nikdy ho tiše nepřepisuj.
  if (existsSync(sidecarPath)) fail(`sidecar už existuje: ${sidecarPath}; zkontroluj jeho recovery_handoff a odstraň ho vědomě.`);
  const identity = resolveRepositoryIdentity(primaryRoot);
  const transportOverrides = checkoutTransportOverrideKeys(primaryRoot);
  if (transportOverrides.length > 0) {
    fail(
      "checkout-local transportní konfigurace je zakázaná pro worktree create: "
      + `${transportOverrides.join(", ")}. Odstraň ji vědomě před spuštěním.`,
    );
  }
  const resolvedRemote = git(primaryRoot, ["ls-remote", "--get-url", identity.remoteUrl]);
  if (resolvedRemote.stdout !== identity.remoteUrl) {
    fail(
      `origin URL přepisuje globální url.*.insteadOf (${identity.remoteUrl} -> ${resolvedRemote.stdout}); `
      + "create lane vyžaduje exact endpoint, credential helper a proxy zůstávají podporované.",
    );
  }
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

  git(primaryRoot, [
    "fetch",
    identity.remoteUrl,
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  await mkdir(dirname(worktreePath), { recursive: true });
  const branchAllocation = allocateOwnedWorktreeBranch({
    git,
    primaryRoot,
    branch,
    baseRef: "origin/main",
  });
  if (!branchAllocation.ok) {
    fail(`branch ${branch} nelze bezpečně alokovat: ${branchAllocation.message}. Nic se nemaže bez ownership důkazu.`);
  }
  const worktreeAdd = git(primaryRoot, ["worktree", "add", worktreePath, branch], { allowFail: true });
  if (worktreeAdd.status !== 0) {
    const rollbackReport = rollbackCreatedWorktree({
      git,
      primaryRoot,
      worktreePath,
      canonicalWorktreePath: canonicalOwnedWorktreePath(worktreePath),
      worktreeCreated: false,
      branch,
      ownerMarker: branchAllocation.ownerMarker,
      branchHead: branchAllocation.branchHead,
      pathExists: existsSync,
    });
    fail(`git worktree add selhalo: ${worktreeAdd.stderr || "bez stderr"}; ${rollbackReport}.`);
  }
  try {
    const sidecarWrite = await writeSidecarAtomically({
      sidecarPath,
      contents: `${JSON.stringify(sidecar, null, 2)}\n`,
    });
    if (sidecarWrite.stagingCleanupError) {
      console.error(
        `warn - worktrees:create: sidecar ${sidecarPath} je platně publikovaný, ale staging soubor ${sidecarWrite.stagingPath} `
        + "nelze odstranit; worktree zůstává platný, dokonči úklid staging souboru vědomě.",
      );
    }
  } catch (error) {
    // Bez sidecaru by worktree zůstal orphan a blokoval čistý retry.
    // Prokázaný worktree vrať zpět; owned branch zachovej a příští create ji
    // idempotentně reuse-ne. Ref deletion nelze atomicky svázat s Git worktree
    // registry a mohl by smazat branch právě připojenou jiným aktérem.
    const rollbackReport = rollbackCreatedWorktree({
      git,
      primaryRoot,
      worktreePath,
      canonicalWorktreePath: canonicalOwnedWorktreePath(worktreePath),
      branch,
      ownerMarker: branchAllocation.ownerMarker,
      branchHead: branchAllocation.branchHead,
      pathExists: existsSync,
      stagingPath: error?.stagingPath,
      stagingCleanupError: error?.stagingCleanupError,
    });
    fail(`zápis sidecaru selhal (${error instanceof Error ? error.message : error}); ${rollbackReport}.`);
  }

  console.log(`ok - worktree: ${worktreePath}`);
  console.log(`ok - branch: ${branch} (base origin/main)`);
  console.log(`ok - sidecar: ${sidecarPath}`);
  console.log("next - ověř `bun run worktrees:check`; pracuj podle skillu worktree-development-discipline.");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`fail - worktrees:create: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    const released = await releaseCreateLock(activeCreateLock);
    if (activeCreateLock && !released.released) {
      console.error(
        `warn - worktrees:create: námi vlastněný create lock nelze bezpečně uvolnit (${released.reason}).`,
      );
    }
    activeCreateLock = null;
  }
}
