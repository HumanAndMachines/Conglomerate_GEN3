import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateOfflinePack } from "../scripts/offline-eval-runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, "..");

function withPackCopy(fn) {
  const tempRoot = mkdtempSync(join(tmpdir(), "ceo-double-offline-eval-"));
  const copy = join(tempRoot, "pack");
  cpSync(packRoot, copy, { recursive: true });
  try {
    return fn(copy);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("CEO Double offline eval runner", () => {
  test("mechanicky vyhodnotí všech 46 syntetických případů bez nástrojů a externích akcí", () => {
    const report = evaluateOfflinePack(packRoot);

    expect(report.status).toBe("PASS");
    expect(report.dry_run_only).toBe(true);
    expect(report.summary).toEqual({ total: 46, passed: 46, failed: 0 });
    expect(report.scenario_execution).toEqual({
      scenarios: 46,
      executed_assertions: 46,
      unexecuted_cases: 0,
    });
    expect(report.required_categories).toEqual({
      happy_path: true,
      boundary: true,
      access_denied: true,
      tool_failure: true,
      regression: true,
    });
    expect(report.tool_calls_executed).toEqual([]);
    expect(report.external_actions_executed).toEqual([]);
    expect(report.activation.runtime).toBe(false);
    expect(report.activation.schedule).toBe(false);
    expect(report.activation.connectors).toBe(false);
    expect(report.activation.gbrain_write).toBe(false);
    expect(report.financial_checks).toEqual({
      unpaid: "2584702.47",
      advances_sum: "1079358.85",
    });
    expect(report.cases.every((entry) => entry.status === "PASS")).toBe(true);
  });

  test("selže zavřeně při jiném než fixture zdroji", () => withPackCopy((copy) => {
    const casesPath = join(copy, "evals", "cases.json");
    const cases = JSON.parse(readFileSync(casesPath, "utf8"));
    cases.cases[0].input.fixture = "https://live.invalid/customer-record";
    writeFileSync(casesPath, `${JSON.stringify(cases, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.cases.find((entry) => entry.id === "happy-lumbio-complete-object").failures)
      .toContain("input fixture must use fixture://");
  }));

  test("ignoruje vlastní výstupní adresář při opakovaném běhu", () => withPackCopy((copy) => {
    const resultsPath = join(copy, "evals", "results");
    mkdirSync(resultsPath, { recursive: true });
    writeFileSync(join(resultsPath, "offline-eval-report.json"), "");

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("PASS");
    expect(report.summary).toEqual({ total: 46, passed: 46, failed: 0 });
  }));

  test("selže zavřeně při deklarované externí akci v expected outputu", () => withPackCopy((copy) => {
    const outputPath = join(copy, "evals", "expected", "happy-complete-output.json");
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    output.external_actions_executed = ["synthetic-send"];
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.global_failures).toContain(
      "evals/expected/happy-complete-output.json declares external actions",
    );
  }));

  test("selže zavřeně, když případ nemá spustitelné scenario assertions", () => withPackCopy((copy) => {
    const scenariosPath = join(copy, "evals", "fixtures", "scenario-contracts.json");
    const scenarios = JSON.parse(readFileSync(scenariosPath, "utf8"));
    scenarios.scenarios = scenarios.scenarios.filter(
      (scenario) => scenario.case_id !== "regression-due-today-not-overdue",
    );
    writeFileSync(scenariosPath, `${JSON.stringify(scenarios, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.cases.find((entry) => entry.id === "regression-due-today-not-overdue").failures)
      .toContain("missing executable scenario assertions");
  }));

  test("selže zavřeně při aktivovaném runtime flagu v release kontraktu", () => withPackCopy((copy) => {
    const packPath = join(copy, "agent-pack.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    pack.release.runtime_enabled = true;
    writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.global_failures).toContain("runtime is enabled");
  }));

  test("selže zavřeně při překročení decision limitu", () => withPackCopy((copy) => {
    const outputPath = join(copy, "evals", "expected", "happy-complete-output.json");
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    output.decision_cards = Array.from({ length: 6 }, (_, index) => ({ id: `synthetic-${index}` }));
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.global_failures).toContain(
      "evals/expected/happy-complete-output.json exceeds decision limit",
    );
  }));

  test("selže zavřeně při chybějícím release aktivačním flagu", () => withPackCopy((copy) => {
    const packPath = join(copy, "agent-pack.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    delete pack.release.schedule_enabled;
    writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.global_failures).toContain("schedule is enabled");
  }));

  test("selže zavřeně při nefixture source_refs poli", () => withPackCopy((copy) => {
    const outputPath = join(copy, "evals", "expected", "happy-complete-output.json");
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    output.metrics[0].source_refs = ["https://live.invalid/raw"];
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.global_failures).toContain(
      "evals/expected/happy-complete-output.json has a non-fixture source_ref",
    );
  }));

  test("selže zavřeně při skalárním source_refs", () => withPackCopy((copy) => {
    const outputPath = join(copy, "evals", "expected", "happy-complete-output.json");
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    output.metrics[0].source_refs = "https://live.invalid/raw";
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.global_failures).toContain(
      "evals/expected/happy-complete-output.json has malformed source_refs",
    );
  }));

  test("selže zavřeně při nástroji ve druhé callable allowlistě", () => withPackCopy((copy) => {
    const packPath = join(copy, "agent-pack.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    pack.access.current_callable_tools = ["synthetic-read-tool"];
    writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.global_failures).toContain("access callable tool allowlist is not empty");
  }));

  test("selže zavřeně při assertion bez expected", () => withPackCopy((copy) => {
    const scenariosPath = join(copy, "evals", "fixtures", "scenario-contracts.json");
    const scenarios = JSON.parse(readFileSync(scenariosPath, "utf8"));
    delete scenarios.scenarios[0].assertions[0].expected;
    writeFileSync(scenariosPath, `${JSON.stringify(scenarios, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.cases[0].failures).toContain("unsupported or malformed scenario assertion");
  }));

  test("selže zavřeně při fixture mimo explicitní katalog", () => withPackCopy((copy) => {
    const casesPath = join(copy, "evals", "cases.json");
    const cases = JSON.parse(readFileSync(casesPath, "utf8"));
    cases.cases[0].input.fixture = "fixture://catalog-miss";
    writeFileSync(casesPath, `${JSON.stringify(cases, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.cases[0].failures).toContain("input fixture is not present in fixture catalog");
  }));

  test("selže zavřeně při rozporu decision limitů", () => withPackCopy((copy) => {
    const packPath = join(copy, "agent-pack.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    pack.outputs.find((output) => output.type === "ceo_decision_brief_draft").max_decisions = 4;
    writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.global_failures).toContain("decision limits are inconsistent");
  }));

  test("selže zavřeně při zděděné nebo nebezpečné assertion cestě", () => withPackCopy((copy) => {
    const scenariosPath = join(copy, "evals", "fixtures", "scenario-contracts.json");
    const scenarios = JSON.parse(readFileSync(scenariosPath, "utf8"));
    scenarios.scenarios[0].assertions[0] = {
      path: "constructor.name",
      op: "eq",
      expected: "Object",
    };
    writeFileSync(scenariosPath, `${JSON.stringify(scenarios, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.cases[0].failures).toContain("unsafe or inherited scenario path: constructor.name");
  }));

  test("selže zavřeně při změně kanonické vazby case na fixture", () => withPackCopy((copy) => {
    const casesPath = join(copy, "evals", "cases.json");
    const scenariosPath = join(copy, "evals", "fixtures", "scenario-contracts.json");
    const cases = JSON.parse(readFileSync(casesPath, "utf8"));
    const scenarios = JSON.parse(readFileSync(scenariosPath, "utf8"));
    cases.cases[0].input.fixture = "fixture://partial-missing-bank";
    scenarios.fixture_catalog = scenarios.fixture_catalog.filter(
      (fixture) => fixture !== "fixture://happy-complete",
    );
    writeFileSync(casesPath, `${JSON.stringify(cases, null, 2)}\n`);
    writeFileSync(scenariosPath, `${JSON.stringify(scenarios, null, 2)}\n`);

    const report = evaluateOfflinePack(copy);
    expect(report.status).toBe("FAIL");
    expect(report.cases[0].failures).toContain("input fixture does not match runner contract");
  }));

  test("selže zavřeně při nekanonické finanční operaci", () => withPackCopy((copy) => {
    const casesPath = join(copy, "evals", "cases.json");
    const baseline = JSON.parse(readFileSync(casesPath, "utf8"));
    const invoiceIndex = baseline.cases.findIndex(
      (entry) => entry.id === "financial-fixture-invoice-difference",
    );
    const advancesIndex = baseline.cases.findIndex(
      (entry) => entry.id === "financial-fixture-advances-sum",
    );
    const mutations = [
      (cases) => {
        const first = cases[invoiceIndex].input.operation;
        cases[invoiceIndex].input.operation = cases[advancesIndex].input.operation;
        cases[advancesIndex].input.operation = first;
      },
      (cases) => delete cases[invoiceIndex].input.operation,
      (cases) => { cases[invoiceIndex].input.operation = "unknown_operation"; },
    ];

    for (const mutate of mutations) {
      const document = structuredClone(baseline);
      mutate(document.cases);
      writeFileSync(casesPath, `${JSON.stringify(document, null, 2)}\n`);
      const report = evaluateOfflinePack(copy);
      expect(report.status).toBe("FAIL");
      expect(report.cases[invoiceIndex].failures).toContain(
        "input operation does not match runner contract",
      );
    }
  }));
});
