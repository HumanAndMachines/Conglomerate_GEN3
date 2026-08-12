// COVERS: the events-API poller against a fake realm that has a PAST — cold
// start (scar R4), the durability ordering record → watermark → last_event_id
// (scar BRIDGE-1), the dedupe that makes catch-up's deliberate overlap free,
// recovery from a garbage-collected queue in BOTH observed shapes (Zulip's own
// `BAD_EVENT_QUEUE_ID` and an nginx 502 with nothing to parse), and the fact
// that a message that is not for Buddy still advances the watermark.
//
// The fake is an HTTP realm, not a stub of our own `ZulipEventsApi`: a stub of
// our own interface can never show that the interface models the world wrongly,
// and that is exactly how R4 walked through a green suite.
//
// DOES NOT COVER: a real Zulip's event semantics (T2 owns that), long-poll
// timing and heartbeats, `restart: unless-stopped` and anything else that needs a
// real appliance, and the model's behaviour once a reply is generated.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBridge, createZulipEventsApi } from "../../bridge/inbound/events.ts";
import { FileReplyQueue } from "../../bridge/inbound/reply-queue.ts";
import { TurnBreaker } from "../../bridge/inbound/turn-breaker.ts";
import { DurableWatermark } from "../../bridge/inbound/watermark.ts";
import { createZulipReplySender } from "../../bridge/run.ts";
import { FakeRealm, fakeRealmConfig, type SeedMessageSpec } from "../fakes/fake-realm.ts";

const STREAM_ID = 101;

const scratches: string[] = [];
// These suites assert POSIX fsync ordering. The Buddy service is Linux-only in
// resident v1; Windows activation is explicitly fail-closed until it has an
// equivalent durable-filesystem adapter.
const posixDurabilityDescribe = process.platform === "win32" ? describe.skip : describe;

afterEach(async () => {
  await Promise.all(
    scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "buddy-poller-"));
  scratches.push(path);
  return path;
}

interface Harness {
  bridge: EventBridge;
  queue: FileReplyQueue;
  watermark: DurableWatermark;
  realm: FakeRealm;
  root: string;
  lines: string[];
  notices: string[];
}

async function harness(options: {
  realm?: FakeRealm;
  root?: string;
  watermark?: DurableWatermark;
  breaker?: TurnBreaker;
} = {}): Promise<Harness> {
  const realm = options.realm ?? new FakeRealm();
  const root = options.root ?? (await scratch());
  const lines: string[] = [];
  const notices: string[] = [];
  const logger = {
    info: (message: string) => lines.push(message),
    warn: (message: string) => lines.push(message),
    error: (message: string) => lines.push(message),
  };
  const cfg = fakeRealmConfig(realm);
  const send = createZulipReplySender(cfg);
  const queue = new FileReplyQueue({
    directory: root,
    // A real reply through the real Zulip client into the fake realm: the whole
    // point of the cold-start test is what lands in somebody's chat window.
    replyProvider: async () => "an answer from Buddy",
    replySender: send,
    logger,
    autoSchedule: false,
  });
  const watermark =
    options.watermark ?? new DurableWatermark(join(root, "state", "watermark.json"));
  const bridge = new EventBridge({
    api: createZulipEventsApi(cfg),
    inbox: queue,
    watermark,
    bot: { userId: realm.botUserId, email: realm.botEmail },
    breaker: options.breaker ?? new TurnBreaker({ limitPerHour: 100 }),
    logger,
    notify: async (_input, content) => {
      notices.push(content);
    },
    buddyName: "Buddy",
    pollTimeoutMs: 1_000,
  });
  return { bridge, queue, watermark, realm, root, lines, notices };
}

