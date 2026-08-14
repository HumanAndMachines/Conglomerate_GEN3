// bridge/inbound — the turns-per-hour breaker.
//
// WHAT IT IS FOR, and it is not rate limiting for its own sake. Under the
// outgoing-webhook shape Zulip decided which messages reached Buddy, so a reply
// could not become the next request: the bot never saw its own messages. A
// Generic bot sees everything in every channel it is subscribed to. The self-echo
// filter in message.ts is the first line of defence, and it is a predicate a
// human wrote — if it is ever wrong (a bot whose `sender_id` is not what we
// registered, a second bot answering into the same topic, a Principal scripting
// a loop), Buddy answers its own answer and the loop runs at the speed of the
// LLM, in the Principal's own private realm, spending his own vendor quota.
//
// This is the ceiling that turns that from "unbounded until someone notices" into
// "N turns, then a visible stop". It is deliberately NOT silent: when it trips,
// the caller posts one short note into the conversation (once per window), so the
// human waiting for an answer learns why there is none. A silent breaker and a
// broken Buddy look identical from the chat window.
//
// It counts TURNS (a runtime call the bridge is about to make), not messages, and
// it is per host, not per conversation: the resource it protects — the
// Principal's own vendor CLI quota and the box's CPU — is per host.

export interface TurnBreakerOptions {
  /** Turns allowed in any rolling hour. */
  limitPerHour?: number;
  now?: () => number;
}

export const DEFAULT_TURNS_PER_HOUR = 30;

const WINDOW_MS = 3_600_000;

export interface BreakerVerdict {
  allowed: boolean;
  /** True exactly once per tripped window: the caller tells the human. */
  announce: boolean;
  /** Turns in the current window at the moment of the decision. */
  used: number;
  limit: number;
}

export class TurnBreaker {
  private readonly limit: number;
  private readonly now: () => number;
  private readonly turns: number[] = [];
  private announcedAt?: number;

  constructor(options: TurnBreakerOptions = {}) {
    const limit = options.limitPerHour ?? DEFAULT_TURNS_PER_HOUR;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Turn breaker limit must be a positive integer");
    }
    this.limit = limit;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Ask for permission to spend one turn. When it is granted the turn is
   * counted — there is no separate `commit`, because a caller that forgot to
   * call it would be a breaker that never trips.
   */
  request(): BreakerVerdict {
    const at = this.now();
    this.prune(at);
    if (this.turns.length < this.limit) {
      this.turns.push(at);
      return { allowed: true, announce: false, used: this.turns.length, limit: this.limit };
    }
    // Announce once per window. The window starts at the OLDEST counted turn, so
    // a Buddy that stays over the ceiling for an hour says so once, not once per
    // dropped message.
    const windowStart = this.turns[0];
    const announce = this.announcedAt === undefined || this.announcedAt < windowStart;
    if (announce) this.announcedAt = at;
    return { allowed: false, announce, used: this.turns.length, limit: this.limit };
  }

  /** When the oldest counted turn leaves the window, as an ISO instant. */
  resumesAt(): string {
    const oldest = this.turns[0];
    return new Date((oldest ?? this.now()) + WINDOW_MS).toISOString();
  }

  private prune(at: number): void {
    const cutoff = at - WINDOW_MS;
    while (this.turns.length > 0 && this.turns[0] <= cutoff) this.turns.shift();
  }
}
