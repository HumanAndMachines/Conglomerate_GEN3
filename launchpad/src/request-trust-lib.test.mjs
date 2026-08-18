import { expect, test } from "bun:test";
import { createRequestTrustPolicy } from "./request-trust-lib.mjs";

const backendUrl = new URL("http://127.0.0.1:4174/api/sync");

function request(headers = {}) {
  return new Request(backendUrl, { method: "POST", headers });
}

test("local trust accepts loopback same-origin requests and rejects foreign origins", () => {
  const trust = createRequestTrustPolicy();
  expect(trust.isTrustedWorkspaceRequest(request(), backendUrl)).toBe(true);
  expect(trust.isTrustedWorkspaceRequest(request({
    origin: backendUrl.origin,
    "sec-fetch-site": "same-origin",
  }), backendUrl)).toBe(true);
  expect(trust.isTrustedWorkspaceRequest(request({
    origin: "https://evil.invalid",
    "sec-fetch-site": "cross-site",
  }), backendUrl)).toBe(false);
});

test("hosted trust requires the exact configured origin and gateway-authenticated GitHub login", () => {
  const externalOrigin = "https://launchpad.management.iotorlazurio.lazurio.io";
  const trust = createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: externalOrigin,
  });
  const headers = {
    origin: externalOrigin,
    "sec-fetch-site": "same-origin",
    "x-lazurio-github-login": "annavesela",
  };

  expect(trust.isTrustedWorkspaceRequest(request(headers), backendUrl)).toBe(true);
  expect(trust.isTrustedWorkspaceRequest(request({ ...headers, origin: "https://evil.invalid" }), backendUrl)).toBe(false);
  expect(trust.isTrustedWorkspaceRequest(request({ ...headers, "sec-fetch-site": "cross-site" }), backendUrl)).toBe(false);
  expect(trust.isTrustedWorkspaceRequest(request({ ...headers, "x-lazurio-github-login": "" }), backendUrl)).toBe(false);
  expect(trust.isTrustedWorkspaceRequest(request({ ...headers, "x-lazurio-github-login": "not a login!" }), backendUrl)).toBe(false);
});

test("hosted trust configuration fails closed", () => {
  expect(() => createRequestTrustPolicy({ profile: "hosted" })).toThrow("required");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "http://launchpad.example.test",
  })).toThrow("clean HTTPS origin");
  expect(() => createRequestTrustPolicy({
    profile: "hosted",
    hostedExternalOrigin: "https://127.0.0.1:4174",
  })).toThrow("loopback");
  expect(() => createRequestTrustPolicy({
    profile: "local",
    hostedExternalOrigin: "https://launchpad.example.test",
  })).toThrow("only in the hosted");
});
