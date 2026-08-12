import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
id: mcplan-cac-0007
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
  expect(result.stdout).toContain(
    "ok - dry-run: plán mission-control/db/data/mission-control/plans/CAC-0007.yaml",
  );
});

test("dry-run rejects a plan whose declared dev_code does not match the request", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan.replaceAll("0007", "0008")]],
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

test("dry-run ignores retired legacy plan copies when repository-db owns the plan", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
    legacyPlans: [["CAC-0007-stale.yaml", validPlan.replace('title: "Create lane fixture"', 'title: "Stale legacy copy"')]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "mission-control/db/data/mission-control/plans/CAC-0007.yaml",
  );
});

test("dry-run rejects a legacy-only plan", async () => {
  const fixture = await createLaneFixture({
    plans: [],
    legacyPlans: [["CAC-0007.yaml", validPlan]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("nebyl nalezen v HumanAndMachine-ai authority checkoutu");
});

test("dry-run rejects a repository-db plans root redirected to retired legacy plans", async () => {
  const fixture = await createLaneFixture({
    plans: [],
    legacyPlans: [["CAC-0007.yaml", validPlan]],
  });
  const canonicalPlansRoot = join(
    fixture.authorityRoot,
    "mission-control",
    "db",
    "data",
    "mission-control",
    "plans",
  );
  const legacyPlansRoot = join(fixture.authorityRoot, "mission-control", "plans");
  await rm(canonicalPlansRoot, { recursive: true });
  await symlink(
    legacyPlansRoot,
    canonicalPlansRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "canonical repository-db plan root resolves through a redirected path",
  );
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

test("dry-run fails closed when repository-db semantic validation rejects the plan", async () => {
  const fixture = await createLaneFixture({
    plans: [[
      "CAC-0007-create-lane.yaml",
      validPlan.replace('title: "Create lane fixture"', 'title: "Semantically invalid"'),
    ]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Mission Control repository-db semantic validation failed");
});

async function createLaneFixture({ plans, legacyPlans = [] }) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "worktree-create-contract-"));
  cleanupPaths.push(fixtureRoot);
  const root = join(fixtureRoot, "Conglomerate_GEN3");
  const authorityRoot = join(root, "organizations", "HumanAndMachine-ai_GEN3");
  const repositoryDbRoot = join(authorityRoot, "mission-control", "db");
  const plansRoot = join(repositoryDbRoot, "data", "mission-control", "plans");
  const legacyPlansRoot = join(authorityRoot, "mission-control", "plans");
  const semanticValidatorPath = join(
    repositoryDbRoot,
    "scripts",
    "validate-mission-control-data.mjs",
  );
  await mkdir(root, { recursive: true });
  await mkdir(plansRoot, { recursive: true });
  await mkdir(join(repositoryDbRoot, "schemas"), { recursive: true });
  await mkdir(join(semanticValidatorPath, ".."), { recursive: true });
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n", "utf8");
  for (const [relativePath, contents] of plans) {
    const planPath = join(plansRoot, relativePath);
    await mkdir(join(planPath, ".."), { recursive: true });
    await writeFile(planPath, contents, "utf8");
  }
  for (const [relativePath, contents] of legacyPlans) {
    const planPath = join(legacyPlansRoot, relativePath);
    await mkdir(join(planPath, ".."), { recursive: true });
    await writeFile(planPath, contents, "utf8");
  }
  await writeFile(
    join(repositoryDbRoot, "schemas", "mission-control-plan.schema.json"),
    `${JSON.stringify({
      type: "object",
      required: ["schema_version", "id", "dev_code", "title"],
      properties: {
        schema_version: { const: "companiesascode.mission_control.plan.v2" },
        id: { type: "string", pattern: "^mcplan-[a-z]{2,6}-[0-9]{4}$" },
        dev_code: { type: "string", pattern: "^[A-Z]{2,6}-[0-9]{4}$" },
        title: { type: "string" },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    semanticValidatorPath,
    `import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
function planSources(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && /\\.ya?ml$/.test(entry.name)) files.push(readFileSync(target, "utf8"));
    }
  };
  walk(join(root, "data", "mission-control", "plans"));
  return files;
}
export function validateMissionControlData(root) {
  return planSources(root).some((source) => source.includes('title: "Semantically invalid"'))
    ? ["semantic fixture rejection"]
    : [];
}
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

function runCreateLane({ root }) {
  const env = { ...process.env };
  delete env.LAZURIO_MISSION_CONTROL_ROOT;
  delete env.HUMANANDMACHINES_ROOT;
  return spawnSync(process.execPath, [
    createScript,
    "--plan", "CAC-0007",
    "--dry-run",
  ], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}
