import { expect, test } from "bun:test";
import {
  normalizePackageRuntime,
  validateDeclaredRuntime,
} from "./runtime-contract-lib.mjs";

function runtime(overrides = {}) {
  return {
    schema_version: "lazurio.runtime.v1",
    id: "example-presentation-v1",
    title: "Presentation",
    company: "example",
    module: "presentation",
    surface: "internal",
    dev_script: "dev",
    tags: ["presentation"],
    listeners: [
      {
        id: "web",
        role: "entrypoint",
        lease: "web",
        protocol: "http",
        health: { kind: "http", path: "/" },
      },
      {
        id: "api",
        role: "auxiliary",
        lease: "api",
        protocol: "http",
        health: { kind: "http", path: "/api/health" },
      },
    ],
    ...overrides,
  };
}

test("normalizes lazurio.runtime.v1 to stable Launchpad aliases", () => {
  const result = normalizePackageRuntime({
    packageJson: { scripts: { dev: "concurrently ..." }, lazurio: { runtime: runtime() } },
  });
  expect(result.issues).toEqual([]);
  expect(result.app).toMatchObject({
    port: null,
    host: null,
    health_path: "/",
    runtime_contract: {
      schema_version: "lazurio.runtime.v1",
      source: "lazurio.runtime",
      legacy: false,
      auxiliary_listeners_known: true,
    },
  });
  expect(result.app.listeners.map((listener) => listener.id)).toEqual(["web", "api"]);
});

test("normalizes legacy app as one entrypoint with unknown auxiliaries", () => {
  const result = normalizePackageRuntime({
    packageJson: {
      companyascode: {
        app: {
          schema_version: "companyascode.launchpad_app.v1",
          id: "example-legacy-v1",
          title: "Legacy",
          company: "example",
          surface: "internal",
          port: 5390,
          host: "localhost",
          health_path: "/",
          dev_script: "dev",
          tags: [],
        },
      },
    },
  });
  expect(result.app.runtime_contract).toMatchObject({
    legacy: true,
    auxiliary_listeners_known: false,
  });
  expect(result.app.listeners).toEqual([
    expect.objectContaining({ role: "entrypoint", allocation: "static", port: 5390 }),
  ]);
});

test("requires exactly one entrypoint", () => {
  const value = runtime({
    listeners: [
      ...runtime().listeners,
      {
        ...runtime().listeners[0],
        id: "second-web",
        role: "entrypoint",
      },
    ],
  });
  const issues = validateDeclaredRuntime({
    runtime: value,
    packageJson: { scripts: { dev: "run" } },
  });
  expect(issues.some((issue) => issue.includes("právě jeden entrypoint"))).toBe(true);
});

test("requires a stable module identity for the single-instance lease", () => {
  const value = runtime();
  delete value.module;
  const issues = validateDeclaredRuntime({
    runtime: value,
    packageJson: { scripts: { dev: "run" } },
  });
  expect(issues.some((issue) => issue.includes("lazurio.runtime.module chybí"))).toBe(true);
  expect(issues.some((issue) => issue.includes("lazurio.runtime.module není validní"))).toBe(true);
});

test("port ownership fields are forbidden in the runtime contract", () => {
  const splitAuthority = runtime({
    listeners: [{
      id: "web",
      role: "entrypoint",
      allocation: "dynamic",
      host: "127.0.0.1",
      port: 5394,
      lease: "web",
      protocol: "http",
      health: { kind: "http", path: "/" },
      claim: { mode: "exclusive" },
    }],
  });
  const issues = validateDeclaredRuntime({
    runtime: splitAuthority,
    packageJson: { scripts: { dev: "run" } },
  });
  for (const field of ["allocation", "host", "port", "claim"]) {
    expect(issues.some((issue) => issue.includes(`.${field} není povolené pole`))).toBe(true);
  }
});

test("every runtime listener must reference a module lease", () => {
  const value = runtime();
  delete value.listeners[0].lease;
  const issues = validateDeclaredRuntime({
    runtime: value,
    packageJson: { scripts: { dev: "run" } },
  });
  expect(issues.some((issue) => issue.includes(".lease chybí"))).toBe(true);
  expect(issues.some((issue) => issue.includes(".lease není validní"))).toBe(true);
});

test("rejects split authority when new and legacy manifests coexist", () => {
  const result = normalizePackageRuntime({
    packagePath: "workspace/demo/package.json",
    packageJson: {
      scripts: { dev: "run" },
      lazurio: { runtime: runtime() },
      companyascode: { app: { id: "legacy" } },
    },
  });
  expect(result.issues).toEqual([
    "workspace/demo/package.json: package nesmí současně deklarovat lazurio.runtime a legacy companyascode.app",
  ]);
});

test("runtime scripts fail closed when Launchpad listener injection is missing", () => {
  const unsafe = validateDeclaredRuntime({
    runtime: runtime(),
    packageJson: {
      scripts: { dev: "vite --host $HOST --port $PORT --strictPort" },
    },
  });
  expect(unsafe.some((issue) => issue.includes("$HOST bez přenositelné fail-closed"))).toBe(
    true,
  );
  expect(unsafe.some((issue) => issue.includes("$PORT bez přenositelné fail-closed"))).toBe(
    true,
  );

  const safe = validateDeclaredRuntime({
    runtime: runtime(),
    packageJson: {
      scripts: {
        dev: 'bun -e "process.exit(process.env.HOST && process.env.PORT ? 0 : 1)" && vite --host "$HOST" --port "$PORT" --strictPort',
      },
    },
  });
  expect(safe).toEqual([]);
});
