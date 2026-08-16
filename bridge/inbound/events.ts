// bridge/inbound — the Zulip Events API poller. This is how Buddy hears.
//
// WHAT IT REPLACED, AND WHY. Buddy used to be an OUTGOING-WEBHOOK bot: Zulip
// POSTed to an HTTP listener the bridge ran on :9081. That put an inbound
// listener for the appliance INSIDE the appliance's own network, and every hop
// of the resulting path had to be bought with an artifact — an entry in Zulip's
// Smokescreen SSRF allow-list, a pinned container address so that entry stayed
// narrow, a container→host ufw rule so the bridge could reach the runtime, and an
// /etc/hosts hairpin so the reply could get back in. Four artifacts, each a
// permanent line item in every future host's boundary evidence, all bought by
// one structural choice. As a GENERIC bot the bridge only ever DIALS OUT, on
// loopback, and all four artifacts are gone.
//
// WHAT IT COSTS IN EXCHANGE, stated honestly because each item is real code:
//   * Zulip no longer decides what Buddy sees. A Generic bot's queue delivers
//     every message in every channel it is subscribed to, so the trigger
//     predicate and the self-echo filter are OURS (message.ts), and the turn
//     breaker is the second line of defence behind them (turn-breaker.ts).
//   * The event queue is state we hold a handle to and do not own. It is
//     garbage-collected after ten minutes idle and it dies with the appliance,
//     so `BAD_EVENT_QUEUE_ID` is a NORMAL state transition — every reboot and
//     every `docker compose down/up` produces one — with its own recovery path.
//   * `last_event_id` is a cursor inside one queue's lifetime and nothing more.
//     The durable anchor is the message-id watermark (watermark.ts).
//
// THE ORDERING RULE, which is the one thing here that must be exactly right:
//
//     durable record  →  watermark  →  last_event_id
//
// A crash anywhere in that sequence is safe. Reverse the first two and a crash
// between them puts a message BELOW the watermark with no record: catch-up will
// never re-fetch it and the queue will never re-deliver it. That is a silently
// lost user message, and it is the only ordering mistake that produces one.

import { deliveryStateLine } from "../telemetry/delivery-log.ts";
import type {
  BotIdentity,
  BridgeAsyncReplySender,
  BridgeEventLogger,
  ZulipMessage,
} from "./message.ts";
import { messageTrigger, toReplyInput } from "./message.ts";
import { isSessionResetCommand } from "./content.ts";
import type { SessionRotations } from "./session-rotations.ts";
import type { FileReplyQueue } from "./reply-queue.ts";
import type { TurnBreaker } from "./turn-breaker.ts";
import type { DurableWatermark } from "./watermark.ts";
import {
  getEvents,
  getMessagesFrom,
  registerEventQueue,
  ZulipQueueGoneError,
  type ZulipConfig,
  type ZulipEvent,
} from "../outbound/zulip.ts";

/**
 * The Zulip read surface, as an interface so the whole poller is testable with
 * no socket, no server and no timing.
 */
export interface ZulipEventsApi {
  register(): Promise<{
    queueId: string;
    lastEventId: number;
    maxMessageId: number;
    longpollTimeoutSeconds?: number;
  }>;
  poll(
    queueId: string,
    lastEventId: number,
    timeoutMs: number,
  ): Promise<ZulipEvent[]>;
  messagesFrom(
    anchor: number,
    numAfter: number,
  ): Promise<{ messages: ZulipMessage[]; foundNewest: boolean }>;
}

export function createZulipEventsApi(cfg: ZulipConfig): ZulipEventsApi {
  return {
    register: () => registerEventQueue(cfg),
    poll: (queueId, lastEventId, timeoutMs) =>
      getEvents(cfg, queueId, lastEventId, timeoutMs),
    messagesFrom: async (anchor, numAfter) => {
      const page = await getMessagesFrom(cfg, anchor, numAfter);
      return {
        messages: page.messages as ZulipMessage[],
        foundNewest: page.foundNewest,
      };
    },
  };
}

