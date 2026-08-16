import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  migrateLegacyRuntimePackage,
  moduleRootForPackage,
  packagePathsBelow,
  rewriteRuntimeScriptsFromModule,
} from "./lazurio-runtime-migrate.mjs";

const roots = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

function packageFixture(app, scripts = { dev: "bun server.mjs" }) {
  return {
    name: "fixture",
    private: true,
    scripts,
    companyascode: { app },
  };
}

const legacy = {
  schema_version: "companyascode.launchpad_app.v1",
  id: "example-demo-v1",
  title: "Demo",
  company: "Example",
  module: "demo",
  surface: "internal",
  port: 5392,
  host: "127.0.0.1",
  health_path: "/health",
  dev_script: "dev",
  tags: ["demo"],
};

test("migrates a single-listener legacy package without split authority", () => {
  const result = migrateLegacyRuntimePackage(packageFixture(legacy));
  expect(result.changed).toBe(true);
  expect(result.packageJson.companyascode).toBeUndefined();
  expect(result.packageJson.lazurio.runtime).toMatchObject({
    schema_version: "lazurio.runtime.v1",
    id: legacy.id,
    listeners: [{ id: "app", role: "entrypoint", lease: "main" }],
  });
  expect(result.moduleManifest).toEqual({
    schema_version: "lazurio.module.v1",
    id: "demo",
    company: "Example",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 5392 }],
    apps: ["package.json"],
    default_app: "package.json",
  });
});

test("refuses to write a runtime generated from an invalid legacy manifest", () => {
  const source = packageFixture({ ...legacy, port: 80, health_path: "health" });
  const result = migrateLegacyRuntimePackage(source);
  expect(result.changed).toBe(false);
  expect(result.packageJson).toEqual(source);
  expect(result.issues.join("\n")).toContain("migrace zablokována");
  expect(result.issues.join("\n")).toContain("port musí být číslo 1024-65535");
  expect(result.issues.join("\n")).toContain("path musí začínat /");
});

test("preserves a stable legacy port outside the new-allocation Organization block", () => {
  const source = packageFixture(legacy);
  const result = migrateLegacyRuntimePackage(source, {
    registry: {
      schema_version: "lazurio.port_registry.v1",
      allocation_strategy: "organization-blocks",
      organization_blocks: [{ company: "Example", start: 24000, end: 24099 }],
    },
  });
  expect(result.changed).toBe(true);
  expect(result.moduleManifest.port_leases[0].port).toBe(5392);
  expect(result.issues).toEqual([]);
});

test("preserves an invalid legacy host so validation blocks migration", () => {
  for (const host of [undefined, "0.0.0.0"]) {
    const source = packageFixture({ ...legacy, host });
    const result = migrateLegacyRuntimePackage(source);
    expect(result.changed).toBe(false);
    expect(result.packageJson).toEqual(source);
    expect(result.issues.join("\n")).toContain("migrace zablokována");
    expect(result.issues.join("\n")).toContain("host");
  }
});

test("refuses a single hardcoded dev port that disagrees with legacy metadata", () => {
  const source = packageFixture(legacy, { dev: "PORT=5393 bun server.mjs" });
  const result = migrateLegacyRuntimePackage(source);
  expect(result.changed).toBe(false);
  expect(result.packageJson).toEqual(source);
  expect(result.issues[0]).toContain("používá port 5393");
  expect(result.issues[0]).toContain("deklaruje 5392");
});

test("blocks split runtimes until both listener overrides are wired manually", () => {
  const result = migrateLegacyRuntimePackage(packageFixture(legacy, {
    dev: "concurrently \"bun run dev:api\" \"bun run dev:web\"",
    "dev:web": "vite --host 127.0.0.1 --port 5392",
    "dev:api": "bun server.ts --port 5393",
  }));
  expect(result.changed).toBe(false);
  expect(result.packageJson.companyascode.app).toEqual(legacy);
  expect(result.issues[0]).toContain("ruční migraci všech listenerů");
  expect(result.issues[0]).toContain("LAZURIO_RUNTIME_LISTENER_<ID>_PORT");
});

test("refuses an ambiguous split runtime", () => {
  const source = packageFixture(legacy, {
    dev: "concurrently \"bun run dev:api\" \"bun run dev:web\"",
    "dev:web": "vite --port 5392",
    "dev:api": "bun server.ts",
  });
  const result = migrateLegacyRuntimePackage(source);
  expect(result.changed).toBe(false);
  expect(result.packageJson).toEqual(source);
  expect(result.issues[0]).toContain("víceprocesový runtime");
});

