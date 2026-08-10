import { expect, test } from "bun:test";
import {
  isCanonicalOrganizationRepositorySlotPath,
  isOrganizationRootSlotPath,
  organizationSlotScope,
} from "./organization-slot-scope-lib.mjs";

test("explicitní root scope podporuje další budoucí moduly Organizace", () => {
  const futureModule = { path: "compliance", space: "root" };

  expect(isOrganizationRootSlotPath(futureModule.path, futureModule)).toBe(true);
  expect(isCanonicalOrganizationRepositorySlotPath(futureModule.path, futureModule)).toBe(true);
  expect(organizationSlotScope(futureModule)).toBe("root");
});

test("fyzické Workspace a Productionspace hranice mají přednost před chybným space", () => {
  expect(organizationSlotScope({ path: "workspace/compliance", space: "root" })).toBe("workspace");
  expect(organizationSlotScope({ path: "productionspace/firmware", space: "root" })).toBe("productionspace");
  expect(isCanonicalOrganizationRepositorySlotPath("company/compliance", { space: "root" })).toBe(false);
});
