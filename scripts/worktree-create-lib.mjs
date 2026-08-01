import { randomUUID } from "node:crypto";
import { link, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

function rollbackOwnedBranch({ git, primaryRoot, branch, ownerMarker, branchHead }) {
  const ownership = ownedBranchStatus({ git, primaryRoot, branch, ownerMarker, branchHead });
  if (!ownership.owned) return `branch se nemaže: ${ownership.reason}`;
  return `owned branch ${branch}@${branchHead} zůstává pro vědomý recovery handoff; automatické mazání refu není bezpečné vůči cizím linked worktree`;
}

function registeredWorktreeMatchesBranch(porcelain, canonicalWorktreePath, branch) {
  return porcelain.split("\n\n").some((block) => {
    const lines = block.split("\n");
    return lines.includes(`worktree ${canonicalWorktreePath}`)
      && lines.includes(`branch refs/heads/${branch}`);
  });
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
}) {
  const ownership = ownedBranchStatus({ git, primaryRoot, branch, ownerMarker, branchHead });
  if (!ownership.owned) {
    return `worktree ani branch se nemažou: ${ownership.reason}; dokonči úklid vědomě po ověření vlastníka`;
  }

  if (!worktreeCreated) {
    const branchReport = rollbackOwnedBranch({ git, primaryRoot, branch, ownerMarker, branchHead });
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

  const registeredWorktree = registeredWorktreeMatchesBranch(
    git(primaryRoot, ["worktree", "list", "--porcelain"], { allowFail: true }).stdout,
    canonicalWorktreePath,
    branch,
  );
  if (!registeredWorktree) {
    return "worktree ani branch se nemažou: exact cesta není registrovaný owned worktree";
  }
  const removed = git(primaryRoot, ["worktree", "remove", "--force", worktreePath], { allowFail: true });
  const worktreeReport = removed.status === 0
    ? "owned worktree vrácen"
    : `owned worktree nelze odstranit: ${removed.stderr || "bez stderr"}`;
  const branchReport = rollbackOwnedBranch({ git, primaryRoot, branch, ownerMarker, branchHead });
  const stillRegisteredWorktree = registeredWorktreeMatchesBranch(
    git(primaryRoot, ["worktree", "list", "--porcelain"], { allowFail: true }).stdout,
    canonicalWorktreePath,
    branch,
  );
  const leftovers = [
    ...(stillRegisteredWorktree || pathExists(worktreePath) ? [`worktree ${worktreePath}`] : []),
    ...(git(primaryRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).status === 0 ? [`branch ${branch}`] : []),
    ...(stagingCleanupError ? [`staging sidecar ${stagingPath}`] : []),
  ];
  return leftovers.length === 0
    ? `${worktreeReport}; ${branchReport}`
    : `${worktreeReport}; ${branchReport}; rollback neúplný, zůstává ${leftovers.join(" a ")} — dokonči úklid vědomě`;
}
