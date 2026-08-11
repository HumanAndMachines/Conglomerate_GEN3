import { expect, test } from "bun:test";
import {
  parseHostedAppUrlsJson,
  projectHostedAppUrl,
  projectHostedRuntimePayload,
} from "./hosted-app-url-lib.mjs";

test("hosted app URLs project navigation without changing local health", () => {
  const urls = parseHostedAppUrlsJson(JSON.stringify({
    "iotor-knowledgebase-v2": "https://knowledgebase.management.example.test/",
  }));
  const projected = projectHostedAppUrl({
    id: "iotor-knowledgebase-v2",
    url: "http://127.0.0.1:5744",
    health_url: "http://127.0.0.1:5744/",
    runtime: { status: "healthy", url: "http://127.0.0.1:5744" },
  }, urls);

  expect(projected.url).toBe("https://knowledgebase.management.example.test/");
  expect(projected.health_url).toBe("http://127.0.0.1:5744/");
  expect(projected.runtime.url).toBe("https://knowledgebase.management.example.test/");
});

test("runtime payload projection is scoped to the exact app id", () => {
  const urls = parseHostedAppUrlsJson(JSON.stringify({
    "example-app-v1": "http://example-app.team.private/",
  }));
  const payload = { url: "http://127.0.0.1:5001", runtime: { url: "http://127.0.0.1:5001" } };

  expect(projectHostedRuntimePayload(payload, "example-app-v1", urls)).toEqual({
    url: "http://example-app.team.private/",
    runtime: { url: "http://example-app.team.private/" },
  });
  expect(projectHostedRuntimePayload(payload, "another-app", urls)).toBe(payload);
});

test("hosted app URLs fail closed on credentials, paths and malformed input", () => {
  for (const raw of [
    "[]",
    "not-json",
    JSON.stringify({ "bad id": "https://example.test/" }),
    JSON.stringify({ app: "javascript:alert(1)" }),
    JSON.stringify({ app: "https://user:secret@example.test/" }),
    JSON.stringify({ app: "https://example.test/path" }),
    JSON.stringify({ app: "https://example.test/?secret=1" }),
  ]) {
    expect(() => parseHostedAppUrlsJson(raw)).toThrow();
  }
});
