// bridge/outbound — thin Zulip REST client for Buddy.
//
// The bridge's ONLY connection to the chat fabric, in both directions. Buddy is
// a GENERIC bot: it reads by registering an event queue and long-polling
// `GET /events`, and it writes with `POST /messages`. Zulip never calls Buddy —
// there is no inbound listener, no webhook URL and no shared webhook token.
// No SDK: Zulip's REST API is plain HTTP form-encoding, so `fetch` is all we
// need (minimal-deps invariant).
//
// Credentials come from the environment (never hard-coded, never committed):
//   ZULIP_SITE            the host's canonical URL
//   BUDDY_BOT_EMAIL       the Generic bot's email
//   BUDDY_BOT_API_KEY     the bot's API key (written by the provisioning lane)

import {
  DeliveryHopError,
  classifyHttpStatus,
  classifyTransportFailure,
  hopHostname,
} from "../telemetry/delivery-log.ts";

export interface ZulipConfig {
  site: string;
  botEmail: string;
  botApiKey: string;
  fetchImpl?: typeof fetch;
}

// THERE IS NO `insecureTls` KNOB HERE, AND THAT IS DELIBERATE (TESTING.md §2).
// The archive carried one: it accepted a self-signed certificate whenever the
// site was loopback HTTPS, and `BUDDY_INSECURE_TLS=1` turned it on anywhere. It
// existed for a local preview and it lived in production code, which is the
// shape of every escape hatch that eventually ships — a Buddy talking to its own
// realm over a connection nobody verified, on a box whose whole selling point is
// that the history is the Principal's alone. T2 generates a local CA and trusts
// it at the host level instead, so the code under test is the code that runs.

export function zulipConfigFromEnv(env: Record<string, string | undefined> = process.env): ZulipConfig {
  const site = env.ZULIP_SITE;
  const botEmail = env.BUDDY_BOT_EMAIL;
  const botApiKey = env.BUDDY_BOT_API_KEY;
  if (!site || !botEmail || !botApiKey) {
    // `refusing to start:` routes this to exit 78 (scar R10): missing
    // credentials do not fix themselves, and a restart loop hides them.
    throw new Error(
      "refusing to start: missing Zulip bot credentials. Set ZULIP_SITE, " +
        "BUDDY_BOT_EMAIL and BUDDY_BOT_API_KEY (the provisioning lane writes " +
        "them into the host env file).",
    );
  }
  return { site: site.replace(/\/$/, ""), botEmail, botApiKey };
}

function authHeader(cfg: ZulipConfig): string {
  return "Basic " + Buffer.from(`${cfg.botEmail}:${cfg.botApiKey}`).toString("base64");
}

/**
 * The event queue this bridge held is gone. Zulip returns it when the queue has
 * been garbage-collected — after `idle_queue_timeout_secs` of inactivity
 * (10 minutes by default), or because the appliance restarted and lost it.
 *
 * IT IS MATCHED ON THE CODE, NEVER THE MESSAGE STRING. Zulip's error messages
 * are internationalized, so a bridge that matched on English text would stop
 * recognising its own recovery condition the moment a realm changed language,
 * and would then sit in the infinite `GET /events`-with-invalid-input loop the
 * Zulip documentation warns about.
 *
 * This is a normal, EXPECTED state transition — every reboot and every
 * `docker compose down/up` of the stack produces one — not an error.
 */
export class ZulipQueueGoneError extends Error {
  constructor() {
    super("Zulip event queue is gone");
    this.name = "ZulipQueueGoneError";
  }
}

