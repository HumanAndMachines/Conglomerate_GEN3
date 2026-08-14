// bridge/telemetry — the content-free delivery state machine of the Buddy bridge.
//
// WHY THIS EXISTS (Host #1, 2026-07-25/26). A reply crossed four hops —
// Zulip → Smokescreen → bridge → agent runtime → back into Zulip — and the only
// operational evidence the bridge produced when the LAST hop failed was a single
// line: "durable reply delivery deferred". That line says a hop failed. It does
// not say WHICH hop, and it does not say WHY, so the outage cost a four-hop
// manual hunt instead of a two-minute read.
//
// The replacement is deliberately two-dimensional and nothing else:
//
//   1. WHERE the delivery got to — an ordered STATE:
//        received → generating → generated → delivering → delivered
//   2. WHEN it fails — the HOP that failed and the ERROR CLASS of that hop:
//        hop:   runtime | zulip
//        class: dns | connect | tls | auth | http_4xx | http_5xx | unknown
//
// `queued` USED TO SIT BETWEEN received AND generating, and it is gone on
// purpose rather than by neglect. It meant one specific event: the bridge had
// persisted the job and was answering Zulip's outgoing webhook with
// `{"response_not_required": true}`, opting out of the 10-second webhook
// deadline. There is no webhook and no deadline any more — Buddy polls — so
// there is no moment between "durably recorded" and "working on it" for that
// state to name. Keeping it would have meant emitting a state that no longer
// corresponds to anything, which is the same defect as a check that reports PASS
// because nobody looked.
//
// PRIVACY IS STRUCTURAL, NOT EDITORIAL. Every emitted line is built ONLY from
// the closed vocabularies below; `safeToken` refuses anything that is not a
// member. A URL, a message body, a bot email, an API key or a hostname cannot
// reach a log line even if a future caller passes one in by mistake. This
// matters concretely: Bun's own TLS errors embed the full request URL in
// `error.message` (measured: ERR_TLS_CERT_ALTNAME_INVALID), so error text is
// never forwarded — only the class derived from it.

import { lookup } from "node:dns/promises";

/** The ordered delivery states. A happy path emits all five, in this order. */
export const DELIVERY_STATES = [
  "received",
  "generating",
  "generated",
  "delivering",
  "delivered",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * The two outbound hops a REPLY crosses. The bridge's third dial — the event
 * long-poll it uses to hear at all — is not one of them: if that fails there is
 * no job here to report on, and the poller reports it as its own state.
 */
export const DELIVERY_HOPS = ["runtime", "zulip"] as const;

export type DeliveryHop = (typeof DELIVERY_HOPS)[number];

/**
 * The error classes an operator can act on. `unknown` is honest, not a bucket
 * for laziness: it means the hop completed at the transport level and failed
 * for a reason that is not one of the classes above (e.g. an unparseable body).
 */
export const DELIVERY_ERROR_CLASSES = [
  "dns",
  "connect",
  "tls",
  "auth",
  "http_4xx",
  "http_5xx",
  "unknown",
] as const;

export type DeliveryErrorClass = (typeof DELIVERY_ERROR_CLASSES)[number];

/** A hop failure that already knows its own class. Its message stays content-free. */
export class DeliveryHopError extends Error {
  readonly hop: DeliveryHop;
  readonly errorClass: DeliveryErrorClass;

  constructor(hop: DeliveryHop, errorClass: DeliveryErrorClass, message: string) {
    super(message);
    this.name = "DeliveryHopError";
    this.hop = hop;
    this.errorClass = errorClass;
  }
}

/** The class carried by a hop error, or `unknown` for anything else. */
export function hopErrorClass(error: unknown): DeliveryErrorClass {
  return error instanceof DeliveryHopError ? error.errorClass : "unknown";
}

function safeToken<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** `[inbound] delivery state=<state>` — the only shape a state line ever has. */
export function deliveryStateLine(state: DeliveryState): string {
  return `[inbound] delivery state=${safeToken(state, DELIVERY_STATES, "received")}`;
}

/** `[inbound] delivery failed hop=<hop> class=<class>` — no URL, no content. */
export function deliveryFailureLine(
  hop: DeliveryHop,
  errorClass: DeliveryErrorClass,
): string {
  return (
    `[inbound] delivery failed hop=${safeToken(hop, DELIVERY_HOPS, "runtime")}` +
    ` class=${safeToken(errorClass, DELIVERY_ERROR_CLASSES, "unknown")}`
  );
}

/**
 * HTTP status → class. 401/403 are the bridge's own credentials being wrong
 * (bot API key, agent-runtime API key); 407 is a proxy refusing the bridge, which is
 * the same operator action: fix the authorization, not the network.
 */
export function classifyHttpStatus(status: number): DeliveryErrorClass {
  if (status === 401 || status === 403 || status === 407) return "auth";
  if (status >= 400 && status < 500) return "http_4xx";
  if (status >= 500 && status < 600) return "http_5xx";
  return "unknown";
}

const DNS_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EAI_NODATA",
  "EAI_FAIL",
  "ERR_DNS",
  "DNSException",
  "ERR_NAME_NOT_RESOLVED",
]);

const TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "HOSTNAME_MISMATCH",
]);

function isTlsCode(code: string): boolean {
  return (
    TLS_CODES.has(code) ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("CERT_")
  );
}

/** Codes of the error and of its `cause` chain, as strings. Messages are ignored. */
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Object; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

export type HostnameProbe = (hostname: string) => Promise<boolean>;

/**
 * Ask this host's own resolver whether the hop's hostname resolves at all.
 * This is the ONLY honest way to separate `dns` from `connect` on this runtime:
 * Bun 1.3.14 reports an NXDOMAIN fetch and a refused connection with the SAME
 * `ConnectionRefused` code (measured 2026-07-26).
 *
 * A resolver that never answers IS a DNS fault, so a timed-out probe is `false`.
 * The hostname is used here and never logged.
 */
export async function resolvesOnThisHost(
  hostname: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  if (!hostname) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Classify a thrown transport failure of one hop. TLS is decided from the error
 * code; DNS vs connect is decided by probing the resolver (see above).
 *
 * KNOWN AND ACCEPTED: the probe answers "does this name resolve NOW", not "did
 * it resolve for the request that just failed". A resolver outage that heals in
 * the millisecond between the two therefore reads as `connect`. There is no
 * better signal on this runtime — Bun does not surface the resolution outcome
 * of a failed fetch, and resolving up-front would add a lookup to every healthy
 * request and still race. The class is a HINT; the load-bearing evidence is the
 * state and the hop, which are positional and cannot be wrong.
 */
export async function classifyTransportFailure(
  error: unknown,
  hostname: string,
  resolves: HostnameProbe = (name) => resolvesOnThisHost(name),
): Promise<DeliveryErrorClass> {
  const codes = errorCodes(error);
  if (codes.some(isTlsCode)) return "tls";
  if (codes.some((code) => DNS_CODES.has(code))) return "dns";
  return (await resolves(hostname)) ? "connect" : "dns";
}

/** The hostname of a hop target, for the resolver probe only. Never logged. */
export function hopHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
