// bridge/inbound — the durable message watermark.
//
// `last_event_id` is NOT this. It is a cursor inside one event queue's lifetime,
// and Zulip's own documentation is explicit that losing a queue is normal: it is
// garbage-collected after `idle_queue_timeout_secs` of inactivity (10 minutes by
// default) and it dies with the appliance. Every `docker compose down/up` of the
// Zulip stack — the rollback drill, an appliance upgrade, a host reboot —
// destroys it. After a re-register the old cursor means nothing.
//
// So the only cursor that survives is keyed on the Zulip MESSAGE id, which is
// realm-global, immutable and increasing. This file is that cursor: the highest
// message id for which a durable inbox record exists on disk.
//
// PRIVACY. The number is a monotonically increasing count of realm messages, so
// it leaks message volume. It stays in the host's gitignored runtime tree and
// never enters evidence; the only permitted evidence claim is
// `observations.bridge.queue_registered` beside it — never this value nor any
// watermark field (ARCHITECTURE §2.3: chat of different Principals is never shared,
// and volume IS content).

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

interface StoredWatermark {
  version: 1;
  message_id: number;
}

export class DurableWatermark {
  private readonly path: string;
  private cached?: number;

  constructor(path: string) {
    if (!path.trim()) throw new Error("Watermark path is required");
    this.path = path;
  }

  /** The highest durably recorded message id, or 0 when nothing is recorded. */
  async read(): Promise<number> {
    if (this.cached !== undefined) return this.cached;
    try {
      const parsed = JSON.parse(
        await readFile(this.path, "utf8"),
      ) as StoredWatermark;
      this.cached =
        parsed.version === 1 && Number.isInteger(parsed.message_id)
          ? Math.max(0, parsed.message_id)
          : 0;
    } catch {
      // Absent or unreadable both mean "no durable anchor". Catch-up then starts
      // from 0, re-presents messages that already have records, and every one of
      // them is absorbed by the inbox's EEXIST. Re-reading is cheap; guessing an
      // anchor forward would silently skip a user message.
      this.cached = 0;
    }
    return this.cached;
  }

  /**
   * Advance to `messageId`, never backwards. Written atomically and fsynced —
   * both the file and its directory — before the caller is allowed to
   * acknowledge the event to Zulip.
   */
  async advanceTo(messageId: number): Promise<void> {
    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new Error("Watermark message id must be a positive integer");
    }
    const current = await this.read();
    if (messageId <= current) return;
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.watermark.${randomUUID()}.tmp`);
    const payload: StoredWatermark = { version: 1, message_id: messageId };
    try {
      await Bun.write(temporary, `${JSON.stringify(payload)}\n`);
      await chmod(temporary, 0o600);
      await syncPath(temporary);
      await rename(temporary, this.path);
      await syncPath(directory);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    this.cached = messageId;
  }
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