async function apiRequest(
  cfg: ZulipConfig,
  method: string,
  path: string,
  options: { form?: Record<string, string>; query?: Record<string, string>; timeoutMs?: number } = {},
): Promise<any> {
  const query = options.query
    ? `?${new URLSearchParams(options.query).toString()}`
    : "";
  const body = options.form ? new URLSearchParams(options.form) : undefined;
  let res: Response;
  try {
    res = await (cfg.fetchImpl ?? fetch)(`${cfg.site}/api/v1/${path}${query}`, {
      method,
      headers: {
        Authorization: authHeader(cfg),
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body,
      ...(options.timeoutMs
        ? { signal: AbortSignal.timeout(options.timeoutMs) }
        : {}),
    });
  } catch (error) {
    // The reply hop. Its error CLASS is the whole diagnosis: `dns` = the
    // canonical hostname does not resolve on this host, `connect` = it
    // resolves but nothing answers on 443, `tls` = it answers with a
    // certificate this host will not accept. The site URL is used only to
    // find the hostname for the resolver probe; it is never logged or thrown.
    throw new DeliveryHopError(
      "zulip",
      await classifyTransportFailure(error, hopHostname(cfg.site)),
      `Zulip ${method} ${path} transport failed`,
    );
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.result !== "success") {
    if (json.code === "BAD_EVENT_QUEUE_ID") throw new ZulipQueueGoneError();
    throw new DeliveryHopError(
      "zulip",
      classifyHttpStatus(res.status),
      `Zulip ${method} ${path} failed with HTTP ${res.status}`,
    );
  }
  return json;
}

function apiForm(
  cfg: ZulipConfig,
  method: string,
  path: string,
  form: Record<string, string>,
): Promise<any> {
  return apiRequest(cfg, method, path, { form });
}

/**
 * Post a message to a topic in a channel identified by its IMMUTABLE id. The
 * topic is created if it doesn't exist.
 *
 * Zulip's `POST /messages` accepts either a channel name or a channel id in
 * `to`: `extract_stream_indicator` JSON-parses the value and takes an integer
 * as the id (zulip-server 12.1, `zerver/actions/message_send.py`). Sending the
 * id is what makes a reply land in the channel the message CAME FROM, even
 * after the Principal renamed it — and it also removes the reverse trap, where
 * a channel literally named "4242" would be parsed as an id under the old
 * name-passing call.
 */
export async function sendToTopic(
  cfg: ZulipConfig,
  streamId: number,
  topic: string,
  content: string,
): Promise<number> {
  if (!Number.isInteger(streamId) || streamId <= 0) {
    throw new Error("Zulip channel id must be a positive integer");
  }
  const json = await apiForm(cfg, "POST", "messages", {
    type: "stream",
    to: String(streamId),
    topic,
    content,
  });
  return json.id as number;
}

/** Send a direct reply to every non-Buddy participant in the triggering DM. */
export async function sendToDirectMessage(
  cfg: ZulipConfig,
  recipientEmails: readonly string[],
  content: string,
): Promise<number> {
  if (recipientEmails.length === 0) {
    throw new Error("Zulip direct-message recipients are required");
  }
  const json = await apiForm(cfg, "POST", "messages", {
    type: "private",
    // Zulip accepts a JSON-encoded email list. Keeping the complete list is
    // what preserves a group DM instead of silently turning it into a 1:1.
    to: JSON.stringify(recipientEmails),
    content,
  });
  return json.id as number;
}

/**
 * Create a report topic: sending the first message to a brand-new topic name IS
 * how a topic is created in Zulip. Named separately to make the intent explicit
 * at call sites (Buddy CREATES a report thread rather than interrupting).
 */
export async function createReportTopic(
  cfg: ZulipConfig,
  streamId: number,
  topic: string,
  content: string,
): Promise<{ messageId: number; topic: string }> {
  const messageId = await sendToTopic(cfg, streamId, topic, content);
  return { messageId, topic };
}

// --- The READ half: event queue, long-poll, catch-up ------------------------
// Buddy is a Generic bot, so nothing is pushed to it. It registers a queue and
// asks for what has happened since the last event it acknowledged.

export interface ZulipRegisteredQueue {
  queueId: string;
  /** The cursor to start polling from. Volatile: it dies with this queue. */
  lastEventId: number;
  /**
   * Zulip's own advice for the HTTP read timeout of the long-poll, "guaranteed
   * to be higher than heartbeat timeout". Absent on older servers.
   */
  longpollTimeoutSeconds?: number;
}

export interface ZulipEvent {
  id: number;
  type: string;
  message?: Record<string, unknown>;
  /** Per-user flags of a `message` event; `mentioned` is the one we read. */
  flags?: string[];
}

/**
 * Allocate an event queue.
 *
 * `event_types: ["message"]` is deliberate and v1-final: the events API also
 * offers edits, deletions, reactions and typing notifications, which is exactly
 * the temptation. Buddy answers messages; anything else is a separate decision.
 *
 * `idle_queue_timeout` is left at the server default (10 minutes). A longer
 * timeout would make restarts cheaper and would exercise the recovery path less
 * — and the recovery path is the one that loses a user message when it is wrong,
 * so it is better constantly proven than rarely used.
 */
export async function registerEventQueue(
  cfg: ZulipConfig,
): Promise<ZulipRegisteredQueue> {
  const json = await apiForm(cfg, "POST", "register", {
    event_types: JSON.stringify(["message"]),
    apply_markdown: "false",
    // No narrow. The trigger predicate lives in bridge/inbound/message.ts and is
    // applied to the live lane and the catch-up lane alike; a narrow here would
    // be a SECOND, differently-written copy of the same decision, and Zulip
    // narrows are conjunctive so it could not express "a DM to me OR a mention"
    // in the first place.
  });
  return {
    queueId: String(json.queue_id),
    lastEventId: Number(json.last_event_id ?? -1),
    longpollTimeoutSeconds:
      typeof json.event_queue_longpoll_timeout_seconds === "number"
        ? json.event_queue_longpoll_timeout_seconds
        : undefined,
  };
}

/**
 * Long-poll for events newer than `lastEventId`. Blocks server-side until an
 * event or a heartbeat, so the HTTP read timeout — not a separate watchdog
 * timer — is what detects a stuck poll: a socket that is neither delivering
 * heartbeats nor erroring is indistinguishable from a healthy idle one, and the
 * timeout is the only thing that can tell them apart.
 *
 * Throws `ZulipQueueGoneError` when the queue has been garbage-collected.
 */
export async function getEvents(
  cfg: ZulipConfig,
  queueId: string,
  lastEventId: number,
  timeoutMs: number,
): Promise<ZulipEvent[]> {
  const json = await apiRequest(cfg, "GET", "events", {
    query: { queue_id: queueId, last_event_id: String(lastEventId) },
    timeoutMs,
  });
  const events = Array.isArray(json.events) ? json.events : [];
  // "Event IDs are guaranteed to be increasing, but they are not guaranteed to
  // be consecutive." Sorting is cheap insurance: the acknowledge cursor may only
  // ever move forward over records that are already durable, and that invariant
  // is easier to hold when the caller processes them in id order.
  return (events as ZulipEvent[])
    .filter((event) => typeof event?.id === "number")
    .sort((left, right) => left.id - right.id);
}

export interface ZulipMessagePage {
  messages: Record<string, unknown>[];
  foundNewest: boolean;
}

/**
 * One page of messages at or after `anchor`, oldest first.
 *
 * The anchor is deliberately the watermark ITSELF rather than watermark + 1, so
 * every catch-up re-presents at least one message that already has a durable
 * record. The overlap costs one skipped write and turns each recovery into a
 * free liveness test of the dedupe path.
 */
export async function getMessagesFrom(
  cfg: ZulipConfig,
  anchor: number,
  numAfter: number,
): Promise<ZulipMessagePage> {
  const json = await apiRequest(cfg, "GET", "messages", {
    query: {
      anchor: anchor > 0 ? String(anchor) : "oldest",
      num_before: "0",
      num_after: String(numAfter),
      narrow: "[]",
      apply_markdown: "false",
    },
  });
  // A page that is not a page is NOT an empty page (TESTING.md H4). Coercing a
  // missing or malformed `messages` field to `[]` would tell catch-up "there is
  // nothing above the watermark", which is the one answer that makes it stop.
  if (!Array.isArray(json.messages)) {
    throw new Error("Zulip did not return a message page");
  }
  return {
    messages: json.messages,
    foundNewest: json.found_newest !== false,
  };
}

/**
 * The realm's newest message id, or 0 for a realm that has never had a message.
 *
 * WHAT IT IS FOR — the cold start. A bridge with no watermark and no inbox
 * record knows nothing about this host's past, and the tempting reading of
 * "nothing" is `anchor = 0`, i.e. the beginning of the realm. On Host #1 that
 * reading answered fifteen historical messages and delivered FIVE real replies
 * into existing private conversations in twenty seconds (scar R4). This probe is
 * how a cold start learns where "now" is instead of guessing where "the
 * beginning" is.
 *
 * IT IS FAIL-CLOSED. An unreadable answer THROWS; it never degrades to 0,
 * because 0 is precisely the value that replays the Principal's history. A
 * genuinely empty realm answers with an empty page and `found_newest`, and that
 * is the only path to a returned 0.
 *
 * `anchor: "newest"` with `num_before: 1` is documented upstream (Zulip REST API,
 * `GET /api/v1/messages`); the id arithmetic below is OURS.
 */
export async function getNewestMessageId(cfg: ZulipConfig): Promise<number> {
  const json = await apiRequest(cfg, "GET", "messages", {
    query: {
      anchor: "newest",
      num_before: "1",
      num_after: "0",
      narrow: "[]",
      apply_markdown: "false",
    },
  });
  if (!Array.isArray(json.messages)) {
    throw new Error("Zulip did not report the realm's newest message");
  }
  let newest = 0;
  for (const message of json.messages as Array<{ id?: unknown }>) {
    if (typeof message?.id === "number" && message.id > newest) newest = message.id;
  }
  return newest;
}

/**
 * The bot's OWN immutable Zulip user id. This is what the self-echo filter keys
 * on; the bot e-mail travels beside it as an assertion and never as a selector
 * (ARCHITECTURE §2.3, ADR-017).
 */
export async function getOwnUserId(cfg: ZulipConfig): Promise<number> {
  const json = await apiRequest(cfg, "GET", "users/me", {});
  const userId = json.user_id;
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("Zulip did not report this bot's own user id");
  }
  return userId as number;
}

