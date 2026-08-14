// COVERS: everything this lane routes on. That the runtime session is keyed on
// the IMMUTABLE `stream_id` and survives a channel rename (scar ID-1); that a
// reply goes back to the channel the message came FROM, by id, after that
// rename; that a stream message with no id is refused rather than routed by a
// name; that the self-echo filter keys on the immutable sender id and treats an
// id/e-mail contradiction as fail-closed; and that `buddy_post` resolves a
// declared KEY to a declared id and refuses loudly when there is none.
//
// DOES NOT COVER: a real Zulip's rename semantics (T2), Zulip topics having no
// id at all — which is why the topic here is a SUBORDINATE name inside a
// resolved id and not a routing key of its own — and the provisioning lane that
// puts the ids into the host env file in the first place.

import { describe, expect, test } from "bun:test";
import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  messageTrigger,
  sessionIdFor,
  toReplyInput,
  privateRecipientEmails,
  type ZulipMessage,
} from "../../bridge/inbound/message.ts";
import {
  buddyChannelsFromEnv,
  buddyPost,
  resolveChannel,
} from "../../bridge/outbound/post.ts";
import { EventBridge, createZulipEventsApi } from "../../bridge/inbound/events.ts";
import { FileReplyQueue } from "../../bridge/inbound/reply-queue.ts";
import { TurnBreaker } from "../../bridge/inbound/turn-breaker.ts";
import { DurableWatermark } from "../../bridge/inbound/watermark.ts";
import { createRuntimeReplyProvider } from "../../bridge/runtime-adapter/http-client.ts";
import { createZulipReplySender } from "../../bridge/run.ts";
import { FakeRealm, fakeRealmConfig } from "../fakes/fake-realm.ts";

const STREAM_ID = 101;
const BOT = { userId: 42, email: "buddy-bot@realm.test" };
const posixDurabilityTest = process.platform === "win32" ? test.skip : test;

const scratches: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SCAR-ID-1 — a channel the Principal renames keeps its conversation", () => {
  posixDurabilityTest("SCAR-ID-1 the session id is unchanged by a rename, and another channel cannot inherit it", async () => {
    // The failure, concretely: the Principal renames #Buddy to a name of their
    // own — one click, on data that is theirs. Keyed on the NAME, that rename
    // silently forked the runtime session, so the thread they were still reading
    // lost its memory. A newly created channel reusing the freed name would then
    // let a NEW thread inherit the old conversation.
    const realm = new FakeRealm({ streams: [{ id: STREAM_ID, name: "Buddy" }] });
    const root = await mkdtemp(join(tmpdir(), "buddy-routing-"));
    scratches.push(root);
    const cfg = fakeRealmConfig(realm);
    const sessions: string[] = [];
    const provider = createRuntimeReplyProvider({
      endpoint: "http://127.0.0.1:8642/v1/chat/completions",
      apiKey: "k",
      model: "hermes",
      systemMessage: () => "a contract",
      fetchImpl: (async (_url: string, init: any) => {
        sessions.push(init.headers["X-Hermes-Session-Id"]);
        return Response.json({ choices: [{ message: { content: "odpoved" } }] });
      }) as unknown as typeof fetch,
    });
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const queue = new FileReplyQueue({
      directory: root,
      replyProvider: provider,
      replySender: createZulipReplySender(cfg),
      logger,
      autoSchedule: false,
    });
    const bridge = new EventBridge({
      api: createZulipEventsApi(cfg),
      inbox: queue,
      watermark: new DurableWatermark(join(root, "state", "watermark.json")),
      bot: { userId: realm.botUserId, email: realm.botEmail },
      breaker: new TurnBreaker({ limitPerHour: 100 }),
      logger,
      notify: async () => {},
      buddyName: "Buddy",
      pollTimeoutMs: 1_000,
    });

    await bridge.recover();
    realm.post({
      to: { kind: "stream", streamId: STREAM_ID, topic: "denik" },
      text: "@**Buddy** prvni",
      mentionsBot: true,
    });
    await bridge.pumpOnce();
    await queue.drainOnce();

    // One click in Zulip. Everything after this line is the same channel with a
    // different name.
    realm.renameStream(STREAM_ID, "Muj vlastni nazev");
    realm.post({
      to: { kind: "stream", streamId: STREAM_ID, topic: "denik" },
      text: "@**Buddy** druha",
      mentionsBot: true,
    });
    await bridge.pumpOnce();
    await queue.drainOnce();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBe(sessions[1]!);
    // And both replies went back into the SAME channel, addressed by its id.
    expect(realm.sent.map((message) => message.to)).toEqual([
      String(STREAM_ID),
      String(STREAM_ID),
    ]);
  });

  test("SCAR-ID-1 a different channel that takes the freed NAME gets a different session", () => {
    const before = sessionIdFor("stream", "stream:101:denik");
    const impostor = sessionIdFor("stream", "stream:999:denik");
    expect(impostor).not.toBe(before);
    // …while the same channel under any name keeps its own key.
    expect(sessionIdFor("stream", "stream:101:denik")).toBe(before);
  });

  test("a topic is a NAME, and stays subordinate to the id one level up", () => {
    // Zulip topics genuinely have no id. Renaming one therefore starts a fresh
    // session — acceptable — but it can never hand the conversation to whoever
    // holds some other channel's name, because the id is inside the key.
    expect(sessionIdFor("stream", "stream:101:denik")).not.toBe(
      sessionIdFor("stream", "stream:101:prace"),
    );
  });

  test("a stream message with no immutable id is REFUSED, never routed by name", () => {
    const message: ZulipMessage = {
      id: 5,
      sender_id: 7,
      type: "stream",
      subject: "denik",
      display_recipient: "Buddy",
      content: "text",
      flags: ["mentioned"],
    };
    // Refusing is the point: the alternative is routing by a name a third party
    // can free.
    expect(toReplyInput(message, "mention", BOT)).toBeNull();
  });
});

