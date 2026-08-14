// bridge/runtime-adapter — the three names Buddy uses to reach ANY agent runtime.
//
// This is the TypeScript half of `host/runtime/runtime-seam.sh`. The shell half
// writes the values into the unit's EnvironmentFile; this half reads them out of
// the process environment. One contract, two languages, and the names are the
// same in both because a seam whose two ends spell it differently is not a seam.
//
// ADR-077 PRECEDENCE, applied to naming. Upstream documentation wins over our
// contract, our contract wins over our invention:
//
//   OURS, therefore named after the ROLE      AGENT_RUNTIME_URL
//                                             AGENT_RUNTIME_KEY
//                                             AGENT_RUNTIME_SESSION_HEADER
//   UPSTREAM's, therefore verbatim            the VALUE of the session header
//                                             defaults to `X-Hermes-Session-Id`,
//                                             which is what Hermes accepts today
//
// That split is the whole trick: the knob is ours and neutral, the value in it
// is upstream's and honest. Swapping the runtime is then an edit of one value in
// one file, not a rename across four running hosts.
//
// LEGACY ALIASES ARE READ, NEVER WRITTEN. `HERMES_API_URL` / `HERMES_API_KEY`
// were the archive's names. A host installed from that lane still starts. But
// an environment carrying BOTH names with DIFFERENT values FAILS CLOSED rather
// than letting the reader rank them: two names for one value is a transition aid
// only while it is one value. The moment they differ, half the components dial
// one endpoint with one bearer and half dial another — and the symptom (a Buddy
// that stops answering, or worse, one that answers out of a stale runtime) says
// nothing at all about the cause.
//
// COVERAGE BOUNDARY of this file: it decides WHICH endpoint and WHICH bearer.
// Whether the runtime at that endpoint honours K1-K6 is the runtime's behaviour
// and is proved elsewhere — the wire test in `tests/bridge/system-message.test.ts`
// proves K3 reaches the request; only a live runtime proves it is obeyed.

/** The canonical, runtime-neutral keys. `host/runtime/runtime-seam.sh` writes these. */
export const AGENT_RUNTIME_URL_KEY = "AGENT_RUNTIME_URL";
export const AGENT_RUNTIME_KEY_KEY = "AGENT_RUNTIME_KEY";
export const AGENT_RUNTIME_SESSION_HEADER_KEY = "AGENT_RUNTIME_SESSION_HEADER";

/**
 * The header Hermes accepts today. It is a DEFAULT, not a constant: K4 says the
 * caller assigns the conversation identity and the runtime honours it across
 * turns, and it says the header NAME is configuration. A bridge that dials the
 * right URL with the wrong header name is the nastiest failure in this file —
 * the runtime answers, nothing errors, and Buddy simply forgets the conversation
 * between every two messages.
 */
export const AGENT_RUNTIME_SESSION_HEADER_DEFAULT = "X-Hermes-Session-Id";

/** Names accepted on READ from a host installed by the archive lane. Never written. */
export const LEGACY_URL_KEY = "HERMES_API_URL";
export const LEGACY_KEY_KEY = "HERMES_API_KEY";
/** Upstream's own name for the same secret inside the gateway EnvironmentFile. */
export const UPSTREAM_KEY_KEY = "API_SERVER_KEY";

export type RuntimeEnvironment = Record<string, string | undefined>;

export interface RuntimeSeam {
  url: string;
  key: string;
  sessionHeader: string;
  /** The model name the runtime is asked for. Upstream's vocabulary, so a value we pass through. */
  model: string;
  /**
   * Which spelling actually supplied the endpoint. Operator-facing telemetry: a
   * host still running on the legacy alias should be visible without reading the
   * EnvironmentFile, and a legacy name that nothing writes any more will
   * otherwise survive for years because it keeps working.
   */
  urlFrom: typeof AGENT_RUNTIME_URL_KEY | typeof LEGACY_URL_KEY;
  keyFrom:
    | typeof AGENT_RUNTIME_KEY_KEY
    | typeof LEGACY_KEY_KEY
    | typeof UPSTREAM_KEY_KEY;
}

