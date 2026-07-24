import { expect, test } from "bun:test";
import {
  buildPortOwnershipIndex,
  findPortOverlaps,
} from "./port-ownership-lib.mjs";

function owner(packagePath, port, overrides = {}) {
  return {
    scope: "organization",
    visibility: "shared",
    app_id: packagePath.split("/").at(-3) ?? packagePath,
    company: "TestCompany",
    module: "mission-control",
    package_path: packagePath,
    port,
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
  expect(overlaps[0]).not.toHaveProperty("suggested_free_port");
  expect(overlaps[0].owners.map((entry) => entry.package_path)).toEqual([
    "organizations/ExampleOrgA_GEN3/mission-control/app/v2/package.json",
    "organizations/ExampleOrgC_GEN3/mission-control/app/v3/package.json",
  ]);
});
