// An in-memory Zulip realm, exposed as a `fetch` implementation.
//
// WHY IT IS A FETCH AND NOT A STUB OF OUR OWN INTERFACE. The archive's poller
// tests stubbed `ZulipEventsApi` — our own interface, shaped by our own idea of
// what a realm does. A stub of your own interface can never tell you that the
// interface models the world wrongly, and that is exactly how scar R4 walked
// through a fully green suite: the stub had no history, so no test could ask
// what happens in front of a realm that does. This fake carries the STATE OF THE
// WORLD (messages, ids, queues, streams) and answers HTTP, so `bridge/outbound/
// zulip.ts` is really exercised, up to and including how it classifies an error
// body it cannot parse.
//
// FIDELITY: every modelled behaviour has a row in `tests/fakes/FIDELITY.md` with
// its source. What is deliberately NOT modelled: Markdown rendering, message
// edits/deletions/reactions, presence, uploads, rate limiting, and any
// permission model — the realm holds exactly one Principal and one bot.
//
// IT MUST BE ABLE TO REFUSE (TESTING.md H6). `dropQueue()`, `breakGateway()` in
// both observed shapes and `refuseSends()` exist so a test can drive a failure
// rather than assert about a string.

export interface SeedMessageSpec {
  /** Where it lands. A DM, or a topic inside a channel identified by its id. */
  to: { kind: "dm" } | { kind: "stream"; streamId: number; topic: string };
  text: string;
  /** Immutable Zulip user id of the sender. Defaults to the Principal. */
  senderId?: number;
  senderEmail?: string;
  senderFullName?: string;
  /** True when the message @mentions the bot — Zulip's `mentioned` flag. */
  mentionsBot?: boolean;
}

export interface FakeRealmMessage {
  id: number;
  sender_id: number;
  sender_email: string;
  sender_full_name: string;
  type: "stream" | "private";
  stream_id?: number;
  subject?: string;
  recipient_id?: number;
  display_recipient?: unknown;
  content: string;
  /** Per-user flags as the BOT sees them. `mentioned` is the one we read. */
  flags: string[];
}

export interface FakeRealmOptions {
  site?: string;
  botUserId?: number;
  botEmail?: string;
  principalId?: number;
  principalEmail?: string;
  principalName?: string;
  streams?: Array<{ id: number; name: string }>;
  /**
   * The realm's PAST — messages that already exist the first time the bridge
   * starts. The single most important knob in this file: a fixture without one
   * cannot express the host every real installation after the first one meets.
   */
  history?: SeedMessageSpec[];
  /** Where message ids start. Immutable and strictly increasing from here. */
  firstMessageId?: number;
}

/** How a broken gateway breaks. Both shapes were observed on Host #1. */
export type GatewayBreak =
  /** Zulip itself answers, with its documented machine-readable code. */
  | "bad-event-queue-id"
  /** nginx answers instead of Zulip: HTML, no `result`, no `code` to match on. */
  | "nginx-502";

interface SentMessage {
  type: "stream" | "private";
  to: string;
  topic?: string;
  content: string;
  id: number;
}

export class FakeRealm {
  readonly site: string;
  readonly botUserId: number;
  readonly botEmail: string;
  /** Everything the bot has POSTed. A cold-start test asserts this stays empty. */
  readonly sent: SentMessage[] = [];

  private readonly principalId: number;
  private readonly principalEmail: string;
  private readonly principalName: string;
  private readonly streams = new Map<number, string>();
  private readonly messages: FakeRealmMessage[] = [];
  private readonly queues = new Map<string, { lastEventId: number; events: Array<{ id: number; type: string; message?: FakeRealmMessage; flags?: string[] }> }>();
  private nextMessageId: number;
  private nextQueue = 1;
  private nextEventId = 1;
  private broken: GatewayBreak | null = null;
  private sendsRefused = false;
  /** Every path this realm was asked for. Lets a test assert HOW it was read. */
  readonly requests: Array<{ method: string; path: string; query: URLSearchParams }> = [];

