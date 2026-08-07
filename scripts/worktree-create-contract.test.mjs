import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorktreeCreateArgs,
  PLAN_CODE_PATTERN,
} from "./worktree-create-contract.mjs";

const cleanupPaths = [];
const createScript = join(import.meta.dir, "worktree-create.mjs");
const validPlan = `schema_version: companiesascode.mission_control.plan.v2
dev_code: CAC-0007
title: "Create lane fixture"
`;

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

test.each([
  "AB-0001",
  "CAC-0085",
  "ABCDEF-9999",
])("accepts canonical Mission Control code %s", (code) => {
  expect(PLAN_CODE_PATTERN.test(code)).toBe(true);
});

test.each([
  "A-0001",
  "ABCDEFG-0001",
  "cac-0085",
  "CAC-85",
])("rejects non-canonical Mission Control code %s", (code) => {
  expect(PLAN_CODE_PATTERN.test(code)).toBe(false);
});

test("parses the supported create-lane arguments", () => {
  expect(parseWorktreeCreateArgs([
    "--plan", "ABCDEF-0001",
    "--branch", "codex/ABCDEF-0001-fixture",
    "--surface", "codex-desktop",
    "--dry-run",
  ])).toEqual({
    plan: "ABCDEF-0001",
    branch: "codex/ABCDEF-0001-fixture",
    surface: "codex-desktop",
    dryRun: true,
  });
});

test.each([
  [["--unknown", "value"], "neznámý argument"],
  [["--plan"], "neúplný argument"],
  [["--surface", "Codex Desktop"], "neplatný formát"],
])("rejects invalid arguments %#", (argv, message) => {
  expect(() => parseWorktreeCreateArgs(argv)).toThrow(message);
});

test("dry-run accepts a unique exact-code plan only after canonical validation", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const result = runCreateLane(fixture);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain("ok - dry-run: plán mission-control/plans/CAC-0007.yaml");
});

test("dry-run rejects a plan whose declared dev_code does not match the request", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan.replace("CAC-0007", "CAC-0008")]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("deklaruje dev_code CAC-0008, očekáváno CAC-0007");
});

test("dry-run fails closed when multiple files claim the same plan code", async () => {
  const fixture = await createLaneFixture({
    plans: [
      ["CAC-0007.yaml", validPlan],
      ["archive/CAC-0007-duplicate.yaml", validPlan],
    ],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("má více kanonických kandidátů");
});

test("dry-run fails closed when the canonical schema rejects the plan", async () => {
  const fixture = await createLaneFixture({
    plans: [[
      "CAC-0007-create-lane.yaml",
      validPlan.replace("companiesascode.mission_control.plan.v2", "invalid.plan"),
    ]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Mission Control plan schema validation failed");
});

async function createLaneFixture({ plans }) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "worktree-create-contract-"));
  cleanupPaths.push(fixtureRoot);
  const root = join(fixtureRoot, "Conglomerate_GEN3");
  const authorityRoot = join(fixtureRoot, "HumanAndMachines");
  const plansRoot = join(authorityRoot, "mission-control", "plans");
  await mkdir(root, { recursive: true });
  await mkdir(plansRoot, { recursive: true });
  await mkdir(join(authorityRoot, "schemas"), { recursive: true });
  await mkdir(join(authorityRoot, "scripts"), { recursive: true });
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n", "utf8");
  for (const [relativePath, contents] of plans) {
    const planPath = join(plansRoot, relativePath);
    await mkdir(join(planPath, ".."), { recursive: true });
    await writeFile(planPath, contents, "utf8");
  }
  await writeFile(
    join(authorityRoot, "schemas", "mission-control-plan.schema.json"),
    `${JSON.stringify({
      type: "object",
      required: ["schema_version", "dev_code", "title"],
      properties: {
        schema_version: { const: "companiesascode.mission_control.plan.v2" },
        dev_code: { type: "string", pattern: "^[A-Z]{2,6}-[0-9]{4}$" },
        title: { type: "string" },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(authorityRoot, "scripts", "json-schema-mini.mjs"),
    `export function validateAgainstSchema(value, schema, label = "$") {
  const failures = [];
  for (const key of schema.required ?? []) {
    if (!(key in value)) failures.push(label + ": missing " + key);
  }
  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    if (!(key in value)) continue;
    if (Object.hasOwn(rule, "const") && value[key] !== rule.const) failures.push(label + "." + key + ": const mismatch");
    if (rule.type === "string" && typeof value[key] !== "string") failures.push(label + "." + key + ": expected string");
    if (rule.pattern && !new RegExp(rule.pattern).test(value[key])) failures.push(label + "." + key + ": pattern mismatch");
  }
  return failures;
}
`,
    "utf8",
  );
  await writeFile(
    join(authorityRoot, "scripts", "mission-control-lib.mjs"),
    `export function loadMissionControlConfig() { return {}; }
export function loadPlanSchema() { return {}; }
export function validatePlanShape() { return []; }
`,
    "utf8",
  );
  for (const args of [
    ["init", "-b", "main"],
    ["remote", "add", "origin", "git@github.com:HumanAndMachines/Conglomerate_GEN3.git"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return { root, authorityRoot };
}

function runCreateLane({ root, authorityRoot }) {
  return spawnSync(process.execPath, [
    createScript,
    "--plan", "CAC-0007",
    "--dry-run",
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HUMANANDMACHINES_ROOT: authorityRoot,
    },
  });
}