/** Upload a file to Zulip; returns the server URL to embed in a message. */
export async function uploadFile(
  cfg: ZulipConfig,
  filename: string,
  bytes: Uint8Array | Buffer,
  contentType = "application/octet-stream",
): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: contentType }), filename);
  let res: Response;
  try {
    res = await (cfg.fetchImpl ?? fetch)(`${cfg.site}/api/v1/user_uploads`, {
      method: "POST",
      headers: { Authorization: authHeader(cfg) },
      body: fd,
    });
  } catch (error) {
    throw new DeliveryHopError(
      "zulip",
      await classifyTransportFailure(error, hopHostname(cfg.site)),
      "Zulip upload transport failed",
    );
  }
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || json.result !== "success") {
    throw new DeliveryHopError(
      "zulip",
      classifyHttpStatus(res.status),
      `Zulip upload failed with HTTP ${res.status}`,
    );
  }
  // Zulip returns a relative uri like /user_uploads/... ; make it absolute.
  const uri: string = json.uri ?? json.url;
  return uri.startsWith("http") ? uri : `${cfg.site}${uri}`;
}
const MAX_RUNTIME_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Fetch a private Zulip inline image with bot authentication and turn it into
 * an OpenAI-compatible data URL. Only this realm's /user_uploads/ namespace is
 * accepted; arbitrary URLs never become an authenticated bridge fetch.
 */