/** Fifteen messages of realm history, five of which would trigger a reply. */
const HISTORY: SeedMessageSpec[] = [
  { to: { kind: "dm" }, text: "poznamky z terapie, prosim shrnout" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "denik" }, text: "dnes bylo hezky" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "denik" }, text: "a vcera taky" },
  { to: { kind: "dm" }, text: "co mam delat s tim mailem" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "prace" }, text: "@**Buddy** koukni na to", mentionsBot: true },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "prace" }, text: "uz nic" },
  { to: { kind: "dm" }, text: "dobrou noc" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "denik" }, text: "ranni zapis" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "denik" }, text: "odpoledni zapis" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "nakupy" }, text: "mleko" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "nakupy" }, text: "chleba" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "prace" }, text: "@**Buddy** a jeste tohle", mentionsBot: true },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "denik" }, text: "vecerni zapis" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "denik" }, text: "jeste jeden" },
  { to: { kind: "stream", streamId: STREAM_ID, topic: "denik" }, text: "posledni" },
];

posixDurabilityDescribe("cold start in front of a realm that already has a past", () => {
  test("SCAR-R4 a first start against a realm with history sends NOTHING", async () => {
    // What actually happened on Host #1 on 2026-07-29: a brand-new bridge in
    // front of a realm with a past accepted fifteen historical messages and
    // delivered FIVE real replies into existing private conversations in twenty
    // seconds, before a human could stop it. The defect was reading "I have no
    // watermark" as "the conversation starts at message 1". A greenfield fixture
    // has no past, which is why the whole archive suite was green.
    const realm = new FakeRealm({ history: HISTORY });
    expect(realm.messageCount).toBe(15);
    const { bridge, queue, watermark, root } = await harness({ realm });

    await bridge.recover();
    await queue.drainOnce();

    // Nothing was sent, and nothing was even ACCEPTED: the one durable record
    // is the anchor's own REFUSAL, written so that a later catch-up — which
    // deliberately re-presents the message AT the watermark — finds something
    // for EEXIST to swallow instead of a historical message to answer.
    expect(realm.sent).toEqual([]);
    expect(await readdir(join(root, "inbox"))).toEqual([`${realm.newestMessageId}.json`]);
    const anchorRecord = JSON.parse(
      await Bun.file(join(root, "inbox", `${realm.newestMessageId}.json`)).text(),
    ) as { state: string; reason?: string };
    expect(anchorRecord.state).toBe("refused");
    expect(anchorRecord.reason).toBe("cold_start_anchor");
    // The anchor moved to NOW, so the past is behind it and stays behind it.
    expect(await watermark.read()).toBe(realm.newestMessageId);
  });

  test("SCAR-R4 and it is still a bridge afterwards — the next message IS answered", async () => {
    // The positive control, without which "answers nothing, ever" would pass the
    // test above. A bridge that is merely broken is not a bridge that is safe.
    const realm = new FakeRealm({ history: HISTORY });
    const { bridge, queue } = await harness({ realm });
    await bridge.recover();
    await queue.drainOnce();
    expect(realm.sent).toEqual([]);

    realm.post({ to: { kind: "dm" }, text: "ahoj, jsi tam?" });
    await bridge.pumpOnce();
    await queue.drainOnce();

    expect(realm.sent).toHaveLength(1);
    expect(realm.sent[0]!.content).toContain("an answer from Buddy");
  });

  test("SCAR-R4 a lost queue after a quiet cold start does not answer the anchor", async () => {
    // Catch-up pages from the watermark INCLUSIVE on purpose and relies on the
    // inbox's EEXIST to swallow the overlap — a promise consume() keeps for
    // every message it judged, and kept for nobody at the one id a cold start
    // wrote before this record existed. The realm's newest historical message
    // here is a Principal's DM, the worst case: before the anchor carried its
    // own refusal record, one appliance restart re-presented it with nothing to
    // swallow it, and the bridge answered a message it had decided to skip.
    const realm = new FakeRealm({
      history: [...HISTORY, { to: { kind: "dm" }, text: "jsi tam jeste?" }],
    });
    const { bridge, queue } = await harness({ realm });
    await bridge.recover();
    await queue.drainOnce();
    expect(realm.sent).toEqual([]);

    // The appliance restarts overnight with the realm quiet: the queue is gone,
    // the bridge re-registers and catches up from the cold-start watermark.
    await bridge.recover();
    await queue.drainOnce();
    expect(realm.sent).toEqual([]);

    // Positive control: still a bridge — the next real message is answered.
    realm.post({ to: { kind: "dm" }, text: "ahoj, jsi tam?" });
    await bridge.pumpOnce();
    await queue.drainOnce();
    expect(realm.sent).toHaveLength(1);
  });

  test("a cold start that cannot read the realm stays SILENT rather than starting at zero", async () => {
    // The fail-closed half. `0` is not a safe default here: it is precisely the
    // value that replays the Principal's whole history, so an unreadable probe
    // throws and the run loop backs off instead.
    const realm = new FakeRealm({ history: HISTORY });
    const { bridge } = await harness({ realm });
    realm.breakGateway("nginx-502");
    await expect(bridge.recover()).rejects.toBeDefined();
    expect(realm.sent).toEqual([]);
  });

  test("a lost watermark on a host that HAS records anchors from the records, not from zero", async () => {
    // The other cold-start shape: the inbox survived, the one watermark file did
    // not. Anchoring at 0 would re-answer every message whose tombstone had been
    // pruned.
    const realm = new FakeRealm({ history: HISTORY });
    const root = await scratch();
    const first = await harness({ realm, root });
    await first.bridge.recover();
    realm.post({ to: { kind: "dm" }, text: "prvni skutecna zprava" });
    await first.bridge.pumpOnce();
    await first.queue.drainOnce();
    expect(realm.sent).toHaveLength(1);

    // Wipe the watermark file only, keep the inbox.
    await rm(join(root, "state", "watermark.json"), { force: true });
    const second = await harness({ realm, root });
    await second.bridge.recover();
    await second.queue.drainOnce();
    // Still one reply in total: the record's own id was the anchor.
    expect(realm.sent).toHaveLength(1);
  });
});

