import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRotations } from "../../bridge/inbound/session-rotations.ts";
import { withSessionRecovery } from "../../bridge/runtime-adapter/session-recovery.ts";
import { EventBridge, createZulipEventsApi } from "../../bridge/inbound/events.ts";
import { FileReplyQueue } from "../../bridge/inbound/reply-queue.ts";
import { TurnBreaker } from "../../bridge/inbound/turn-breaker.ts";
import { DurableWatermark } from "../../bridge/inbound/watermark.ts";
import { createZulipReplySender } from "../../bridge/run.ts";
import { FakeRealm, fakeRealmConfig } from "../fakes/fake-realm.ts";

let scratch = "";
const posixDurabilityTest = process.platform === "win32" ? test.skip : test;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = "";
});

posixDurabilityTest("/reset rotation is durable and idempotent under replay", async () => {
  scratch = await mkdtemp(join(tmpdir(), "buddy-session-rotations-"));
  const path = join(scratch, "state.json");
  const first = new SessionRotations(path);
  expect(await first.resolve("route")).toBe("route");
  expect(await first.resetAt("route", 42)).toBe("route-r42");
  expect(await first.resetAt("route", 42)).toBe("route-r42");

  const afterRestart = new SessionRotations(path);
  expect(await afterRestart.resolve("route")).toBe("route-r42");
  expect(await afterRestart.resetAt("route", 41)).toBe("route-r42");
  expect(await afterRestart.resetAt("route", 99)).toBe("route-r99");
});
posixDurabilityTest("EventBridge handles rendered /reset without calling the runtime", async () => {
  scratch = await mkdtemp(join(tmpdir(), "buddy-session-reset-e2e-"));
  const realm = new FakeRealm();
  const cfg = fakeRealmConfig(realm);
  const sessions: string[] = [];
  const notices: string[] = [];
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  // Wired the way run.ts wires it: ONE rotation store, shared by the /reset
  // command (EventBridge) and the send-time resolve (provider wrapper). The
  // session id stays BASE inside the queue; the wrapper resolves at send.
  const sessionRotations = new SessionRotations(
    join(scratch, "state", "session-rotations.json"),
  );
  const queue = new FileReplyQueue({
    directory: scratch,
    replyProvider: withSessionRecovery({
      provider: async (input) => {
        sessions.push(input.sessionId);
        return "answer";
      },
      rotations: sessionRotations,
      buddyName: "Buddy",
    }),
    replySender: createZulipReplySender(cfg),
    logger,
    autoSchedule: false,
  });
  const bridge = new EventBridge({
    api: createZulipEventsApi(cfg),
    inbox: queue,
    watermark: new DurableWatermark(join(scratch, "state", "watermark.json")),
    bot: { userId: realm.botUserId, email: realm.botEmail },
    breaker: new TurnBreaker({ limitPerHour: 100 }),
    logger,
    notify: async (_input, content) => { notices.push(content); },
    buddyName: "Buddy",
    sessionRotations,
    pollTimeoutMs: 1_000,
  });

  await bridge.recover();
  realm.post({ to: { kind: "dm" }, text: "before" });
  await bridge.pumpOnce();
  await queue.drainOnce();

  realm.post({ to: { kind: "dm" }, text: "<p>/reset</p>" });
  await bridge.pumpOnce();
  await queue.drainOnce();

  realm.post({ to: { kind: "dm" }, text: "after" });
  await bridge.pumpOnce();
  await queue.drainOnce();

  expect(sessions).toHaveLength(2);
  expect(sessions[1]).not.toBe(sessions[0]);
  expect(sessions[1]).toMatch(/-r\d+$/);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("Fresh context started");
});
