import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

export const CREATE_LOCK_STALE_MS = 10 * 60 * 1000;
const OWNER_FILE = "owner.json";

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function validOwner(value) {
  return value
    && typeof value === "object"
    && value.schema_version === "companiesascode.worktree_create_lock.v1"
    && typeof value.create_id === "string"
    && value.create_id.length > 0
    && Number.isInteger(value.pid)
    && value.pid > 0
    && typeof value.hostname === "string"
    && value.hostname.length > 0
    && Number.isFinite(Date.parse(value.started_at))
    && typeof value.primary_root === "string"
    && typeof value.branch === "string";
}

async function readOwner(lockPath) {
  try {
    const entry = await lstat(lockPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    const value = JSON.parse(await readFile(join(lockPath, OWNER_FILE), "utf8"));
    return validOwner(value) ? value : null;
  } catch {
    return null;
  }
}

async function restoreQuarantinedLock(quarantinePath, lockPath) {
  try {
    await rename(quarantinePath, lockPath);
    return true;
  } catch {
    return false;
  }
}

export async function acquireCreateLock({
  lockPath,
  primaryRoot,
  branch,
  planCode = null,
  now = () => new Date(),
  createId = randomUUID,
  host = hostname(),
  pid = process.pid,
  processAlive = defaultProcessAlive,
  staleAfterMs = CREATE_LOCK_STALE_MS,
} = {}) {
  const owner = {
    schema_version: "companiesascode.worktree_create_lock.v1",
    create_id: createId(),
    pid,
    hostname: host,
    started_at: now().toISOString(),
    primary_root: primaryRoot,
    branch,
    plan_code: planCode,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(
          join(lockPath, OWNER_FILE),
          `${JSON.stringify(owner, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return { ok: true, lock: { lockPath, owner }, reclaimed: attempt > 0 };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const observed = await readOwner(lockPath);
    if (!observed) {
      return {
        ok: false,
        message: `create lock ${lockPath} nemá ověřitelná ownership metadata; nemaže se automaticky`,
      };
    }
    const ageMs = now().getTime() - Date.parse(observed.started_at);
    const sameHost = observed.hostname === host;
    const ownerAlive = sameHost ? processAlive(observed.pid) : true;
    if (ageMs < staleAfterMs || ownerAlive) {
      return {
        ok: false,
        message: `create lock ${lockPath} drží ${observed.hostname}:${observed.pid} (${observed.branch})`,
      };
    }

    const quarantinePath = `${lockPath}.stale-${createId()}`;
    try {
      await rename(lockPath, quarantinePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return { ok: false, message: `stale create lock nelze bezpečně izolovat: ${error.message}` };
    }
    const quarantined = await readOwner(quarantinePath);
    if (!quarantined || quarantined.create_id !== observed.create_id) {
      const restored = await restoreQuarantinedLock(quarantinePath, lockPath);
      return {
        ok: false,
        message: `ownership create locku se během recovery změnilo; ${restored ? "lock byl vrácen" : `izolovaný lock zůstal v ${quarantinePath}`}`,
      };
    }
    await rm(quarantinePath, { recursive: true, force: true });
  }

  return { ok: false, message: `create lock ${lockPath} mezitím převzal jiný proces` };
}

export async function releaseCreateLock(lock) {
  if (!lock?.lockPath || !lock?.owner?.create_id) return { released: false, reason: "missing ownership" };
  const quarantinePath = `${lock.lockPath}.release-${lock.owner.create_id}`;
  try {
    await rename(lock.lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { released: true, reason: "already absent" };
    return { released: false, reason: error.message };
  }
  const observed = await readOwner(quarantinePath);
  if (!observed || observed.create_id !== lock.owner.create_id) {
    const restored = await restoreQuarantinedLock(quarantinePath, lock.lockPath);
    return {
      released: false,
      reason: restored ? "ownership changed; lock restored" : `ownership changed; isolated lock remains at ${quarantinePath}`,
    };
  }
  await rm(quarantinePath, { recursive: true, force: true });
  return { released: true, reason: null };
}