posixDurabilityDescribe("the durability ordering — record, then watermark, then acknowledgement", () => {
  test("SCAR-BRIDGE-1 the record is on disk BEFORE the watermark moves past the message", async () => {
    // Reverse these two and a crash between them puts a message BELOW the
    // watermark with no record: catch-up never re-fetches it because it is below
    // the anchor, and the event queue never re-delivers it because it was
    // acknowledged. The Principal's message is then silently never answered, and
    // nothing anywhere reports anything — it is the ONLY ordering mistake in this
    // lane that loses a message rather than duplicating one.
    const realm = new FakeRealm();
    const { bridge, queue, watermark } = await harness({ realm });
    const order: string[] = [];
    const acceptSpy = queue.accept.bind(queue);
    const advanceSpy = watermark.advanceTo.bind(watermark);
    (queue as any).accept = async (input: any) => {
      order.push(`accept:${input.messageId}`);
      return acceptSpy(input);
    };
    (watermark as any).advanceTo = async (id: number) => {
      order.push(`watermark:${id}`);
      return advanceSpy(id);
    };

    await bridge.recover();
    const id = realm.post({ to: { kind: "dm" }, text: "zprava, kterou nesmim ztratit" });
    await bridge.pumpOnce();

    expect(order).toEqual([`accept:${id}`, `watermark:${id}`]);
  });

  test("SCAR-BRIDGE-1 a crash between the two leaves a RECORD, never a gap", async () => {
    const realm = new FakeRealm();
    const root = await scratch();
    // A watermark that cannot be written — a full disk, a read-only mount. The
    // crash we cannot rehearse is a power cut; this is its observable twin.
    const failing = new DurableWatermark(join(root, "state", "watermark.json"));
    let broken = true;
    const real = failing.advanceTo.bind(failing);
    (failing as any).advanceTo = async (id: number) => {
      if (broken) throw new Error("ENOSPC");
      return real(id);
    };
    const { bridge, queue } = await harness({ realm, root, watermark: failing });
    await bridge.recover();
    const id = realm.post({ to: { kind: "dm" }, text: "prezije to pad?" });
    await expect(bridge.pumpOnce()).rejects.toThrow(/ENOSPC/);

    // The record exists even though the watermark never moved. That is the whole
    // safety property: the message is recoverable from disk, and the un-advanced
    // watermark means catch-up will present it again.
    expect(await readdir(join(root, "inbox"))).toContain(`${id}.json`);

    // And once the disk heals, exactly one reply goes out — not two.
    broken = false;
    await bridge.pumpOnce();
    await queue.drainOnce();
    expect(realm.sent).toHaveLength(1);
  });

  test("a replayed message is absorbed rather than answered twice", async () => {
    const realm = new FakeRealm();
    const { bridge, queue } = await harness({ realm });
    await bridge.recover();
    realm.post({ to: { kind: "dm" }, text: "jednou" });
    await bridge.pumpOnce();
    // Catch-up anchors AT the watermark rather than above it, so it always
    // re-presents at least one message that already has a record. That overlap
    // is deliberate: it turns every recovery into a free liveness test of dedupe.
    await bridge.catchUp();
    await queue.drainOnce();
    expect(realm.sent).toHaveLength(1);
  });

  test("a message that is not for Buddy advances the watermark and records nothing", async () => {
    const realm = new FakeRealm();
    const { bridge, queue, watermark, root } = await harness({ realm });
    await bridge.recover();
    const id = realm.post({
      to: { kind: "stream", streamId: STREAM_ID, topic: "denik" },
      text: "psano jen pro sebe, bez zmínky",
    });
    await bridge.pumpOnce();
    await queue.drainOnce();

    expect(realm.sent).toEqual([]);
    expect(await readdir(join(root, "inbox"))).toEqual([]);
    // The DECISION was made, so leaving it behind the watermark would make every
    // later recovery re-read a growing tail of already-judged messages. The
    // safety property is untouched: it is about a message we ACCEPTED.
    expect(await watermark.read()).toBe(id);
  });
});

