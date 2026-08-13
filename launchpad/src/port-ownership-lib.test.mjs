import { expect, test } from "bun:test";
import {
  buildPortOwnershipIndex,
  findPortOverlaps,
} from "./port-ownership-lib.mjs";

function owner(packagePath, port, overrides = {}) {
  return {
    host: "127.0.0.1",
    scope: "organization",
    visibility: "shared",
    app_id: packagePath.split("/").at(-3) ?? packagePath,
    company: "TestCompany",
    module: "mission-control",
    package_path: packagePath,
    port,
    listener_id: "entrypoint",
    lease_id: "main",
    listener_role: "entrypoint",
    allocation: "static",
    protocol: "http",
    claim_mode: "exclusive",
    claim_group: null,
    legacy: false,
    ...overrides,
  };
}

test("findPortOverlaps returns deterministic owner-aware diagnostics without remapping", () => {
  const owners = [
    owner("organizations/ExampleOrgA_GEN3/mission-control/app/v2/package.json", 5392, {
      app_id: "example-org-a-mission-control-v2",
      company: "ExampleOrgA",
    }),
    owner("organizations/ExampleOrgB_GEN3/mission-control/app/v1/package.json", 5393, {
      app_id: "example-org-b-mission-control-v1",
      company: "ExampleOrgB",
    }),
    owner("organizations/ExampleOrgC_GEN3/mission-control/app/v3/package.json", 5392, {
      app_id: "example-org-c-mission-control-v3",
      company: "ExampleOrgC",
    }),
  ];

  const index = buildPortOwnershipIndex(owners);
  const overlaps = findPortOverlaps(index);

  expect(index.used_ports).toEqual([5392, 5393]);
  expect(overlaps).toHaveLength(1);
  expect(overlaps[0]).toMatchObject({ port: 5392 });
  expect(overlaps[0]).toMatchObject({ classification: "declared-conflict", conflict: true });
  expect(overlaps[0]).not.toHaveProperty("suggested_free_port");
  expect(overlaps[0].owners.map((entry) => entry.package_path)).toEqual([
    "organizations/ExampleOrgA_GEN3/mission-control/app/v2/package.json",
    "organizations/ExampleOrgC_GEN3/mission-control/app/v3/package.json",
  ]);
});

test("only versions of the same module listener may share a port", () => {
  const compatible = buildPortOwnershipIndex([
    owner("organizations/One/app/package.json", 5287, {
      app_id: "one-design-system-v1",
      company: "One",
      module: "design-system",
    }),
    owner("organizations/Two/app/package.json", 5287, {
      app_id: "one-design-system-v2",
      company: "One",
      module: "design-system",
    }),
  ]).overlaps[0];
  expect(compatible).toMatchObject({
    classification: "module-version-lease",
    intentional: true,
    conflict: false,
    module_lease: "One/design-system#main",
  });

  const incompatible = buildPortOwnershipIndex([
    compatible.owners[0],
    { ...compatible.owners[1], company: "Two" },
  ]).overlaps[0];
  expect(incompatible).toMatchObject({ classification: "declared-conflict", conflict: true });
});

test("legacy owners never gain module-lease sharing authority", () => {
  const overlap = buildPortOwnershipIndex([
    owner("organizations/One/app/v1/package.json", 5287, { app_id: "one-v1", company: "One", legacy: true }),
    owner("organizations/One/app/v2/package.json", 5287, { app_id: "one-v2", company: "One" }),
  ]).overlaps[0];

  expect(overlap).toMatchObject({
    classification: "legacy-overlap",
    intentional: false,
    conflict: true,
    module_lease: null,
  });
});

test("port ownership is global across local bind hosts", () => {
  const overlap = buildPortOwnershipIndex([
    owner("organizations/One/app/package.json", 5392, { host: "localhost", company: "One" }),
    owner("organizations/Two/app/package.json", 5392, { host: "127.0.0.1", company: "Two" }),
  ]).overlaps[0];

  expect(overlap).toMatchObject({ endpoint: "*:5392", host: "*", port: 5392, conflict: true });
});

test("IPv6 and IPv4 declarations still collide by numeric port", () => {
  const overlap = buildPortOwnershipIndex([
    owner("organizations/One/app/package.json", 5392, { host: "::1", company: "One" }),
    owner("organizations/Two/app/package.json", 5392, { host: "127.0.0.1", company: "Two" }),
  ]).overlaps[0];

  expect(overlap).toMatchObject({ endpoint: "*:5392", host: "*", port: 5392, conflict: true });
});

test("different versions of one module must declare the same listener endpoint", () => {
  const index = buildPortOwnershipIndex([
    owner("organizations/One/app/v1/package.json", 24001, { app_id: "one-v1", company: "One" }),
    owner("organizations/One/app/v2/package.json", 24002, { app_id: "one-v2", company: "One" }),
  ]);

  expect(index.overlaps).toEqual([]);
  expect(index.module_listener_drifts).toMatchObject([{
    module_lease: "One/mission-control#main",
    classification: "module-listener-drift",
    conflict: true,
  }]);
});
