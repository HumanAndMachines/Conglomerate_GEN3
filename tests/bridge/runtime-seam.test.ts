// COVERS: the runtime seam's resolution rules — the canonical AGENT_RUNTIME_*
// names, the legacy HERMES_* aliases being READ, two names with different values
// failing closed, the configurable session header reaching the wire under the
// configured name, and a malformed header name being refused rather than sent.
//
// DOES NOT COVER: whether a real runtime honours the header (K4 obedience — only
// a live runtime shows that); whether the shell half
// (host/runtime/runtime-seam.sh) and this half agree at INSTALL time, which is
// the exec-ring install seam's job; and the bind itself (K2), which belongs to
// the gateway lane.

import { describe, expect, test } from "bun:test";
import {
  AGENT_RUNTIME_SESSION_HEADER_DEFAULT,
  readRuntimeSeam,
  resolveAliased,
} from "../../bridge/runtime-adapter/seam.ts";
import { createRuntimeReplyProvider } from "../../bridge/runtime-adapter/http-client.ts";
import type { BridgeReplyInput } from "../../bridge/inbound/message.ts";

const CANONICAL = {
  AGENT_RUNTIME_URL: "http://127.0.0.1:8642/v1/chat/completions",
  AGENT_RUNTIME_KEY: "runtime-bearer",
};

const JOB: BridgeReplyInput = {
  text: "ahoj",
  senderName: "Ada Lovelace",
  trigger: "direct_message",
  conversationKind: "private",
  sessionId: "buddy-zulip-private-abc123",
  messageId: 4242,
  replyTarget: { kind: "private", recipientEmails: ["ada@realm.test"] },
};

describe("the names are ours, the values are upstream's", () => {
  test("the canonical names resolve and say where they came from", () => {
    const seam = readRuntimeSeam(CANONICAL);
    expect(seam.url).toBe(CANONICAL.AGENT_RUNTIME_URL);
    expect(seam.key).toBe(CANONICAL.AGENT_RUNTIME_KEY);
    expect(seam.urlFrom).toBe("AGENT_RUNTIME_URL");
    expect(seam.keyFrom).toBe("AGENT_RUNTIME_KEY");
    // The DEFAULT is upstream's spelling; the knob holding it is ours.
    expect(seam.sessionHeader).toBe(AGENT_RUNTIME_SESSION_HEADER_DEFAULT);
    expect(seam.sessionHeader).toBe("X-Hermes-Session-Id");
  });

  test("a host installed by the archive lane still starts, and says so", () => {
    const seam = readRuntimeSeam({
      HERMES_API_URL: CANONICAL.AGENT_RUNTIME_URL,
      HERMES_API_KEY: CANONICAL.AGENT_RUNTIME_KEY,
    });
    expect(seam.url).toBe(CANONICAL.AGENT_RUNTIME_URL);
    expect(seam.urlFrom).toBe("HERMES_API_URL");
    expect(seam.keyFrom).toBe("HERMES_API_KEY");
  });

  test("upstream's own key name carries the same secret", () => {
    // One value, two names, never two generated secrets: the gateway
    // EnvironmentFile writes API_SERVER_KEY for Hermes and AGENT_RUNTIME_KEY for
    // us, and both must resolve to the one bearer.
    const seam = readRuntimeSeam({
      ...CANONICAL,
      API_SERVER_KEY: CANONICAL.AGENT_RUNTIME_KEY,
    });
    expect(seam.key).toBe(CANONICAL.AGENT_RUNTIME_KEY);
  });

  test("two names with DIFFERENT values fail closed, naming the keys and not the values", () => {
    let thrown: Error | undefined;
    try {
      readRuntimeSeam({
        AGENT_RUNTIME_URL: "http://127.0.0.1:8642/v1/chat/completions",
        HERMES_API_URL: "http://127.0.0.1:9999/v1/chat/completions",
        AGENT_RUNTIME_KEY: "k",
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("AGENT_RUNTIME_URL and HERMES_API_URL");
    // A bearer must never be quoted back. The URL is not a secret, but the same
    // code path handles the key, so the rule is the same in both.
    expect(thrown!.message).not.toContain("9999");
  });

  test("a bearer that disagrees with itself is refused without printing either half", () => {
    let thrown: Error | undefined;
    try {
      readRuntimeSeam({
        AGENT_RUNTIME_URL: CANONICAL.AGENT_RUNTIME_URL,
        AGENT_RUNTIME_KEY: "secret-alpha",
        API_SERVER_KEY: "secret-beta",
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).not.toContain("secret-alpha");
    expect(thrown!.message).not.toContain("secret-beta");
  });

  test("the resolver returns the canonical name when nothing at all is declared", () => {
    // The false path of the previous two: no value is not a conflict.
    expect(resolveAliased({}, "A", ["B"])).toEqual({ value: "", from: "A" });
  });

  test("a missing endpoint or bearer is a refusal with a remedy, never a default", () => {
    expect(() => readRuntimeSeam({ AGENT_RUNTIME_KEY: "k" })).toThrow(
      /AGENT_RUNTIME_URL is not set/,
    );
    expect(() => readRuntimeSeam({ AGENT_RUNTIME_URL: CANONICAL.AGENT_RUNTIME_URL })).toThrow(
      /AGENT_RUNTIME_KEY is not set/,
    );
  });
});

describe("K4 — the session id travels under the CONFIGURED header", () => {
  async function capture(sessionHeader?: string): Promise<Record<string, string>> {
    let headers: Record<string, string> = {};
    const provider = createRuntimeReplyProvider({
      endpoint: CANONICAL.AGENT_RUNTIME_URL,
      apiKey: "k",
      model: "hermes",
      sessionHeader,
      systemMessage: () => "a contract",
      fetchImpl: (async (_url: string, init: any) => {
        headers = init.headers as Record<string, string>;
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      }) as unknown as typeof fetch,
    });
    await provider(JOB);
    return headers;
  }

  test("the default is Hermes' own spelling", async () => {
    const headers = await capture();
    expect(headers["X-Hermes-Session-Id"]).toBe(JOB.sessionId);
  });

  test("a configured name replaces it — that is what makes the runtime swappable", async () => {
    const headers = await capture("X-Session-Id");
    expect(headers["X-Session-Id"]).toBe(JOB.sessionId);
    expect(headers["X-Hermes-Session-Id"]).toBeUndefined();
  });

  test("a header name that is not an HTTP token is refused at start-up", () => {
    // Sent instead of refused, this is the quietest bug in the lane: the runtime
    // answers, nothing errors, and Buddy starts a brand-new conversation on every
    // single message because the session id never arrived.
    expect(() =>
      readRuntimeSeam({ ...CANONICAL, AGENT_RUNTIME_SESSION_HEADER: "X Session Id" }),
    ).toThrow(/not a valid HTTP header name/);
  });
});
