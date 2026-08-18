import { expect, test } from "bun:test";
import { createRequestTrustPolicy } from "./request-trust-lib.mjs";

const backendUrl = new URL("http://127.0.0.1:4174/api/sync");

function request(headers = {}) {
  return new Request(backendUrl, { method: "POST", headers });
}

test("local trust accepts loopback same-origin requests and rejects foreign origins", async () => {
  const trust = createRequestTrustPolicy();
  expect(await trust.isTrustedWorkspaceRequest(request(), backendUrl)).toBe(true);
  expect(await trust.isTrustedWorkspaceRequest(request({
    origin: backendUrl.origin,
    "sec-fetch-site": "same-origin",
  }), backendUrl)).toBe(true);
  expect(await trust.isTrustedWorkspaceRequest(request({
    origin: "https://evil.invalid",
    "sec-fetch-site": "cross-site",
  }), backendUrl)).toBe(false);
});

test("hosted trust revalidates the signed OAuth session and exact gateway identity", async () => {
  const externalOrigin = "https://launchpad.management.iotorlazurio.lazurio.io";
  const authCheckUrl = "https://auth.management.iotorlazurio.lazurio.io/oauth2/auth";
  const authCalls = [];
  const trust = createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: externalOrigin,
    hostedAuthCheckUrl: authCheckUrl,
    fetchImpl: async (url, init) => {
      authCalls.push({ url, init });
      if (init.headers.cookie !== "_oauth2_proxy=valid-session") {
        return new Response(null, { status: 401 });
      }
      return new Response(null, {
        status: 202,
        headers: { "x-auth-request-user": "annavesela" },
      });
    },
  });
  const headers = {
    cookie: "_oauth2_proxy=valid-session",
    origin: externalOrigin,
    "sec-fetch-site": "same-origin",
    "x-lazurio-github-login": "annavesela",
  };

  expect(await trust.isTrustedWorkspaceRequest(request(headers), backendUrl)).toBe(true);
  expect(authCalls).toHaveLength(1);
  expect(authCalls[0].url).toBe(authCheckUrl);
  expect(authCalls[0].init.redirect).toBe("manual");
  expect(authCalls[0].init.headers.cookie).toBe("_oauth2_proxy=valid-session");

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
  expect(await trust.isTrustedWorkspaceRequest(request({ ...headers, cookie: "_oauth2_proxy=forged" }), backendUrl)).toBe(false);
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
    profile: "local",
    hostedExternalOrigin: "https://launchpad.example.test",
  })).toThrow("only in the hosted");
  expect(() => createRequestTrustPolicy({
    profile: "local",
    hostedAuthCheckUrl: "https://auth.example.test/oauth2/auth",
  })).toThrow("only in the hosted");
});