  constructor(options: FakeRealmOptions = {}) {
    this.site = (options.site ?? "https://realm.test").replace(/\/$/, "");
    this.botUserId = options.botUserId ?? 42;
    this.botEmail = options.botEmail ?? "buddy-bot@realm.test";
    this.principalId = options.principalId ?? 7;
    this.principalEmail = options.principalEmail ?? "principal@realm.test";
    this.principalName = options.principalName ?? "Ada Lovelace";
    this.nextMessageId = options.firstMessageId ?? 1;
    for (const stream of options.streams ?? [{ id: 101, name: "Buddy" }]) {
      this.streams.set(stream.id, stream.name);
    }
    // The past is appended before any queue exists, which is precisely what
    // makes it the past: no event ever carried it.
    for (const spec of options.history ?? []) this.append(spec);
  }

  /** Append a message. Returns its immutable id. Delivers to every live queue. */
  post(spec: SeedMessageSpec): number {
    const message = this.append(spec);
    for (const queue of this.queues.values()) {
      queue.events.push({
        id: this.nextEventId++,
        type: "message",
        message,
        flags: message.flags,
      });
    }
    return message.id;
  }

  /**
   * Rename a channel. The name changes; the id does not. Everything that routes
   * on the name breaks here and everything that routes on the id does not — the
   * whole point of ADR-017 in one method.
   */
  renameStream(streamId: number, name: string): void {
    if (!this.streams.has(streamId)) {
      throw new Error(`fake realm has no channel with id ${streamId}`);
    }
    this.streams.set(streamId, name);
  }

  /** Garbage-collect every event queue, as Zulip does after ten idle minutes. */
  dropQueue(): void {
    this.queues.clear();
  }

  breakGateway(mode: GatewayBreak): void {
    this.broken = mode;
  }

  healGateway(): void {
    this.broken = null;
  }

  /** Make `POST /messages` fail, so a test can drive the reply hop's failure. */
  refuseSends(refused = true): void {
    this.sendsRefused = refused;
  }

  /** The realm's newest message id, or 0. What a correct cold start anchors at. */
  get newestMessageId(): number {
    return this.messages.length === 0 ? 0 : this.messages[this.messages.length - 1]!.id;
  }

  get messageCount(): number {
    return this.messages.length;
  }

  /** The `fetch` the Zulip client is constructed with. */
  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    this.requests.push({ method, path, query: url.searchParams });

    if (this.broken === "nginx-502" && path !== "users/me") {
      // What a half-restarted appliance really answers: nginx's own HTML, with
      // no `result` and no `code`. A client that recognises its recovery
      // condition only by parsing Zulip's JSON sees NOTHING here.
      return new Response(
        "<html><head><title>502 Bad Gateway</title></head><body>502</body></html>",
        { status: 502, headers: { "Content-Type": "text/html" } },
      );
    }
    if (this.broken === "bad-event-queue-id" && path === "events") {
      return Response.json(
        { result: "error", msg: "Bad event queue ID", code: "BAD_EVENT_QUEUE_ID" },
        { status: 400 },
      );
    }

