import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { buildGitInventory } from "./git-inventory-lib.mjs";
import { materializeRepoCheckout } from "./git-materialization-lib.mjs";
import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";

export const LAZURIO_UPDATE_STATES = Object.freeze(["current", "updated", "blocked"]);

const BLOCKING_RELATIONS = new Set(["ahead", "diverged", "unknown"]);
const BLOCKING_OPERATIONS = new Set(["merge", "rebase", "am", "cherry_pick", "revert"]);

/**
 * The complete public classifier. It intentionally has no intermediate
 * lifecycle states: Git is inspected again on every run and the caller gets
 * exactly current, updated, or blocked.
 */
export function classifyLazurioRepoUpdate({
  directoryOnly = false,
  operation = null,
  expectedBranch = "main",
  mainRelation = "current",
  detached = false,
  detachedHeadMatchesMain = false,
  sparseOrHiddenIndex = false,
  dirty = false,
  branch = "main",
} = {}) {
  if (directoryOnly) return { state: "current", action: "none", reason: "directory_only" };
  if (operation && BLOCKING_OPERATIONS.has(operation)) {
    return { state: "blocked", action: "none", reason: `${operation}_in_progress` };
  }
  if (expectedBranch !== "main") {
    return { state: "blocked", action: "none", reason: "managed_branch_not_main" };
  }
  if (sparseOrHiddenIndex) {
    return { state: "blocked", action: "none", reason: "hidden_index_state" };
  }
  if (BLOCKING_RELATIONS.has(mainRelation)) {
    return {
      state: "blocked",
      action: "none",
      reason: mainRelation === "ahead" ? "local_main_commits" : `main_${mainRelation}`,
    };
  }
  if (detached && !detachedHeadMatchesMain) {
    return { state: "blocked", action: "none", reason: "detached_head" };
  }
  const needsSwitch = branch !== "main";
  const needsFastForward = mainRelation === "behind";
  if (dirty) {
    return {
      state: "updated",
      action: "stash_switch_fast_forward",
      reason: "local_changes_preserved",
      needsSwitch,
      needsFastForward,
    };
  }
  if (needsSwitch || needsFastForward || mainRelation === "missing") {
    return {
      state: "updated",
      action: needsFastForward ? "fast_forward" : "switch_main",
      reason: needsFastForward ? "fast_forward_available" : "main_checkout_required",
      needsSwitch: true,
      needsFastForward,
    };
  }
  return { state: "current", action: "none", reason: "already_current" };
}

export async function runLazurioUpdate({
  rootPath,
  runtimeRoot = resolve(import.meta.dirname, "..", ".."),
  deps = {},
} = {}) {
  if (!rootPath) throw new Error("runLazurioUpdate requires rootPath");
  const absoluteRoot = resolve(rootPath);
  const now = deps.now ?? (() => new Date());
  const runId = deps.runId ?? randomUUID();
  const acquireLock = deps.acquireLock ?? acquireUpdateLock;
  const buildInventory = deps.buildInventory ?? buildGitInventory;
  const updateRepo = deps.updateRepo ?? updateManagedRepo;
  const materializeRepo = deps.materializeRepo ?? materializeRepoCheckout;
  const checkpoint = deps.checkpoint ?? (() => {});
  let lock;

  if (await runtimeOverlapsWorkingRoot({ runtimeRoot, workingRoot: absoluteRoot })) {
    const result = blockedResult(rootDescriptor(absoluteRoot), "runtime_not_isolated", {
      detail: "Launchpad/CLI runtime běží z pracovního checkoutu, který by měl aktualizovat. Nejdřív spusť immutable Lazurio runtime s tímto checkoutem předaným jako working root.",
      codex: false,
      nextAction: "retry",
    });
    return updateReport({ rootPath: absoluteRoot, runId, now, results: [result], warnings: [] });
  }

  try {
    lock = await acquireLock({ rootPath: absoluteRoot, runId, now });
  } catch (error) {
    return lockedReport({ rootPath: absoluteRoot, runId, now, error });
  }

  const results = [];
  const warnings = [];
  try {
    const rootRepo = rootDescriptor(absoluteRoot);
    const rootResult = await safeUpdateRepo(rootRepo, {
      runId,
      updateRepo,
      checkpoint,
      deps,
    });
    results.push(rootResult);

    const initialInventory = await safeInventory(buildInventory, absoluteRoot, warnings);
    if (initialInventory.failed) {
      results.push(blockedResult(inventoryDescriptor(absoluteRoot), "inventory_unavailable", {
        detail: "Lazurio nedokázalo bezpečně určit Organization rooty a Workspace Moduly; žádný další checkout nezměnilo.",
      }));
      return updateReport({ rootPath: absoluteRoot, runId, now, results, warnings });
    }
    const organizationRoots = managedOrganizationRoots(initialInventory);
    if (rootResult.state === "blocked") {
      results.push(...deferredHierarchyResults(initialInventory, "lazurio::root"));
      return updateReport({ rootPath: absoluteRoot, runId, now, results, warnings });
    }

    for (const organizationRoot of organizationRoots) {
      const organizationResult = await safeUpdateRepo(organizationRoot, {
        runId,
        updateRepo,
        checkpoint,
        deps,
      });
      results.push(organizationResult);

      if (organizationResult.state === "blocked") {
        results.push(...deferredModuleResults(initialInventory, organizationRoot.organization));
        continue;
      }

      // The Organization root owns the manifest. Re-read after its update so
      // a module added on GitHub is materialized during this same run.
      const refreshed = await safeInventory(buildInventory, absoluteRoot, warnings);
      if (refreshed.failed) {
        results.push(blockedResult(inventoryDescriptor(absoluteRoot, organizationRoot.organization), "inventory_unavailable", {
          detail: `Po aktualizaci Organization rootu ${organizationRoot.organization} nešel znovu načíst manifest; Workspace Moduly zůstaly nedotčené.`,
        }));
        continue;
      }
      const modules = managedWorkspaceModules(refreshed, organizationRoot.organization);
      for (const moduleRepo of modules) {
        if (!existsSync(moduleRepo.absolute_path)) {
          const materialized = await safeMaterializeModule({
            rootPath: absoluteRoot,
            repo: moduleRepo,
            runId,
            materializeRepo,
            checkpoint,
            deps,
          });
          results.push(materialized);
          continue;
        }
        results.push(await safeUpdateRepo(moduleRepo, {
          runId,
          updateRepo,
          checkpoint,
          deps,
        }));
      }
    }

    return updateReport({ rootPath: absoluteRoot, runId, now, results, warnings });
  } finally {
    await lock.release().catch(() => {});
  }
}

