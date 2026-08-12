// bridge/inbound — the durable inbox.
//
// It is TWO things at once, and separating them in your head is the only way the
// ordering rules below make sense:
//
//   1. THE DEDUPE STORE of the inbound half. One file per Zulip message id. A
//      record is created with `O_EXCL` + `link()`, so a second attempt at the
//      same message id hits `EEXIST` and is a no-op. That is what makes an
//      accepted message exactly-once *processed* across a crash, a re-register
//      and the deliberate overlap of catch-up.
//   2. THE WORK QUEUE for replies that outlive a bridge restart. It calls
//      the agent runtime, checkpoints the answer, sends it through the Zulip REST
//      and retries with bounded backoff.
//
// WHY THE RECORD IS NOT DELETED ON DELIVERY. It used to be `unlink`ed. Under the
// webhook shape that was fine: Zulip decided what reached us and would not
// re-deliver an already-answered message. With an event queue, the same message
// comes back whenever the queue is garbage-collected and catch-up re-reads from
// the watermark — and a deleted record is indistinguishable from a message never
// seen. So delivery REPLACES the record with a content-free tombstone.
//
// CONTENT BOUNDARY. A live record carries the Principal's own chat text: mode
// 0600 inside a mode 0700 tree under the host's gitignored runtime path. A
// tombstone carries a message id and a timestamp and nothing else. Nothing from
// either enters a log line, an error, delivery telemetry or evidence.

import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type DeliveryErrorClass,
  type DeliveryHop,
  deliveryFailureLine,
  deliveryStateLine,
  hopErrorClass,
} from "../telemetry/delivery-log.ts";
import type {
  BridgeAsyncReplySender,
  BridgeEventLogger,
  BridgeReplyInput,
  BridgeReplyProvider,
} from "./message.ts";

type StoredReplyJob =
  | {
      version: 2;
      state: "accepted";
      input: BridgeReplyInput;
      reply?: string;
      attempts: number;
      nextAttemptAt: number;
    }
  | { version: 2; state: "delivered"; message_id: number; at: string }
  | {
      version: 2;
      state: "refused";
      message_id: number;
      at: string;
      reason: RefusalReason;
    }
  | {
      version: 2;
      state: "dead";
      message_id: number;
      at: string;
      hop: DeliveryHop;
      error_class: DeliveryErrorClass;
      attempts: number;
    };

/**
 * Why a triggering message was recorded but never worked on. A closed
 * vocabulary, because it is written to disk and read by an operator.
 *   `turn_breaker` — the host's turns-per-hour ceiling was already spent.
 *   `unroutable`   — the message carries no immutable channel id, or a DM has
 *                    no recipient left once Buddy is removed. Answering it would
 *                    mean routing by a name a third party can free.
 */
