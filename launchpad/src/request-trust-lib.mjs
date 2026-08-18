const localBackendHosts = new Set(["127.0.0.1", "localhost"]);
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function createRequestTrustPolicy({ profile = "local", hostedExternalOrigin = "" } = {}) {
  const normalizedProfile = String(profile ?? "local").trim().toLowerCase() || "local";
  if (normalizedProfile !== "local" && normalizedProfile !== "hosted") {
    throw new Error("Launchpad request trust profile must be local or hosted.");
  }

  const hostedOrigin = normalizedProfile === "hosted"
    ? normalizeHostedLaunchpadOrigin(hostedExternalOrigin)
    : null;
  if (normalizedProfile === "local" && String(hostedExternalOrigin ?? "").trim() !== "") {
    throw new Error("LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN is valid only in the hosted Workspace profile.");
  }

  return Object.freeze({
    profile: normalizedProfile,
    hosted_origin: hostedOrigin,
    isTrustedLocalRequest,
    isTrustedWorkspaceRequest(request, url) {
      if (isTrustedLocalRequest(request, url)) return true;
      if (normalizedProfile !== "hosted" || !localBackendHosts.has(url.hostname)) return false;

      // The hosted browser never reaches this loopback listener directly. Caddy
      // authenticates the exact GitHub Team, strips an incoming identity header,
      // and only then injects X-Lazurio-GitHub-Login into the proxied request.
      // Requiring that proof together with the catalogued public Origin keeps
      // this an adapter for the existing GitHub boundary, not a second ACL.
      const login = request.headers.get("x-lazurio-github-login") ?? "";
      return request.headers.get("sec-fetch-site") === "same-origin"
        && request.headers.get("origin") === hostedOrigin
        && githubLoginPattern.test(login);
    },
  });
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
