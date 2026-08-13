import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  HostedAppUrlError,
  createHostedAppUrlAdapter,
  parseHostedAppUrlsJson,
  parseTeamServiceCatalogJson,
  projectHostedAppUrl,
  projectHostedRuntimePayload,
  requireHostedAppUrl,
} from "./hosted-app-url-lib.mjs";
import { validateAgainstSchema } from "./json-schema-mini.mjs";

const appId = "iotor-knowledgebase-v2";
const externalOrigin = "https://knowledgebase.management.example.test/";
const catalogSchema = JSON.parse(await readFile(
  new URL("../schemas/lazurio-team-service-catalog.schema.json", import.meta.url),
  "utf8",
));

test("local profile preserves loopback navigation and health", () => {
  const adapter = createHostedAppUrlAdapter({
    profile: "local",
    serviceCatalogJson: "malformed input is ignored outside hosted profile",
  });
  const app = localApp();
  expect(projectHostedAppUrl(app, adapter)).toBe(app);
  expect(projectHostedRuntimePayload({ url: app.url, runtime: app.runtime }, app, adapter))
    .toEqual({ url: app.url, runtime: app.runtime });
  expect(requireHostedAppUrl(localApp(), adapter)).toBeNull();
});

test("hosted profile projects the exact HTTPS Team catalog origin without changing internal health", () => {
  const adapter = createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    serviceCatalogJson: teamCatalogJson(),
  });
  const projected = projectHostedAppUrl(localApp(), adapter);
  expect(projected.url).toBe(externalOrigin);
  expect(projected.health_url).toBe("http://127.0.0.1:5744/health");
  expect(projected.runtime.url).toBe(externalOrigin);
  expect(projected.runtime.health_url).toBe("http://127.0.0.1:5744/health");
  expect(requireHostedAppUrl(localApp(), adapter)).toBe(externalOrigin);
});

test("hosted profile projects nested restart and switch lifecycle URLs", () => {
  const adapter = createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    serviceCatalogJson: teamCatalogJson(),
  });
  const loopback = "http://127.0.0.1:5744";
  const projected = projectHostedRuntimePayload({
    action: "restart",
    start: { runtime: { url: loopback, health_url: `${loopback}/health` } },
    started: { url: loopback, runtime: { url: loopback } },
  }, localApp(), adapter);
  expect(projected.start.runtime.url).toBe(externalOrigin);
  expect(projected.start.runtime.health_url).toBe(`${loopback}/health`);
  expect(projected.started.url).toBe(externalOrigin);
  expect(projected.started.runtime.url).toBe(externalOrigin);
  expect(JSON.stringify(projected)).not.toContain('"url":"http://127.0.0.1');

  const projectedError = projectHostedRuntimePayload({
    error: "app_start_failed",
    runtime: { status: "unhealthy", url: loopback, health_url: `${loopback}/health` },
  }, localApp(), adapter);
  expect(projectedError.runtime.url).toBe(externalOrigin);
  expect(projectedError.runtime.health_url).toBe(`${loopback}/health`);
});

test("hosted profile fails closed for missing mapping and never returns loopback", () => {
  const adapter = createHostedAppUrlAdapter({ profile: "hosted", expectedTeamId: "iotor-builders" });
  const projected = projectHostedRuntimePayload({
    url: "http://127.0.0.1:5744",
    runtime: { url: "http://127.0.0.1:5744", health_url: "http://127.0.0.1:5744/health" },
  }, localApp(), adapter);
  expect(projected.url).toBeNull();
  expect(projected.runtime.url).toBeNull();
  expect(projected.runtime.health_url).toBe("http://127.0.0.1:5744/health");
  expect(() => requireHostedAppUrl(localApp(), adapter)).toThrow(HostedAppUrlError);
  expect(() => requireHostedAppUrl(localApp(), adapter)).toThrow("will not expose loopback navigation");
});

test("canonical catalog is the only authority and compatibility map is only a fallback seam", () => {
  const compatibility = JSON.stringify({ [appId]: externalOrigin });
  expect(createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    compatibilityUrlsJson: compatibility,
  }))
    .toMatchObject({ profile: "hosted", source: "compatibility-injected-map" });
  expect(() => createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    serviceCatalogJson: teamCatalogJson(),
    compatibilityUrlsJson: compatibility,
  })).toThrow("one URL authority");
});

