import { expect, test } from "bun:test";
import {
  organizationHash,
  parseLaunchpadHash,
  personalspaceHash,
  resolveLaunchpadHash,
} from "../public/deep-link.js";

const companies = [
  { slug: "Macano-Tech", display_name: "Macano-Tech" },
  { slug: "Lumbio", display_name: "Lumbio" },
];

test("Organization deep-link zachová a znovu přečte přesný company slug", () => {
  const hash = organizationHash("Macano-Tech");
  expect(hash).toBe("#/org/Macano-Tech");
  expect(parseLaunchpadHash(hash)).toEqual({
    kind: "organization",
    organization: "Macano-Tech",
  });
  expect(resolveLaunchpadHash(hash, { companies })).toMatchObject({
    status: "matched",
    scope: "org",
    company: "Macano-Tech",
  });
});

test("Personalspace má stabilní local-only route bez username nebo osobních dat", () => {
  expect(personalspaceHash()).toBe("#/personalspace");
  expect(resolveLaunchpadHash(personalspaceHash(), { personalspaceAvailable: true })).toMatchObject({
    status: "matched",
    scope: "personal",
    company: "all",
  });
  expect(resolveLaunchpadHash(personalspaceHash(), { personalspaceAvailable: false }).status).toBe("unavailable");
});

test("Root bez scope zachová současný default a neplatné route failují bezpečně", () => {
  expect(resolveLaunchpadHash("", { companies }).status).toBe("none");
  expect(resolveLaunchpadHash("#/", { companies }).status).toBe("none");
  expect(resolveLaunchpadHash("#/org/Unknown", { companies }).status).toBe("not_found");
  expect(resolveLaunchpadHash("#/org/%E0%A4%A", { companies }).status).toBe("invalid");
  expect(resolveLaunchpadHash("#/org/..", { companies }).status).toBe("invalid");
  expect(resolveLaunchpadHash("#/org/Org/module/secrets", { companies }).status).toBe("invalid");
});

test("Deep-link builder odmítne prázdné a path-like Organization slugy", () => {
  expect(() => organizationHash("")).toThrow(TypeError);
  expect(() => organizationHash("../OtherOrg")).toThrow(TypeError);
  expect(() => organizationHash("Org\\Other")).toThrow(TypeError);
});
