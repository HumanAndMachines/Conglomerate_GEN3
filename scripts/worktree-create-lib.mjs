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
  return { ok: true, ownerMarker, branchHead };
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

function rollbackOwnedBranch({
  git,
  primaryRoot,
  branch,
  ownerMarker,
  branchHead,
  worktreePath,
  pathExists,
}) {
  const ownership = ownedBranchStatus({ git, primaryRoot, branch, ownerMarker, branchHead });
  if (!ownership.owned) return `branch se nemaže: ${ownership.reason}`;
  const listed = git(primaryRoot, ["worktree", "list", "--porcelain", "-z"], { allowFail: true });
  if (listed.status !== 0) return "branch se nemaže: linked worktrees nelze ověřit";
  if (registeredWorktreeUsesBranch(listed.stdout, branch)) {
    return "branch se nemaže: stále ji používá linked worktree";
  }
  if (worktreePath && pathExists(worktreePath)) {
    return `branch se nemaže: worktree cesta ${worktreePath} stále existuje`;
  }
  const deleted = git(
    primaryRoot,
    ["update-ref", "-d", `refs/heads/${branch}`, branchHead],
    { allowFail: true },
  );
  if (deleted.status !== 0) {
    return `branch se nemaže: exact compare-and-delete selhal (${deleted.stderr || "bez stderr"})`;
  }
  const verifiedAbsent = git(
    primaryRoot,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { allowFail: true },
  );
  if (verifiedAbsent.status === 0) {
    return `branch se nemaže: exact ref po compare-and-delete stále existuje`;
  }
  const currentMarker = git(
    primaryRoot,
    ["config", "--local", "--get", `branch.${branch}.description`],
    { allowFail: true },
  );
  if (currentMarker.status === 0 && currentMarker.stdout.trim() !== ownerMarker) {
    return `owned branch ${branch}@${branchHead} vrácena; změněný ownership marker zůstává nedotčený`;
  }
  const markerCleanup = git(
    primaryRoot,
    ["config", "--local", "--unset-all", `branch.${branch}.description`],
    { allowFail: true },
  );
  return markerCleanup.status === 0 || markerCleanup.status === 5
    ? `owned branch ${branch}@${branchHead} vrácena`
    : `owned branch ${branch}@${branchHead} vrácena; ownership marker nelze odstranit (${markerCleanup.stderr || "bez stderr"})`;
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
    const branchReport = rollbackOwnedBranch({
      git,
      primaryRoot,
      branch,
      ownerMarker,
      branchHead,
      worktreePath,
      pathExists,
    });
    const leftovers = [
      ...(pathExists(worktreePath) ? [`worktree cesta ${worktreePath}`] : []),
      ...(git(primaryRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).status === 0 ? [`branch ${branch}`] : []),
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
  const branchReport = rollbackOwnedBranch({
    git,
    primaryRoot,
    branch,
    ownerMarker,
    branchHead,
    worktreePath,
    pathExists,
  });
  const leftovers = [
    ...(stillRegisteredWorktree || pathExists(worktreePath) ? [`worktree ${worktreePath}`] : []),
    ...(git(primaryRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).status === 0 ? [`branch ${branch}`] : []),
    ...(stagingCleanupError ? [`staging sidecar ${stagingPath}`] : []),
    ...(directoryCleanupError ? [`worktree directory cleanup (${directoryCleanupError.message})`] : []),
  ];
  return leftovers.length === 0
    ? `${worktreeReport}; ${branchReport}`
    : `${worktreeReport}; ${branchReport}; rollback neúplný, zůstává ${leftovers.join(" a ")} — dokonči úklid vědomě`;
}
