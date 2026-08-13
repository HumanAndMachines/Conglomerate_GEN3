import { expect, test } from "bun:test";
import {
  nextFreeModulePort,
  normalizePortRegistry,
  validateModuleLeasesAgainstRegistry,
} from "./port-registry-lib.mjs";

function registry() {
  return {
    schema_version: "lazurio.port_registry.v1",
    allocation_strategy: "organization-blocks",
    organization_blocks: [
      { company: "alpha", start: 24000, end: 24099 },
      { company: "beta", start: 24100, end: 24199 },
    ],
  };
}

test("central registry owns non-overlapping Organization blocks", () => {
  expect(normalizePortRegistry(registry()).issues).toEqual([]);
  const overlapping = registry();
  overlapping.organization_blocks[1].start = 24099;
  expect(normalizePortRegistry(overlapping).issues.some((issue) => issue.includes("se překrývají"))).toBe(true);
});

test("module lease must stay inside the centrally assigned block", () => {
  const normalized = normalizePortRegistry(registry()).registry;
  const issues = validateModuleLeasesAgainstRegistry({
    registry: normalized,
    modules: [{
      id: "demo",
      company: "alpha",
      module_path: "demo/lazurio.module.json",
      port_leases: [{ id: "main", port: 24101 }],
    }],
  });
  expect(issues).toEqual([
    "demo/lazurio.module.json: lease main port 24101 leží mimo block 24000-24099",
  ]);
});

test("different modules cannot own the same numeric port", () => {
  const normalized = normalizePortRegistry(registry()).registry;
  const issues = validateModuleLeasesAgainstRegistry({
    registry: normalized,
    modules: [
      { id: "one", company: "alpha", module_path: "one", port_leases: [{ id: "main", port: 24001 }] },
      { id: "two", company: "alpha", module_path: "two", port_leases: [{ id: "main", port: 24001 }] },
    ],
  });
  expect(issues).toContain("port 24001 vlastní dva moduly: alpha/one a alpha/two");
});

test("one company/module identity can have only one module-root manifest", () => {
  const normalized = normalizePortRegistry(registry()).registry;
  const issues = validateModuleLeasesAgainstRegistry({
    registry: normalized,
    modules: [
      {
        id: "demo",
        company: "alpha",
        module_path: "modules/demo/lazurio.module.json",
        port_leases: [{ id: "main", port: 24001 }],
      },
      {
        id: "demo",
        company: "alpha",
        module_path: "workspace/demo/lazurio.module.json",
        port_leases: [{ id: "main", port: 24001 }],
      },
    ],
  });
  expect(issues).toContain(
    "alpha/demo má více module-root manifestů: modules/demo/lazurio.module.json a workspace/demo/lazurio.module.json",
  );
});

test("creator selects the first free port only at module creation time", () => {
  const normalized = normalizePortRegistry(registry()).registry;
  expect(nextFreeModulePort({
    registry: normalized,
    company: "alpha",
    modules: [{
      id: "one",
      company: "alpha",
      port_leases: [{ id: "main", port: 24001 }],
    }],
  })).toBe(24002);
});
