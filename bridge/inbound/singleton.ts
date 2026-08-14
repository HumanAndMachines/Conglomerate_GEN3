// bridge/inbound — one poller per host, enforced.
//
// THE FAILURE THIS EXISTS FOR. The webhook shape failed loudly at this: two
// bridges meant two processes binding :9081, and the second died with EADDRINUSE
// before it could do anything. A poller binds nothing. Two pollers registering
// with the same bot each get their OWN event queue, both are delivered every
// message, both call the runtime, and the Principal gets every answer twice —
// without an error anywhere, because from Zulip's side two clients of one bot is
// a perfectly normal thing to be.
//
// systemd already refuses to start a second copy of the same unit, and on a
// Personalspace Host that is the real guard. This lock is for everything that is
// not systemd: an operator running `bun bridge/run.ts` by hand to watch it work
// while the unit is up, a drill, a half-stopped unit during an upgrade.

import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";

export interface SingletonLock {
  release(): Promise<void>;
}

interface LockOwner {
  version: 1;
  pid: number;
  token: string;
}

function processIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else — alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function owner(pid = process.pid): LockOwner {
  return { version: 1, pid, token: randomUUID() };
}

async function readOwner(path: string): Promise<LockOwner | null> {
  const text = await readFile(path, "utf8").catch(() => "");
  try {
    const parsed = JSON.parse(text) as Partial<LockOwner>;
    if (
      parsed.version === 1 &&
      Number.isInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
    ) {
      return parsed as LockOwner;
    }
  } catch {
    // A numeric PID is the pre-token lock format. It can be judged for liveness
    // and reclaimed under the transition guard during a rolling upgrade.
  }
  const legacyPid = Number(text.trim());
  if (Number.isInteger(legacyPid) && legacyPid > 0) {
    return { version: 1, pid: legacyPid, token: `legacy-pid:${legacyPid}` };
  }
  return null;
}

async function createOwnedFile(path: string, lockOwner: LockOwner): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(lockOwner)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Remove a path only while it still names this exact owner token. */
async function unlinkIfOwned(path: string, token: string): Promise<boolean> {
  const current = await readOwner(path);
  if (current?.token !== token) return false;
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  return true;
}

/**
 * Serialize every create, stale reclaim and release transition.
 *
 * The old implementation let two starters both inspect the same stale PID;
 * after the first created its live lock, the second could unlink it. The short-
 * lived transition guard makes that sequence impossible. A guard orphaned by a
 * crash fails closed and names an operator remedy instead of recursively trying
 * to reclaim the mechanism that authorizes reclamation.
 */
async function acquireTransitionGuard(path: string): Promise<SingletonLock> {
  const lockOwner = owner();
  try {
    await createOwnedFile(path, lockOwner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readOwner(path);
    const state = existing && processIsAlive(existing.pid) ? `live pid ${existing.pid}` : "stale or unreadable";
    throw new Error(
      `Buddy bridge singleton transition guard ${path} is already held (${state}). ` +
        "Do not remove it while a bridge start or stop is running; if no such " +
        "process exists, remove only this transition guard and start again.",
    );
  }
  return {
    release: async () => {
      await unlinkIfOwned(path, lockOwner.token);
    },
  };
}

/**
 * Take the host-local poller lock, or throw. A canonical lock left behind by a
 * process that is gone (SIGKILL, a power cut) is reclaimed while the transition
 * guard is held; one held by a live process is never stolen. Both the long-lived
 * lock and the short transition guard carry unguessable owner tokens, and a
 * release removes only the token it created.
 */
export async function acquireSingletonLock(path: string): Promise<SingletonLock> {
  const transitionPath = `${path}.transition`;
  const transition = await acquireTransitionGuard(transitionPath);
  const lockOwner = owner();
  try {
    try {
      await createOwnedFile(path, lockOwner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readOwner(path);
      if (!existing) {
        throw new Error(
          `Buddy bridge singleton lock ${path} exists but its owner record is ` +
            "unreadable. Refusing to remove a lock whose liveness cannot be proven; " +
            "verify that no bridge process is running, then remove only this lock.",
        );
      }
      if (processIsAlive(existing.pid)) {
        throw new Error(
          `another Buddy bridge is already running (pid ${existing.pid}). Two pollers ` +
            "would register two event queues with the same bot and answer every " +
            "message twice; stop the other one (systemctl stop buddy-bridge) " +
            "before starting this one.",
        );
      }
      await unlink(path);
      await createOwnedFile(path, lockOwner);
    }
  } finally {
    await transition.release();
  }

  return {
    release: async () => {
      const releaseTransition = await acquireTransitionGuard(transitionPath);
      try {
        await unlinkIfOwned(path, lockOwner.token);
      } finally {
        await releaseTransition.release();
      }
    },
  };
}