describe("the self-echo filter, on the immutable sender id", () => {
  const dm = (overrides: Partial<ZulipMessage> = {}): ZulipMessage => ({
    id: 9,
    sender_id: 7,
    sender_email: "principal@realm.test",
    type: "private",
    content: "ahoj",
    ...overrides,
  });

  test("a DM from the Principal triggers; the bot's own message never does", () => {
    expect(messageTrigger(dm(), BOT)).toBe("direct_message");
    expect(messageTrigger(dm({ sender_id: BOT.userId }), BOT)).toBeNull();
  });

  test("a channel message triggers ONLY on the documented mention flag", () => {
    const streamMessage = dm({ type: "stream", stream_id: STREAM_ID, subject: "denik" });
    expect(messageTrigger(streamMessage, BOT)).toBeNull();
    expect(messageTrigger(streamMessage, BOT, ["mentioned"])).toBe("mention");
  });

  test("an id naming another account while the e-mail says Buddy is a contradiction, and is dropped", () => {
    // The e-mail is asserted BESIDE the id, never used as a selector. A
    // contradiction fails closed, because dropping is the safe direction: the
    // alternative is Buddy answering its own reply, for ever, in the Principal's
    // own private realm, at the speed of the model.
    expect(messageTrigger(dm({ sender_email: BOT.email }), BOT)).toBeNull();
  });

  test("the bot is removed from a DM's recipients, and a DM with nobody left is unroutable", () => {
    expect(
      privateRecipientEmails(
        [{ email: BOT.email }, { email: "principal@realm.test" }],
        "principal@realm.test",
        BOT.email,
      ),
    ).toEqual(["principal@realm.test"]);
    expect(
      toReplyInput(
        { id: 3, sender_id: 7, type: "private", display_recipient: [{ email: BOT.email }] },
        "direct_message",
        BOT,
      ),
    ).toBeNull();
  });
});

describe("buddy_post — the one place unprompted speech decides a channel", () => {
  test("a declared KEY resolves to the id provisioning reported", () => {
    const registry = buddyChannelsFromEnv({
      BUDDY_STREAM_ID: "101",
      BUDDY_ESCALATIONS_STREAM_ID: "202",
    });
    expect(resolveChannel("home", registry)).toBe(101);
    expect(resolveChannel("escalations", registry)).toBe(202);
    expect(resolveChannel(404, registry)).toBe(404);
  });

  test("a key with no declared id fails LOUDLY instead of falling back to a name", () => {
    // An escalation delivered to whoever happens to hold the name
    // "buddy-escalations" is worse than an escalation that visibly failed.
    expect(() => resolveChannel("escalations", { home: 101 })).toThrow(
      /has no declared id/,
    );
    expect(buddyChannelsFromEnv({ BUDDY_STREAM_ID: "not-a-number" })).toEqual({});
  });

  test("posting reaches the realm by id, and a stale id is an error rather than a guess", async () => {
    const realm = new FakeRealm({ streams: [{ id: STREAM_ID, name: "Buddy" }] });
    const cfg = fakeRealmConfig(realm);
    const result = await buddyPost(cfg, { home: STREAM_ID }, {
      stream: "home",
      topic: "report",
      markdown: "hotovo",
      openThread: true,
    });
    expect(result.streamId).toBe(STREAM_ID);
    expect(realm.sent[0]!.to).toBe(String(STREAM_ID));
    await expect(
      buddyPost(cfg, { home: 999 }, { stream: "home", topic: "t", markdown: "x" }),
    ).rejects.toBeDefined();
  });
});
