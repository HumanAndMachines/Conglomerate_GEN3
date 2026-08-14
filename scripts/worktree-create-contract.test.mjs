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
  expect(result.stdout).toContain("ok - dry-run: plán data/mission-control/plans/CAC-0007.yaml");
});

test("dry-run normalizes an explicit Organization root to repository-db", async () => {
  const fixture = await createLaneFixture({
    plans: [["2026/07/CAC-0007-create-lane.yaml", validPlan]],
  });
  const result = runCreateLane({
    ...fixture,
    authorityOverride: fixture.organizationRoot,
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(
    "ok - dry-run: plán data/mission-control/plans/2026/07/CAC-0007-create-lane.yaml",
  );
});

test("dry-run rejects an explicit external repository-db authority", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  const externalAuthorityRoot = join(
    dirname(fixture.root),
    "external-repository-db-authority",
  );
  await cp(fixture.authorityRoot, externalAuthorityRoot, { recursive: true });
  const result = runCreateLane({
    root: fixture.root,
    authorityOverride: externalAuthorityRoot,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "nový worktree vyžaduje Mission Control authority",
  );
});

test.skipIf(process.platform === "win32")(
  "dry-run rejects a symlinked Organization authority component",
  async () => {
    const fixture = await createLaneFixture({
      plans: [["CAC-0007.yaml", validPlan]],
    });
    const externalAuthorityRoot = join(dirname(fixture.root), "symlink-target-db");
    await cp(fixture.authorityRoot, externalAuthorityRoot, { recursive: true });
    await rm(fixture.authorityRoot, { recursive: true, force: true });
    await symlink(externalAuthorityRoot, fixture.authorityRoot, "dir");
    const result = runCreateLane(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("obsahuje symlink nebo neadresářovou komponentu");
  },
);

test("dry-run fails closed when multiple Organizations claim the same plan code", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
  await cp(
    fixture.organizationRoot,
    join(fixture.root, "organizations", "SecondOrganization_GEN3"),
    { recursive: true },
  );
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("nalezen ve více Organization Mission Control autoritách");
});

test("dry-run ignores an unrelated partial Organization authority", async () => {
  const fixture = await createLaneFixture({
    plans: [["CAC-0007.yaml", validPlan]],
  });
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
  const result = runCreateLane(fixture);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
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
    "data/mission-control/plans/CAC-0007.yaml",
  );
});

test("dry-run rejects a legacy-only plan", async () => {
  const fixture = await createLaneFixture({
    plans: [],
    legacyPlans: [["CAC-0007.yaml", validPlan]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("nebyl nalezen v žádné připojené Organization Mission Control autoritě");
});

test("dry-run rejects a repository-db plans root redirected to retired legacy plans", async () => {
  const fixture = await createLaneFixture({
    plans: [],
    legacyPlans: [["CAC-0007.yaml", validPlan]],
  });
  const canonicalPlansRoot = join(
    fixture.authorityRoot,
    "data",
    "mission-control",
    "plans",
  );
  const legacyPlansRoot = join(fixture.organizationRoot, "mission-control", "plans");
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

test("dry-run rejects a selected plan whose id does not match dev_code", async () => {
  const fixture = await createLaneFixture({
    plans: [[
      "CAC-0007-create-lane.yaml",
      validPlan.replace("id: mcplan-cac-0007", "id: mcplan-cac-9999"),
    ]],
  });
  const result = runCreateLane(fixture);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Mission Control plan id must match dev_code");
});

async function createLaneFixture({ plans, legacyPlans = [] }) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "worktree-create-contract-"));
  cleanupPaths.push(fixtureRoot);
  const root = join(fixtureRoot, "Conglomerate_GEN3");
  const organizationRoot = join(root, "organizations", "TestOrganization_GEN3");
  const authorityRoot = join(organizationRoot, "mission-control", "db");
  const repositoryDbRoot = authorityRoot;
  const plansRoot = join(authorityRoot, "data", "mission-control", "plans");
  const legacyPlansRoot = join(organizationRoot, "mission-control", "plans");
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
    ["remote", "add", "origin", "git@github.com:TestProvider/Lazurio.git"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return { root, organizationRoot, authorityRoot };
}

function runCreateLane({ root, authorityOverride = null }) {
  const env = { ...process.env };
  delete env.MISSION_CONTROL_AUTHORITY_ROOT;
  delete env.LAZURIO_MISSION_CONTROL_ROOT;
  if (authorityOverride) env.MISSION_CONTROL_AUTHORITY_ROOT = authorityOverride;
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
