// Konformní test producenta (decision 0118).
//
// Root doctor je od téhle změny jedním z doctorů na společném surfacu, a proto
// se měří stejným metrem jako každý mount: produkuje validní v3 report, souhrn
// odvozený JEDINOU funkcí, exit kód odpovídající reportu, `blocked` nese
// `remedy` a `not_applicable` nese `owner`.
//
// Druhá polovina mechanismu (rozbitý potomek shodí agregát) je v
// `doctor-children-lib.test.mjs`.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DOCTOR_REPORT_SCHEMA_VERSION_V3,
  buildSummary,
  exitCodeForSummaryStatus,
  loadDoctorReportSchema,
  satisfiesGate,
  summarizeStatus,
  validateDoctorReport,
} from "./doctor-surface-lib.mjs";
import { buildDoctorReportFromAppsResponse } from "./diagnostics-lib.mjs";

const launchpadRoot = join(import.meta.dirname, "..");
const schema = loadDoctorReportSchema(launchpadRoot);

function appsResponseFixture(overrides = {}) {
  return {
    launchpad_root: { display_name: "Test root" },
    root: "/tmp/test-root",
    failures: [],
    warnings: [],
    apps: [],
    organizations: [],
    port_overlaps: [],
    ...overrides,
  };
}

test("vendorovaná kopie schématu nese v3 a obě polarity verzní brány", () => {
  const raw = JSON.parse(readFileSync(join(launchpadRoot, "schemas", "doctor-report.schema.json"), "utf8"));

  expect(raw.properties.schema_version.enum).toContain(DOCTOR_REPORT_SCHEMA_VERSION_V3);
  expect(raw.properties.checks.items.properties.status.enum).toContain("not_applicable");
  expect(raw.properties.checks.items.properties.status.enum).toContain("blocked");
  expect(raw.properties.summary.properties.status.enum).toContain("incomplete");
  expect(raw.properties.children).toBeTruthy();
  // children[].report je rekurzivní odkaz na celé schéma — kopie toho tvaru na
  // druhém místě by se rozešla.
  expect(raw.properties.children.items.properties.report.$ref).toBe("#");
});

test("root doctor produkuje validní v3 report", () => {
  const report = buildDoctorReportFromAppsResponse(appsResponseFixture(), { schema });

  expect(report.schema_version).toBe(DOCTOR_REPORT_SCHEMA_VERSION_V3);
  expect(report.scope.type).toBe("launchpad_root");
  expect(validateDoctorReport(report, { schema, label: "root" })).toEqual([]);
});

test("root doctor nikdy nevydá legacy 'skip'", () => {
  const report = buildDoctorReportFromAppsResponse(
    appsResponseFixture({ failures: ["organizations: mount chybí"] }),
    { schema },
  );

  expect(report.checks.some((check) => check.status === "skip")).toBe(false);
  expect(report.summary.skip).toBeUndefined();
  expect(report.summary.not_applicable).toBeGreaterThanOrEqual(0);
  expect(report.summary.blocked).toBeGreaterThanOrEqual(0);
});

test("každý blocked nese remedy a každý not_applicable nese ownera", () => {
  const report = buildDoctorReportFromAppsResponse(
    appsResponseFixture({ failures: ["organizations: mount chybí"] }),
    { schema },
  );

  for (const check of report.checks) {
    if (check.status === "blocked") {
      expect(check.blocked_reason?.length).toBeGreaterThan(0);
      expect(check.remedy?.length).toBeGreaterThan(0);
    }
    if (check.status === "not_applicable") {
      expect(check.owner?.length).toBeGreaterThan(0);
      expect(["owned_by_root", "no_such_mount", "not_declared"]).toContain(check.not_applicable_reason);
    }
  }
});

test("souhrn je odvozený jedinou funkcí, ne ručně dopsaný", () => {
  const report = buildDoctorReportFromAppsResponse(appsResponseFixture(), { schema });

  expect(report.summary).toEqual(buildSummary(report.checks));
  expect(report.summary.status).toBe(summarizeStatus(report.checks));
});

