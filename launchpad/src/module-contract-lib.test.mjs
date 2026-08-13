import { expect, test } from "bun:test";
import {
  materializeRuntimeFromModule,
  normalizeModuleManifest,
} from "./module-contract-lib.mjs";

const moduleManifest = {
  schema_version: "lazurio.module.v1",
  id: "presentation",
  company: "HumanAndMachine-ai",
  tcp_port_policy: { mode: "single" },
  port_leases: [{ id: "main", host: "127.0.0.1", port: 24209 }],
};

test("module manifest is the sole owner of the materialized TCP endpoint", () => {
  const normalized = normalizeModuleManifest({ manifest: moduleManifest });
  expect(normalized.issues).toEqual([]);
  const result = materializeRuntimeFromModule({
    module: normalized.module,
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
    "package.json: module lease main je referencovaný více runtime listenery",
  );
});

test("malformed runtime listener is isolated as a contract issue", () => {
  const module = normalizeModuleManifest({ manifest: moduleManifest }).module;
  const result = materializeRuntimeFromModule({
    module,
    runtime: {
      company: "HumanAndMachine-ai",
      module: "presentation",
      listeners: [null],
    },
  });
  expect(result.issues).toContain(
    "package.json: lazurio.runtime.listeners[0] musí být object",
  );
  expect(result.app.listeners).toEqual([]);
});