export interface EventBridgeOptions {
  api: ZulipEventsApi;
  inbox: Pick<
    FileReplyQueue,
    "accept" | "refuse" | "hasRecordedMessageId" | "highestRecordedMessageId"
  >;
  watermark: DurableWatermark;
  bot: BotIdentity;
  breaker: TurnBreaker;
  logger: BridgeEventLogger;
  /** Used only to tell a waiting human that the breaker has tripped. */
  notify: BridgeAsyncReplySender;
  buddyName: string;
  /**
   * Called after every successful (re-)registration. The runtime uses it to
   * write the content-free poller state file that replaced the health port —
   * `systemctl is-active` cannot tell a live process from one that can hear.
   */
  onRegistered?: (info: { registrations: number }) => Promise<void> | void;
  catchUpPageSize?: number;
  maxCatchUpPages?: number;
  sessionRotations?: SessionRotations;
  /** HTTP read timeout of the long-poll; also the stuck-socket detector. */
  pollTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /**
   * Floor between two polls that returned nothing. A correct Zulip blocks for
   * minutes and this never fires; a server that answers `GET /events`
   * immediately and empty — a proxy in front of it, a half-upgraded appliance —
   * would otherwise turn the loop into a hot spin against its own host.
   */
  idlePollFloorMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_TIMEOUT_MS = 90_000;

function breakerNotice(buddyName: string, limit: number, resumesAt: string): string {
  return (
    `I have reached my ceiling of ${limit} turns in one hour and I am pausing ` +
    "until it clears — around " +
    `${resumesAt}. This is a safety stop on my own host, not a refusal: it is ` +
    "what keeps a runaway loop from spending your whole vendor quota while you " +
    `are asleep. Anything you send meanwhile is recorded but not answered.\n\n—${buddyName}`
  );
}

function sessionResetNotice(buddyName: string): string {
  return (
    "Fresh context started. The previous conversation remains stored in " +
    `Zulip.\n\n-${buddyName}`
  );
}

export class EventBridge {
  private readonly options: Required<
    Pick<
      EventBridgeOptions,
      | "catchUpPageSize"
      | "maxCatchUpPages"
      | "pollTimeoutMs"
      | "backoffBaseMs"
      | "backoffMaxMs"
      | "idlePollFloorMs"
    >
  > &
    EventBridgeOptions;
  private queueId?: string;
  private lastEventId = -1;
  private registrationMaxMessageId?: number;
  private registrations = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollTimeoutPinned: boolean;

