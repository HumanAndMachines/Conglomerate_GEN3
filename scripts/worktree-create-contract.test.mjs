import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  expect(result.stdout).toContain("ok - dry-run: plán data/mission-control/plans/CAC-0007.yaml");
});

test("dry-run accepts an Organization-scoped repository-db authority", async () => {
  const fixture = await createRepositoryDbLaneFixture();
  const result = runOrganizationCreateLane(fixture);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(
    "ok - dry-run: plán data/mission-control/plans/2026/07/CAC-0007-create-lane.yaml",
  );
});

test("dry-run rejects an explicit external repository-db authority", async () => {
  const fixture = await createRepositoryDbLaneFixture();
  const externalAuthorityRoot = join(
    dirname(fixture.root),
    "external-repository-db-authority",
  );
  await cp(
    join(fixture.organizationRoot, "mission-control", "db"),
    externalAuthorityRoot,
    { recursive: true },
  );
  const result = runCreateLane({
    root: fixture.root,
    authorityRoot: externalAuthorityRoot,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "nový worktree vyžaduje Mission Control authority",
  );
});

test.skipIf(process.platform === "win32")("dry-run rejects a symlinked Organization authority component", async () => {
  const fixture = await createRepositoryDbLaneFixture();
  const databaseRoot = join(fixture.organizationRoot, "mission-control", "db");
  const externalAuthorityRoot = join(dirname(fixture.root), "symlink-target-db");
  await cp(databaseRoot, externalAuthorityRoot, { recursive: true });
  await rm(databaseRoot, { recursive: true, force: true });
  await symlink(externalAuthorityRoot, databaseRoot, "dir");
  const result = runOrganizationCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("obsahuje symlink nebo neadresářovou komponentu");
});

test("dry-run fails closed when multiple Organizations claim the same plan code", async () => {
  const fixture = await createRepositoryDbLaneFixture();
  await cp(
    fixture.organizationRoot,
    join(fixture.root, "organizations", "SecondOrganization_GEN3"),
    { recursive: true },
  );
  const result = runOrganizationCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("nalezen ve více Organization Mission Control autoritách");
});

test("dry-run ignores an unrelated partial Organization authority", async () => {
  const fixture = await createRepositoryDbLaneFixture();
  const partialAuthorityRoot = join(
    fixture.root,
    "organizations",
    "AA-PartialOrganization_GEN3",
    "mission-control",
    "db",
  );
  await mkdir(partialAuthorityRoot, { recursive: true });
  await writeFile(
    join(partialAuthorityRoot, "repository-db.manifest.json"),
    '{"schema_version":"companiesascode.repository_db.manifest.v1","data_mode":"repository-db","data_root":"data/mission-control"}\n',
    "utf8",
  );
  const result = runOrganizationCreateLane(fixture);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(
    "ok - dry-run: plán data/mission-control/plans/2026/07/CAC-0007-create-lane.yaml",
  );
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
  const organizationRoot = join(root, "organizations", "TestOrganization_GEN3");
  const authorityRoot = join(organizationRoot, "mission-control", "db");
  const plansRoot = join(authorityRoot, "data", "mission-control", "plans");
  await mkdir(plansRoot, { recursive: true });
  await mkdir(join(authorityRoot, "schemas"), { recursive: true });
  await mkdir(join(authorityRoot, "scripts"), { recursive: true });
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n", "utf8");
  await writeFile(
    join(organizationRoot, "company.gen3.json"),
    '{"organization_kind":"organization"}\n',
    "utf8",
  );
  await writeFile(
    join(authorityRoot, "repository-db.manifest.json"),
    `${JSON.stringify({
      schema_version: "companiesascode.repository_db.manifest.v1",
      data_mode: "repository-db",
      data_root: "data/mission-control",
    }, null, 2)}\n`,
    "utf8",
  );
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
    join(authorityRoot, "scripts", "validate-mission-control-data.mjs"),
    "export function validateMissionControlData() { return []; }\n",
    "utf8",
  );
  for (const args of [
    ["init", "-b", "main"],
    ["remote", "add", "origin", "git@github.com:TestProvider/Lazurio.git"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return { root, authorityRoot };
}

async function createRepositoryDbLaneFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "worktree-create-repository-db-"));
  cleanupPaths.push(fixtureRoot);
  const root = join(fixtureRoot, "Conglomerate_GEN3");
  const organizationRoot = join(root, "organizations", "HumanAndMachine-ai_GEN3");
  const authorityRoot = join(organizationRoot, "mission-control", "db");
  const planRoot = join(
    authorityRoot,
    "data",
    "mission-control",
    "plans",
    "2026",
    "07",
  );
  await mkdir(planRoot, { recursive: true });
  await mkdir(join(authorityRoot, "schemas"), { recursive: true });
  await mkdir(join(authorityRoot, "scripts"), { recursive: true });
  await writeFile(join(root, "launchpad.gen3.json"), "{}\n", "utf8");
  await writeFile(
    join(organizationRoot, "company.gen3.json"),
    '{"organization_kind":"organization"}\n',
    "utf8",
  );
  await writeFile(
    join(authorityRoot, "repository-db.manifest.json"),
    `${JSON.stringify({
      schema_version: "companiesascode.repository_db.manifest.v1",
      data_mode: "repository-db",
      data_root: "data/mission-control",
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(authorityRoot, "schemas", "mission-control-plan.schema.json"),
    `${JSON.stringify({
      type: "object",
      required: ["schema_version", "dev_code", "title"],
      properties: {
        schema_version: { const: "companiesascode.mission_control.plan.v2" },
        dev_code: { type: "string", pattern: "^[A-Z]{2,6}-[0-9]{4}$" },
        title: { type: "string", minLength: 1 },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(authorityRoot, "scripts", "validate-mission-control-data.mjs"),
    "export function validateMissionControlData() { return []; }\n",
    "utf8",
  );
  await writeFile(
    join(planRoot, "CAC-0007-create-lane.yaml"),
    validPlan,
    "utf8",
  );
  for (const args of [
    ["init", "-b", "main"],
    ["remote", "add", "origin", "git@github.com:TestProvider/Lazurio.git"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return { root, organizationRoot };
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
      MISSION_CONTROL_AUTHORITY_ROOT: authorityRoot,
    },
  });
}

function runOrganizationCreateLane({ root }) {
  const env = { ...process.env };
  delete env.MISSION_CONTROL_AUTHORITY_ROOT;
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
