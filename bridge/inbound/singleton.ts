// bridge/inbound — one poller per host, enforced.
//
// THE FAILURE THIS EXISTS FOR. The webhook shape failed loudly at this: two
// bridges meant two processes binding :9081, and the second died with EADDRINUSE
// before it could do anything. A poller binds nothing. Two pollers registering
// with the same bot each get their OWN event queue, both are delivered every
// message, both call the runtime, and the Principal gets every answer twice — with
// error anywhere, because from Zulip's side two clients of one bot is a
// perfectly normal thing to be.
//
// systemd already refuses to start a second copy of the same unit, and on a
// Personalspace Host that is the real guard. This lock is for everything that is
// not systemd: an operator running `bun bridge/run.ts` by hand to watch it work
// while the unit is up, a drill, a half-stopped unit during an upgrade.

import { open, unlink } from "node:fs/promises";

export interface SingletonLock {
  release(): Promise<void>;
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

/**
 * Take the host-local poller lock, or throw. A lock file left behind by a
 * process that is gone (SIGKILL, a power cut) is reclaimed; one held by a live
 * process is never stolen.
 */
export async function acquireSingletonLock(
  path: string,
): Promise<SingletonLock> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          await unlink(path).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number((await Bun.file(path).text().catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && processIsAlive(holder)) {
        throw new Error(
          `another Buddy bridge is already running (pid ${holder}). Two pollers ` +
            "would register two event queues with the same bot and answer every " +
            "message twice; stop the other one (systemctl stop buddy-bridge) " +
            "before starting this one.",
        );
      }
      await unlink(path).catch(() => undefined);
    }
  }
  throw new Error("could not take the Buddy bridge singleton lock");
}