export async function readLazurioUpdateStatus({ rootPath, deps = {} } = {}) {
  if (!rootPath) throw new Error("readLazurioUpdateStatus requires rootPath");
  const absoluteRoot = resolve(rootPath);
  const rootRepo = rootDescriptor(absoluteRoot);
  const inspect = deps.inspectLocalRepo ?? inspectLocalRepo;
  const buildInventory = deps.buildInventory ?? buildGitInventory;
  const run = deps.runGit ?? runGit;
  let inventory;
  try {
    inventory = await buildInventory({ companiesRoot: absoluteRoot });
  } catch (error) {
    const blocked = blockedResult(inventoryDescriptor(absoluteRoot), "inventory_unavailable", {
      detail: `Lokální inventář nejde bezpečně načíst: ${error instanceof Error ? error.message : String(error)}`,
    });
    return localStatusReport(blocked);
  }
  if ((inventory.warnings ?? []).length > 0) {
    const blocked = blockedResult(inventoryDescriptor(absoluteRoot), "inventory_invalid", {
      detail: `Lokální inventář není úplný: ${inventory.warnings[0]}`,
    });
    return localStatusReport(blocked);
  }

  const repos = [
    rootRepo,
    ...managedOrganizationRoots(inventory),
    ...(inventory.repos ?? [])
      .filter((repo) => repo.repo_kind === "module" && repo.workspace !== "productionspace")
      .sort(compareRepoIdentity),
  ];
  for (const repo of repos) {
    // Chybějící Workspace Modul je legitimní materialization kandidát pro
    // explicitní Sync, ne lokální history blocker prvního renderu.
    if (repo.repo_kind === "module" && !existsSync(repo.absolute_path)) continue;
    const local = await inspect(repo, { ...deps, runGit: run });
    if (!local.ok) {
      return localStatusReport(blockedResult(repo, local.reason ?? "git_inspection_failed", {
        detail: local.detail,
        codex: local.codex !== false,
      }));
    }
    if (local.directoryOnly) continue;
    if (local.operation) {
      return localStatusReport(blockedResult(repo, `${local.operation}_in_progress`, {
        detail: `V repozitáři probíhá ${local.operation}.`,
      }));
    }
    if (repo.expected_branch && repo.expected_branch !== "main") {
      return localStatusReport(blockedResult(repo, "managed_branch_not_main", {
        detail: `Spravovaný checkout deklaruje větev ${repo.expected_branch}; Lazurio update spravuje pouze main.`,
      }));
    }
    if (local.sparseOrHiddenIndex) {
      return localStatusReport(blockedResult(repo, "hidden_index_state", {
        detail: "Index používá skip-worktree nebo assume-unchanged.",
      }));
    }
    const localMain = await commitOid(run, repo.absolute_path, "refs/heads/main");
    const cachedTarget = await commitOid(run, repo.absolute_path, "refs/remotes/origin/main");
    const mainRelation = localMain && cachedTarget
      ? await compareCommits(run, repo.absolute_path, localMain, cachedTarget)
      : localMain ? "current" : "missing";
    const decision = classifyLazurioRepoUpdate({
      mainRelation,
      detached: !local.branch,
      detachedHeadMatchesMain: Boolean(localMain && local.head === localMain),
      dirty: local.dirtyPaths.length > 0,
      branch: local.branch,
    });
    if (decision.state === "blocked") {
      return localStatusReport(blockedResult(repo, decision.reason, {
        detail: relationDetail(mainRelation, local, cachedTarget ?? "cached origin/main chybí"),
      }));
    }
  }

  return {
    schema_version: "lazurio.update_status.v1",
    state: "current",
    checked_remote: false,
    message: "Lazurio je připravené k explicitní synchronizaci; GitHub se na prvním renderu nekontroluje.",
    reason: "explicit_sync_required",
  };
}

