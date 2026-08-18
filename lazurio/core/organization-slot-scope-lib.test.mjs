import { describe, expect, test } from "bun:test";

import { organizationSlotUiExposure } from "./organization-slot-scope-lib.mjs";

describe("organizationSlotUiExposure", () => {
  test("respects an explicit diagnostics-only workspace declaration", () => {
    expect(organizationSlotUiExposure({
      path: "workspace/tender-intake",
      ui_exposure: "diagnostics-only",
    })).toBe("diagnostics-only");
  });

  test("allows a diagnostics-only default to be explicitly presented as a module", () => {
    expect(organizationSlotUiExposure({
      path: "mission-control/db",
      ui_exposure: "module",
    })).toBe("module");
  });

  test("ignores unknown presentation values and keeps the safe default", () => {
    expect(organizationSlotUiExposure({
      path: "workspace/example",
      ui_exposure: "hidden",
    })).toBe("module");
  });
});
