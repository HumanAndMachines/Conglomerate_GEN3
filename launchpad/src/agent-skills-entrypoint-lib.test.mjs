import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentSkillsEntrypointsDoctorCheck,
  inspectAgentSkillsEntrypoint,
} from "./agent-skills-entrypoint-lib.mjs";

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function organizationFixture(name) {
  const companiesRoot = await mkdtemp(join(tmpdir(), `agent-skills-${name}-`));
  tempRoots.push(companiesRoot);
  const organizationRoot = join(companiesRoot, "organizations", "Example_GEN3");
  await mkdir(join(organizationRoot, ".agents", "skills"), { recursive: true });
  return { companiesRoot, organizationRoot };
}

test("Doctor je read-only a chybějící lokální entrypoint hlásí jako Repair", async () => {
  const { companiesRoot } = await organizationFixture("missing");
  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(check.status).toBe("warn");
  expect(check.details[0]).toContain("repair_needed/entrypoint_missing");
});

test("Doctor přijme symlink nebo Windows junction na kanonické skilly", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("ready");
  await mkdir(join(organizationRoot, ".claude"), { recursive: true });
  await symlink(
    join(organizationRoot, ".agents", "skills"),
    join(organizationRoot, ".claude", "skills"),
    "junction",
  );

  const entrypointState = await inspectAgentSkillsEntrypoint(organizationRoot, {
    platform: "win32",
  });
  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(entrypointState.status).toBe("ok");
  expect(check.status).toBe("ok");
});

test("Doctor fail-closed odmítne samostatnou druhou kopii skillů", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("duplicate");
  await mkdir(join(organizationRoot, ".claude", "skills"), { recursive: true });
  await writeFile(join(organizationRoot, ".claude", "skills", "local.md"), "local\n");

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(check.status).toBe("fail");
  expect(check.details[0]).toContain("blocked/entrypoint_duplicate_directory");
});

test("Doctor nespouští Organization kód a legacy placeholder jen doporučí opravit", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("placeholder");
  await mkdir(join(organizationRoot, ".claude"), { recursive: true });
  await writeFile(join(organizationRoot, ".claude", "skills"), "../.agents/skills\n");
  await mkdir(join(organizationRoot, "scripts"), { recursive: true });
  await writeFile(
    join(organizationRoot, "scripts", "agent-skills-entrypoint.mjs"),
    "throw new Error('Doctor nesmí spustit Organization kód');\n",
  );

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(check.status).toBe("warn");
  expect(check.details[0]).toContain("repair_needed/entrypoint_legacy_placeholder");
});

test("Doctor odmítne .claude junction mimo root Organizace", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("escape");
  const outside = await mkdtemp(join(tmpdir(), "agent-skills-outside-"));
  tempRoots.push(outside);
  await symlink(outside, join(organizationRoot, ".claude"), "junction");

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(check.status).toBe("fail");
  expect(check.details[0]).toContain("blocked/compatibility_parent_not_directory");
});

test("Doctor nepřeskočí přijatý kontrakt kvůli rozbitému skills junctionu", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("broken-link");
  const target = await mkdtemp(join(tmpdir(), "agent-skills-broken-target-"));
  tempRoots.push(target);
  await mkdir(join(organizationRoot, ".claude"), { recursive: true });
  await symlink(target, join(organizationRoot, ".claude", "skills"), "junction");
  await rm(target, { recursive: true, force: true });

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(check.status).toBe("warn");
  expect(check.details[0]).toContain("repair_needed/entrypoint_wrong_link");
});
