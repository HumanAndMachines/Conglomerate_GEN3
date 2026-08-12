// bridge/inbound — what a Zulip message IS to this bridge, and everything
// derived from it: the trigger decision, the agent-runtime session key and the
// target.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE POLLER. Under the outgoing-webhook
// shape Zulip decided which messages Buddy saw: the bot only ever received a DM
// it was part of, or a channel message that @mentioned it. That decision is now
// OURS — a Generic bot's event queue delivers every message in every channel the
// bot is subscribed to, and the catch-up path re-reads the same messages from
// `GET /messages`. Both lanes call `messageTrigger` below, so a
// trigger-classification bug is one bug in one place rather than a live path and
// a recovery path that disagree during an incident.

import { createHash } from "node:crypto";
import { normalizeZulipContent } from "./content.ts";

/**
 * The Zulip message object as it arrives on a `message` event and on
 * `GET /api/v1/messages`. The two shapes are the same object; that is what
 * lets catch-up reuse this module unchanged.
 */
export interface ZulipMessage {
  id?: number;
  /** IMMUTABLE Zulip user id of the sender. The self-echo filter keys on it. */
  sender_id?: number;
  sender_email?: string;
  sender_full_name?: string;
  /** "stream" | "private" */
  type?: string;
  /**
   * The IMMUTABLE Zulip channel id, present on every stream message. It
   * survives a channel rename; `display_recipient` does not.
   */
  stream_id?: number;
  /** The topic, for stream messages. A name, and deliberately subordinate. */
  subject?: string;
  recipient_id?: number;
  display_recipient?: unknown;
  content?: string;
  /**
   * Zulip's per-user message flags. `mentioned` is the documented flag the
   * trigger predicate reads. On `GET /messages` the flags arrive on the message
   * itself; on an event they arrive next to it, so both are accepted.
   */
  flags?: string[];
}

export type BridgeTrigger = "direct_message" | "mention";

export interface BridgeReplyInput {
  text: string;
  /** Same-origin private Zulip uploads, fetched with bot auth at delivery time. */
  imageUrls?: string[];
  senderName: string;
  trigger: BridgeTrigger | string;
  conversationKind: "stream" | "private";
  sessionId: string;
  /**
   * The Zulip message id this turn answers. It is the dedupe key of the whole
   * inbound half: realm-global, immutable and increasing, so it still means the
   * same thing after the event queue is garbage-collected and re-registered.
   * An EVENT id could not do this job — event ids live and die with one queue.
   */
  messageId: number;
  replyTarget:
    | {
        kind: "stream";
        /** The immutable channel id and the ONLY thing this bridge routes on. */
        streamId: number;
        /**
         * A topic has no id in Zulip, so this is a name — but a SUBORDINATE
         * one: it only ever selects a thread WITHIN `streamId`. Renaming a
         * topic therefore starts a fresh session, and can never hand the
         * conversation to whoever holds some other channel's name.
         */
        topic: string;
      }
    | { kind: "private"; recipientEmails: string[] };
}

export type BridgeReplyProvider = (input: BridgeReplyInput) => Promise<string>;
export type BridgeAsyncReplySender = (
  input: BridgeReplyInput,
  content: string,
) => Promise<void>;

export interface BridgeEventLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const CONSOLE_LOGGER: BridgeEventLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

// --- The Buddy's own display name (PER-HOST) ---------------------------------
// This is the name the Principal reads. It is supplied per host through
// BUDDY_NAME and fails SAFE to the generic "Buddy" — NEVER to another host's
// Buddy.
//
// The concrete failure this exists for: Host #2 is installed from this same
// repo. With the name baked in as a literal, the owner's very first message to
// their brand-new Buddy came back signed by somebody else's Buddy.
export const DEFAULT_BUDDY_NAME = "Buddy";

export function buddyDisplayName(
  env: Record<string, string | undefined> = process.env,
): string {
  return (env.BUDDY_NAME ?? "").trim() || DEFAULT_BUDDY_NAME;
}

interface ZulipPrivateParticipant {
  email?: unknown;
}

export function privateRecipientEmails(
  displayRecipient: unknown,
  senderEmail: string | undefined,
  botEmail: string | undefined,
): string[] {
  const candidates = Array.isArray(displayRecipient)
    ? displayRecipient
        .map((participant: ZulipPrivateParticipant) => participant?.email)
        .filter((email): email is string => typeof email === "string")
    : [];
  if (senderEmail) candidates.push(senderEmail);
  const normalizedBotEmail = botEmail?.trim().toLowerCase();
  return [
    ...new Map(
      candidates
        .map((email) => email.trim())
        .filter(Boolean)
        .filter((email) => email.toLowerCase() !== normalizedBotEmail)
        .map((email) => [email.toLowerCase(), email]),
    ).values(),
  ].sort((left, right) => left.localeCompare(right));
}

