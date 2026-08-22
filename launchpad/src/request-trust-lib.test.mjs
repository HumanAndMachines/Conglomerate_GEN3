import { expect, test } from "bun:test";
import { createRequestTrustPolicy } from "./request-trust-lib.mjs";

const backendUrl = new URL("http://127.0.0.1:4174/api/sync");

function request(headers = {}) {
  return new Request(backendUrl, { method: "POST", headers });
}

test("local trust accepts loopback same-origin requests and rejects foreign origins", async () => {
  const trust = createRequestTrustPolicy();
  expect(await trust.evaluateWorkspaceRequest(request(), backendUrl)).toEqual({
    trusted: true,
    reason: "trusted_local",
  });
  expect(await trust.isTrustedWorkspaceRequest(request(), backendUrl)).toBe(true);
  expect(await trust.isTrustedWorkspaceRequest(request({
    origin: backendUrl.origin,
    "sec-fetch-site": "same-origin",
  }), backendUrl)).toBe(true);
  expect(await trust.isTrustedWorkspaceRequest(request({
    origin: "https://evil.invalid",
    "sec-fetch-site": "cross-site",
  }), backendUrl)).toBe(false);
  expect(await trust.evaluateWorkspaceRequest(request({
    origin: "https://evil.invalid",
    "sec-fetch-site": "cross-site",
  }), backendUrl)).toEqual({
    trusted: false,
    reason: "local_request_rejected",
  });
});

test("hosted trust revalidates the signed OAuth session and exact gateway identity", async () => {
  const externalOrigin = "https://launchpad.management.iotorlazurio.lazurio.io";
  const authCheckUrl = "https://auth.management.iotorlazurio.lazurio.io/oauth2/auth";
  const authCookieName = "__Secure-lazurio-management-workspace";
  const authCalls = [];
  const trust = createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: externalOrigin,
    hostedAuthCheckUrl: authCheckUrl,
    hostedAuthCookieName: authCookieName,
    fetchImpl: async (url, init) => {
      authCalls.push({ url, init });
      if (init.headers.cookie !== `${authCookieName}=valid-session`) {
        return new Response(null, { status: 401 });
      }
      return new Response(null, {
        status: 202,
        headers: { "x-auth-request-user": "annavesela" },
      });
    },
  });
  const headers = {
    cookie: `launchpad-theme=dark; ${authCookieName}=valid-session; analytics-id=private`,
    origin: externalOrigin,
    "sec-fetch-site": "same-origin",
    "x-lazurio-github-login": "annavesela",
  };

  expect(await trust.isTrustedWorkspaceRequest(request(headers), backendUrl)).toBe(true);
  expect(authCalls).toHaveLength(1);
  expect(await trust.evaluateWorkspaceRequest(request(headers), backendUrl)).toEqual({
    trusted: true,
    reason: "trusted_hosted",
  });
  expect(authCalls).toHaveLength(2);
  expect(authCalls[0].url).toBe(authCheckUrl);
  expect(authCalls[0].init.redirect).toBe("manual");
  expect(authCalls[0].init.headers.cookie).toBe(`${authCookieName}=valid-session`);

  expect(await trust.isTrustedWorkspaceRequest(request(), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    origin: backendUrl.origin,
    "sec-fetch-site": "same-origin",
  }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({ ...headers, origin: "https://evil.invalid" }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({ ...headers, "sec-fetch-site": "cross-site" }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({ ...headers, "x-lazurio-github-login": "" }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({ ...headers, "x-lazurio-github-login": "not a login!" }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({ ...headers, cookie: "" }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}=`,
  }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}-lookalike=valid-session`,
  }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}=valid-session; ${authCookieName}=duplicate`,
  }), backendUrl)).toBe(false);
  expect(await trust.isTrustedWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}=forged`,
  }), backendUrl)).toBe(false);
  expect(await trust.evaluateWorkspaceRequest(request({
    ...headers,
    cookie: `${authCookieName}=forged`,
  }), backendUrl)).toEqual({
    trusted: false,
    reason: "hosted_auth_rejected",
  });
  expect(await trust.evaluateWorkspaceRequest(request({
    ...headers,
    cookie: `unrelated=value`,
  }), backendUrl)).toEqual({
    trusted: false,
    reason: "hosted_auth_cookie_missing",
  });
  expect(await trust.isTrustedWorkspaceRequest(request({
    ...headers,
    "x-lazurio-github-login": "other-user",
  }), backendUrl)).toBe(false);
});

test("hosted trust configuration fails closed", () => {
  expect(() => createRequestTrustPolicy({ profile: "hosted" })).toThrow("required");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "http://launchpad.example.test",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
  })).toThrow("clean HTTPS origin");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://127.0.0.1:4174",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
  })).toThrow("loopback");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
  })).toThrow("AUTH_CHECK_URL is required");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
    hostedAuthCheckUrl: "http://127.0.0.1:4180/oauth2/auth",
  })).toThrow("distinct clean HTTPS");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
    hostedAuthCheckUrl: "https://launchpad.example.test/oauth2/auth",
  })).toThrow("distinct clean HTTPS");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
  })).toThrow("AUTH_COOKIE_NAME is required");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://launchpad.example.test",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
    hostedAuthCookieName: "invalid cookie name",
  })).toThrow("one exact HTTP cookie name");
  expect(() => createRequestTrustPolicy({
    profile: "local",
    hostedExternalOrigin: "https://launchpad.example.test",
  })).toThrow("only in the hosted");
  expect(() => createRequestTrustPolicy({
    profile: "local",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
  })).toThrow("only in the hosted");
  expect(() => createRequestTrustPolicy({
    profile: "local",
    hostedAuthCookieName: "__Secure-lazurio-example-workspace",
  })).toThrow("only in the hosted");
});
