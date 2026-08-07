import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { link, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

function temporarySidecarPath(sidecarPath, createId) {
  return join(
    dirname(sidecarPath),
    `.${basename(sidecarPath)}.${createId()}.tmp`,
  );
}

function attachCleanupFailure(error, stagingPath, cleanupError) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.stagingPath = stagingPath;
  failure.stagingCleanupError = cleanupError;
  return failure;
}

async function removeStagingFile(path, remove) {
  try {
    await remove(path, { force: true });
    return null;
  } catch (error) {
    return error;
  }
}

// Sidecar se nejdřív zapíše do jedinečného souboru v téže složce. Hard link
// publikuje dokončený obsah bez přepsání existujícího sidecaru; při selhání
// zápisu se maže jen tento námi vlastněný staging soubor.
export async function writeSidecarAtomically({
  sidecarPath,
  contents,
  createId = randomUUID,
  write = writeFile,
  createLink = link,
  remove = rm,
} = {}) {
  const stagingPath = temporarySidecarPath(sidecarPath, createId);
  try {
    await write(stagingPath, contents, { encoding: "utf8", flag: "wx" });
    await createLink(stagingPath, sidecarPath);
  } catch (error) {
    const cleanupError = await removeStagingFile(stagingPath, remove);
    throw attachCleanupFailure(error, stagingPath, cleanupError);
  }

  const stagingCleanupError = await removeStagingFile(stagingPath, remove);
  return { stagingPath, stagingCleanupError };
}

export function allocateOwnedWorktreeBranch({ git, primaryRoot, branch, baseRef, createId = randomUUID }) {
  const existingHead = git(
    primaryRoot,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { allowFail: true },
  );
  if (existingHead.status === 0) {
    const marker = git(
      primaryRoot,
      ["config", "--local", "--get", `branch.${branch}.description`],
      { allowFail: true },
    );
    const baseHead = git(primaryRoot, ["rev-parse", "--verify", baseRef], { allowFail: true });
    const linked = git(primaryRoot, ["worktree", "list", "--porcelain", "-z"], { allowFail: true });
    const ownerMarker = marker.stdout?.trim();
    const branchHead = existingHead.stdout?.trim();
    if (marker.status !== 0 || !isCreateLaneOwnerMarker(ownerMarker)) {
      return { ok: false, message: "existující branch nemá platný worktree-create ownership marker" };
    }
    if (baseHead.status !== 0 || !branchHead || branchHead !== baseHead.stdout.trim()) {
      return { ok: false, message: `existující owned branch není přesně na ${baseRef}` };
    }
    if (linked.status !== 0) {
      return { ok: false, message: "existující owned branch nelze ověřit proti linked worktrees" };
    }
    if (registeredWorktreeUsesBranch(linked.stdout, branch)) {
      return { ok: false, message: "existující owned branch už používá linked worktree" };
    }
    return { ok: true, ownerMarker, branchHead, reused: true };
  }
  if (existingHead.status !== 1) {
    return {
      ok: false,
      message: `existenci branche nelze bezpečně ověřit (${existingHead.stderr || "bez stderr"})`,
    };
  }
  const ownerMarker = `worktree-create:${createId()}`;
  const created = git(primaryRoot, ["branch", "--no-track", branch, baseRef], { allowFail: true });
  if (created.status !== 0) {
    return { ok: false, message: created.stderr || "branch nelze vytvořit" };
  }
  const head = git(primaryRoot, ["rev-parse", `refs/heads/${branch}`], { allowFail: true });
  if (head.status !== 0 || !head.stdout) {
    return { ok: false, message: "branch byl vytvořen, ale jeho exact head nelze ověřit" };
  }
  const branchHead = head.stdout.trim();
  const marked = git(primaryRoot, ["config", "--local", `branch.${branch}.description`, ownerMarker], { allowFail: true });
  if (marked.status !== 0) {
    return {
      ok: false,
      message: `ownership marker nelze zapsat: ${marked.stderr || "bez stderr"}; branch ${branch}@${branchHead} zůstává pro vědomý recovery handoff, protože ji mohl převzít jiný linked worktree`,
    };
  }
  return { ok: true, ownerMarker, branchHead, reused: false };
}