test("hosted adapter binds the catalog to the expected Team and discovered module lease", () => {
  expect(() => createHostedAppUrlAdapter({
    profile: "hosted",
    serviceCatalogJson: teamCatalogJson(),
  })).toThrow("LAZURIO_TEAM_ID is required");
  expect(() => createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor builders",
    serviceCatalogJson: teamCatalogJson(),
  })).toThrow("LAZURIO_TEAM_ID is required");
  expect(() => createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "wrong-team",
    serviceCatalogJson: teamCatalogJson(),
  })).toThrow("expected wrong-team");

  const adapter = createHostedAppUrlAdapter({
    profile: "hosted",
    expectedTeamId: "iotor-builders",
    serviceCatalogJson: teamCatalogJson({ module_lease_key: "iotor/deals" }),
  });
  expect(() => requireHostedAppUrl(localApp(), adapter)).toThrow("claims iotor/deals");
  expect(projectHostedAppUrl(localApp(), adapter)).toMatchObject({
    url: null,
    hosted_url_error: "hosted_app_lease_mismatch",
  });
});

test("hosted catalog and compatibility input reject malformed or non-HTTPS origins", () => {
  for (const mutate of [
    () => "not-json",
    () => JSON.stringify({}),
    () => teamCatalogJson({ external_origin: "http://module.team.example.test/" }),
    () => teamCatalogJson({ external_origin: "https://user:secret@example.test/" }),
    () => teamCatalogJson({ external_origin: "https://example.test/path" }),
    () => teamCatalogJson({ external_origin: "https://example.test/?secret=1" }),
    () => teamCatalogJson({ module_lease_key: "missing-slash" }),
  ]) {
    expect(() => parseTeamServiceCatalogJson(mutate())).toThrow();
  }
  expect(() => parseHostedAppUrlsJson(JSON.stringify({ [appId]: "http://legacy.example.test/" }))).toThrow();
  for (const loopback of [
    "https://127.0.0.1/",
    "https://127.1/",
    "https://localhost/",
    "https://localhost./",
    "https://LOCALHOST/",
    "https://App.LOCALHOST/",
    "https://module.localhost./",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
  ]) {
    expect(() => parseHostedAppUrlsJson(JSON.stringify({ [appId]: loopback }))).toThrow("loopback");
  }
});

test("published Team catalog schema matches runtime origin and identity constraints", () => {
  const valid = JSON.parse(teamCatalogJson());
  expect(validateAgainstSchema(valid, catalogSchema)).toEqual([]);

  for (const external_origin of [
    "http://module.team.example.test/",
    "https://user:secret@example.test/",
    "https://example.test/path",
    "https://example.test/?secret=1",
    "https://localhost./",
    "https://127.0.0.1/",
    "https://127.1/",
    "https://2130706433/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://module.team.example.test:99999/",
  ]) {
    const catalog = JSON.parse(teamCatalogJson({ external_origin }));
    expect(validateAgainstSchema(catalog, catalogSchema).length).toBeGreaterThan(0);
    expect(() => parseTeamServiceCatalogJson(JSON.stringify(catalog))).toThrow();
  }

  const invalidTeam = JSON.parse(teamCatalogJson());
  invalidTeam.team_id = "iotor builders";
  expect(validateAgainstSchema(invalidTeam, catalogSchema).length).toBeGreaterThan(0);
  expect(() => parseTeamServiceCatalogJson(JSON.stringify(invalidTeam))).toThrow("team_id is invalid");

  const duplicateApp = JSON.parse(teamCatalogJson());
  duplicateApp.services.push({ ...duplicateApp.services[0], external_origin: "https://other.example.test/" });
  expect(() => parseTeamServiceCatalogJson(JSON.stringify(duplicateApp))).toThrow("duplicates app_id");

  const uppercaseDns = JSON.parse(teamCatalogJson({ external_origin: "https://Module.Team.Example/" }));
  expect(validateAgainstSchema(uppercaseDns, catalogSchema).length).toBeGreaterThan(0);
  expect(() => parseTeamServiceCatalogJson(JSON.stringify(uppercaseDns))).toThrow("ASCII DNS name");

  const cgnat = JSON.parse(teamCatalogJson({ external_origin: "https://100.64.12.34:443/" }));
  expect(validateAgainstSchema(cgnat, catalogSchema)).toEqual([]);
  expect(parseTeamServiceCatalogJson(JSON.stringify(cgnat)).services.get(appId).external_origin)
    .toBe("https://100.64.12.34/");
});

function localApp() {
  return {
    id: appId,
    company: "iotor",
    module: "knowledgebase",
    url: "http://127.0.0.1:5744",
    health_url: "http://127.0.0.1:5744/health",
    runtime: {
      status: "healthy",
      url: "http://127.0.0.1:5744",
      health_url: "http://127.0.0.1:5744/health",
    },
  };
}

function teamCatalogJson(overrides = {}) {
  return JSON.stringify({
    schema_version: "lazurio.team_service_catalog.v1",
    team_id: "iotor-builders",
    generated_at: "2026-08-13T10:00:00Z",
    services: [{
      app_id: appId,
      module_lease_key: "iotor/knowledgebase",
      external_origin: externalOrigin,
      ...overrides,
    }],
  });
}
