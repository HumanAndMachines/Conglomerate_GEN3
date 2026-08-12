// bridge/outbound — `buddy_post`, the ONE way Buddy speaks unprompted.
//
// WHY ONE ENTRY POINT. Answering a message is a reply and needs no decision: the
// target is wherever the message came from. Everything else Buddy says — a
// finished report, a nightly summary, an escalation because a standing mandate
// hit its boundary — is Buddy CHOOSING to open its mouth, and every one of those
// went through a different call site with a different idea of where a channel id
// comes from. One entry point means one place where "which channel" is decided,
// one place where the id-binding rule is honoured, and one thing to name in a
// mandate.
//
// HOW THE CHANNEL IS ADDRESSED (ARCHITECTURE §2.3, ADR-017). The wire value
// is always the IMMUTABLE `stream_id`. A caller may pass that number directly, or
// one of the two channel KEYS this repository declares end to end — `home` and
// `escalations`. A key is not a Zulip name: the Principal cannot rename it, a
// stranger cannot claim it, and it never reaches Zulip. It is resolved through
// the registry below, which is populated from the ids `provision_zulip.py`
// reports after creating the channels. The Zulip channel behind `home` may be
// renamed to anything the Principal likes and `buddy_post` keeps working; that
// is the whole point.
//
// A TOPIC IS A NAME AND HAS NO ID IN ZULIP. It stays subordinate: it only ever
// selects a thread WITHIN the resolved channel id.

import {
  createReportTopic,
  sendToTopic,
  type ZulipConfig,
} from "./zulip.ts";

/** Channel keys this repository declares end to end. Never a Zulip name. */
export const BUDDY_CHANNEL_KEYS = ["home", "escalations"] as const;
export type BuddyChannelKey = (typeof BUDDY_CHANNEL_KEYS)[number];

export type BuddyChannelRegistry = Partial<Record<BuddyChannelKey, number>>;

export interface BuddyPostRequest {
  /** An immutable Zulip channel id, or a declared channel key. */
  stream: number | BuddyChannelKey;
  topic: string;
  markdown: string;
  /**
   * True when the caller intends to OPEN a thread rather than continue one.
   * Zulip creates a topic implicitly on first message either way; naming the
   * intent is what keeps "Buddy files a report" distinguishable from "Buddy
   * interrupts an existing conversation" at the call site.
   */
  openThread?: boolean;
}

export interface BuddyPostResult {
  messageId: number;
  streamId: number;
  topic: string;
}

/**
 * The channel ids provisioning reported, read from the host's `./.env`. A key
 * with no id is simply absent — posting to it then fails loudly rather than
 * falling back to a name.
 *
 * `home` reads BUDDY_STREAM_ID, the key provisioning has always written for the
 * Principal's own channel.
 */
export function buddyChannelsFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuddyChannelRegistry {
  const registry: BuddyChannelRegistry = {};
  const home = Number(env.BUDDY_STREAM_ID);
  const escalations = Number(env.BUDDY_ESCALATIONS_STREAM_ID);
  if (Number.isInteger(home) && home > 0) registry.home = home;
  if (Number.isInteger(escalations) && escalations > 0) {
    registry.escalations = escalations;
  }
  return registry;
}

export function resolveChannel(
  stream: number | BuddyChannelKey,
  registry: BuddyChannelRegistry,
): number {
  if (typeof stream === "number") {
    if (!Number.isInteger(stream) || stream <= 0) {
      throw new Error("Zulip channel id must be a positive integer");
    }
    return stream;
  }
  const resolved = registry[stream];
  if (resolved === undefined) {
    // Fail loudly. The tempting fallback — post to the channel called
    // "buddy-escalations" — is exactly the name-selection ADR-017 forbids, and
    // an escalation delivered to whoever happens to hold that name is worse than
    // an escalation that visibly failed.
    throw new Error(
      `Buddy channel "${stream}" has no declared id; re-run provisioning so the ` +
        "host ./.env carries BUDDY_STREAM_ID and BUDDY_ESCALATIONS_STREAM_ID",
    );
  }
  return resolved;
}

/** Post into a Buddy-owned channel. The single unprompted-speech entry point. */
export async function buddyPost(
  cfg: ZulipConfig,
  registry: BuddyChannelRegistry,
  request: BuddyPostRequest,
): Promise<BuddyPostResult> {
  const topic = request.topic.trim();
  if (!topic) throw new Error("Buddy post requires a topic");
  if (!request.markdown.trim()) {
    throw new Error("Buddy post requires content");
  }
  const streamId = resolveChannel(request.stream, registry);
  if (request.openThread) {
    const created = await createReportTopic(
      cfg,
      streamId,
      topic,
      request.markdown,
    );
    return { messageId: created.messageId, streamId, topic: created.topic };
  }
  const messageId = await sendToTopic(cfg, streamId, topic, request.markdown);
  return { messageId, streamId, topic };
}