  constructor(options: EventBridgeOptions) {
    this.pollTimeoutPinned = options.pollTimeoutMs !== undefined;
    this.options = {
      catchUpPageSize: 100,
      maxCatchUpPages: 50,
      pollTimeoutMs: DEFAULT_POLL_TIMEOUT_MS,
      backoffBaseMs: 2_000,
      backoffMaxMs: 60_000,
      idlePollFloorMs: 250,
      ...options,
    };
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));
  }

  /** True once a queue has been allocated. The poller's liveness surface. */
  get registered(): boolean {
    return this.queueId !== undefined;
  }

  /** How many times a queue has been (re-)allocated. Content-free telemetry. */
  get registrationCount(): number {
    return this.registrations;
  }

  /**
   * Allocate a queue and then catch up.
   *
   * REGISTER BEFORE FETCHING, always. Anything that arrives during the catch-up
   * fetch is already captured by the new queue, and the deliberate overlap is
   * absorbed by the inbox's `EEXIST`. Fetching first would leave a gap exactly
   * the width of the fetch.
   */
  async recover(): Promise<void> {
    const queue = await this.options.api.register();
    this.queueId = queue.queueId;
    this.lastEventId = queue.lastEventId;
    this.registrationMaxMessageId = queue.maxMessageId;
    this.registrations += 1;
    if (queue.longpollTimeoutSeconds && !this.pollTimeoutPinned) {
      // Zulip's own advice, "guaranteed to be higher than heartbeat timeout".
      this.options.pollTimeoutMs = Math.max(
        10_000,
        Math.round(queue.longpollTimeoutSeconds * 1_000 * 1.5),
      );
    }
    this.options.logger.info("[inbound] event queue registered");
    try {
      await this.catchUp();
      // Readiness means both halves succeeded: the queue exists AND the durable
      // message boundary/catch-up is established. Publishing it earlier lets a
      // service gate report healthy while recover() is still able to fail.
      await this.options.onRegistered?.({ registrations: this.registrations });
    } catch (error) {
      // A queue whose historical gap was not closed is not usable live state.
      // Forget it so the run loop registers a new atomic boundary and resumes
      // catch-up from the durable watermark instead of silently pumping past
      // the missing range on its next iteration.
      this.queueId = undefined;
      this.lastEventId = -1;
      this.registrationMaxMessageId = undefined;
      throw error;
    }
  }

  /**
   * Page forward from the durable watermark, feeding every message through the
   * SAME predicate the live lane uses.
   *
   * WHY NO NARROW. A Zulip narrow is a CONJUNCTION; there is no OR operator. So
   * `is:dm` AND `is:mentioned` asks for messages that are both — effectively
   * empty — while either alone silently drops the other trigger class, and the
   * two classes ARE the trigger. A single narrowed query would report success
   * while the message that arrived during the outage was never answered. Paging
   * everything above the watermark costs a handful of extra rows in a
   * one-member realm (one Principal per host) and keeps ONE trigger predicate, so a
   * classification bug is one bug found by one test rather than a live path and
   * a recovery path that disagree during an incident.
   */
  async catchUp(): Promise<number> {
    const registrationBoundary = this.registrationMaxMessageId;
    if (
      typeof registrationBoundary !== "number" ||
      !Number.isInteger(registrationBoundary) ||
      registrationBoundary < 0
    ) {
      throw new Error(
        "Zulip registration supplied no valid max_message_id catch-up boundary",
      );
    }
    let anchor = await this.options.watermark.read();
    let hasBoundary = await this.options.watermark.hasDurableBoundary();
    if (anchor === 0 && !hasBoundary) {
      // The watermark file is gone but the inbox may not be. Seeding from the
      // highest recorded id is what stops a lost watermark from re-answering the
      // realm's whole history, message by message.
      anchor = await this.options.inbox.highestRecordedMessageId();
      if (anchor > 0) {
        await this.options.watermark.advanceTo(anchor);
        hasBoundary = true;
      }
    }
    if (anchor === 0 && !hasBoundary) {
      // COLD START — no watermark, no record, nothing at all. Reading "I know
      // nothing" as "the conversation starts at message 1" would replay a
      // realm's historical messages into existing private conversations. A
      // greenfield fixture cannot expose that boundary because it has no past,
      // so `tests/fakes/fake-realm.ts` accepts explicit `history`.
      //
      // So a cold start anchors at the server-owned boundary returned by the
      // SAME register request that allocated this queue. A separate newest-
      // message probe after registration has a race: a new DM can enter both
      // the queue and that probe, then be misclassified as historical and
      // swallowed by inbox dedupe. Zulip's register `max_message_id` exists as
      // part of its initial-data/event-queue atomicity contract.
      const newest = registrationBoundary;
      if (newest > 0) {
        // The anchor gets a durable REFUSAL record before the watermark moves.
        // Catch-up deliberately re-presents the message AT the watermark and
        // relies on the inbox's EEXIST to swallow it — a promise that holds for
        // every message consume() judged, and held for nobody at the one id a
        // cold start writes. Without this record, the first lost event queue
        // (an appliance restart is enough) re-presents the newest HISTORICAL
        // message with nothing to swallow it, and the bridge answers it: R4
        // again, one message at a time. Record first, then watermark — the
        // same durability order consume() lives by.
        await this.options.inbox.refuse(newest, "cold_start_anchor");
        await this.options.watermark.advanceTo(newest);
        anchor = newest;
      } else {
        // Persist zero as an ESTABLISHED boundary. Without this distinction, a
        // realm that was empty on first start can lose its first message if the
        // process restarts after Zulip queued it but before it was recorded: the
        // second start would mistake that message for pre-existing history.
        await this.options.watermark.initializeAt(0);
      }
      this.options.logger.info(
        "[inbound] cold start: anchored at the register boundary; history is not answered",
      );
    }
    let seen = 0;
    let reachedBoundary = false;
    for (let page = 0; page < this.options.maxCatchUpPages; page += 1) {
      const result = await this.options.api.messagesFrom(
        anchor,
        this.options.catchUpPageSize,
      );
      const messages = [...result.messages]
        .filter((message) => typeof message.id === "number")
        .sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
      for (const message of messages) {
        await this.consume(message);
        seen += 1;
        anchor = Math.max(anchor, message.id ?? anchor);
      }
      // We only need to close the historical gap that existed when this queue
      // was registered. Messages created afterwards are already durable in the
      // queue, so an active realm cannot keep readiness perpetually chasing a
      // moving "newest" value. foundNewest remains an equivalent success proof.
      if (result.foundNewest || anchor >= registrationBoundary) {
        reachedBoundary = true;
        break;
      }
      if (messages.length === 0) {
        throw new Error(
          "Zulip catch-up returned an empty page before reaching the registration boundary",
        );
      }
    }
    if (!reachedBoundary) {
      throw new Error(
        `Zulip catch-up did not reach the registration boundary within ${this.options.maxCatchUpPages} pages`,
      );
    }
    if (seen > 0) this.options.logger.info("[inbound] catch-up complete");
    return seen;
  }

  /**
   * One long-poll pass. Returns the number of events consumed. Exposed so the
   * whole state machine can be exercised without a loop or a clock.
   */
  async pumpOnce(): Promise<number> {
    if (!this.queueId) throw new Error("Event bridge is not registered");
    const events = await this.options.api.poll(
      this.queueId,
      this.lastEventId,
      this.options.pollTimeoutMs,
    );
    for (const event of events) {
      if (event.type === "message" && event.message) {
        await this.consume(event.message as ZulipMessage, event.flags);
      }
      // Only now. A heartbeat carries no work, but the acknowledgement of a
      // message event must come after that message's record and watermark are on
      // disk — that is the whole ordering rule, applied per event because events
      // are processed strictly serially in id order.
      this.lastEventId = Math.max(this.lastEventId, event.id);
    }
    return events.length;
  }

  /** The production loop. Runs until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = this.options.backoffBaseMs;
    while (!signal.aborted) {
      try {
        if (!this.queueId) await this.recover();
        const consumed = await this.pumpOnce();
        backoff = this.options.backoffBaseMs;
        if (consumed === 0) await this.sleep(this.options.idlePollFloorMs);
      } catch (error) {
        if (error instanceof ZulipQueueGoneError) {
          // EXPECTED, not an error: the queue was garbage-collected or the
          // appliance restarted. Re-register immediately, with no backoff — the
          // Principal's next message is already waiting behind this.
          this.options.logger.info("[inbound] event queue gone; re-registering");
          this.queueId = undefined;
          continue;
        }
        if (signal.aborted) return;
        this.options.logger.error("[inbound] event poll failed");
        // A stuck poll, a half-open socket, a Zulip restart: all bounded. The
        // queue id is kept, so a poll that merely timed out resumes exactly
        // where it was rather than throwing the cursor away.
        await this.sleep(backoff);
        backoff = Math.min(this.options.backoffMaxMs, backoff * 2);
      }
    }
  }

  /**
   * Decide about ONE message and make that decision durable, in the order the
   * comment at the top of this file insists on.
   */
  private async consume(
    message: ZulipMessage,
    eventFlags?: string[],
  ): Promise<void> {
    const messageId = message.id;
    if (typeof messageId !== "number" || messageId <= 0) return;
    const trigger = messageTrigger(message, this.options.bot, eventFlags);
    if (trigger === null) {
      // Not for Buddy — its own message, or a channel message with no mention.
      // Nothing is recorded, but the watermark still advances past it: the
      // decision WAS made, and leaving it behind the watermark would make every
      // later recovery re-read a growing tail of messages we have already
      // judged. The safety property is unaffected — that property is about a
      // message we ACCEPTED and failed to record.
      await this.options.watermark.advanceTo(messageId);
      return;
    }

    const input = toReplyInput(message, trigger, this.options.bot);
    if (!input) {
      this.options.logger.warn("[inbound] refused: reply target is unroutable");
      await this.options.inbox.refuse(messageId, "unroutable");
      await this.options.watermark.advanceTo(messageId);
      return;
    }

    const baseSessionId = input.sessionId;
    // Catch-up deliberately overlaps the live queue at the durable watermark.
    // Detect that content-free record before asking the breaker to spend a
    // turn; replays are not new runtime work and must not consume quota.
    if (await this.options.inbox.hasRecordedMessageId(messageId)) {
      await this.options.watermark.advanceTo(messageId);
      return;
    }
    if (this.options.sessionRotations && isSessionResetCommand(input.text)) {
      // The reset generation is the Zulip message id itself, so replay after a
      // crash is idempotent rather than rotating twice.
      await this.options.sessionRotations.resetAt(baseSessionId, messageId);
      const created = await this.options.inbox.refuse(
        messageId,
        "session_reset_command",
      );
      await this.options.watermark.advanceTo(messageId);
      if (created) {
        await this.options.notify(
          input,
          sessionResetNotice(this.options.buddyName),
        );
      }
      return;
    }
    // input.sessionId stays the BASE id through the queue on purpose: the
    // reply provider wrapper resolves it at SEND time, so a job queued before
    // a rotation still lands on the fresh session (and a job re-run after a
    // crash cannot wedge twice on the same wall).
    const verdict = this.options.breaker.request();
    if (!verdict.allowed) {
      this.options.logger.warn("[inbound] refused: turn breaker is open");
      await this.options.inbox.refuse(messageId, "turn_breaker");
      await this.options.watermark.advanceTo(messageId);
      if (verdict.announce) {
        await this.options
          .notify(
            input,
            breakerNotice(
              this.options.buddyName,
              verdict.limit,
              this.options.breaker.resumesAt(),
            ),
          )
          .catch(() => {
            this.options.logger.error("[inbound] breaker notice undelivered");
          });
      }
      return;
    }

    const created = await this.options.inbox.accept(input);
    await this.options.watermark.advanceTo(messageId);
    if (created) this.options.logger.info(deliveryStateLine("received"));
  }
}