export async function downloadRuntimeImage(
  cfg: ZulipConfig,
  reference: string,
): Promise<string> {
  const site = new URL(cfg.site);
  const source = new URL(reference, site);
  if (
    source.origin !== site.origin ||
    !source.pathname.startsWith("/user_uploads/") ||
    source.pathname.startsWith("/user_uploads/temporary/")
  ) {
    throw new Error("refusing to fetch an image outside this Zulip realm");
  }

  // Zulip's documented API first exchanges the protected upload path for a
  // short-lived URL. The browser /user_uploads/ route does not accept API Basic
  // auth directly and correctly answers 404 to that shape.
  const metadataUrl = new URL(
    `/api/v1${source.pathname}${source.search}`,
    site,
  );
  const fetchImpl = cfg.fetchImpl ?? fetch;
  let metadataResponse: Response;
  try {
    metadataResponse = await fetchImpl(metadataUrl, {
      headers: { Authorization: authHeader(cfg) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new DeliveryHopError(
      "zulip",
      await classifyTransportFailure(error, hopHostname(cfg.site)),
      "Zulip image URL exchange transport failed",
    );
  }
  const metadata = (await metadataResponse.json().catch(() => ({}))) as {
    result?: string;
    url?: string;
  };
  if (!metadataResponse.ok || metadata.result !== "success" || !metadata.url) {
    throw new DeliveryHopError(
      "zulip",
      classifyHttpStatus(metadataResponse.status),
      `Zulip image URL exchange failed with HTTP ${metadataResponse.status}`,
    );
  }
  const temporary = new URL(metadata.url, site);
  if (
    temporary.origin !== site.origin ||
    !temporary.pathname.startsWith("/user_uploads/temporary/")
  ) {
    throw new Error("Zulip returned an invalid temporary upload URL");
  }

  let res: Response;
  try {
    res = await fetchImpl(temporary, {
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new DeliveryHopError(
      "zulip",
      await classifyTransportFailure(error, hopHostname(cfg.site)),
      "Zulip image download transport failed",
    );
  }
  if (!res.ok) {
    throw new DeliveryHopError(
      "zulip",
      classifyHttpStatus(res.status),
      `Zulip image download failed with HTTP ${res.status}`,
    );
  }
  const contentType = (res.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error("Zulip upload is not an image");
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_RUNTIME_IMAGE_BYTES) {
    throw new Error("Zulip image is larger than the runtime image limit");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_RUNTIME_IMAGE_BYTES) {
    throw new Error("Zulip image is larger than the runtime image limit");
  }
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}
