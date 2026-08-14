// COVERS: automatic recovery from a wedged runtime session (Host #2, measured
// 2026-08-01) — the second trigger of the shared rotation state. That the two
// exhaustion sentences the pinned runtime produces rotate the session and
// nothing else does; that resolution happens at SEND time so a queued or
// re-run job lands on the fresh session; that the rotation is keyed by the
// triggering message id, so a redelivered job cannot rotate twice; that a
// healthy reply passes through byte-identical; and that the notice — not the
// raw error — is what reaches the Principal.
//
// The FIRST trigger — the Principal typing /reset — and the durable store
// itself are covered by tests/bridge/session-rotations.test.ts. Both triggers
// share ONE store on purpose: two stores writing the same session header
// would rotate past each other.
//
// THE MEASURED DAY. First morning after handover, every message — including a
// bare "Buddy?" — returned `Context length exceeded: max compression
// attempts (3) reached.` The runtime persists the over-full session, the
// bridge's DM session id is permanent by design, and the Principal had no
// escape from the chat window. Until this mechanism existed, a wedged Buddy
// stayed dead until an operator deleted the session on the host — and that
// morning the operator had no SSH either.

import { describe, expect, test } from "bun:test";
import type { BridgeReplyInput } from "../../bridge/inbound/message.ts";
import {
  isCompressionExhausted,
  sessionRotatedNotice,
  withSessionRecovery,
} from "../../bridge/runtime-adapter/session-recovery.ts";

const EXHAUSTED = "Context length exceeded: max compression attempts (3) reached.";

/**
 * In-memory stand-in with the SessionRotations contract (resolve/resetAt,
 * message-id keyed, monotonic). The durable implementation is covered in
 * session-rotations.test.ts; these tests are about the wrapper, and the fast
 * ring pays real fsyncs dearly on CI hardware.
 */
function memoryRotations() {
  const routes = new Map<string, number>();
  return {
    routes,
    async resolve(base: string): Promise<string> {
      const at = routes.get(base);
      return at && at > 0 ? `${base}-r${at}` : base;
    },
    async resetAt(base: string, messageId: number): Promise<string> {
      if ((routes.get(base) ?? 0) < messageId) routes.set(base, messageId);
      return this.resolve(base);
    },
  };
}

function dmInput(sessionId: string, messageId = 1): BridgeReplyInput {
  return {
    text: "Buddy?",
    senderName: "Principal",
    trigger: "direct",
    conversationKind: "private",
    sessionId,
    messageId,
    replyTarget: { kind: "private", recipientEmails: ["principal@example.test"] },
  } as BridgeReplyInput;
}

describe("detection is exactly the runtime's exhaustion sentences", () => {
  test("both measured sentences match, with any attempt count", () => {
    expect(isCompressionExhausted(EXHAUSTED)).toBe(true);
    expect(
      isCompressionExhausted(
        "Request payload too large: max compression attempts (6) reached.",
      ),
    ).toBe(true);
    // Whitespace from transport framing must not defeat the match.
    expect(isCompressionExhausted(`  ${EXHAUSTED}\n`)).toBe(true);
  });

  test("a reply that merely QUOTES the sentence does not rotate", () => {
    // A Buddy explaining its own yesterday's outage would otherwise wipe the
    // very conversation in which it is explaining it.
    expect(
      isCompressionExhausted(
        `Yesterday I kept answering "${EXHAUSTED}" — sorry about that.`,
      ),
    ).toBe(false);
    expect(isCompressionExhausted("")).toBe(false);
    expect(isCompressionExhausted("A normal answer.")).toBe(false);
    // The false path of the anchors: same words, more text on the line.
    expect(isCompressionExhausted(`${EXHAUSTED} Please resend.`)).toBe(false);
  });
});

describe("the wrapped provider", () => {
  test("healthy reply passes through byte-identical, session untouched", async () => {
    const rotations = memoryRotations();
    const seen: string[] = [];
    const provider = withSessionRecovery({
      provider: async (input) => {
        seen.push(input.sessionId);
        return "A normal answer.";
      },
      rotations,
      buddyName: "Buddy",
    });
    const reply = await provider(dmInput("base"));
    expect(reply).toBe("A normal answer.");
    expect(seen).toEqual(["base"]);
    expect(rotations.routes.size).toBe(0);
  });

  test("SCAR-SESSIONWEDGE-1 exhaustion reply rotates the session, and the Principal reads the notice — not the error", async () => {
    const rotations = memoryRotations();
    const logged: string[] = [];
    const provider = withSessionRecovery({
      provider: async () => EXHAUSTED,
      rotations,
      buddyName: "Buddy",
      log: (line) => logged.push(line),
    });
    const reply = await provider(dmInput("base", 42));
    expect(reply).toBe(sessionRotatedNotice("Buddy"));
    expect(reply).not.toContain("Context length exceeded");
    expect(reply).toContain("—Buddy");
    expect(await rotations.resolve("base")).toBe("base-r42");
    // The operational line is content-free: no session id, no text, no names.
    expect(logged).toEqual([
      "[inbound] runtime session rotated after compression exhaustion",
    ]);
  });

  test("the NEXT turn resolves to the fresh session and gets a real answer", async () => {
    const rotations = memoryRotations();
    const seen: string[] = [];
    const provider = withSessionRecovery({
      provider: async (input) => {
        seen.push(input.sessionId);
        // The wedged session answers with the wall; the fresh one answers.
        return input.sessionId === "base" ? EXHAUSTED : "Alive again.";
      },
      rotations,
      buddyName: "Buddy",
    });
    await provider(dmInput("base", 7));
    const second = await provider(dmInput("base", 9));
    expect(second).toBe("Alive again.");
    expect(seen).toEqual(["base", "base-r7"]);
  });

  test("a re-run of the SAME job rotates once, not twice (message-id idempotence)", async () => {
    // The reply queue checkpoints the reply after the provider returns; if the
    // process dies in between, the job re-runs. resetAt() keyed by the same
    // message id is a no-op the second time — and the re-run already resolves
    // to the fresh session, so it gets an answer instead of the wall.
    const rotations = memoryRotations();
    const seen: string[] = [];
    const provider = withSessionRecovery({
      provider: async (input) => {
        seen.push(input.sessionId);
        return input.sessionId === "base" ? EXHAUSTED : "Alive again.";
      },
      rotations,
      buddyName: "Buddy",
    });
    await provider(dmInput("base", 7));
    const rerun = await provider(dmInput("base", 7));
    expect(rerun).toBe("Alive again.");
    expect(seen).toEqual(["base", "base-r7"]);
    expect(await rotations.resolve("base")).toBe("base-r7");
  });

  test("a second wall on the fresh session rotates again — recovery is not one-shot", async () => {
    const rotations = memoryRotations();
    const seen: string[] = [];
    const provider = withSessionRecovery({
      provider: async (input) => {
        seen.push(input.sessionId);
        return EXHAUSTED;
      },
      rotations,
      buddyName: "Buddy",
    });
    await provider(dmInput("base", 3));
    await provider(dmInput("base", 5));
    await provider(dmInput("base", 8));
    expect(seen).toEqual(["base", "base-r3", "base-r5"]);
  });
});
