const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const teamIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const moduleLeaseKeyPattern = /^[^/\s]+\/[^/\s]+$/;
const dnsLabelPattern = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const dnsHostPattern = `(?=[a-z0-9.-]*[a-z])${dnsLabelPattern}(?:\\.${dnsLabelPattern})*`;
const ipv4OctetPattern = "(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])";
const ipv4HostPattern = `${ipv4OctetPattern}(?:\\.${ipv4OctetPattern}){3}`;
const tcpPortPattern = "(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
const hostedOriginLexicalPattern = new RegExp(
  `^https://(?:${dnsHostPattern}|${ipv4HostPattern})(?::${tcpPortPattern})?/$`,
);

export class HostedAppUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostedAppUrlError";
    this.code = code;
    this.status = 409;
  }
}

export function parseWorkspaceProfile(rawValue) {
  const profile = String(rawValue ?? "local").trim().toLowerCase() || "local";
  if (!["local", "hosted"].includes(profile)) {
    throw new Error("LAZURIO_WORKSPACE_PROFILE must be local or hosted.");
  }
  return profile;
}

export function createHostedAppUrlAdapter({
  profile = "local",
  expectedTeamId = "",
  serviceCatalogJson = "",
  compatibilityUrlsJson = "",
} = {}) {
  const normalizedProfile = parseWorkspaceProfile(profile);
  if (normalizedProfile === "local") {
    return { profile: "local", source: "local-loopback", team_id: null, services: new Map() };
  }
  if (!teamIdPattern.test(expectedTeamId)) {
    throw new Error("LAZURIO_TEAM_ID is required for the hosted Workspace profile.");
  }
  const hasCatalog = typeof serviceCatalogJson === "string" && serviceCatalogJson.trim() !== "";
  const hasCompatibilityMap = typeof compatibilityUrlsJson === "string" && compatibilityUrlsJson.trim() !== "";
  if (hasCatalog && hasCompatibilityMap) {
    throw new Error("Hosted Launchpad accepts one URL authority: use LAZURIO_TEAM_SERVICE_CATALOG_JSON and remove the compatibility map.");
  }
  if (hasCatalog) {
    const catalog = parseTeamServiceCatalogJson(serviceCatalogJson);
    if (catalog.team_id !== expectedTeamId) {
      throw new Error(`Team service catalog is for ${catalog.team_id}, expected ${expectedTeamId}.`);
    }
    return catalog;
  }
  const compatibilityUrls = parseHostedAppUrlsJson(compatibilityUrlsJson);
  return {
    profile: "hosted",
    source: hasCompatibilityMap ? "compatibility-injected-map" : "missing-service-catalog",
    team_id: expectedTeamId,
    services: new Map([...compatibilityUrls].map(([appId, externalOrigin]) => [appId, {
      app_id: appId,
      module_lease_key: null,
      external_origin: externalOrigin,
    }])),
  };
}

export function parseTeamServiceCatalogJson(rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("LAZURIO_TEAM_SERVICE_CATALOG_JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LAZURIO_TEAM_SERVICE_CATALOG_JSON must be a JSON object.");
  }
  const allowedRootKeys = new Set(["schema_version", "team_id", "generated_at", "services"]);
  if (Object.keys(parsed).some((key) => !allowedRootKeys.has(key))) {
    throw new Error("Team service catalog contains an unknown property.");
  }
  if (parsed.schema_version !== "lazurio.team_service_catalog.v1") {
    throw new Error("Team service catalog schema_version must be lazurio.team_service_catalog.v1.");
  }
  if (!teamIdPattern.test(parsed.team_id ?? "")) {
    throw new Error("Team service catalog team_id is invalid.");
  }
  if (!isRfc3339(parsed.generated_at)) throw new Error("Team service catalog generated_at must be RFC3339.");
  if (!Array.isArray(parsed.services)) throw new Error("Team service catalog services must be an array.");

  const services = new Map();
  for (const service of parsed.services) {
    const allowedServiceKeys = new Set(["app_id", "module_lease_key", "external_origin"]);
    if (!service || typeof service !== "object" || Array.isArray(service)
      || Object.keys(service).some((key) => !allowedServiceKeys.has(key))) {
      throw new Error("Team service catalog contains an invalid service record.");
    }
    if (!appIdPattern.test(service.app_id ?? "")) throw new Error("Team service catalog app_id is invalid.");
    if (!moduleLeaseKeyPattern.test(service.module_lease_key ?? "")) {
      throw new Error(`Team service catalog module_lease_key for ${service.app_id} is invalid.`);
    }
    if (services.has(service.app_id)) throw new Error(`Team service catalog duplicates app_id ${service.app_id}.`);
    services.set(service.app_id, {
      app_id: service.app_id,
      module_lease_key: service.module_lease_key,
      external_origin: normalizeHostedOrigin(service.app_id, service.external_origin),
    });
  }
  return {
    profile: "hosted",
    source: "team-service-catalog",
    team_id: parsed.team_id,
    generated_at: parsed.generated_at,
    services,
  };
}

