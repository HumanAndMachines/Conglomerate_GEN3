// bridge/runtime-adapter — the client that speaks K1-K6 to whatever agent
// runtime this host runs. Hermes today; the contract is
// `docs/agent-runtime-contract.md` and it is deliberately not Hermes-shaped.
//
// WHICH CLAUSE LIVES WHERE, so a future runtime swap knows what to re-verify:
//
//   K1  OpenAI-shaped chat endpoint     `POST <url>`, `choices[0].message.content`
//   K2  bearer on a private bind        `Authorization: Bearer …`; the bind itself
//                                       is the gateway's business, asserted in
//                                       `host/runtime/hermes/gateway-env.sh`
//   K3  the system message LAYERS       one `{role:"system"}` message ahead of the
//                                       Principal's text, assembled per turn
//   K4  caller-supplied session id      sent under a CONFIGURABLE header name
//   K5  MCP over stdio                  not this file's job — the runtime's own
//                                       config; gbrain is reached by the runtime
//   K6  runtime is no system of record  not this file's job either, but it is why
//                                       nothing here caches a conversation
//
// K3 IS FAIL-CLOSED HERE, AND THAT IS A DELIBERATE STRENGTHENING OF THE ARCHIVE.
// The archive sent the Principal's text with no system message when no profile
// was declared, so a Buddy could take every turn of its life with neither
// CONSTITUTION.md nor MANDATES.md in front of it while every log stayed green
// (scar R7). ARCHITECTURE §2.6 says the contract is read in EVERY turn. A turn
// with no contract is therefore not a degraded turn, it is not a turn: this
// client refuses to send it.
//
// PRIVACY. The assembled contract is the Principal's own accepted document. It
// is sent to the Principal's own runtime on the Principal's own host and NOWHERE
// else: it never enters a log line, an error message, delivery telemetry or
// lifecycle evidence. That promise is structural rather than editorial, because
// every line this lane emits is built only from the closed vocabularies in
// `bridge/telemetry/delivery-log.ts`.

import type {
  BridgeReplyInput,
  BridgeReplyProvider,
} from "../inbound/message.ts";
import {
  DeliveryHopError,
  classifyHttpStatus,
  classifyTransportFailure,
  hopHostname,
} from "../telemetry/delivery-log.ts";
import { AGENT_RUNTIME_SESSION_HEADER_DEFAULT } from "./seam.ts";

interface RuntimeChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export interface RuntimeClientConfig {
  /** K1 — the chat endpoint. */
  endpoint: string;
  /** K2 — the bearer. Never logged, never thrown, never part of an error. */
  apiKey: string;
  /** Upstream's model/profile name. A pass-through value. */
  model: string;
  /** K4 — the header the session id travels in. Configuration, not a constant. */
  sessionHeader?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Resolve an authenticated private Zulip image to a data URL. */
  loadImage?: (url: string) => Promise<string>;
  /**
   * K3 — the moral contract, assembled PER TURN by `bridge/agency/system-message.ts`.
   *
   * It is a function and not a string because two of its inputs change between
   * turns: who is writing, and what day it is. A bridge that has been up since
   * Tuesday must not still be telling the runtime it is Tuesday.
   *
   * Returning null is a REFUSAL, not a fallback — see the header.
   */
  systemMessage: (input: BridgeReplyInput) => string | null;
}

function normalizedEndpoint(value: string): string {
  // Both throws carry `refusing to start:` because a malformed endpoint is
  // configuration, not weather — it routes to exit 78 (scar R10), where a bare
  // TypeError from `new URL` would read as transient and restart for ever.
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(
      "refusing to start: AGENT_RUNTIME_URL is not a parseable URL " +
        "(the value itself is withheld from this message on purpose)",
    );
  }
  if (!/^https?:$/.test(endpoint.protocol)) {
    throw new Error("refusing to start: the agent runtime endpoint must use HTTP or HTTPS");
  }
  return endpoint.toString();
}

/**
 * Thin, fail-closed client for the runtime's authenticated OpenAI-compatible
 * API. Request bodies and replies are deliberately absent from errors and logs.
 */
export function createRuntimeReplyProvider(
  config: RuntimeClientConfig,
): BridgeReplyProvider {
  const endpoint = normalizedEndpoint(config.endpoint);
  // Kept for the resolver probe that separates a `dns` failure from a `connect`
  // failure on this hop. It is never logged and never enters an error message.
  const endpointHostname = hopHostname(endpoint);
  if (!config.apiKey.trim()) throw new Error("The agent runtime API key is required");
  if (!config.model.trim()) throw new Error("The agent runtime model is required");
  const sessionHeader =
    config.sessionHeader?.trim() || AGENT_RUNTIME_SESSION_HEADER_DEFAULT;
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 120_000;

  return async (input: BridgeReplyInput): Promise<string> => {
    const { text, sessionId } = input;
    let userContent: string | Array<Record<string, unknown>> = text;
    if (input.imageUrls?.length) {
      if (!config.loadImage) {
        throw new DeliveryHopError(
          "runtime",
          "unknown",
          "agent runtime image loader is not configured",
        );
      }
      const dataUrls = await Promise.all(input.imageUrls.map(config.loadImage));
      userContent = [
        ...(text ? [{ type: "text", text }] : []),
        ...dataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
      ];
    }
    // Assembled here, sent, and then dropped. It is the Principal's own accepted
    // document; it is never held for a log line, an error or evidence.
    const preamble = config.systemMessage(input)?.trim() || null;
    if (!preamble) {
      // K3, fail-closed. The message is content-free and names the remedy: this
      // string reaches the operator's journal and, through the dead-letter
      // notice, the person waiting in the chat window.
      throw new DeliveryHopError(
        "runtime",
        "unknown",
        "refusing to take a turn with no moral contract: the assembled system " +
          "message is empty, so CONSTITUTION.md and MANDATES.md would not be in " +
          "front of this turn (ARCHITECTURE §2.6). Check BUDDY_PROFILE_DIR.",
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          // K4. The NAME is configuration; the value is ours to assign, and it
          // is derived from immutable Zulip ids (bridge/inbound/message.ts).
          [sessionHeader]: sessionId,
        },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          // K3 — LAYERED, never merged: one system message, then the
          // Principal's text, in that order. The runtime adds its own system
          // prompt underneath; it does not replace ours and we do not replace
          // its.
          messages: [
            { role: "system", content: preamble },
            { role: "user", content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DeliveryHopError(
        "runtime",
        await classifyTransportFailure(error, endpointHostname),
        "agent runtime request failed",
      );
    }

    if (!response.ok) {
      throw new DeliveryHopError(
        "runtime",
        classifyHttpStatus(response.status),
        `agent runtime returned HTTP ${response.status}`,
      );
    }
    let payload: RuntimeChatResponse;
    try {
      payload = (await response.json()) as RuntimeChatResponse;
    } catch {
      // The hop itself succeeded; the body did not. That is not one of the
      // network/auth/HTTP classes, so it is reported honestly as `unknown`
      // rather than folded into a class an operator would act on.
      throw new DeliveryHopError(
        "runtime",
        "unknown",
        "agent runtime returned invalid JSON",
      );
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new DeliveryHopError(
        "runtime",
        "unknown",
        "agent runtime returned no reply content",
      );
    }
    return content;
  };
}

