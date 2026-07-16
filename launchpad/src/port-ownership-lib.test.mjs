import { expect, test } from "bun:test";
import {
  buildPortOwnershipIndex,
  findPortCollisions,
  suggestNextFreePort,
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

test("suggestNextFreePort starts after the colliding port and wraps within schema range", () => {
  expect(suggestNextFreePort([1024, 5392, 5393], { afterPort: 5392 })).toBe(5394);
  expect(suggestNextFreePort([65535, 1024], { afterPort: 65535 })).toBe(1025);
  expect(suggestNextFreePort([1024, 1025], { afterPort: 1024, minPort: 1024, maxPort: 1025 })).toBeNull();
});

test("findPortCollisions returns owner-aware diagnostics and deterministic suggestion", () => {
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
  const collisions = findPortCollisions(index);

  expect(index.used_ports).toEqual([5392, 5393]);
  expect(collisions).toHaveLength(1);
  expect(collisions[0]).toMatchObject({
    port: 5392,
    suggested_free_port: 5394,
  });
  expect(collisions[0].owners.map((entry) => entry.package_path)).toEqual([
    "organizations/ExampleOrgA_GEN3/mission-control/app/v2/package.json",
    "organizations/ExampleOrgC_GEN3/mission-control/app/v3/package.json",
  ]);
});
