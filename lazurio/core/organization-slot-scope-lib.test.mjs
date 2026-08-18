import { describe, expect, test } from "bun:test";

import {
  organizationSlotCatalogPresentation,
  organizationSlotUiExposure,
} from "./organization-slot-scope-lib.mjs";

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

  test("keeps an unknown override on an existing diagnostics-only default", () => {
    expect(organizationSlotUiExposure({
      path: "mission-control/db",
      ui_exposure: "hidden",
    })).toBe("diagnostics-only");
  });
});

describe("organizationSlotCatalogPresentation", () => {
  test("normalizes the human description and exposure in one Core result", () => {
    expect(organizationSlotCatalogPresentation({
      path: "workspace/current",
      description: "  Srozumitelný popis modulu.  ",
      ui_exposure: " DIAGNOSTICS-ONLY ",
    })).toEqual({
      description: "Srozumitelný popis modulu.",
      ui_exposure: "diagnostics-only",
    });
  });

  test("uses null for an absent description and preserves Core classification", () => {
    expect(organizationSlotCatalogPresentation({
      path: "mission-control/db",
      description: "   ",
    })).toEqual({
      description: null,
      ui_exposure: "diagnostics-only",
    });
  });

  test("rejects non-string manifest descriptions without changing exposure", () => {
    expect(organizationSlotCatalogPresentation({
      path: "workspace/current",
      description: 42,
    })).toEqual({
      description: null,
      ui_exposure: "module",
    });
  });
});