function localStatusReport(blocked) {
  return {
    schema_version: "lazurio.update_status.v1",
    state: "blocked",
    checked_remote: false,
    message: blocked.message,
    reason: blocked.reason,
    repo_key: blocked.repo_key,
    next_action: blocked.next_action,
  };
}

async function safeUpdateRepo(repo, context) {
  try {
    return await context.updateRepo(repo, context);
  } catch (error) {
    return blockedResult(repo, "update_internal_error", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function updateManagedRepo(repo, context = {}) {
  const run = context.deps?.runGit ?? runGit;
  const inspect = context.deps?.inspectLocalRepo ?? inspectLocalRepo;
  const installDependencies = context.deps?.installDependencies ?? installFrozenBunDependencies;
  const checkpoint = context.checkpoint ?? (() => {});
  const local = await inspect(repo, { ...context.deps, runGit: run });
  if (local.directoryOnly) return currentResult(repo, "directory_only", "Adresář nemá vlastní Git checkout; Lazurio ho přeskočilo.");
  if (!local.ok) {
    return blockedResult(repo, local.reason ?? "git_inspection_failed", {
      detail: local.detail,
      codex: local.codex !== false,
    });
  }
  if (local.operation) {
    return blockedResult(repo, `${local.operation}_in_progress`, {
      detail: `V repozitáři probíhá ${local.operation}.`,
    });
  }
  if (repo.expected_branch && repo.expected_branch !== "main") {
    return blockedResult(repo, "managed_branch_not_main", {
      detail: `Spravovaný checkout deklaruje větev ${repo.expected_branch}; Lazurio update spravuje pouze main.`,
    });
  }
  if (local.sparseOrHiddenIndex) {
    return blockedResult(repo, "hidden_index_state", {
      detail: "Index používá skip-worktree nebo assume-unchanged a stash nelze úplně ověřit.",
    });
  }

  const source = await verifyRemoteSource(repo, run);
  if (!source.ok) {
    return blockedResult(repo, source.reason, {
      detail: source.detail,
      nextAction: source.nextAction,
      codex: source.nextAction !== "github_access",
    });
  }
  const fetched = await run(
    [
      "fetch",
      "--no-tags",
      "--prune",
      "--force",
      "--",
      source.url,
      "+refs/heads/main:refs/remotes/origin/main",
    ],
    { cwd: repo.absolute_path, timeoutMs: GIT_FETCH_TIMEOUT_MS, env: safeGitRemoteEnv() },
  );
  if (!fetched.ok) {
    return blockedResult(repo, "github_unavailable", {
      detail: commandFailure(fetched, "GitHub verzi se nepodařilo stáhnout."),
      nextAction: "github_access",
      codex: false,
    });
  }
  await checkpoint("after_fetch", { repo, runId: context.runId });

  const verifiedAgain = await verifyRemoteSource(repo, run);
  if (!verifiedAgain.ok || verifiedAgain.fingerprint !== source.fingerprint) {
    return blockedResult(repo, "remote_changed", {
      detail: "Origin se během kontroly změnil; update byl zastaven.",
    });
  }

  const target = await commitOid(run, repo.absolute_path, "refs/remotes/origin/main");
  if (!target) {
    return blockedResult(repo, "remote_main_missing", {
      detail: "Git nepotvrdil commit origin/main.",
      nextAction: "github_access",
      codex: false,
    });
  }
  const localMain = await commitOid(run, repo.absolute_path, "refs/heads/main");
  const mainRelation = localMain
    ? await compareCommits(run, repo.absolute_path, localMain, target)
    : "missing";
  const detached = !local.branch;
  const decision = classifyLazurioRepoUpdate({
    operation: local.operation,
    expectedBranch: repo.expected_branch ?? "main",
    mainRelation,
    detached,
    detachedHeadMatchesMain: Boolean(localMain && local.head === localMain),
    sparseOrHiddenIndex: local.sparseOrHiddenIndex,
    dirty: local.dirtyPaths.length > 0,
    branch: local.branch,
  });
  // Detached HEAD bez bezpečné vazby na local main se nesmí opustit: mohl by
  // obsahovat jediný dosažitelný odkaz na commit. Ostatní history blockery
  // smějí nejdřív uložit necommitnutou práci a bezpečně vrátit checkout na
  // main, ale samotnou historii pak algoritmus nemění.
  if (decision.state === "blocked" && decision.reason === "detached_head") {
    return blockedResult(repo, decision.reason, {
      detail: relationDetail(mainRelation, local, target),
    });
  }

  const actions = [];
  let recoveryStash = null;
  if (local.dirtyPaths.length > 0) {
    const stash = await createVerifiedRecoveryStash({
      repo,
      run,
      runId: context.runId,
      local,
    });
    if (!stash.ok) {
      return blockedResult(repo, stash.reason, {
        detail: stash.detail,
        recoveryStash: stash.stashSha ?? null,
      });
    }
    recoveryStash = stash.stashSha;
    actions.push("recovery_stash");
    await checkpoint("after_stash", { repo, runId: context.runId, stash: recoveryStash });
  }

  if (local.branch !== "main") {
    const switched = localMain
      ? await run(["switch", "main"], { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
      : await run(
        ["switch", "--track", "-c", "main", "origin/main"],
        { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
      );
    if (!switched.ok) {
      return blockedResult(repo, "switch_main_failed", {
        detail: commandFailure(switched, "Checkout nešlo přepnout na main."),
        recoveryStash,
      });
    }
    actions.push("switch_main");
    await checkpoint("after_switch_main", { repo, runId: context.runId });
  }

  if (decision.state === "blocked") {
    return blockedResult(repo, decision.reason, {
      detail: relationDetail(mainRelation, local, target),
      recoveryStash,
      actions,
    });
  }

  if (mainRelation === "behind") {
    // Pull only the exact OID fetched and classified above. The local `.`
    // transport makes this a pure ff checkout step: no second network fetch
    // can move the target between verification and mutation.
    const pulled = await run(
      ["pull", "--ff-only", "--no-rebase", "--no-tags", "--", ".", target],
      { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (!pulled.ok) {
      return blockedResult(repo, "fast_forward_failed", {
        detail: commandFailure(pulled, "Fast-forward pull selhal."),
        recoveryStash,
      });
    }
    actions.push("fast_forward");
    await checkpoint("after_fast_forward", { repo, runId: context.runId });
  }

  const final = await inspect(repo, { ...context.deps, runGit: run });
  const finalTarget = await commitOid(run, repo.absolute_path, "refs/remotes/origin/main");
  const finalSource = await verifyRemoteSource(repo, run);
  if (
    !final.ok
    || final.branch !== "main"
    || final.dirtyPaths.length > 0
    || !finalTarget
    || final.head !== finalTarget
    || !finalSource.ok
    || finalSource.fingerprint !== source.fingerprint
  ) {
    return blockedResult(repo, "post_update_verification_failed", {
      detail: "Repo po update není prokazatelně clean main na origin/main.",
      recoveryStash,
    });
  }

  if (actions.length > 0 && await declaresFrozenBunInstall(repo.absolute_path)) {
    const installed = await installDependencies({ cwd: repo.absolute_path });
    if (!installed.ok) {
      return blockedResult(repo, "dependency_install_failed", {
        detail: installed.detail ?? "bun install --frozen-lockfile selhal.",
        recoveryStash,
        actions,
      });
    }
    actions.push("frozen_bun_install");
    await checkpoint("after_dependency_install", { repo, runId: context.runId });
    const afterInstall = await inspect(repo, { ...context.deps, runGit: run });
    if (
      !afterInstall.ok
      || afterInstall.branch !== "main"
      || afterInstall.dirtyPaths.length > 0
      || afterInstall.head !== finalTarget
    ) {
      return blockedResult(repo, "dependency_install_changed_checkout", {
        detail: "Frozen Bun install dokončil běh, ale checkout po něm není prokazatelně clean main na origin/main.",
        recoveryStash,
        actions,
      });
    }
  }

  if (actions.length === 0) {
    return currentResult(repo, "already_current", "Repo už je clean main na origin/main.", {
      head: final.head,
    });
  }
  return updatedResult(repo, {
    reason: recoveryStash ? "local_changes_preserved" : "checkout_updated",
    message: recoveryStash
      ? "Repo je aktualizované; lokální změny zůstaly bezpečně v recovery stashi."
      : "Repo je aktualizované a clean na main.",
    head: final.head,
    actions,
    recoveryStash,
  });
}

export async function inspectLocalRepo(repo, deps = {}) {
  const run = deps.runGit ?? runGit;
  if (!repo.absolute_path || !existsSync(repo.absolute_path)) {
    return { ok: false, reason: "repo_missing", detail: "Checkout chybí.", codex: false };
  }
  const top = await run(["rev-parse", "--show-toplevel"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!top.ok) return { ok: true, directoryOnly: true, dirtyPaths: [] };
  const [realTop, realRepo] = await Promise.all([
    canonicalPath(top.stdout),
    canonicalPath(repo.absolute_path),
  ]);
  if (realTop !== realRepo) return { ok: true, directoryOnly: true, dirtyPaths: [] };

  const [gitDirResult, commonDirResult] = await Promise.all([
    run(["rev-parse", "--git-dir"], { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["rev-parse", "--git-common-dir"], { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  if (!gitDirResult.ok || !commonDirResult.ok) {
    return { ok: false, reason: "git_inspection_failed", detail: "Git metadata nejdou ověřit." };
  }
  const gitDir = await canonicalPath(resolveGitPath(repo.absolute_path, gitDirResult.stdout));
  const commonDir = await canonicalPath(resolveGitPath(repo.absolute_path, commonDirResult.stdout));
  if (gitDir !== commonDir) {
    return {
      ok: false,
      reason: "worktree_excluded",
      detail: "Tato cesta je Git worktree; Lazurio update worktrees nikdy nemutuje.",
    };
  }

  const operation = await readOperation(repo, run);
  const [branch, head, dirtyPaths, hiddenIndex] = await Promise.all([
    run(["branch", "--show-current"], { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    commitOid(run, repo.absolute_path, "HEAD"),
    readDirtyPaths(run, repo.absolute_path),
    run(["ls-files", "-v"], { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  if (!branch.ok || !head || !dirtyPaths.ok || !hiddenIndex.ok) {
    return { ok: false, reason: "git_inspection_failed", detail: "Lokální Git stav nejde úplně přečíst." };
  }
  return {
    ok: true,
    directoryOnly: false,
    branch: branch.stdout || null,
    head,
    operation,
    dirtyPaths: dirtyPaths.paths,
    sparseOrHiddenIndex: hiddenIndex.stdout
      .split("\n")
      .filter(Boolean)
      .some((line) => line.startsWith("S ") || /^[a-z]/.test(line)),
  };
}

async function readOperation(repo, run) {
  for (const [ref, operation] of [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry_pick"],
    ["REVERT_HEAD", "revert"],
  ]) {
    const result = await run(["rev-parse", "--quiet", "--verify", ref], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (result.ok) return operation;
  }
  for (const [marker, operation] of [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
  ]) {
    const gitPath = await run(["rev-parse", "--git-path", marker], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (!gitPath.ok || !gitPath.stdout) continue;
    const path = resolveGitPath(repo.absolute_path, gitPath.stdout);
    if (!existsSync(path)) continue;
    if (marker === "rebase-apply" && existsSync(join(path, "applying"))) return "am";
    return operation;
  }
  return null;
}

async function verifyRemoteSource(repo, run) {
  const remote = await run(["remote", "get-url", "--all", "origin"], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  const urls = remote.stdout.split("\n").filter(Boolean);
  if (!remote.ok || urls.length !== 1) {
    return {
      ok: false,
      reason: "origin_invalid",
      detail: "Repo musí mít právě jeden ověřitelný origin.",
    };
  }
  const expected = String(repo.repo ?? "").trim();
  if (expected && normalizeGitRemote(urls[0]) !== normalizeGitRemote(expected)) {
    return {
      ok: false,
      reason: "origin_mismatch",
      detail: "Lokální origin neodpovídá Organization manifestu.",
    };
  }
  return {
    ok: true,
    url: urls[0],
    fingerprint: normalizeGitRemote(urls[0]),
  };
}

async function createVerifiedRecoveryStash({ repo, run, runId, local }) {
  const beforeHead = local.head;
  const message = `lazurio-update:${runId}:${repo.key}:${beforeHead}`;
  const stash = await run(
    ["stash", "push", "--include-untracked", "--message", message],
    { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (!stash.ok) {
    return { ok: false, reason: "recovery_stash_failed", detail: commandFailure(stash, "Recovery stash se nepodařilo vytvořit.") };
  }
  const stashSha = await commitOid(run, repo.absolute_path, "refs/stash");
  if (!stashSha) {
    return { ok: false, reason: "recovery_stash_unverified", detail: "Git nepotvrdil SHA recovery stashe." };
  }
  const [object, patch, names, after] = await Promise.all([
    run(["cat-file", "-e", `${stashSha}^{commit}`], { cwd: repo.absolute_path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["stash", "show", "--include-untracked", "--binary", "--patch", stashSha], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    run(["stash", "show", "--include-untracked", "--name-only", "-z", stashSha], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    inspectLocalRepo(repo, { runGit: run }),
  ]);
  const stashedPaths = new Set(splitNull(names.stdout));
  const allPathsPresent = local.dirtyPaths.every((path) => stashedPaths.has(path));
  if (
    !object.ok
    || !patch.ok
    || !names.ok
    || !allPathsPresent
    || !after.ok
    || after.dirtyPaths.length > 0
    || after.head !== beforeHead
  ) {
    return {
      ok: false,
      reason: "recovery_stash_unverified",
      detail: "Recovery stash vznikl, ale jeho úplnost nebo clean checkout nejde prokázat; nic dalšího se neprovedlo.",
      stashSha,
    };
  }
  return { ok: true, stashSha, message };
}

async function safeMaterializeModule({
  rootPath,
  repo,
  runId,
  materializeRepo,
  checkpoint,
  deps,
}) {
  if (repo.expected_branch !== "main") {
    return blockedResult(repo, "managed_branch_not_main", {
      detail: `Workspace Modul deklaruje ${repo.expected_branch}; Lazurio update spravuje pouze main.`,
    });
  }
  try {
    const result = await materializeRepo({ companiesRoot: rootPath, repo, deps: deps?.materializationDeps });
    if (!result.ok) {
      return blockedResult(repo, result.code ?? "materialization_failed", {
        detail: result.message,
        nextAction: result.outcome === "missing_access" ? "github_access" : "codex",
        codex: result.outcome !== "missing_access",
      });
    }
    await checkpoint("after_materialization", { repo, runId });
    let actions = ["materialize"];
    if (await declaresFrozenBunInstall(repo.absolute_path)) {
      const install = deps?.installDependencies ?? installFrozenBunDependencies;
      const installed = await install({ cwd: repo.absolute_path });
      if (!installed.ok) {
        return blockedResult(repo, "dependency_install_failed", {
          detail: installed.detail ?? "bun install --frozen-lockfile selhal.",
          actions,
        });
      }
      actions = [...actions, "frozen_bun_install"];
    }
    return updatedResult(repo, {
      reason: "module_materialized",
      message: "Workspace Modul byl bezpečně naklonovaný na clean main.",
      head: result.head ?? null,
      actions,
    });
  } catch (error) {
    return blockedResult(repo, "materialization_failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function safeInventory(buildInventory, rootPath, warnings) {
  try {
    const inventory = await buildInventory({ companiesRoot: rootPath });
    const inventoryWarnings = inventory.warnings ?? [];
    warnings.push(...inventoryWarnings);
    return { ...inventory, failed: inventoryWarnings.length > 0 };
  } catch (error) {
    warnings.push(`Git inventář nejde načíst: ${error instanceof Error ? error.message : String(error)}`);
    return { repos: [], warnings: [], failed: true };
  }
}

function managedOrganizationRoots(inventory) {
  return (inventory.repos ?? [])
    .filter((repo) => repo.repo_kind === "organization_root")
    .sort(compareRepoIdentity);
}

function managedWorkspaceModules(inventory, organization) {
  return (inventory.repos ?? [])
    .filter((repo) => repo.organization === organization && repo.repo_kind === "module" && repo.workspace !== "productionspace")
    .sort(compareRepoIdentity);
}

function deferredHierarchyResults(inventory, parentKey) {
  return (inventory.repos ?? [])
    .filter((repo) => repo.repo_kind === "organization_root" || (repo.repo_kind === "module" && repo.workspace !== "productionspace"))
    .sort(compareRepoIdentity)
    .map((repo) => deferredResult(repo, parentKey));
}

function deferredModuleResults(inventory, organization) {
  return managedWorkspaceModules(inventory, organization)
    .map((repo) => deferredResult(repo, `${organization}::root`));
}

function deferredResult(repo, parentKey) {
  return blockedResult(repo, "parent_blocked", {
    detail: `Nadřazený checkout ${parentKey} je blocked; tento potomek zůstal nedotčený.`,
    codex: false,
    nextAction: "retry",
  });
}

function rootDescriptor(rootPath) {
  return {
    key: "lazurio::root",
    repo_kind: "lazurio_root",
    organization: null,
    module: "root",
    repo_path: ".",
    absolute_path: rootPath,
    expected_branch: "main",
    repo: null,
  };
}

function inventoryDescriptor(rootPath, organization = null) {
  return {
    key: organization ? `${organization}::inventory` : "lazurio::inventory",
    repo_kind: "inventory",
    organization,
    module: null,
    repo_path: organization ? `organizations/${organization}` : ".",
    absolute_path: rootPath,
  };
}

function updateReport({ rootPath, runId, now, results, warnings }) {
  const state = results.some((result) => result.state === "blocked")
    ? "blocked"
    : results.some((result) => result.state === "updated")
      ? "updated"
      : "current";
  const firstBlocked = results.find((result) => result.state === "blocked") ?? null;
  return {
    schema_version: "lazurio.update.v1",
    state,
    ok: state !== "blocked",
    run_id: runId,
    generated_at: now().toISOString(),
    root: rootPath,
    message: state === "blocked"
      ? firstBlocked?.message ?? "Část Lazurio update potřebuje pomoc."
      : state === "updated"
        ? "Lazurio je aktualizované."
        : "Lazurio je aktuální.",
    next_action: firstBlocked?.next_action ?? null,
    summary: {
      current: results.filter((result) => result.state === "current").length,
      updated: results.filter((result) => result.state === "updated").length,
      blocked: results.filter((result) => result.state === "blocked").length,
    },
    results,
    warnings: [...new Set(warnings)],
  };
}

function lockedReport({ rootPath, runId, now, error }) {
  const result = blockedResult(rootDescriptor(rootPath), "update_locked", {
    detail: error?.message ?? "Jiný Lazurio update právě běží.",
    codex: false,
    nextAction: "retry",
  });
  return updateReport({ rootPath, runId, now, results: [result], warnings: [] });
}

function currentResult(repo, reason, message, extra = {}) {
  return resultIdentity(repo, { state: "current", reason, message, ...extra });
}

function updatedResult(repo, { reason, message, head = null, actions = [], recoveryStash = null }) {
  return resultIdentity(repo, {
    state: "updated",
    reason,
    message,
    head,
    actions,
    recovery_stash: recoveryStash,
  });
}

function blockedResult(repo, reason, {
  detail = null,
  recoveryStash = null,
  actions = [],
  codex = true,
  nextAction = null,
} = {}) {
  const kind = nextAction ?? (codex ? "codex" : "retry");
  const prompt = kind === "codex" ? codexRepairPrompt(repo, reason, detail, recoveryStash) : null;
  return resultIdentity(repo, {
    state: "blocked",
    reason,
    message: detail ?? "Repo nejde bezpečně aktualizovat.",
    actions,
    recovery_stash: recoveryStash,
    next_action: {
      kind,
      label: kind === "codex"
        ? "Vyřešit s Codexem"
        : kind === "github_access"
          ? "Ověřit přístup na GitHub"
          : "Spustit lazurio update znovu",
      prompt,
    },
  });
}

function resultIdentity(repo, result) {
  return {
    repo_key: repo.key,
    repo_kind: repo.repo_kind,
    organization: repo.organization ?? null,
    module: repo.module ?? null,
    path: repo.repo_path ?? repo.absolute_path,
    ...result,
  };
}

function codexRepairPrompt(repo, reason, detail, recoveryStash) {
  const recoveryStashLine = !recoveryStash
    ? null
    : reason === "recovery_stash_unverified"
      ? `Neověřený recovery stash (update s ním nepokračoval): ${recoveryStash}`
      : `Ověřený recovery stash: ${recoveryStash}`;
  return [
    "Lazurio update je zablokovaný a tento Git stav se nesmí opravovat automaticky.",
    `Repo: ${repo.absolute_path}`,
    `Repo key: ${repo.key}`,
    "Požadovaný invariant: primární checkout je clean main a lze jej fast-forwardnout na origin/main.",
    `Zjištěný problém: ${reason}${detail ? ` — ${detail}` : ""}`,
    recoveryStashLine,
    "Zachovej všechny commity a stashe. Nepoužívej reset --hard ani force push.",
    "Dohledatelnou práci převeď do task/PR worktree, oprav primární checkout na clean main a potom spusť `lazurio update` znovu.",
  ].filter(Boolean).join("\n");
}

export async function acquireUpdateLock({ rootPath, runId, now, staleRecoveryAttempted = false }) {
  const digest = createHash("sha256").update(rootPath).digest("hex").slice(0, 20);
  const path = join(tmpdir(), `lazurio-update-${digest}.lock`);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ root: rootPath, run_id: runId, pid: process.pid, started_at: now().toISOString() }));
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      let owner = "";
      try { owner = await readFile(path, "utf8"); } catch {}
      const metadata = parseLockMetadata(owner);
      if (
        !staleRecoveryAttempted
        && metadata?.root === rootPath
        && Number.isSafeInteger(metadata.pid)
        && metadata.pid > 0
        && !processIsAlive(metadata.pid)
      ) {
        await unlink(path);
        return acquireUpdateLock({
          rootPath,
          runId,
          now,
          staleRecoveryAttempted: true,
        });
      }
      throw new Error(`Jiný Lazurio update drží lock ${path}${owner ? ` (${owner})` : ""}.`);
    }
    throw error;
  }
  return {
    path,
    async release() {
      await handle.close();
      await unlink(path);
    },
  };
}

function parseLockMetadata(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function readDirtyPaths(run, cwd) {
  const [tracked, untracked] = await Promise.all([
    run(["diff", "--name-only", "-z", "HEAD", "--"], { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["ls-files", "--others", "--exclude-standard", "-z"], { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  if (!tracked.ok || !untracked.ok) return { ok: false, paths: [] };
  return { ok: true, paths: [...new Set([...splitNull(tracked.stdout), ...splitNull(untracked.stdout)])].sort() };
}

async function commitOid(run, cwd, ref) {
  const result = await run(["rev-parse", "--quiet", "--verify", `${ref}^{commit}`], {
    cwd,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return result.ok && /^[0-9a-f]{40,64}$/i.test(result.stdout) ? result.stdout : null;
}

async function compareCommits(run, cwd, local, target) {
  if (local === target) return "current";
  const localAncestor = await run(["merge-base", "--is-ancestor", local, target], { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (localAncestor.ok) return "behind";
  const targetAncestor = await run(["merge-base", "--is-ancestor", target, local], { cwd, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (targetAncestor.ok) return "ahead";
  return "diverged";
}

async function declaresFrozenBunInstall(cwd) {
  return existsSync(join(cwd, "package.json"))
    && (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb")));
}

async function installFrozenBunDependencies({ cwd }) {
  try {
    const child = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return exitCode === 0
      ? { ok: true }
      : { ok: false, detail: stderr.trim() || stdout.trim() || `bun install skončil kódem ${exitCode}.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function relationDetail(relation, local, target) {
  if (relation === "ahead") return `Lokální main obsahuje commity mimo origin/main (${local.head} proti ${target}).`;
  if (relation === "diverged") return `Lokální main a origin/main mají diverged historii (${local.head} proti ${target}).`;
  if (relation === "unknown") return "Vztah main k origin/main nejde bezpečně určit.";
  if (!local.branch) return "Checkout je detached mimo bezpečně doložený main.";
  return `Repo nejde bezpečně převést na clean main (${relation}).`;
}

function commandFailure(result, fallback) {
  return result.stderr || result.error || result.stdout || fallback;
}

function splitNull(value) {
  return String(value ?? "").split("\0").filter(Boolean);
}

function normalizeGitRemote(remote) {
  const value = String(remote ?? "").trim().replace(/\/+$/, "");
  const github = value.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  );
  return github ? `github:${github[1].toLowerCase()}/${github[2].toLowerCase()}` : value;
}

function resolveGitPath(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function canonicalPath(path) {
  try { return await realpath(path); } catch { return resolve(path); }
}

async function runtimeOverlapsWorkingRoot({ runtimeRoot, workingRoot }) {
  if (!runtimeRoot) return false;
  const [runtime, working] = await Promise.all([
    canonicalPath(resolve(runtimeRoot)),
    canonicalPath(resolve(workingRoot)),
  ]);
  const fromWorking = relative(working, runtime);
  return fromWorking === "" || (!fromWorking.startsWith("..") && !isAbsolute(fromWorking));
}

function compareRepoIdentity(left, right) {
  return `${left.organization ?? ""}\0${left.module ?? left.key}`
    .localeCompare(`${right.organization ?? ""}\0${right.module ?? right.key}`);
}
