import { afterAll, expect, test } from "bun:test";
import { mkdir, rename, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { buildMissionControlPlanIndex, readMissionControlPlanAt } from "./mission-control-plan-lib.mjs";
import { createLaunchpadGitFixture } from "./git-fixture-helpers.test.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createEscapedOrganizationFixture() {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const externalOrganizationRoot = `${root}-external-organization`;
  tempRoots.push(externalOrganizationRoot);
  await rename(organizationRoot, externalOrganizationRoot);
  await writeFile(
    join(externalOrganizationRoot, "mission-control", "plans", "DEV-ESCAPE.yaml"),
    "dev_code: DEV-ESCAPE\ntitle: Escaped Organization plan\n",
  );
  await symlink(externalOrganizationRoot, organizationRoot, process.platform === "win32" ? "junction" : "dir");
  return { root };
}

test("Mission Control plan index parses YAML frontmatter without a YAML dependency", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const plansRoot = join(root, "organizations", "BetaCo_GEN3", "mission-control", "plans", "2026", "07");
  await mkdir(plansRoot, { recursive: true });
  await writeFile(
    join(plansRoot, "DEV-6327-deals-git-status.yaml"),
    [
      "schema_version: companiesascode.mission_control.plan.v2",
      "id: mcplan-dev-6327",
      "dev_code: DEV-6327",
      "title: Deals Git status badges",
      "status: in_progress",
      "links:",
      "  - path: modules/deals",
      "",
    ].join("\n"),
  );

  const index = await buildMissionControlPlanIndex({ companiesRoot: root, organization: "BetaCo", module: "deals" });

  expect(index.plans).toContainEqual(
    expect.objectContaining({
      code: "DEV-6327",
      organization: "BetaCo",
      title: "Deals Git status badges",
      status: "in_progress",
      module_match: "direct",
      path: "organizations/BetaCo_GEN3/mission-control/plans/2026/07/DEV-6327-deals-git-status.yaml",
    }),
  );
});

test("Mission Control plan index discovers the canonical nested v3 data path and preserves its exact relative path", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const plansRoot = join(
    root,
    "organizations",
    "BetaCo_GEN3",
    "mission-control",
    "db",
    "data",
    "mission-control",
    "plans",
    "2026",
    "07",
  );
  await mkdir(plansRoot, { recursive: true });
  await writeFile(
    join(plansRoot, "DEV-6416-omegaco-migration.yaml"),
    "dev_code: DEV-6416\ntitle: OmegaCo migration\nstatus: review\nlinks:\n  - path: workspace/deals\n",
  );

  const index = await buildMissionControlPlanIndex({ companiesRoot: root, organization: "BetaCo", module: "deals" });

  expect(index.plans).toContainEqual(
    expect.objectContaining({
      code: "DEV-6416",
      organization_relative_path: "mission-control/db/data/mission-control/plans/2026/07/DEV-6416-omegaco-migration.yaml",
      path: "organizations/BetaCo_GEN3/mission-control/db/data/mission-control/plans/2026/07/DEV-6416-omegaco-migration.yaml",
      module_match: "direct",
    }),
  );
});

test("Mission Control direct read fails closed for non-exact aliases outside the two allowed plan roots", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const plansRoot = join(orgRoot, "mission-control", "plans", "2026", "07");
  await mkdir(plansRoot, { recursive: true });
  await writeFile(join(plansRoot, "DEV-6416.yaml"), "dev_code: DEV-6416\ntitle: Exact plan\n");

  const invalid = await readMissionControlPlanAt({
    companiesRoot: root,
    organizationPath: "organizations/BetaCo_GEN3",
    planPath: "mission-control/plans/2026/07/../07/DEV-6416.yaml",
  });

  expect(invalid).toBeNull();
});

test("Mission Control plan index ignores an Organization mount that is a symlink escape", async () => {
  const { root } = await createEscapedOrganizationFixture();

  const index = await buildMissionControlPlanIndex({ companiesRoot: root, organization: "BetaCo" });

  expect(index.plans.some((plan) => plan.code === "DEV-ESCAPE")).toBe(false);
});

test("Mission Control direct read rejects an Organization mount that is a symlink escape", async () => {
  const { root } = await createEscapedOrganizationFixture();

  const directRead = await readMissionControlPlanAt({
    companiesRoot: root,
    organizationPath: "organizations/BetaCo_GEN3",
    planPath: "mission-control/plans/DEV-ESCAPE.yaml",
  });

  expect(directRead).toBeNull();
});

test("Mission Control direct read fails closed when an allowed plan root is a symlink escape", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const externalPlansRoot = join(root, "external-plans");
  await mkdir(join(orgRoot, "mission-control"), { recursive: true });
  await mkdir(externalPlansRoot, { recursive: true });
  await writeFile(join(externalPlansRoot, "DEV-6416.yaml"), "dev_code: DEV-6416\ntitle: Escaped plan\n");
  await rm(join(orgRoot, "mission-control", "plans"), { recursive: true, force: true });
  await symlink(
    externalPlansRoot,
    join(orgRoot, "mission-control", "plans"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const invalid = await readMissionControlPlanAt({
    companiesRoot: root,
    organizationPath: "organizations/BetaCo_GEN3",
    planPath: "mission-control/plans/DEV-6416.yaml",
  });

  expect(invalid).toBeNull();
});
