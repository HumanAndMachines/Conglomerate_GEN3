import { expect, test } from "bun:test";
import { semanticAppIconKey } from "../public/app-icon-key.js";

test("semantic app icons follow the module function used in GEN2", () => {
  expect(semanticAppIconKey({ module: "deals" })).toBe("deal");
  expect(semanticAppIconKey({ module: "warehouse" })).toBe("warehouse");
  expect(semanticAppIconKey({ module: "products" })).toBe("product");
  expect(semanticAppIconKey({ module: "pricebook" })).toBe("pricebook");
  expect(semanticAppIconKey({ module: "invoices" })).toBe("invoice");
  expect(semanticAppIconKey({ module: "installations" })).toBe("installation");
  expect(semanticAppIconKey({ module: "dashboard" })).toBe("dashboard");
  expect(semanticAppIconKey({ module: "profitability" })).toBe("profitability");
  expect(semanticAppIconKey({ module: "datasheets" })).toBe("datasheet");
  expect(semanticAppIconKey({ module: "knowledgebase" })).toBe("book");
  expect(semanticAppIconKey({ module: "marketing" })).toBe("marketing");
  expect(semanticAppIconKey({ module: "website" })).toBe("website");
  expect(semanticAppIconKey({ module: "examples" })).toBe("examples");
});

test("filesystem tag cannot turn a datasheet into a design palette", () => {
  expect(
    semanticAppIconKey({
      module: "datasheets",
      id: "omegaco-datasheets-v1",
      tags: ["datasheets", "engineering", "filesystem-db-v2"],
    }),
  ).toBe("datasheet");
  expect(semanticAppIconKey({ module: "design-system", tags: ["brand"] })).toBe("palette");
  expect(semanticAppIconKey({ module: "infra" })).toBe("system");
});

test("a known manifest icon remains authoritative", () => {
  expect(semanticAppIconKey({ module: "datasheets", icon: "book" })).toBe("book");
  expect(semanticAppIconKey({ module: "datasheets", icon: "unknown-icon" })).toBe("datasheet");
});