export const REFUSAL_REASONS = [
  "turn_breaker",
  "unroutable",
  "cold_start_anchor",
  "session_reset_command",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface FileReplyQueueOptions {
  /** Queue ROOT. `inbox/` and `dead/` are created inside it. */
  directory: string;
  replyProvider: BridgeReplyProvider;
  replySender: BridgeAsyncReplySender;
  logger: BridgeEventLogger;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Delivery attempts before a job is dead-lettered. */
  maxAttempts?: number;
  /** Tombstones more than this far below the newest id are pruned. */
  tombstoneRetention?: number;
  autoSchedule?: boolean;
}

/** The default ceiling. Six attempts with the default backoff spans ~10 minutes. */
export const DEFAULT_MAX_ATTEMPTS = 6;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * The note the waiting human gets when a reply is given up on. It names the hop
 * and the error class — the same closed vocabulary the operator log uses — and
 * nothing else: not the URL, not the Principal's own text, not a credential.
 *
 * IT EXISTS BECAUSE SILENCE IS INDISTINGUISHABLE FROM THINKING. Before the
 * ceiling, a reply that could not be delivered retried for ever and the only
 * trace was in the host's journal. From the chat window, a Buddy that has given
 * up and a Buddy that is still working look exactly the same, and the person is
 * the one component of this system that cannot read the journal.
 */
export function deadLetterNotice(
  buddyName: string,
  hop: DeliveryHop,
  errorClass: DeliveryErrorClass,
  attempts: number,
): string {
  return (
    `I could not finish answering your last message. I tried ${attempts} times; ` +
    `the \`${hop}\` hop kept failing with \`${errorClass}\`.\n\n` +
    "Your message is parked on this host, not lost — an operator can find it " +
    "in the bridge's dead-letter directory. Ask me again once the cause is " +
    `fixed and I will pick it up normally.\n\n—${buddyName}`
  );
}

export class FileReplyQueue {
  private readonly root: string;
  private readonly inbox: string;
  private readonly dead: string;
  private readonly replyProvider: BridgeReplyProvider;
  private readonly replySender: BridgeAsyncReplySender;
  private readonly logger: BridgeEventLogger;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly tombstoneRetention: number;
  private readonly autoSchedule: boolean;
  private timer?: ReturnType<typeof setTimeout>;
  private draining = false;
  /**
   * Message ids Zulip accepted whose durable tombstone could NOT be written,
   * because the same storage fault that blocked the replace also blocked the
   * rewrite. It is the second line of defence for the no-duplicate-delivery
   * property: the on-disk tombstone survives a restart and this does not, but
   * this one survives a dead disk and the tombstone does not. Entries are
   * dropped as soon as the tombstone is finally on disk, so it stays bounded by
   * the number of jobs currently stuck on a broken disk.
   */
  private readonly deliveredWithoutTombstone = new Set<number>();

  constructor(options: FileReplyQueueOptions) {
    if (!options.directory.trim()) {
      throw new Error("Reply queue directory is required");
    }
    this.root = options.directory;
    this.inbox = join(this.root, "inbox");
    this.dead = join(this.root, "dead");
    this.replyProvider = options.replyProvider;
    this.replySender = options.replySender;
    this.logger = options.logger;
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.retryMaxMs = options.retryMaxMs ?? 300_000;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.tombstoneRetention = options.tombstoneRetention ?? 1_000;
    this.autoSchedule = options.autoSchedule ?? true;
  }

  async start(): Promise<void> {
    await this.ensureDirectories();
    this.schedule(0);
  }

  /**
   * Durably accept a message. Returns false when a record for this message id
   * already exists — the `EEXIST` that makes a replay a no-op.
   *
   * THE CALLER MUST NOT ADVANCE ANY CURSOR BEFORE THIS RESOLVES. The record is
   * fsynced, and its directory is fsynced, before the promise settles.
   */
  async accept(input: BridgeReplyInput): Promise<boolean> {
    await this.ensureDirectories();
    const job: StoredReplyJob = {
      version: 2,
      state: "accepted",
      input,
      attempts: 0,
      nextAttemptAt: 0,
    };
    const created = await this.createAtomically(
      this.pathFor(input.messageId),
      job,
    );
    if (created) this.schedule(0);
    return created;
  }

  /**
   * Record that this message was seen and deliberately not worked on. It is the
   * same `O_EXCL` create as `accept`, so it is idempotent under replay, and it
   * is content-free — a refusal is not a place to retain the Principal's text.
   *
   * It exists so the watermark may advance past a message the bridge REFUSED
   * without that being indistinguishable from a message it never saw.
   */
  async refuse(messageId: number, reason: RefusalReason): Promise<boolean> {
    await this.ensureDirectories();
    return this.createAtomically(this.pathFor(messageId), {
      version: 2,
      state: "refused",
      message_id: messageId,
      at: new Date().toISOString(),
      reason,
    });
  }

  /**
   * The highest message id this inbox has ever recorded, live or tombstoned.
   *
   * WHY IT IS NEEDED. Tombstones are pruned, and the watermark file is the only
   * other durable anchor. If that one file is lost while the inbox survives,
   * catch-up would anchor at 0 and re-present the realm's whole history — every
   * message whose tombstone had been pruned would be answered a second time.
   * Seeding the watermark from this value on cold start closes that hole for the
   * cost of one directory listing.
   */
  async highestRecordedMessageId(): Promise<number> {
    await this.ensureDirectories();
    let highest = 0;
    for (const filename of await this.recordFiles()) {
      const id = Number(filename.slice(0, -5));
      if (id > highest) highest = id;
    }
    return highest;
  }

  async drainOnce(): Promise<{ delivered: number; remaining: number }> {
    if (this.draining) {
      return { delivered: 0, remaining: await this.pendingCount() };
    }
    this.draining = true;
    let delivered = 0;
    try {
      await this.ensureDirectories();
      for (const filename of await this.recordFiles()) {
        const path = join(this.inbox, filename);
        let job: StoredReplyJob;
        try {
          job = JSON.parse(await readFile(path, "utf8")) as StoredReplyJob;
          if (job.version !== 2) throw new Error("Unsupported reply queue job");
        } catch {
          this.logger.error("[inbound] durable reply job unreadable");
          continue;
        }
        if (job.state !== "accepted") continue;
        const messageId = job.input.messageId;
        // A job Zulip already accepted is never sent again. It only survived
        // because writing the tombstone failed; the reply is out, so the single
        // correct action is to retire it.
        if (this.deliveredWithoutTombstone.has(messageId)) {
          if (await this.tombstone(path, messageId)) {
            this.deliveredWithoutTombstone.delete(messageId);
          }
          continue;
        }
        if (job.nextAttemptAt > Date.now()) continue;

        // The hop currently in flight. It is positional, so a failure can never
        // be attributed to the wrong hop; only the error CLASS comes from the
        // thrown error.
        let hop: DeliveryHop = "runtime";
        try {
          if (job.reply === undefined) {
            this.logger.info(deliveryStateLine("generating"));
            const reply = await this.replyProvider(job.input);
            if (!reply.trim()) {
              throw new Error("Reply provider returned empty content");
            }
            job.reply = reply;
            await this.replaceAtomically(path, job);
          }
          // Also emitted when a restart or a retry resumes a checkpointed
          // reply: the reply exists, so this attempt starts at `generated`.
          this.logger.info(deliveryStateLine("generated"));
          hop = "zulip";
          this.logger.info(deliveryStateLine("delivering"));
          await this.replySender(job.input, job.reply);
          // Zulip has accepted the reply. Everything below is host-local
          // bookkeeping, so it is deliberately OUTSIDE the hop try: a failing
          // rename or fsync must never be reported as `hop=zulip`, which would
          // name the one hop that demonstrably worked and send the operator
          // after the network instead of after the disk.
          delivered += 1;
          this.logger.info(deliveryStateLine("delivered"));
          // Remember it in-process FIRST — that guard costs no disk, so it holds
          // even when the same fault also blocks the durable tombstone — then
          // try to make the tombstone survive a restart.
          this.deliveredWithoutTombstone.add(messageId);
          if (await this.tombstone(path, messageId)) {
            this.deliveredWithoutTombstone.delete(messageId);
          } else {
            // The durable half of the guard is gone: this process will not
            // resend, but a restart before the disk heals would. Say so — it is
            // the operator's only notice that the queue has dropped to its
            // at-least-once contract for this one reply.
            this.logger.error("[inbound] delivered reply job tombstone failed");
          }
        } catch (error) {
          const errorClass = hopErrorClass(error);
          job.attempts += 1;
          if (job.attempts >= this.maxAttempts) {
            await this.deadLetter(path, job, hop, errorClass);
            continue;
          }
          job.nextAttemptAt = Date.now() + this.retryDelay(job.attempts);
          await this.replaceAtomically(path, job);
          // WHICH hop failed and WHY, in a closed vocabulary. Never the URL, the
          // message, the recipients or a credential.
          this.logger.error(deliveryFailureLine(hop, errorClass));
        }
      }
      await this.pruneTombstones();
    } finally {
      this.draining = false;
    }

    const remaining = await this.pendingCount();
    if (remaining > 0) this.schedule(this.retryBaseMs);
    return { delivered, remaining };
  }

  /**
   * Give up on a job: park the full record (private text and all) under `dead/`
   * where an operator can find it, leave a content-free tombstone in the inbox
   * so the message is never re-accepted, and TELL THE PERSON WAITING.
   *
   * The notice is best-effort by construction: when the failing hop is `zulip`,
   * the very channel the notice would travel on is the broken one. A failed
   * notice is logged and the job is still parked — the alternative, retrying the
   * notice for ever, is the infinite silent retry this ceiling exists to end.
   */
  private async deadLetter(
    path: string,
    job: Extract<StoredReplyJob, { state: "accepted" }>,
    hop: DeliveryHop,
    errorClass: DeliveryErrorClass,
  ): Promise<void> {
    const messageId = job.input.messageId;
    this.logger.error(deliveryFailureLine(hop, errorClass));
    this.logger.error(
      `[inbound] reply dead-lettered after ${job.attempts} attempts`,
    );
    try {
      await this.writeSynced(join(this.dead, `${messageId}.json`), job);
      await this.syncDirectory(this.dead);
    } catch {
      // Parking failed; the tombstone below still stops a retry storm, and the
      // job's content is lost. Reported as itself, never as a hop failure.
      this.logger.error("[inbound] dead-letter parking failed");
    }
    try {
      await this.replySender(
        job.input,
        deadLetterNotice(
          (process.env.BUDDY_NAME ?? "").trim() || "Buddy",
          hop,
          errorClass,
          job.attempts,
        ),
      );
    } catch {
      this.logger.error("[inbound] dead-letter notice could not be delivered");
    }
    const stone: StoredReplyJob = {
      version: 2,
      state: "dead",
      message_id: messageId,
      at: new Date().toISOString(),
      hop,
      error_class: errorClass,
      attempts: job.attempts,
    };
    await this.replaceAtomically(path, stone).catch(() => {
      this.logger.error("[inbound] dead-letter tombstone failed");
    });
  }

  /** Replace a delivered record with its content-free tombstone. */
  private async tombstone(path: string, messageId: number): Promise<boolean> {
    const stone: StoredReplyJob = {
      version: 2,
      state: "delivered",
      message_id: messageId,
      at: new Date().toISOString(),
    };
    try {
      await this.replaceAtomically(path, stone);
      return true;
    } catch {
      return false;
    }
  }

  private pathFor(messageId: number): string {
    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new Error("Reply queue message id must be a positive integer");
    }
    return join(this.inbox, `${messageId}.json`);
  }

  private async ensureDirectories(): Promise<void> {
    for (const directory of [this.root, this.inbox, this.dead]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
  }

  private async createAtomically(
    target: string,
    job: StoredReplyJob,
  ): Promise<boolean> {
    const temporary = join(
      this.inbox,
      `.${basename(target)}.${randomUUID()}.tmp`,
    );
    await this.writeSynced(temporary, job);
    try {
      await link(temporary, target);
      await this.syncDirectory(this.inbox);
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return false;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async replaceAtomically(
    target: string,
    job: StoredReplyJob,
  ): Promise<void> {
    const temporary = join(
      this.inbox,
      `.${basename(target)}.${randomUUID()}.tmp`,
    );
    await this.writeSynced(temporary, job);
    try {
      await rename(temporary, target);
      await this.syncDirectory(this.inbox);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async writeSynced(
    path: string,
    job: StoredReplyJob,
  ): Promise<void> {
    await writeFile(path, `${JSON.stringify(job)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private retryDelay(attempts: number): number {
    return Math.min(
      this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.min(Math.max(attempts - 1, 0), 10),
    );
  }

  private async recordFiles(): Promise<string[]> {
    return (await readdir(this.inbox))
      .filter((filename) => /^[0-9]+\.json$/.test(filename))
      .sort((left, right) => Number(left.slice(0, -5)) - Number(right.slice(0, -5)));
  }

  private async pendingCount(): Promise<number> {
    await this.ensureDirectories();
    let pending = 0;
    for (const filename of await this.recordFiles()) {
      try {
        const job = JSON.parse(
          await readFile(join(this.inbox, filename), "utf8"),
        ) as StoredReplyJob;
        if (job.state === "accepted") pending += 1;
      } catch {
        // Unreadable is reported by the drain, not counted as pending work.
      }
    }
    return pending;
  }

  /**
   * Drop tombstones far below the newest recorded id. They only have to outlive
   * the deliberate catch-up overlap; keeping every one for ever would grow the
   * directory by one file per message the Principal ever sends.
   */
  private async pruneTombstones(): Promise<void> {
    const files = await this.recordFiles();
    if (files.length === 0) return;
    const newest = Number(files[files.length - 1].slice(0, -5));
    const cutoff = newest - this.tombstoneRetention;
    if (cutoff <= 0) return;
    for (const filename of files) {
      const id = Number(filename.slice(0, -5));
      if (id >= cutoff) break;
      const path = join(this.inbox, filename);
      try {
        const job = JSON.parse(await readFile(path, "utf8")) as StoredReplyJob;
        if (job.state === "accepted") continue;
        await unlink(path);
      } catch {
        // A tombstone that cannot be pruned is harmless; it just stays.
      }
    }
  }

  private schedule(delayMs: number): void {
    if (!this.autoSchedule || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drainOnce().catch(() => {
        this.logger.error("[inbound] durable reply queue unavailable");
        this.schedule(this.retryBaseMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }
}