test("blocks direct concurrent commands without conventional script names", () => {
  const source = packageFixture(legacy, {
    dev: "concurrently \"vite --port 5392\" \"bun server.ts --port 5393\"",
  });
  const result = migrateLegacyRuntimePackage(source);
  expect(result.changed).toBe(false);
  expect(result.packageJson).toEqual(source);
  expect(result.issues[0]).toContain("5392/5393");
});

test("blocks shell-background runtimes and observes environment port assignments", () => {
  const source = packageFixture(legacy, {
    dev: "PORT=5393 bun api.mjs & vite --port 5392",
  });
  const result = migrateLegacyRuntimePackage(source);
  expect(result.changed).toBe(false);
  expect(result.packageJson).toEqual(source);
  expect(result.issues[0]).toContain("5392/5393");
  expect(result.issues[0]).toContain("ruční migraci všech listenerů");
});

test("moves an inline port contract to the module root and leaves only lease references", () => {
  const source = {
    name: "fixture",
    scripts: { dev: "bun server.mjs" },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: "example-demo-v2",
        title: "Demo",
        company: "Example",
        module: "demo",
        surface: "internal",
        dev_script: "dev",
        tags: ["demo"],
        listeners: [{
          id: "web",
          role: "entrypoint",
          allocation: "static",
          host: "127.0.0.1",
          port: 5392,
          protocol: "http",
          health: { kind: "http", path: "/" },
          claim: { mode: "exclusive" },
        }],
      },
    },
  };
  const result = migrateLegacyRuntimePackage(source);
  expect(result.changed).toBe(true);
  expect(result.packageJson.lazurio.runtime.listeners).toEqual([{
    id: "web",
    role: "entrypoint",
    lease: "main",
    protocol: "http",
    health: { kind: "http", path: "/" },
  }]);
  expect(result.moduleManifest.port_leases).toEqual([
    { id: "main", host: "127.0.0.1", port: 5392 },
  ]);
});

test("removes copied numeric ports from package scripts in favor of injected lease env", () => {
  const packageJson = {
    scripts: {
      dev: "concurrently 'bun run dev:web' 'bun run dev:api'",
      "dev:web": "vite --port 5392",
      "dev:api": "bun server.ts --port 5393",
    },
    lazurio: {
      runtime: {
        listeners: [
          { id: "web", role: "entrypoint", lease: "web" },
          { id: "api", role: "auxiliary", lease: "api" },
        ],
      },
    },
  };
  const result = rewriteRuntimeScriptsFromModule(packageJson, {
    port_leases: [
      { id: "web", port: 5392 },
      { id: "api", port: 5393 },
    ],
  });
  expect(result.changed).toBe(true);
  expect(result.packageJson.scripts["dev:web"]).toBe('vite --port "$PORT"');
  expect(result.packageJson.scripts["dev:api"]).toBe('bun server.ts --port "$LAZURIO_RUNTIME_LISTENER_API_PORT"');
});

test("root migration excludes Personalspace and worktrees unless directly targeted", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-runtime-migrate-boundary-"));
  roots.push(root);
  const canonical = join(root, "organizations", "Acme", "workspace", "demo", "package.json");
  const worktree = join(root, "organizations", "Acme", ".worktrees", "demo", "package.json");
  const personal = join(root, "personalspace", "owner_GEN3", "workspace", "notes", "package.json");
  for (const path of [canonical, worktree, personal]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{}\n");
  }

  expect(await packagePathsBelow(root)).toEqual([canonical]);
  expect(await packagePathsBelow(join(root, "personalspace", "owner_GEN3"))).toEqual([personal]);
});

test("directory migration excludes tests and fixture package manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-runtime-migrate-live-only-"));
  roots.push(root);
  const live = join(root, "workspace", "demo", "package.json");
  const excluded = [
    join(root, "workspace", "demo", "tests", "package.json"),
    join(root, "workspace", "demo", "fixtures", "package.json"),
    join(root, "workspace", "demo", "__tests__", "package.json"),
  ];
  for (const path of [live, ...excluded]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{}\n");
  }

  expect(await packagePathsBelow(root)).toEqual([live]);
});

test("direct package targets keep the module manifest beside a root package", () => {
  const moduleRoot = join(tmpdir(), "organizations", "Acme", "workspace", "demo");
  expect(moduleRootForPackage(join(moduleRoot, "package.json"), "demo")).toBe(
    moduleRoot,
  );
  expect(
    moduleRootForPackage(join(moduleRoot, "app", "v2", "package.json"), "demo"),
  ).toBe(moduleRoot);
});
