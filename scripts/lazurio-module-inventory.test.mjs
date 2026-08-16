import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventoryLazurioModules } from "./lazurio-module-inventory.mjs";

const roots = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("inventory separates Modules, empty Apps and nested repository-db slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-inventory-"));
  roots.push(root);
  const organization = join(root, "organizations", "Example_GEN3");
  await mkdir(join(organization, "workspace", "website", ".git"), { recursive: true });
  await mkdir(join(organization, "workspace", "notes", ".git"), { recursive: true });
  await mkdir(join(organization, "workspace", "warehouse-data", ".git"), { recursive: true });
  await writeJson(join(organization, "company.gen3.json"), {
    company: { slug: "Example" },
  });
  await writeJson(join(organization, "modules.manifest.json"), {
    company: "Example",
    module_slots: [
      { slug: "website", path: "workspace/website", git: { url: "git@github.com:Example/website.git", branch: "main" } },
      { slug: "notes", path: "workspace/notes", git: { url: "git@github.com:Example/notes.git", branch: "main" } },
      { slug: "website-data", path: "workspace/website/db", git: { url: "git@github.com:Example/website-data.git", branch: "v3" }, materialization: "repository_db_mount", source_of_truth: "repository-db:v3" },
      { slug: "future", path: "workspace/future", status: "planned_slot", source_of_truth: "planned_slot" },
      { slug: "firmware", path: "productionspace/firmware", git: { url: "git@github.com:Example/firmware.git", branch: "0.12.11-dev" } },
      { slug: "infra", path: "infra", git: { url: "git@github.com:Example/infra.git", branch: "main" } },
    ],
  });
  await writeJson(join(organization, "workspace", "website", "app", "v2", "package.json"), {
    scripts: { dev: "astro dev --port 5289" },
  });
  await writeJson(join(organization, "workspace", "notes", "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: "notes",
    company: "Example",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24001 }],
    apps: [],
  });

  const inventory = await inventoryLazurioModules(root);
  expect(inventory.summary).toMatchObject({
    declared_modules: 2,
    materialized_modules: 2,
    missing_module_contracts: 1,
    explicit_contracts: 1,
    modules_without_apps: 1,
    runnable_undeclared_packages: 1,
    excluded_slots: 4,
  });
  const website = inventory.modules.find((module) => module.module === "website");
  expect(website).toMatchObject({
    repository: "git@github.com:Example/website.git",
    declaration_source: "modules.manifest.json",
  });
  expect(website.proposal).toMatchObject({
    apps: ["app/v2/package.json"],
    default_app: "app/v2/package.json",
    port_candidates: [5289],
  });
  expect(inventory.excluded.map((slot) => slot.reason).sort()).toEqual([
    "nested-db",
    "not-workspace-module",
    "planned-slot",
    "productionspace",
  ]);
});

test("inventory keeps company.gen3.json modules as a compatibility fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-module-inventory-legacy-"));
  roots.push(root);
  const organization = join(root, "organizations", "Legacy_GEN3");
  await mkdir(join(organization, "workspace", "website", ".git"), { recursive: true });
  await writeJson(join(organization, "company.gen3.json"), {
    company: { slug: "Legacy" },
    modules: [
      { slug: "website", path: "workspace/website", repo: "git@github.com:Legacy/website.git" },
    ],
  });

  const inventory = await inventoryLazurioModules(root);
  expect(inventory.summary).toMatchObject({ declared_modules: 1, materialized_modules: 1 });
  expect(inventory.modules[0]).toMatchObject({
    module: "website",
    repository: "git@github.com:Legacy/website.git",
    declaration_source: "company.gen3.json#modules",
  });
});
