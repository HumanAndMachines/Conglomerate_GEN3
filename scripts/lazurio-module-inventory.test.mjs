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
    modules: [
      { slug: "website", path: "workspace/website", repo: "git@github.com:Example/website.git" },
      { slug: "notes", path: "workspace/notes", repo: "git@github.com:Example/notes.git" },
      { slug: "warehouse-data", path: "workspace/warehouse-data", repo: "git@github.com:Example/warehouse-data.git", classification: "workspace-repository-db-data" },
      { slug: "future", path: "workspace/future", repo: "" },
      { slug: "firmware", path: "productionspace/firmware", repo: "git@github.com:Example/firmware.git" },
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
    excluded_slots: 3,
  });
  const website = inventory.modules.find((module) => module.module === "website");
  expect(website.proposal).toMatchObject({
    apps: ["app/v2/package.json"],
    default_app: "app/v2/package.json",
    port_candidates: [5289],
  });
  expect(inventory.excluded.map((slot) => slot.reason).sort()).toEqual([
    "nested-db",
    "planned-slot",
    "productionspace",
  ]);
});