function trimmed(env: RuntimeEnvironment, key: string): string {
  return (env[key] ?? "").trim();
}

/**
 * Resolve one value from a canonical name and its aliases.
 *
 * Returns the value and the name that supplied it. Throws when two names carry
 * DIFFERENT non-empty values — see the header. The refusal names both keys,
 * never their values: this function handles a bearer token.
 */
export function resolveAliased(
  env: RuntimeEnvironment,
  canonical: string,
  aliases: readonly string[],
): { value: string; from: string } {
  const seen: Array<{ key: string; value: string }> = [];
  for (const key of [canonical, ...aliases]) {
    const value = trimmed(env, key);
    if (value) seen.push({ key, value });
  }
  if (seen.length === 0) return { value: "", from: canonical };
  const distinct = new Set(seen.map((entry) => entry.value));
  if (distinct.size > 1) {
    throw new Error(
      `the environment carries DIFFERENT values for ${seen
        .map((entry) => entry.key)
        .join(" and ")}. The components reading the two names would not be ` +
        "talking to the same agent runtime; fix the host env file so exactly " +
        `one value is declared (the canonical name is ${canonical}).`,
    );
  }
  return { value: seen[0]!.value, from: seen[0]!.key };
}

/**
 * Read the whole runtime seam out of an environment, or throw with a remedy.
 *
 * Fail-closed on purpose: a bridge with no runtime endpoint is a Buddy that
 * hears and cannot answer, which from the chat window is indistinguishable from
 * a Buddy that is thinking.
 */
export function readRuntimeSeam(env: RuntimeEnvironment): RuntimeSeam {
  const url = resolveAliased(env, AGENT_RUNTIME_URL_KEY, [LEGACY_URL_KEY]);
  const key = resolveAliased(env, AGENT_RUNTIME_KEY_KEY, [
    LEGACY_KEY_KEY,
    UPSTREAM_KEY_KEY,
  ]);
  if (!url.value) {
    throw new Error(
      `${AGENT_RUNTIME_URL_KEY} is not set. The Hermes seam mirrors it into the ` +
        "host env file (host/runtime/hermes/gateway-env.sh); the bridge install " +
        "seam copies it into the unit's EnvironmentFile.",
    );
  }
  if (!key.value) {
    throw new Error(
      `${AGENT_RUNTIME_KEY_KEY} is not set. It is the one generated gateway ` +
        `secret, written under ${UPSTREAM_KEY_KEY} for upstream and under ` +
        `${AGENT_RUNTIME_KEY_KEY} for us — one value, two names, never two secrets.`,
    );
  }
  const header =
    trimmed(env, AGENT_RUNTIME_SESSION_HEADER_KEY) ||
    AGENT_RUNTIME_SESSION_HEADER_DEFAULT;
  // A header name is an HTTP token. A value with a space or a colon in it would
  // be silently mangled or rejected by fetch, and the symptom would be K4 quietly
  // not holding — so it is refused here, where the remedy is one env line.
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) {
    throw new Error(
      `${AGENT_RUNTIME_SESSION_HEADER_KEY}=${header} is not a valid HTTP header ` +
        "name. A malformed header name means the runtime never receives the " +
        "session id and Buddy starts a new conversation on every message (K4).",
    );
  }
  return {
    url: url.value,
    key: key.value,
    sessionHeader: header,
    // Upstream's default profile name. Hermes routes on the profile, not on a
    // model catalogue, so this is a pass-through value and not a choice we make.
    model: trimmed(env, "AGENT_RUNTIME_MODEL") || trimmed(env, "HERMES_MODEL") || "hermes",
    urlFrom: url.from as RuntimeSeam["urlFrom"],
    keyFrom: key.from as RuntimeSeam["keyFrom"],
  };
}
