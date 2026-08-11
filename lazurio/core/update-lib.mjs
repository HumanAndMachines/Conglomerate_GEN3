import { existsSync } from "fs";
import { readFile, realpath } from "fs/promises";
import { join, resolve } from "path";
import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";

export const UPDATE_CHANNELS = ["stable", "nightly"];

const stableTagPattern = /^v(\d+)\.(\d+)\.(\d+)$/;
const updateMessages = {
  up_to_date: "Používáš aktuální verzi zvoleného kanálu.",
  update_available: "Je k dispozici novější verze a lze ji bezpečně aktualizovat fast-forwardem.",
  ahead_of_channel_target: "Lokální verze je před cílem kanálu. Žádný downgrade se neprovede; zůstáváš na této verzi, dokud tě kanál nedožene.",
  diverged: "Lokální historie a cíl kanálu se rozešly. Aktualizace je zablokovaná; vyber „Vyřešit s Agentem“.",
  wrong_branch: "Conglomerate root není na branchi main. Aktualizace je zablokovaná; vyber „Vyřešit s Agentem“.",
  dirty_worktree: "Tracked soubory obsahují lokální změny. Zvol „Aktualizovat a zachovat změny“, nebo „Vyřešit s Agentem“.",
  no_release_tag: "Stable kanál zatím nemá žádný release tag ve formátu vMAJOR.MINOR.PATCH. Můžeš přepnout na nightly.",
  fetch_failed: "Cíl kanálu se nepodařilo bezpečně načíst nebo ověřit. Repo zůstalo beze změny.",
};

export async function readUpdateChannelConfig({ rootPath }) {
  const configPath = join(rootPath, "launchpad.gen3.local.json");
  if (!existsSync(configPath)) {
    return {
      channel: "stable",
      configured_value: null,
      state: "defaulted",
      valid: true,
      warning: null,
      path: "launchpad.gen3.local.json",
    };
  }

  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    return invalidChannelConfig(null, `launchpad.gen3.local.json nejde přečíst jako JSON (${error.message}); používám stable.`);
  }

  const configuredValue = config?.update_channel;
  if (configuredValue === undefined || configuredValue === null || configuredValue === "") {
    return {
      channel: "stable",
      configured_value: configuredValue ?? null,
      state: "defaulted",
      valid: true,
      warning: null,
      path: "launchpad.gen3.local.json",
    };
  }
  if (UPDATE_CHANNELS.includes(configuredValue)) {
    return {
      channel: configuredValue,
      configured_value: configuredValue,
      state: "configured",
      valid: true,
      warning: null,
      path: "launchpad.gen3.local.json",
    };
  }
  return invalidChannelConfig(
    configuredValue,
    `Neplatný update_channel ${JSON.stringify(configuredValue)}; povolené hodnoty jsou stable a nightly. Používám stable.`,
  );
}

export function selectHighestStableTag(tags) {
  return tags
    .map((tag) => {
      const match = String(tag).match(stableTagPattern);
      if (!match) return null;
      return { tag: String(tag), version: match.slice(1).map((part) => BigInt(part)) };
    })
    .filter(Boolean)
    .sort((left, right) => compareVersionParts(right.version, left.version))[0]?.tag ?? null;
}

export function deriveUpdateState({
  fetch_ok = true,
  branch,
  channel,
  target_available = true,
  tracked_changes = 0,
  ahead = 0,
  behind = 0,
} = {}) {
  let state;
  if (!fetch_ok) state = "fetch_failed";
  else if (branch !== "main") state = "wrong_branch";
  else if (!target_available) state = channel === "stable" ? "no_release_tag" : "fetch_failed";
  else if (!Number.isFinite(ahead) || !Number.isFinite(behind)) state = "fetch_failed";
  else if (ahead > 0 && behind > 0) state = "diverged";
  else if (ahead > 0) state = "ahead_of_channel_target";
  else if (tracked_changes > 0) state = "dirty_worktree";
  else if (behind > 0) state = "update_available";
  else state = "up_to_date";

  return {
    state,
    message: updateMessages[state],
    can_update: state === "update_available",
    can_update_with_autostash: state === "dirty_worktree" && behind > 0 && ahead === 0,
  };
}