    const form = await readForm(init);
    switch (`${method} ${path}`) {
      case "GET users/me":
        return Response.json({ result: "success", user_id: this.botUserId });
      case "POST register":
        return Response.json({
          result: "success",
          queue_id: this.registerQueue(),
          last_event_id: -1,
          // Zulip returns this when `message` is in fetch_event_types. It is the
          // initial-state boundary from the same request that creates the queue.
          max_message_id: this.newestMessageId,
          event_queue_longpoll_timeout_seconds: 90,
        });
      case "GET events":
        return this.events(url.searchParams);
      case "GET messages":
        return this.messagePage(url.searchParams);
      case "POST messages":
        return this.send(form);
      default:
        return Response.json(
          { result: "error", msg: `fake realm has no route for ${method} ${path}` },
          { status: 404 },
        );
    }
  }) as unknown as typeof fetch;

  // ---------------------------------------------------------------- internals

  private append(spec: SeedMessageSpec): FakeRealmMessage {
    const id = this.nextMessageId++;
    const senderId = spec.senderId ?? this.principalId;
    const base = {
      id,
      sender_id: senderId,
      sender_email:
        spec.senderEmail ??
        (senderId === this.botUserId ? this.botEmail : this.principalEmail),
      sender_full_name: spec.senderFullName ?? this.principalName,
      content: spec.text,
      // A message the bot sent is never `mentioned` to the bot itself.
      flags: spec.mentionsBot && senderId !== this.botUserId ? ["mentioned"] : [],
    };
    const message: FakeRealmMessage =
      spec.to.kind === "stream"
        ? {
            ...base,
            type: "stream",
            stream_id: spec.to.streamId,
            subject: spec.to.topic,
            // The NAME, exactly as Zulip sends it: correct at the moment of
            // sending and stale for ever after a rename. Anything that routes
            // on this value is routing on a name.
            display_recipient: this.streams.get(spec.to.streamId) ?? "unknown",
          }
        : {
            ...base,
            type: "private",
            recipient_id: 501,
            display_recipient: [
              { email: this.principalEmail, full_name: this.principalName },
              { email: this.botEmail, full_name: "Buddy" },
            ],
          };
    this.messages.push(message);
    return message;
  }

  private registerQueue(): string {
    const queueId = `fake-queue-${this.nextQueue++}`;
    this.queues.set(queueId, { lastEventId: -1, events: [] });
    return queueId;
  }

  private events(query: URLSearchParams): Response {
    const queueId = query.get("queue_id") ?? "";
    const queue = this.queues.get(queueId);
    if (!queue) {
      // The documented, machine-readable shape. Matching on this code and never
      // on the message string is what keeps recovery working in a realm whose
      // language is not English.
      return Response.json(
        { result: "error", msg: "Bad event queue ID", code: "BAD_EVENT_QUEUE_ID" },
        { status: 400 },
      );
    }
    const since = Number(query.get("last_event_id") ?? "-1");
    const events = queue.events.filter((event) => event.id > since);
    return Response.json({ result: "success", events });
  }

  private messagePage(query: URLSearchParams): Response {
    const anchor = query.get("anchor") ?? "oldest";
    const numBefore = Number(query.get("num_before") ?? "0");
    const numAfter = Number(query.get("num_after") ?? "0");
    let page: FakeRealmMessage[];
    if (anchor === "newest") {
      page = this.messages.slice(Math.max(0, this.messages.length - Math.max(numBefore, 1)));
      return Response.json({ result: "success", messages: page, found_newest: true });
    }
    const from = anchor === "oldest" ? 0 : Number(anchor);
    const at = this.messages.filter((message) => message.id >= from);
    page = at.slice(0, numAfter);
    return Response.json({
      result: "success",
      messages: page,
      found_newest: page.length === at.length,
    });
  }

  private send(form: URLSearchParams): Response {
    if (this.sendsRefused) {
      return Response.json(
        { result: "error", msg: "fake realm is refusing sends" },
        { status: 500 },
      );
    }
    const type = form.get("type") === "private" ? "private" : "stream";
    const to = form.get("to") ?? "";
    if (type === "stream") {
      // Upstream JSON-parses `to` and takes an integer as the channel ID
      // (zulip-server 12.1, zerver/actions/message_send.py). A channel that
      // does not exist is an error, which is what makes posting to a stale id
      // observable instead of silent.
      const streamId = Number(to);
      if (!this.streams.has(streamId)) {
        return Response.json(
          { result: "error", msg: `no channel with id ${to}`, code: "BAD_REQUEST" },
          { status: 400 },
        );
      }
    }
    const id = this.post({
      to:
        type === "stream"
          ? { kind: "stream", streamId: Number(to), topic: form.get("topic") ?? "" }
          : { kind: "dm" },
      text: form.get("content") ?? "",
      senderId: this.botUserId,
      senderEmail: this.botEmail,
      senderFullName: "Buddy",
    });
    this.sent.push({
      type,
      to,
      topic: form.get("topic") ?? undefined,
      content: form.get("content") ?? "",
      id,
    });
    return Response.json({ result: "success", id });
  }
}

async function readForm(init?: RequestInit): Promise<URLSearchParams> {
  const body = init?.body;
  if (!body) return new URLSearchParams();
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  return new URLSearchParams();
}

/** A `ZulipConfig` pointed at this realm. The real client, a fake world. */
export function fakeRealmConfig(realm: FakeRealm) {
  return {
    site: realm.site,
    botEmail: realm.botEmail,
    botApiKey: "fake-bot-api-key",
    fetchImpl: realm.fetch,
  };
}
