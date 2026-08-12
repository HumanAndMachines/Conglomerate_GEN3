// bridge/inbound — the poller's liveness surface.
//
// WHY IT HAD TO BE INVENTED. The webhook bridge answered `GET /health` on a
// port, and everything that needed to know whether Buddy could hear — the
// reboot drill, the local roundtrip harness, an operator at 23:00 — asked that
// port. A poller binds nothing, so `systemctl is-active` is the only signal left
// and it is not the same claim: a process can be perfectly alive with no event
// queue, which is a Buddy that is running and deaf.
//
// So the poller writes one small file whenever it (re-)registers. It is
// deliberately the MINIMUM that answers "can Buddy hear right now", and
// deliberately not the watermark: a watermark value is a monotonically
// increasing count of realm messages and would leak message volume into
// anything that reads it (ARCHITECTURE §2.3). Evidence may report
// `bridge_queue_registered: true`; it may never report a message id.

import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface PollerState {
  version: 1;
  registered: true;
  /** How many times a queue has been allocated since this process started. */
  registrations: number;
  at: string;
}

export async function writePollerState(
  path: string,
  registrations: number,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.poller.${randomUUID()}.tmp`);
  const state: PollerState = {
    version: 1,
    registered: true,
    registrations,
    at: new Date().toISOString(),
  };
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