function isCreateLaneOwnerMarker(value) {
  return /^(?:worktree-create|launchpad-worktree-create):[A-Za-z0-9._-]+$/.test(value ?? "");
}

function ownedBranchStatus({ git, primaryRoot, branch, ownerMarker, branchHead }) {
  if (!ownerMarker || !branchHead) return { owned: false, reason: "chybí ownership důkaz" };
  const marker = git(primaryRoot, ["config", "--local", "--get", `branch.${branch}.description`], { allowFail: true });
  const head = git(primaryRoot, ["rev-parse", `refs/heads/${branch}`], { allowFail: true });
  if (marker.status !== 0 || marker.stdout.trim() !== ownerMarker) return { owned: false, reason: "ownership marker nesedí" };
  if (head.status !== 0 || head.stdout.trim() !== branchHead) return { owned: false, reason: "branch head se po alokaci změnil" };
  return { owned: true };
}

function parseWorktreePorcelain(porcelain) {
  if (!porcelain.includes("\0")) {
    return porcelain.split("\n\n").filter(Boolean).map((block) => block.split("\n"));
  }
  const records = [];
  let current = [];
  for (const field of porcelain.split("\0")) {
    if (field === "") {
      if (current.length > 0) records.push(current);
      current = [];
    } else {
      current.push(field);
    }
  }
  if (current.length > 0) records.push(current);
  return records;
}

function pathKey(value, platform) {
  if (platform === "win32") {
    return win32.resolve(value.replaceAll("/", "\\")).replaceAll("\\", "/").toLowerCase();
  }
  const normalized = resolve(value).replaceAll("\\", "/");
  return normalized;
}

function registeredWorktreeMatchesBranch(
  porcelain,
  canonicalWorktreePath,
  branch,
  platform,
  canonicalizePath,
) {
  const expectedPath = pathKey(canonicalWorktreePath, platform);
  return parseWorktreePorcelain(porcelain).some((fields) => {
    const worktreeField = fields.find((field) => field.startsWith("worktree "));
    if (!worktreeField || !fields.includes(`branch refs/heads/${branch}`)) return false;
    const reportedPath = worktreeField.slice("worktree ".length);
    try {
      return pathKey(canonicalizePath(reportedPath), platform) === expectedPath;
    } catch {
      return false;
    }
  });
}

function registeredWorktreeUsesBranch(porcelain, branch) {
  return parseWorktreePorcelain(porcelain).some((fields) => (
    fields.includes(`branch refs/heads/${branch}`)
  ));
}

function canonicalRollbackPath(primaryRoot, worktreePath, canonicalWorktreePath, platform) {
  if (!canonicalWorktreePath) return false;
  const joinPath = platform === "win32" ? win32.join : join;
  const expectedParent = pathKey(joinPath(primaryRoot, ".worktrees", "root"), platform);
  const requested = pathKey(worktreePath, platform);
  const canonical = pathKey(canonicalWorktreePath, platform);
  return posix.dirname(requested) === expectedParent && requested === canonical;
}

function preserveOwnedBranchForRetry({
  git,
  primaryRoot,
  branch,
  ownerMarker,
  branchHead,
}) {
  const ownership = ownedBranchStatus({ git, primaryRoot, branch, ownerMarker, branchHead });
  if (!ownership.owned) return `branch zůstává nedotčená: ${ownership.reason}`;
  const listed = git(primaryRoot, ["worktree", "list", "--porcelain", "-z"], { allowFail: true });
  if (listed.status !== 0) return "owned branch zůstává zachována; linked worktrees nelze ověřit";
  if (registeredWorktreeUsesBranch(listed.stdout, branch)) {
    return "owned branch zůstává zachována: používá ji linked worktree";
  }
  return `owned branch ${branch}@${branchHead} zůstává zachována pro bezpečný retry`;
}

