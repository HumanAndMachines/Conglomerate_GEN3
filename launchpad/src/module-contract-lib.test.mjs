import { expect, test } from "bun:test";
import {
  materializeRuntimeFromModule,
  normalizeModuleManifest,
  resolveModuleAppDeclaration,
} from "../../lazurio/core/module-contract-lib.mjs";

const moduleManifest = {
  schema_version: "lazurio.module.v1",
  id: "presentation",
  company: "HumanAndMachine-ai",
  tcp_port_policy: { mode: "single" },
  port_leases: [{ id: "main", host: "127.0.0.1", port: 24209 }],
  apps: ["app/v1/package.json"],
  default_app: "app/v1/package.json",
};

test("module app inventory distinguishes explicit empty from legacy missing", () => {
  const explicit = structuredClone(moduleManifest);
  explicit.apps = [];
  delete explicit.default_app;
  const normalizedExplicit = normalizeModuleManifest({ manifest: explicit });
  expect(normalizedExplicit.issues).toEqual([]);
  expect(normalizedExplicit.module.apps).toEqual([]);
  expect(normalizedExplicit.module.app_declaration_state).toBe("explicit");

  const legacy = structuredClone(moduleManifest);
  delete legacy.apps;
  delete legacy.default_app;
  const normalizedLegacy = normalizeModuleManifest({ manifest: legacy });
  expect(normalizedLegacy.issues).toEqual([]);
  expect(normalizedLegacy.module.apps).toBeNull();
  expect(normalizedLegacy.module.app_declaration_state).toBe("legacy-missing");
});

test("non-empty module apps require one explicit listed default package", () => {
  const missing = structuredClone(moduleManifest);
  delete missing.default_app;
  expect(normalizeModuleManifest({ manifest: missing }).issues).toContain(
    "lazurio.module.json: lazurio.module.default_app musí být bezpečná relativní POSIX cesta končící package.json",
  );

  const outside = structuredClone(moduleManifest);
  outside.default_app = "app/v2/package.json";
  expect(normalizeModuleManifest({ manifest: outside }).issues).toContain(
    "lazurio.module.json: lazurio.module.default_app app/v2/package.json musí být uvedený v apps",
  );

  const traversal = structuredClone(moduleManifest);
  traversal.apps = ["../package.json"];
  traversal.default_app = "../package.json";
  expect(normalizeModuleManifest({ manifest: traversal }).issues.some((issue) => issue.includes("bezpečná relativní POSIX"))).toBe(true);
});

test("runtime package must be explicitly listed once Module apps exist", () => {
  const module = normalizeModuleManifest({
    manifest: moduleManifest,
    modulePath: "organizations/Example/workspace/presentation/lazurio.module.json",
  }).module;
  expect(resolveModuleAppDeclaration({
    module,
    packagePath: "organizations/Example/workspace/presentation/app/v1/package.json",
  })).toMatchObject({
    app: { package: "app/v1/package.json", declared: true, default: true, state: "explicit" },
    issues: [],
  });
  expect(resolveModuleAppDeclaration({
    module,
    packagePath: "organizations/Example/workspace/presentation/editor/v1/package.json",
  }).issues).toContain(
    "organizations/Example/workspace/presentation/editor/v1/package.json: package není uvedený v organizations/Example/workspace/presentation/lazurio.module.json#apps",
  );
});

test("module manifest is the sole owner of the materialized TCP endpoint", () => {
  const normalized = normalizeModuleManifest({ manifest: moduleManifest });
  expect(normalized.issues).toEqual([]);
  const result = materializeRuntimeFromModule({
    module: normalized.module,
    packagePath: "app/v1/package.json",
    runtime: {
      schema_version: "lazurio.runtime.v1",
      id: "humanandmachine-ai-presentation-v1",
      company: "HumanAndMachine-ai",
      module: "presentation",
      listeners: [{
        id: "web",
        role: "entrypoint",
        lease: "main",
        protocol: "http",
        health: { kind: "http", path: "/" },
      }],
    },
  });
  expect(result.issues).toEqual([]);
  expect(result.app.entrypoint_listener).toMatchObject({
    lease: "main",
    port: 24209,
    host: "127.0.0.1",
    allocation: "static",
    claim: { mode: "exclusive" },
  });
});

test("multiple TCP ports require an explicit reason", () => {
  const manifest = structuredClone(moduleManifest);
  manifest.port_leases.push({ id: "api", host: "127.0.0.1", port: 24210 });
  const single = normalizeModuleManifest({ manifest });
  expect(single.issues.some((issue) => issue.includes("single vyžaduje právě jeden"))).toBe(true);
  manifest.tcp_port_policy = { mode: "exception", reason: "short" };
  const vague = normalizeModuleManifest({ manifest });
  expect(vague.issues.some((issue) => issue.includes("konkrétní zdůvodnění"))).toBe(true);
  manifest.tcp_port_policy.reason = "Existing split web and API runtime pending local IPC migration.";
  expect(normalizeModuleManifest({ manifest }).issues).toEqual([]);
});

test("runtime may use a subset of module leases reserved for other concrete runtimes", () => {
  const manifest = structuredClone(moduleManifest);
  manifest.tcp_port_policy = {
    mode: "exception",
    reason: "Existing split web and API runtime pending local IPC migration.",
  };
  manifest.port_leases.push({ id: "api", host: "127.0.0.1", port: 24210 });
  const module = normalizeModuleManifest({ manifest }).module;
  const result = materializeRuntimeFromModule({
    module,
    packagePath: "app/v1/package.json",
    runtime: {
      company: "HumanAndMachine-ai",
      module: "presentation",
      listeners: [{
        id: "web",
        role: "entrypoint",
        lease: "main",
        protocol: "http",
        health: { kind: "http", path: "/" },
      }],
    },
  });
  expect(result.issues).toEqual([]);
  expect(result.app.listeners).toHaveLength(1);
  expect(result.app.listeners[0].port).toBe(24209);
});

test("one module lease can be referenced by only one runtime listener", () => {
  const module = normalizeModuleManifest({ manifest: moduleManifest }).module;
  const result = materializeRuntimeFromModule({
    module,
    packagePath: "app/v1/package.json",
    runtime: {
      company: "HumanAndMachine-ai",
      module: "presentation",
      listeners: [
        {
          id: "web",
          role: "entrypoint",
          lease: "main",
          protocol: "http",
          health: { kind: "http", path: "/" },
        },
        {
          id: "api",
          role: "auxiliary",
          lease: "main",
          protocol: "http",
          health: { kind: "http", path: "/api/health" },
        },
      ],
    },
  });
  expect(result.issues).toContain(
    "app/v1/package.json: module lease main je referencovaný více runtime listenery",
  );
});

test("malformed runtime listener is isolated as a contract issue", () => {
  const module = normalizeModuleManifest({ manifest: moduleManifest }).module;
  const result = materializeRuntimeFromModule({
    module,
    packagePath: "app/v1/package.json",
    runtime: {
      company: "HumanAndMachine-ai",
      module: "presentation",
      listeners: [null],
    },
  });
  expect(result.issues).toContain(
    "app/v1/package.json: lazurio.runtime.listeners[0] musí být object",
  );
  expect(result.app.listeners).toEqual([]);
});