export async function readRootUpdateStatus({ rootPath, refresh = true } = {}) {
  if (!rootPath) throw new Error("readRootUpdateStatus requires rootPath");
  const channelConfig = await readUpdateChannelConfig({ rootPath });
  const rootCheck = await verifyRootCheckout(rootPath);
  if (!rootCheck.ok) {
    return statusFailure({ rootPath, channelConfig, detail: rootCheck.detail });
  }

  let fetchResult = null;
  if (refresh) {
    // --prune-tags drží lokální tagy v synchronizaci s originem — yanknutý
    // nebo přesunutý tag nesmí strašit v Doctor pohledu (update.channel čte
    // lokální tagy), zatímco merge target se ověřuje přes ls-remote.
    fetchResult = await runGit(["fetch", "origin", "main", "--tags", "--prune", "--prune-tags"], {
      cwd: rootPath,
      timeoutMs: GIT_FETCH_TIMEOUT_MS,
      env: safeGitRemoteEnv(),
    });
  }

  const [branchResult, headResult, describeResult, worktreeResult] = await Promise.all([
    runGit(["branch", "--show-current"], { cwd: rootPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: rootPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["describe", "--tags", "--always"], { cwd: rootPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: rootPath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
  ]);
  const localError = [branchResult, headResult, describeResult, worktreeResult].find((result) => !result.ok);
  if (localError) {
    return statusFailure({
      rootPath,
      channelConfig,
      detail: localError.stderr || localError.error || "Lokální Git stav nejde přečíst.",
      fetchResult,
    });
  }

  const target = await resolveChannelTarget({ rootPath, channel: channelConfig.channel });
  const statusRows = worktreeResult.stdout.split("\n").filter(Boolean);
  const trackedRows = statusRows.filter((row) => !row.startsWith("??"));
  const untrackedRows = statusRows.filter((row) => row.startsWith("??"));
  let ahead = 0;
  let behind = 0;
  let relationOk = target.available || !target.detail;
  let relationDetail = target.detail ?? null;
  if (target.available) {
    const relationResult = await runGit(
      ["rev-list", "--left-right", "--count", `HEAD...${target.sha}`],
      { cwd: rootPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (relationResult.ok) {
      [ahead, behind] = relationResult.stdout.split(/\s+/).map((value) => Number(value));
      relationOk = Number.isFinite(ahead) && Number.isFinite(behind);
    } else {
      relationOk = false;
      relationDetail = relationResult.stderr || relationResult.error || "Vztah HEAD a cíle kanálu nejde ověřit.";
    }
  }

  const fetchOk = refresh ? Boolean(fetchResult?.ok) : true;
  const model = deriveUpdateState({
    fetch_ok: fetchOk && relationOk,
    branch: branchResult.stdout,
    channel: channelConfig.channel,
    target_available: target.available,
    tracked_changes: trackedRows.length,
    ahead,
    behind,
  });
  const headSha = headResult.stdout;

  return {
    schema_version: "companiesascode.launchpad.update_status.v1",
    generated_at: new Date().toISOString(),
    channel: channelConfig.channel,
    channel_config: channelConfig,
    head: {
      sha: headSha,
      short_sha: headSha.slice(0, 7),
      branch: branchResult.stdout || null,
    },
    target: target.available
      ? { ref: target.ref, sha: target.sha, short_sha: target.sha.slice(0, 7), version: target.version }
      : { ref: target.ref, sha: null, short_sha: null, version: target.version },
    version: {
      describe: describeResult.stdout,
      head_sha: headSha,
      short_sha: headSha.slice(0, 7),
      channel: channelConfig.channel,
    },
    state: model.state,
    message: model.message,
    can_update: model.can_update,
    can_update_with_autostash: model.can_update_with_autostash,
    target_relation: targetRelation({ targetAvailable: target.available, relationOk, ahead, behind }),
    counts: {
      ahead,
      behind,
      tracked_changes: trackedRows.length,
      untracked_files: untrackedRows.length,
    },
    changes: {
      tracked: trackedRows,
      untracked: untrackedRows,
    },
    fetch: {
      attempted: refresh,
      ok: refresh ? Boolean(fetchResult?.ok) : null,
      error: fetchResult && !fetchResult.ok
        ? fetchResult.stderr || fetchResult.error || "git fetch selhal"
        : relationOk ? null : relationDetail,
    },
    binary: { state: "not_available" },
  };
}

export async function performRootUpdate({ rootPath, mode = "ff_only" } = {}) {
  if (!rootPath) throw new Error("performRootUpdate requires rootPath");
  if (!["ff_only", "preserve_changes"].includes(mode)) {
    return {
      ok: false,
      code: "invalid_update_mode",
      state: "fetch_failed",
      message: "Neplatná volba aktualizace. Použij ff_only nebo preserve_changes.",
    };
  }

  const before = await readRootUpdateStatus({ rootPath, refresh: true });
  const fromCommit = before.head?.sha ?? null;
  if (before.state === "up_to_date") {
    return updateResult({ ok: true, updated: false, mode, before, after: before, fromCommit, toCommit: fromCommit });
  }
  if (before.state === "dirty_worktree" && mode !== "preserve_changes") {
    return updateBlocked(before, "explicit_preserve_required");
  }
  const eligibleWithAutostash = before.state === "dirty_worktree"
    && before.can_update_with_autostash
    && mode === "preserve_changes";
  const eligibleClean = before.state === "update_available";
  if (!eligibleClean && !eligibleWithAutostash) return updateBlocked(before, "update_not_safe");

  const mutation = eligibleWithAutostash
    ? await mergeTargetWithAutostash({ rootPath, before })
    : await mergeTargetFastForward({ rootPath, before });
  const after = await readRootUpdateStatus({ rootPath, refresh: false });
  const toCommit = after.head?.sha ?? mutation.to_commit ?? fromCommit;
  if (!mutation.ok) {
    return {
      ...updateResult({
        ok: false,
        updated: Boolean(mutation.updated),
        mode,
        before,
        after,
        fromCommit,
        toCommit,
      }),
      code: mutation.code,
      message: mutation.message,
      stash_preserved: Boolean(mutation.stash_preserved),
    };
  }
  if (toCommit !== before.target?.sha) {
    return {
      ...updateResult({ ok: false, updated: true, mode, before, after, fromCommit, toCommit }),
      code: "update_verification_failed",
      message: "Fast-forward proběhl, ale výsledný HEAD neodpovídá ověřenému cíli. Vyřeš stav s Agentem.",
    };
  }
  return {
    ...updateResult({ ok: true, updated: true, mode, before, after, fromCommit, toCommit }),
    message: "Aktualizace je hotová. Restartuj Launchpad, aby načetl novou verzi.",
    autostash: eligibleWithAutostash,
    stash_preserved: Boolean(mutation.stash_preserved),
  };
}

function invalidChannelConfig(configuredValue, warning) {
  return {
    channel: "stable",
    configured_value: configuredValue,
    state: "invalid",
    valid: false,
    warning,
    path: "launchpad.gen3.local.json",
  };
}

function compareVersionParts(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

async function verifyRootCheckout(rootPath) {
  const topLevel = await runGit(["rev-parse", "--show-toplevel"], {
    cwd: rootPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!topLevel.ok) return { ok: false, detail: topLevel.stderr || topLevel.error || "Git root nejde určit." };
  try {
    const [actualRoot, expectedRoot] = await Promise.all([realpath(topLevel.stdout), realpath(resolve(rootPath))]);
    if (actualRoot !== expectedRoot) {
      return { ok: false, detail: "Zadaná cesta není samostatný Conglomerate Git root." };
    }
  } catch (error) {
    return { ok: false, detail: error.message };
  }
  return { ok: true };
}

async function resolveChannelTarget({ rootPath, channel }) {
  if (channel === "nightly") {
    const result = await runGit(["rev-parse", "--verify", "origin/main^{commit}"], {
      cwd: rootPath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    return result.ok
      ? { available: true, ref: "origin/main", sha: result.stdout, version: null, detail: null }
      : { available: false, ref: "origin/main", sha: null, version: null, detail: result.stderr || result.error };
  }

  // Stable target se vybírá VÝHRADNĚ z tagů inzerovaných originem — lokální
  // nebo stale tagy (git tag --list) nesmí nikdy určit release cíl kanálu.
  const remoteTags = await runGit(["ls-remote", "--tags", "origin"], {
    cwd: rootPath,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
  if (!remoteTags.ok) {
    return {
      available: false,
      ref: null,
      sha: null,
      version: null,
      detail: remoteTags.stderr || remoteTags.error || "Tagy originu nejde přečíst.",
      remote_error: true,
    };
  }
  const originTags = parseRemoteTags(remoteTags.stdout);
  const tag = selectHighestStableTag([...originTags.keys()]);
  if (!tag) return { available: false, ref: null, sha: null, version: null, detail: null };
  // Peeled sha z ls-remote je commit; ověř, že po fetchi existuje lokálně.
  const originSha = originTags.get(tag);
  const result = await runGit(["rev-parse", "--verify", `${originSha}^{commit}`], {
    cwd: rootPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return result.ok
    ? { available: true, ref: tag, sha: result.stdout, version: tag, detail: null }
    : {
      available: false,
      ref: tag,
      sha: null,
      version: tag,
      detail: result.stderr || result.error || "Origin tag není lokálně dostupný; fetch zřejmě selhal.",
    };
}

// Parsuje `git ls-remote --tags origin`: peeled řádky (refs/tags/x^{}) mají
// přednost, protože ukazují na commit anotovaného tagu.
export function parseRemoteTags(output) {
  const tags = new Map();
  for (const line of String(output).split("\n")) {
    const match = line.match(/^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/);
    if (!match) continue;
    const [, sha, name, peeled] = match;
    if (peeled || !tags.has(name)) tags.set(name, sha);
  }
  return tags;
}

function statusFailure({ rootPath, channelConfig, detail, fetchResult = null }) {
  const model = deriveUpdateState({ fetch_ok: false, branch: null, channel: channelConfig.channel });
  return {
    schema_version: "companiesascode.launchpad.update_status.v1",
    generated_at: new Date().toISOString(),
    channel: channelConfig.channel,
    channel_config: channelConfig,
    head: null,
    target: null,
    version: { describe: null, head_sha: null, short_sha: null, channel: channelConfig.channel },
    state: model.state,
    message: model.message,
    can_update: false,
    can_update_with_autostash: false,
    target_relation: "unknown",
    counts: { ahead: 0, behind: 0, tracked_changes: 0, untracked_files: 0 },
    changes: { tracked: [], untracked: [] },
    fetch: {
      attempted: Boolean(fetchResult),
      ok: fetchResult ? Boolean(fetchResult.ok) : null,
      error: detail,
    },
    binary: { state: "not_available" },
    root_path: rootPath,
  };
}

function targetRelation({ targetAvailable, relationOk, ahead, behind }) {
  if (!targetAvailable || !relationOk) return "unknown";
  if (ahead > 0 && behind > 0) return "diverged";
  if (ahead > 0) return "ahead";
  if (behind > 0) return "behind";
  return "same";
}

async function mergeTargetFastForward({ rootPath, before }) {
  // TOCTOU guard: mezi status snapshotem a merge se stav mohl změnit.
  // Přesně před mutací znovu ověř HEAD i čistotu tracked souborů.
  const [headCheck, statusCheck] = await Promise.all([
    runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: rootPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(["status", "--porcelain=v1"], { cwd: rootPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  const trackedDirty = statusCheck.ok
    ? statusCheck.stdout.split("\n").filter((row) => row && !row.startsWith("??")).length > 0
    : true;
  if (!headCheck.ok || headCheck.stdout !== before.head.sha || !statusCheck.ok || trackedDirty) {
    return {
      ok: false,
      updated: false,
      code: "update_precondition_changed",
      message: "Stav repa se mezi kontrolou a aktualizací změnil. Nic se nezměnilo; spusť aktualizaci znovu.",
    };
  }
  const merge = await runGit(["merge", "--ff-only", before.target.sha], {
    cwd: rootPath,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
  });
  if (!merge.ok) {
    return {
      ok: false,
      updated: false,
      code: "update_merge_failed",
      message: merge.stderr || merge.error || "Fast-forward aktualizace selhala; repo zůstalo bez úmyslného přepisu historie.",
    };
  }
  return { ok: true, updated: true, to_commit: before.target.sha };
}

async function mergeTargetWithAutostash({ rootPath, before }) {
  // Záměrná odchylka od původního redesign návrhu rebase --autostash:
  // zrcadlíme bezpečný per-repo pattern stash → ff-only → přesná obnova.
  // Identita autostashe: zapamatuj si stash tip PŘED push — `git stash push`
  // umí skončit ok i bez vytvoření záznamu (změny mezitím zmizely) a my pak
  // nesmíme aplikovat ani dropnout případný starší stash uživatele.
  const preStash = await runGit(["rev-parse", "refs/stash"], { cwd: rootPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  const preStashSha = preStash.ok ? preStash.stdout : null;
  const stash = await runGit(
    ["stash", "push", "--include-untracked", "--message", `launchpad-root-update-${new Date().toISOString()}`],
    { cwd: rootPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
  );
  if (!stash.ok) {
    return {
      ok: false,
      updated: false,
      code: "autostash_create_failed",
      message: "Lokální změny se nepodařilo bezpečně odložit. Aktualizace se nespustila.",
    };
  }
  const stashRef = await runGit(["rev-parse", "refs/stash"], { cwd: rootPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (!stashRef.ok || !stashRef.stdout || stashRef.stdout === preStashSha) {
    return {
      ok: false,
      updated: false,
      code: "autostash_identity_failed",
      message: "Autostash nevznikl, nebo nejde prokázat jeho identita (změny se mezitím zřejmě změnily). Aktualizace se nespustila a existující stash zůstal nedotčený; spusť ji znovu.",
      stash_preserved: false,
    };
  }

  const cleanCheck = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: rootPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  const headCheck = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: rootPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!cleanCheck.ok || cleanCheck.stdout || !headCheck.ok || headCheck.stdout !== before.head.sha) {
    const restored = await restoreCreatedStash({ rootPath, stashSha: stashRef.stdout });
    return {
      ok: false,
      updated: false,
      code: restored.ok ? "autostash_precondition_changed" : "autostash_restore_failed",
      message: restored.ok
        ? "Po odložení změn se změnily podmínky aktualizace. Lokální změny jsou obnovené."
        : "Aktualizace se nespustila, ale automatické obnovení změn selhalo. Autostash zůstal zachovaný.",
      stash_preserved: !restored.dropped,
    };
  }

  const merge = await mergeTargetFastForward({ rootPath, before });
  if (!merge.ok) {
    const restored = await restoreCreatedStash({ rootPath, stashSha: stashRef.stdout });
    return {
      ...merge,
      code: restored.ok ? merge.code : "autostash_restore_failed",
      message: restored.ok
        ? "Fast-forward aktualizace selhala; lokální změny jsou obnovené."
        : "Fast-forward aktualizace selhala a změny nešlo automaticky obnovit. Autostash zůstal zachovaný.",
      stash_preserved: !restored.dropped,
    };
  }

  const restored = await restoreCreatedStash({ rootPath, stashSha: stashRef.stdout });
  if (!restored.ok) {
    return {
      ok: false,
      updated: true,
      to_commit: before.target.sha,
      code: "autostash_conflict",
      message: "Nová verze je stažená, ale lokální změny se při obnově střetly. Autostash zůstal zachovaný; vyřeš konflikt s Agentem.",
      stash_preserved: true,
    };
  }
  return {
    ok: true,
    updated: true,
    to_commit: before.target.sha,
    stash_preserved: !restored.dropped,
  };
}

export async function restoreCreatedStash({ rootPath, stashSha }) {
  const apply = await runGit(["stash", "apply", "--index", stashSha], {
    cwd: rootPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!apply.ok) return { ok: false, dropped: false };
  // Náš autostash najdi podle SHA v celém stacku — když mezitím přibyl cizí
  // stash nad naším, nesmí nám ujet drop (a cizí stash se nikdy nedropne).
  const list = await runGit(["stash", "list", "--format=%H"], {
    cwd: rootPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!list.ok) return { ok: true, dropped: false };
  const index = list.stdout.split("\n").filter(Boolean).indexOf(stashSha);
  if (index === -1) return { ok: true, dropped: false };
  // Fail-safe re-check identity přesně před dropem (úzké TOCTOU okno).
  const verify = await runGit(["rev-parse", `stash@{${index}}`], {
    cwd: rootPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!verify.ok || verify.stdout !== stashSha) return { ok: true, dropped: false };
  const drop = await runGit(["stash", "drop", `stash@{${index}}`], {
    cwd: rootPath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  return { ok: true, dropped: drop.ok };
}

function updateBlocked(before, code) {
  return {
    ...updateResult({
      ok: false,
      updated: false,
      mode: null,
      before,
      after: before,
      fromCommit: before.head?.sha ?? null,
      toCommit: before.head?.sha ?? null,
    }),
    code,
    message: before.message,
  };
}

function updateResult({ ok, updated, mode, before, after, fromCommit, toCommit }) {
  return {
    schema_version: "companiesascode.launchpad.update.v1",
    generated_at: new Date().toISOString(),
    ok,
    updated,
    action: mode === "preserve_changes" ? "update_ff_only_with_autostash" : "update_ff_only",
    channel: before.channel,
    state: after.state,
    message: after.message,
    from_commit: fromCommit,
    to_commit: toCommit,
    before,
    after,
    binary: { state: "not_available" },
  };
}