export interface BotIdentity {
  /** IMMUTABLE Zulip user id of this Buddy's bot. Authoritative. */
  userId: number;
  /** The bot's e-mail. A NAME: asserted beside the id, never a selector. */
  email?: string;
}

/**
 * Should Buddy answer this message at all, and under which trigger?
 *
 * THE FAILURE THIS EXISTS FOR, and it is the highest-probability defect of the
 * whole events-API shape: the outgoing-webhook bot could not see a message it
 * was not mentioned in, and could not see its own. A Generic bot sees both. Get
 * the self-check wrong and Buddy answers its own reply, in the Principal's
 * private realm, forever — each answer arriving as a new event that triggers the
 * next one. The turn breaker (turn-breaker.ts) is the second line of defence
 * precisely because this one is a predicate a human wrote.
 *
 * The self-check is on `sender_id`, the immutable Zulip user id (ADR-017). The
 * e-mail is asserted BESIDE it: a message whose address matches the bot while
 * the id does not is a contradiction, and a contradiction is dropped, because
 * dropping is the fail-closed direction here.
 */
export function messageTrigger(
  message: ZulipMessage,
  bot: BotIdentity,
  eventFlags?: string[],
): BridgeTrigger | null {
  if (typeof message.id !== "number") return null;
  if (message.sender_id === bot.userId) return null;
  const botEmail = bot.email?.trim().toLowerCase();
  if (botEmail && message.sender_email?.trim().toLowerCase() === botEmail) {
    return null;
  }
  if (message.type === "private") return "direct_message";
  const flags = eventFlags ?? message.flags ?? [];
  return flags.includes("mentioned") ? "mention" : null;
}

/**
 * WHAT THIS KEY MUST SURVIVE, concretely: the Principal renames #Buddy to a name
 * of their own — one click in Zulip, on data that is theirs. Keyed on the channel
 * NAME, that rename silently forked the runtime session: the thread the Principal
 * was still reading lost its memory. And the old name was then free for anyone to
 * claim, so a newly created channel called "Buddy" would let a NEW thread inherit
 * that old conversation. `stream_id` is immutable, so the key travels with the
 * channel through any rename.
 */
export function sessionIdFor(
  conversationKind: "stream" | "private",
  routeKey: string,
): string {
  return `buddy-zulip-${conversationKind}-${createHash("sha256")
    .update(routeKey)
    .digest("hex")
    .slice(0, 20)}`;
}

/**
 * Turn a triggering Zulip message into the reply input the queue stores.
 * Returns null when the message cannot be routed safely — a stream message with
 * no immutable channel id, or a DM with no recipient left after the bot is
 * removed. Refusing is the point: the alternative is routing by a name a third
 * party can free.
 */
export function toReplyInput(
  message: ZulipMessage,
  trigger: BridgeTrigger,
  bot: BotIdentity,
): BridgeReplyInput | null {
  if (typeof message.id !== "number") return null;
  const senderName = message.sender_full_name ?? "there";
  const { text, imageUrls } = normalizeZulipContent(message.content ?? "");
  if (message.type === "stream") {
    if (typeof message.stream_id !== "number") return null;
    const topic = message.subject ?? "";
    return {
      text,
      imageUrls,
      senderName,
      trigger,
      conversationKind: "stream",
      sessionId: sessionIdFor("stream", `stream:${message.stream_id}:${topic}`),
      messageId: message.id,
      replyTarget: { kind: "stream", streamId: message.stream_id, topic },
    };
  }
  const recipientEmails = privateRecipientEmails(
    message.display_recipient,
    message.sender_email,
    bot.email,
  );
  if (recipientEmails.length === 0) return null;
  const routeKey =
    typeof message.recipient_id === "number"
      ? `recipient:${message.recipient_id}`
      : `participants:${recipientEmails
          .map((email) => email.toLowerCase())
          .join(",")}`;
  return {
    text,
    imageUrls,
    senderName,
    trigger,
    conversationKind: "private",
    sessionId: sessionIdFor("private", routeKey),
    messageId: message.id,
    replyTarget: { kind: "private", recipientEmails },
  };
}

