import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { allocateModulePort } from "./lazurio-module-port.mjs";

const roots = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("creator allocates once from the central Organization block", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-port-creator-"));
  roots.push(root);
  const existingRoot = join(root, "organizations", "Acme", "workspace", "alpha");
  const targetRoot = join(root, "organizations", "Acme", "workspace", "beta");
  const guideRoot = join(root, "guide");
  await mkdir(existingRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await mkdir(guideRoot, { recursive: true });
  await writeFile(join(root, "lazurio.port-registry.json"), JSON.stringify({
    schema_version: "lazurio.port_registry.v1",
    allocation_strategy: "organization-blocks",
    organization_blocks: [{ company: "Acme", start: 24000, end: 24099 }],
  }));
  await writeFile(join(root, "organizations", "Acme", "modules.manifest.json"), JSON.stringify({
    company: "Acme",
    module_slots: [
      { path: "workspace/alpha", slug: "alpha" },
      { path: "workspace/beta", slug: "beta" },
    ],
  }));
  await writeFile(join(root, "organizations", "Acme", "company.gen3.json"), JSON.stringify({
    modules: [{ path: "workspace/company-only", slug: "company-only" }],
  }));
  const companyOnlyRoot = join(root, "organizations", "Acme", "workspace", "company-only");
  await mkdir(companyOnlyRoot, { recursive: true });
  await writeFile(join(companyOnlyRoot, "lazurio.module.json"), JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "company-only",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24002 }],
  }));
  await writeFile(join(existingRoot, "lazurio.module.json"), JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "alpha",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24001 }],
  }));
  await writeFile(join(guideRoot, "lazurio.module.json"), JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "guide",
    company: "Acme",
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port: 24003 }],
  }));
  const staleWorktreeRoot = join(root, "organizations", "Acme", ".worktrees", "workspace", "stale", "DEV-old");
  const personalRoot = join(root, "personalspace", "owner_GEN3", "workspace", "private");
  const noncanonicalRoot = join(existingRoot, "app", "v1");
  await mkdir(staleWorktreeRoot, { recursive: true });
  await mkdir(personalRoot, { recursive: true });
  await mkdir(noncanonicalRoot, { recursive: true });
  for (const [path, id] of [[staleWorktreeRoot, "stale"], [personalRoot, "private"], [noncanonicalRoot, "fixture"]]) {
    await writeFile(join(path, "lazurio.module.json"), JSON.stringify({
      schema_version: "lazurio.module.v1",
      id,
      company: "Acme",
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port: 24002 }],
    }));
  }

  const result = await allocateModulePort({
    conglomerateRoot: root,
    moduleRoot: targetRoot,
    company: "Acme",
    module: "beta",
  });
  expect(result.manifest.port_leases[0].port).toBe(24004);
  await expect(allocateModulePort({
    conglomerateRoot: root,
    moduleRoot: targetRoot,
    company: "Acme",
    module: "beta",
  })).rejects.toThrow("už existuje");

  const worktreeTarget = join(root, "organizations", "Acme", ".worktrees", "workspace", "gamma", "DEV-2");
  await mkdir(worktreeTarget, { recursive: true });
  await expect(allocateModulePort({
    conglomerateRoot: root,
    moduleRoot: worktreeTarget,
    company: "Acme",
    module: "gamma",
  })).rejects.toThrow("nesmí alokovat lease do worktree");
});