// Compatibility seam for PR #104 and staged infrastructure. It is consulted
// only when the canonical generated Team service catalog is absent.
export function parseHostedAppUrlsJson(rawValue) {
  if (typeof rawValue !== "string" || rawValue.trim() === "") return new Map();
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("LAUNCHPAD_HOSTED_APP_URLS_JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LAUNCHPAD_HOSTED_APP_URLS_JSON must be a JSON object.");
  }
  const urls = new Map();
  for (const [appId, candidate] of Object.entries(parsed)) {
    if (!appIdPattern.test(appId) || typeof candidate !== "string") {
      throw new Error("Hosted app navigation contains an invalid app id or URL.");
    }
    urls.set(appId, normalizeHostedOrigin(appId, candidate));
  }
  return urls;
}

export function requireHostedAppUrl(app, adapter) {
  if (adapter.profile !== "hosted") return null;
  const service = hostedServiceForApp(app, adapter);
  if (!service) {
    throw new HostedAppUrlError(
      "hosted_app_url_missing",
      `Hosted service catalog has no external HTTPS origin for ${app?.id}; Launchpad will not expose loopback navigation.`,
    );
  }
  return service.external_origin;
}

export function projectHostedAppUrl(app, adapter) {
  if (adapter.profile !== "hosted") return app;
  let hostedUrl = null;
  let hostedUrlError = null;
  try {
    hostedUrl = hostedServiceForApp(app, adapter)?.external_origin ?? null;
  } catch (error) {
    hostedUrlError = error.code ?? "hosted_app_url_invalid";
  }
  return {
    ...app,
    url: hostedUrl,
    hosted_url_source: adapter.source,
    ...(hostedUrlError ? { hosted_url_error: hostedUrlError } : {}),
    runtime: app.runtime && typeof app.runtime === "object"
      ? { ...app.runtime, url: hostedUrl }
      : app.runtime,
  };
}

export function projectHostedRuntimePayload(payload, app, adapter) {
  if (adapter.profile !== "hosted" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  let hostedUrl = null;
  let hostedUrlError = null;
  try {
    hostedUrl = hostedServiceForApp(app, adapter)?.external_origin ?? null;
  } catch (error) {
    hostedUrlError = error.code ?? "hosted_app_url_invalid";
  }
  return {
    ...projectLifecycleUrls(payload, hostedUrl),
    hosted_url_source: adapter.source,
    ...(hostedUrlError ? { hosted_url_error: hostedUrlError } : {}),
  };
}

function projectLifecycleUrls(payload, hostedUrl) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const projected = {
    ...payload,
    ...(Object.hasOwn(payload, "url") ? { url: payload.url ? hostedUrl : null } : {}),
  };
  for (const key of ["runtime", "start", "started", "stop"]) {
    if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
      projected[key] = projectLifecycleUrls(payload[key], hostedUrl);
    }
  }
  return projected;
}

function hostedServiceForApp(app, adapter) {
  const service = adapter.services.get(app?.id);
  if (!service) return null;
  const discoveredLeaseKey = typeof app?.company === "string" && typeof app?.module === "string"
    ? `${app.company}/${app.module}`
    : null;
  if (!discoveredLeaseKey) {
    throw new HostedAppUrlError(
      "hosted_app_lease_unknown",
      `Hosted URL for ${app?.id} cannot be bound because discovery has no module lease identity.`,
    );
  }
  // The compatibility map predates module_lease_key. It is never allowed to
  // claim another lease: its exact app-id entry is joined to the current
  // discovery record. Canonical catalog entries must carry and match the key.
  if (service.module_lease_key !== null && service.module_lease_key !== discoveredLeaseKey) {
    throw new HostedAppUrlError(
      "hosted_app_lease_mismatch",
      `Hosted URL for ${app.id} claims ${service.module_lease_key}, expected ${discoveredLeaseKey}.`,
    );
  }
  return service;
}

function normalizeHostedOrigin(appId, candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Hosted app navigation for ${appId} is not an absolute URL.`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
  ) {
    throw new Error(`Hosted app navigation for ${appId} must be a clean HTTPS origin.`);
  }
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname === "::1"
    || hostname === "0:0:0:0:0:0:0:1"
    || /^::ffff:7f[0-9a-f]{2}:/.test(hostname)
  ) {
    throw new Error(`Hosted app navigation for ${appId} must not use a loopback origin.`);
  }
  if (!hostedOriginLexicalPattern.test(candidate)) {
    throw new Error(
      `Hosted app navigation for ${appId} must use an ASCII DNS name or canonical IPv4 host and a valid TCP port.`,
    );
  }
  return url.toString();
}

function isRfc3339(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