test("nezapojená children lane je blocked, ne tichá zelená", () => {
  // Kdo zavolá builder bez `childLane`, dostane report, který o podřízených
  // doctorech PŘIZNÁ, že je nesvolával. Tohle je ten fail-closed default, kvůli
  // kterému zapomenuté napojení nevypadá jako root bez deklarovaných doctorů.
  const report = buildDoctorReportFromAppsResponse(appsResponseFixture(), { schema });
  const check = report.checks.find((item) => item.id === "doctor.children");

  expect(check?.status).toBe("blocked");
  expect(check?.remedy?.length).toBeGreaterThan(0);
  expect(report.summary.status).toBe("incomplete");
  expect(satisfiesGate(report.summary.status)).toBe(false);
  expect(exitCodeForSummaryStatus(report.summary.status)).toBe(2);
});

test("incomplete nesplní bránu, i když v reportu není jediný fail", () => {
  const report = buildDoctorReportFromAppsResponse(appsResponseFixture(), { schema });

  expect(report.summary.fail).toBe(0);
  expect(report.summary.blocked).toBeGreaterThan(0);
  expect(satisfiesGate(report.summary.status)).toBe(false);
});

test("self conformance check pojmenuje porušení schématu místo tiché zelené", () => {
  // Nekonformní id (velká písmena) — přesně ten tvar, který dnes vzniká z app id
  // některých Organizací. Kontrola musí být fail, ne mlčení.
  const report = buildDoctorReportFromAppsResponse(
    appsResponseFixture({
      apps: [{
        id: "ExampleOrg-App-v1",
        company: "ExampleOrg",
        module: "app",
        runtime: { status: "stopped" },
        dependencies: { state: "ok" },
      }],
    }),
    { schema },
  );
  const check = report.checks.find((item) => item.id === "doctor.self_conformance");

  expect(check?.status).toBe("fail");
  expect(check.details.join(" ")).toContain("neodpovídá pattern");
  expect(report.summary.status).toBe("fail");
});

test("bez schématu se self conformance netváří, že proběhla", () => {
  const report = buildDoctorReportFromAppsResponse(appsResponseFixture());

  expect(report.checks.some((check) => check.id === "doctor.self_conformance")).toBe(false);
});

test("rozbitý potomek se v reportu objeví PRÁVĚ JEDNOU", () => {
  // Regrese: self conformance check se přidává až nad hotovým agregátem. Kdyby
  // se ten agregát kvůli němu stavěl podruhé, syntetizoval by `doctor.child.N`
  // znovu a jedna vada by v panelu svítila dvakrát.
  const brokenChild = {
    declaration_path: "organizations/ExampleOrg_GEN3/company.gen3.json",
    mount_path: "organizations/ExampleOrg_GEN3",
    invoked_command: ["bun", "scripts/doctor.mjs"],
    outcome: "no_report",
    failures: ["Podřízený doctor nevypsal na stdout žádný report."],
  };
  const report = buildDoctorReportFromAppsResponse(appsResponseFixture(), {
    schema,
    childLane: { children: [brokenChild], checks: [] },
  });

  const defects = report.checks.filter((check) => check.id === "doctor.child.0");
  expect(defects).toHaveLength(1);
  expect(defects[0].status).toBe("fail");
  expect(report.summary.status).toBe("fail");
  expect(report.summary).toEqual(buildSummary(report.checks));
  expect(validateDoctorReport(report, { schema, label: "root" })).toEqual([]);
});

test("checks vnořené v children[] se do souhrnu započítají, ale nezdvojí", () => {
  const childReport = {
    schema_version: DOCTOR_REPORT_SCHEMA_VERSION_V3,
    scope: { type: "organization", path: ".", name: "ExampleOrg" },
    summary: { status: "warn", ok: 1, warn: 1, fail: 0, not_applicable: 0, blocked: 0 },
    checks: [
      { id: "example.a", status: "ok", severity: "required", title: "A", message: "ok" },
      { id: "example.b", status: "warn", severity: "required", title: "B", message: "warn" },
    ],
  };
  const report = buildDoctorReportFromAppsResponse(appsResponseFixture(), {
    schema,
    childLane: {
      children: [{
        declaration_path: "organizations/ExampleOrg_GEN3/company.gen3.json",
        mount_path: "organizations/ExampleOrg_GEN3",
        invoked_command: ["bun", "scripts/doctor.mjs"],
        outcome: "report",
        failures: [],
        report: childReport,
      }],
      checks: [],
    },
  });

  // Souhrn nese jeden warn dítěte navíc oproti vlastním checkům rodiče.
  const ownSummary = buildSummary(report.checks);
  expect(report.summary.warn).toBe(ownSummary.warn + 1);
  expect(report.summary.ok).toBe(ownSummary.ok + 1);
  expect(validateDoctorReport(report, { schema, label: "root" })).toEqual([]);
});