export function rollbackCreatedWorktree({
  git,
  primaryRoot,
  worktreePath,
  branch,
  pathExists,
  stagingPath,
  stagingCleanupError,
  ownerMarker,
  branchHead,
  canonicalWorktreePath = worktreePath,
  worktreeCreated = true,
  platform = process.platform,
  removeDirectory = (path) => rmSync(path, { recursive: true, force: true }),
  canonicalizePath = realpathSync,
}) {
  const ownership = ownedBranchStatus({ git, primaryRoot, branch, ownerMarker, branchHead });
  if (!ownership.owned) {
    return `worktree ani branch se nemažou: ${ownership.reason}; dokonči úklid vědomě po ověření vlastníka`;
  }

  if (!worktreeCreated) {
    const branchReport = preserveOwnedBranchForRetry({
      git,
      primaryRoot,
      branch,
      ownerMarker,
      branchHead,
    });
    const leftovers = [
      ...(pathExists(worktreePath) ? [`worktree cesta ${worktreePath}`] : []),
    ];
    return leftovers.length === 0
      ? branchReport
      : `${branchReport}; rollback neúplný, zůstává ${leftovers.join(" a ")} — dokonči úklid vědomě`;
  }
  if (!canonicalWorktreePath) {
    return "worktree ani branch se nemažou: worktree cesta není ověřený běžný adresář; dokonči úklid vědomě po ověření vlastníka";
  }
  if (!canonicalRollbackPath(primaryRoot, worktreePath, canonicalWorktreePath, platform)) {
    return "worktree ani branch se nemažou: worktree cesta není přesný kanonický child .worktrees/root; dokonči úklid vědomě";
  }

  const registeredWorktree = registeredWorktreeMatchesBranch(
    git(primaryRoot, ["worktree", "list", "--porcelain", "-z"], { allowFail: true }).stdout,
    canonicalWorktreePath,
    branch,
    platform,
    canonicalizePath,
  );
  if (!registeredWorktree) {
    return "worktree ani branch se nemažou: exact cesta není registrovaný owned worktree";
  }
  const removed = git(primaryRoot, ["worktree", "remove", "--force", worktreePath], { allowFail: true });
  const worktreeReport = removed.status === 0
    ? "owned worktree vrácen"
    : `owned worktree nelze odstranit: ${removed.stderr || "bez stderr"}`;
  let listedAfter = git(primaryRoot, ["worktree", "list", "--porcelain", "-z"], { allowFail: true });
  let stillRegisteredWorktree = listedAfter.status !== 0 || registeredWorktreeMatchesBranch(
    listedAfter.stdout,
    canonicalWorktreePath,
    branch,
    platform,
    canonicalizePath,
  );
  if (stillRegisteredWorktree) {
    git(primaryRoot, ["worktree", "prune", "--expire", "now"], { allowFail: true });
    listedAfter = git(primaryRoot, ["worktree", "list", "--porcelain", "-z"], { allowFail: true });
    stillRegisteredWorktree = listedAfter.status !== 0 || registeredWorktreeMatchesBranch(
      listedAfter.stdout,
      canonicalWorktreePath,
      branch,
      platform,
      canonicalizePath,
    );
  }
  let directoryCleanupError = null;
  if (!stillRegisteredWorktree && pathExists(worktreePath)) {
    try {
      removeDirectory(worktreePath);
    } catch (error) {
      directoryCleanupError = error;
    }
  }
  const branchReport = preserveOwnedBranchForRetry({
    git,
    primaryRoot,
    branch,
    ownerMarker,
    branchHead,
  });
  const leftovers = [
    ...(stillRegisteredWorktree || pathExists(worktreePath) ? [`worktree ${worktreePath}`] : []),
    ...(stagingCleanupError ? [`staging sidecar ${stagingPath}`] : []),
    ...(directoryCleanupError ? [`worktree directory cleanup (${directoryCleanupError.message})`] : []),
  ];
  return leftovers.length === 0
    ? `${worktreeReport}; ${branchReport}`
    : `${worktreeReport}; ${branchReport}; rollback neúplný, zůstává ${leftovers.join(" a ")} — dokonči úklid vědomě`;
}
