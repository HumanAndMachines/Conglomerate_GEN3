// bridge/runtime-adapter — recovery from a wedged runtime session.
//
// THE FAILURE THIS EXISTS FOR, measured 2026-08-01 on a Buddy cohort host, first
// morning after handover. Every message — including a a bare Buddy-name prompt — came
// back as:
//
//   Context length exceeded: max compression attempts (3) reached.
//
// The mechanism (read from the runtime's source, not guessed): when context
// compression fails its configured number of attempts, the runtime returns
// that sentence AS THE REPLY CONTENT and persists the over-full session. The
// bridge derives a DM's session id from immutable Zulip ids, so the session is
// PERMANENT — which is right for continuity and fatal here: once wedged,
// every future turn hits the same wall before the model is ever reached.
//
// The Principal has no way out from the chat window. The runtime's own hint
// ("Try /new") is a TUI command; through the OpenAI-shaped gateway (contract
// K1) message text is just message text. A wedged Buddy therefore stays dead
// until an operator deletes the session on the host — and the first morning
// of Host #2, the operator had no SSH access either.
//
// THE RECOVERY. The bridge owns session identity (contract K4: "the caller
// assigns it"), so the bridge can ROTATE it: detect the exhaustion reply,
// record a rotation in the durable store shared with the Principal's /reset
// command (bridge/inbound/session-rotations.ts), and answer with an honest
// notice instead of the raw error. The next turn carries a fresh session id;
// the runtime starts clean. Continuity is not lost where it
// matters — history lives in Zulip and memory in gbrain (contract K6: the
// runtime is a system of record for nothing).
//
// WHAT THIS IS NOT. Not a retry: the wedged turn's text is NOT resent on the
// fresh session. The Principal is told the conversation context was dropped
// and asked to resend — losing context silently would be worse than losing
// it honestly. And detection is deliberately narrow: only the runtime's
// exhaustion sentences rotate the session. A false positive here would throw
// away a healthy conversation's context on the strength of a coincidental
// reply, so an unrecognized wording fails SAFE — the bridge behaves exactly
// as before this file existed, and the pinned strings are covered by a test
// that must be updated when the runtime pin moves.

import type {
  BridgeReplyInput,
  BridgeReplyProvider,
} from "../inbound/message.ts";
import type { SessionRotations } from "../inbound/session-rotations.ts";

// The two exhaustion sentences the pinned runtime can produce, verbatim from
// its conversation loop (`Lazurio/hermes-agent`, agent/conversation_loop.py):
// one for input overflow, one for the payload-too-large retry path. Anchored
// exact-shape matches — `.trim()` plus `^…$` — so a reply that merely QUOTES
// the sentence (a Buddy explaining its own yesterday's outage, say) does not
// rotate anything.
const EXHAUSTION_SHAPES: readonly RegExp[] = [
  /^Context length exceeded: max compression attempts \(\d+\) reached\.$/,
  /^Request payload too large: max compression attempts \(\d+\) reached\.$/,
];

/** True when a runtime reply is the compression-exhaustion sentence itself. */
export function isCompressionExhausted(reply: string): boolean {
  const line = reply.trim();
  return EXHAUSTION_SHAPES.some((shape) => shape.test(line));
}

/**
 * What the Principal reads instead of the raw error. Honest about what was
 * lost and what was not; same register and signature as `deadLetterNotice`,
 * because it exists for the same reason — the person in the chat window is
 * the one component that cannot read the journal.
 */
export function sessionRotatedNotice(buddyName: string): string {
  return (
    "Our conversation grew past what I can hold in working context, and " +
    "compacting it failed — so I have started a fresh one. My long-term " +
    "memory and everything already in this chat are untouched; what I lost " +
    "is the working thread of the last conversation.\n\n" +
    "Please send your last request again and I will pick it up from here.\n\n" +
    `—${buddyName}`
  );
}

export interface SessionRecoveryOptions {
  provider: BridgeReplyProvider;
  /**
   * The ONE rotation store, shared with the /reset command in events.ts. Two
   * stores writing the same session header would rotate past each other —
   * a /reset would be undone by the next automatic resolve and vice versa —
   * so both triggers go through this single, message-id-keyed state
   * (bridge/inbound/session-rotations.ts).
   */
  rotations: Pick<SessionRotations, "resolve" | "resetAt">;
  buddyName: string;
  /** Content-free operational line; the closed-vocabulary logger from run.ts. */
  log?: (line: string) => void;
}

/**
 * Wrap a reply provider with session rotation.
 *
 * The wrapper resolves the effective session id at SEND time — not at ingest —
 * so a reply job that was queued before a rotation still lands on the fresh
 * session when it is finally sent. Detection happens on the reply of the SAME
 * call, so the notice reaches exactly the turn that hit the wall.
 */
export function withSessionRecovery(
  options: SessionRecoveryOptions,
): BridgeReplyProvider {
  const { provider, rotations, buddyName } = options;
  const log = options.log ?? (() => undefined);
  return async (input: BridgeReplyInput): Promise<string> => {
    const reply = await provider({
      ...input,
      // Resolved at SEND time, not at ingest: a job queued before a rotation
      // must land on the fresh session when it is finally sent.
      sessionId: await rotations.resolve(input.sessionId),
    });
    if (!isCompressionExhausted(reply)) return reply;
    // Rotate BEFORE answering, keyed by the triggering message id — the same
    // idempotence the /reset command uses. If the notice fails to deliver and
    // the queue re-runs this job, resetAt() with the same id is a no-op and
    // the re-run already resolves to the fresh session instead of the wall.
    await rotations.resetAt(input.sessionId, input.messageId);
    // Content-free by construction: no session id, no text, no sender.
    log("[inbound] runtime session rotated after compression exhaustion");
    return sessionRotatedNotice(buddyName);
  };
}
