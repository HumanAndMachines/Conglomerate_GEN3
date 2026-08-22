const localBackendHosts = new Set(["127.0.0.1", "localhost"]);
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const maxHostedCookieHeaderBytes = 16 * 1024;
const maxHostedCookieNameBytes = 256;
const hostedAuthCheckTimeoutMs = 2_000;

export function createRequestTrustPolicy({
  profile = "local",
  hostedExternalOrigin = "",
  hostedAuthCheckUrl = "",
  hostedAuthCookieName = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedProfile = String(profile ?? "local").trim().toLowerCase() || "local";
  if (normalizedProfile !== "local" && normalizedProfile !== "hosted") {
    throw new Error("Launchpad request trust profile must be local or hosted.");
  }

  const hostedOrigin = normalizedProfile === "hosted"
    ? normalizeHostedLaunchpadOrigin(hostedExternalOrigin)
    : null;
  const hostedAuthUrl = normalizedProfile === "hosted"
    ? normalizeHostedAuthCheckUrl(hostedAuthCheckUrl, hostedOrigin)
    : null;
  const hostedCookieName = normalizedProfile === "hosted"
    ? normalizeHostedAuthCookieName(hostedAuthCookieName)
    : null;
  if (normalizedProfile === "local" && String(hostedExternalOrigin ?? "").trim() !== "") {
    throw new Error("LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN is valid only in the hosted Workspace profile.");
  }
  if (normalizedProfile === "local" && String(hostedAuthCheckUrl ?? "").trim() !== "") {
    throw new Error("LAZURIO_LAUNCHPAD_AUTH_CHECK_URL is valid only in the hosted Workspace profile.");
  }
  if (normalizedProfile === "local" && String(hostedAuthCookieName ?? "").trim() !== "") {
    throw new Error("LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME is valid only in the hosted Workspace profile.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Launchpad hosted auth verifier requires a fetch implementation.");
  }

  async function evaluateWorkspaceRequest(request, url) {
    if (normalizedProfile === "local") {
      const trusted = isTrustedLocalRequest(request, url);
      return trustDecision(
        trusted,
        trusted ? "trusted_local" : "local_request_rejected",
      );
    }
    if (!localBackendHosts.has(url.hostname)) {
      return trustDecision(false, "hosted_backend_not_loopback");
    }

    // The hosted browser never reaches this loopback listener directly. Caddy
    // authenticates the exact GitHub Team, strips an incoming identity header,
    // and only then injects X-Lazurio-GitHub-Login into the proxied request.
    // A local workspace process can forge those transport headers, so they are
    // only routing invariants. Authorization is independently revalidated
    // over a separately authenticated TLS route against oauth2-proxy with
    // the browser's signed HttpOnly session cookie.
    const login = request.headers.get("x-lazurio-github-login") ?? "";
    if (request.headers.get("sec-fetch-site") !== "same-origin") {
      return trustDecision(false, "hosted_fetch_site_mismatch");
    }
    if (request.headers.get("origin") !== hostedOrigin) {
      return trustDecision(false, "hosted_origin_mismatch");
    }
    if (!githubLoginPattern.test(login)) {
      return trustDecision(false, "hosted_gateway_login_invalid");
    }

    const cookieSelection = selectHostedAuthCookie(
      request.headers.get("cookie") ?? "",
      hostedCookieName,
    );
    if (!cookieSelection.cookie) {
      return trustDecision(false, cookieSelection.reason);
    }

    try {
      const authResponse = await fetchImpl(hostedAuthUrl, {
        method: "GET",
        headers: { cookie: cookieSelection.cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(hostedAuthCheckTimeoutMs),
      });
      const authorizedLogin = authResponse.headers.get("x-auth-request-user") ?? "";
      if (authResponse.status < 200 || authResponse.status >= 300) {
        return trustDecision(false, "hosted_auth_rejected");
      }
      if (authorizedLogin !== login) {
        return trustDecision(false, "hosted_auth_identity_mismatch");
      }
      return trustDecision(true, "trusted_hosted");
    } catch {
      return trustDecision(false, "hosted_auth_unavailable");
    }
  }

  return Object.freeze({
    profile: normalizedProfile,
    hosted_origin: hostedOrigin,
    hosted_auth_check_url: hostedAuthUrl,
    isTrustedLocalRequest,
    evaluateWorkspaceRequest,
    async isTrustedWorkspaceRequest(request, url) {
      const decision = await evaluateWorkspaceRequest(request, url);
      return decision.trusted;
    },
  });
}

function trustDecision(trusted, reason) {
  return Object.freeze({ trusted, reason });
}

export function isTrustedLocalRequest(request, url) {
  if (!localBackendHosts.has(url.hostname)) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  if (origin && origin !== url.origin) return false;
  return true;
}

function normalizeHostedLaunchpadOrigin(rawValue) {
  const candidate = String(rawValue ?? "").trim();
  if (!candidate) {
    throw new Error("LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN is required for the hosted Workspace profile.");
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN must be an absolute HTTPS origin.");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
    || (candidate !== url.origin && candidate !== `${url.origin}/`)
  ) {
    throw new Error("LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN must be a clean HTTPS origin.");
  }
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname === "::1"
    || hostname === "0:0:0:0:0:0:0:1"
  ) {
    throw new Error("LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN must not use a loopback host.");
  }
  return url.origin;
}

function normalizeHostedAuthCheckUrl(rawValue, hostedOrigin) {
  const candidate = String(rawValue ?? "").trim();
  if (!candidate) {
    throw new Error("LAZURIO_LAUNCHPAD_AUTH_CHECK_URL is required for the hosted Workspace profile.");
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("LAZURIO_LAUNCHPAD_AUTH_CHECK_URL must be an absolute HTTPS URL.");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/oauth2/auth"
    || candidate !== url.href
    || url.origin === hostedOrigin
  ) {
    throw new Error(
      "LAZURIO_LAUNCHPAD_AUTH_CHECK_URL must be a distinct clean HTTPS /oauth2/auth endpoint.",
    );
  }
  return url.href;
}

function normalizeHostedAuthCookieName(rawValue) {
  const candidate = String(rawValue ?? "").trim();
  if (!candidate) {
    throw new Error("LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME is required for the hosted Workspace profile.");
  }
  if (
    candidate !== rawValue
    || Buffer.byteLength(candidate, "utf8") > maxHostedCookieNameBytes
    || !cookieNamePattern.test(candidate)
  ) {
    throw new Error("LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME must be one exact HTTP cookie name.");
  }
  return candidate;
}

function selectHostedAuthCookie(rawHeader, expectedName) {
  if (!rawHeader) {
    return { cookie: null, reason: "hosted_auth_cookie_missing" };
  }
  if (Buffer.byteLength(rawHeader, "utf8") > maxHostedCookieHeaderBytes) {
    return { cookie: null, reason: "hosted_auth_cookie_invalid" };
  }

  let selected = null;
  for (const rawPair of rawHeader.split(";")) {
    const pair = rawPair.trim();
    const separator = pair.indexOf("=");
    if (separator <= 0 || pair.slice(0, separator).trim() !== expectedName) continue;
    const value = pair.slice(separator + 1).trim();
    if (!value || selected !== null) {
      return { cookie: null, reason: "hosted_auth_cookie_invalid" };
    }
    selected = `${expectedName}=${value}`;
  }
  return selected
    ? { cookie: selected, reason: "hosted_auth_cookie_selected" }
    : { cookie: null, reason: "hosted_auth_cookie_missing" };
}