posixDurabilityDescribe("the queue is state we hold a handle to and do not own", () => {
  test("a garbage-collected queue is re-registered, not reported as an error", async () => {
    const realm = new FakeRealm();
    const { bridge, queue } = await harness({ realm });
    await bridge.recover();
    realm.dropQueue();
    // Zulip's own machine-readable code. Matching on it rather than on the
    // English message is what keeps recovery working in a realm that is not in
    // English.
    await expect(bridge.pumpOnce()).rejects.toThrow(/queue is gone/i);

    await bridge.recover();
    realm.post({ to: { kind: "dm" }, text: "po restartu appliance" });
    await bridge.pumpOnce();
    await queue.drainOnce();
    expect(realm.sent).toHaveLength(1);
  });

  test("an nginx 502 with nothing to parse is a plain failure, not a fake recovery", async () => {
    // MĚŘENO on Host #1: a real interruption came back through THIS branch, not
    // through Zulip's JSON. A client that treats every failure as "the queue is
    // gone" would throw its cursor away on every hiccup; one that treats this as
    // recoverable would loop.
    const realm = new FakeRealm();
    const { bridge } = await harness({ realm });
    await bridge.recover();
    realm.breakGateway("nginx-502");
    const error = await bridge.pumpOnce().catch((thrown: Error) => thrown);
    expect((error as Error).name).not.toBe("ZulipQueueGoneError");
    expect(realm.sent).toEqual([]);
  });
});

posixDurabilityDescribe("the turn breaker is the second line of defence behind the echo filter", () => {
  test("over the ceiling, the message is recorded, refused and the human is told once", async () => {
    const realm = new FakeRealm();
    const { bridge, queue, notices, root } = await harness({
      realm,
      breaker: new TurnBreaker({ limitPerHour: 1 }),
    });
    await bridge.recover();
    realm.post({ to: { kind: "dm" }, text: "prvni" });
    realm.post({ to: { kind: "dm" }, text: "druha" });
    realm.post({ to: { kind: "dm" }, text: "treti" });
    await bridge.pumpOnce();
    await queue.drainOnce();

    expect(realm.sent).toHaveLength(1);
    // Announced ONCE per window, not once per dropped message: a silent breaker
    // and a broken Buddy look identical from the chat window.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("ceiling");
    // The refused messages are RECORDED, so the watermark may pass them without
    // that being indistinguishable from a message the bridge never saw.
    expect((await readdir(join(root, "inbox"))).length).toBe(3);
  });
});
