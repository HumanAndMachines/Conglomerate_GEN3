const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error(`Hosted app navigation for ${appId} is not an absolute URL.`);
    }
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== "/"
    ) {
      throw new Error(`Hosted app navigation for ${appId} must be a clean HTTP(S) origin.`);
    }
    urls.set(appId, url.toString());
  }
  return urls;
}

export function projectHostedAppUrl(app, hostedAppUrls) {
  const hostedUrl = hostedAppUrls.get(app?.id);
  if (!hostedUrl || typeof app?.url !== "string") return app;
  return {
    ...app,
    url: hostedUrl,
    runtime: app.runtime && typeof app.runtime === "object"
      ? { ...app.runtime, ...(app.runtime.url ? { url: hostedUrl } : {}) }
      : app.runtime,
  };
}

export function projectHostedRuntimePayload(payload, appId, hostedAppUrls) {
  const hostedUrl = hostedAppUrls.get(appId);
  if (!hostedUrl || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...payload,
    ...(payload.url ? { url: hostedUrl } : {}),
    runtime: payload.runtime && typeof payload.runtime === "object"
      ? { ...payload.runtime, ...(payload.runtime.url ? { url: hostedUrl } : {}) }
      : payload.runtime,
  };
}
