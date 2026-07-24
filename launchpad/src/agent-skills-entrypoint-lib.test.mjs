import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CAPABILITY_MODES,
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

async function writeSkill(root, slug, contents = `# ${slug}\n`) {
  await mkdir(join(root, ".agents", "skills", slug), { recursive: true });
  await writeFile(join(root, ".agents", "skills", slug, "SKILL.md"), contents);
}

async function writeMirror(root, slug, contents = `# ${slug}\n`) {
  await mkdir(join(root, ".claude", "skills", slug), { recursive: true });
  await writeFile(join(root, ".claude", "skills", slug, "SKILL.md"), contents);
}

test("Unix Doctor je read-only a chybějící mirror hlásí jako Repair", async () => {
  const { companiesRoot } = await organizationFixture("missing");
  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
    platform: "linux",
  });

  expect(check.status).toBe("warn");
  expect(check.details[0]).toContain("repair_needed/mirror_missing");
});

test("Windows Codex-only checkout nevyžaduje .claude/skills mirror ani placeholder", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("codex-only");
  const missingCheck = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
    platform: "win32",
    agentCapabilityMode: AGENT_CAPABILITY_MODES.CODEX_ONLY,
  });
  expect(missingCheck.status).toBe("ok");
  expect(missingCheck.details[0]).toContain("ok/codex_entrypoint_ready");

  await mkdir(join(organizationRoot, ".claude"), { recursive: true });
  await writeFile(join(organizationRoot, ".claude", "skills"), "../.agents/skills\n");
  const placeholderCheck = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
    platform: "win32",
    agentCapabilityMode: AGENT_CAPABILITY_MODES.CODEX_ONLY,
  });
  expect(placeholderCheck.status).toBe("ok");
  expect(placeholderCheck.details[0]).toContain("ok/codex_entrypoint_ready");
});

test("Windows Claude-compatible checkout vede placeholder na repair lane", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("claude-compatible");
  const missingCheck = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
    platform: "win32",
    agentCapabilityMode: AGENT_CAPABILITY_MODES.CLAUDE_COMPATIBLE,
  });
  expect(missingCheck.status).toBe("warn");
  expect(missingCheck.details[0]).toContain("repair_needed/mirror_missing");

  await mkdir(join(organizationRoot, ".claude"), { recursive: true });
  await writeFile(join(organizationRoot, ".claude", "skills"), "../.agents/skills\n");
  const placeholderCheck = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
    platform: "win32",
    agentCapabilityMode: AGENT_CAPABILITY_MODES.CLAUDE_COMPATIBLE,
  });
  expect(placeholderCheck.status).toBe("warn");
  expect(placeholderCheck.details[0]).toContain("repair_needed/mirror_legacy_placeholder");
});

test("Legacy symlink na kanonické skilly je přechodový repair stav, ne fail (decision 0104)", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("legacy-link");
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
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(entrypointState.status).toBe("repair_needed");
  expect(entrypointState.code).toBe("mirror_legacy_link");
  expect(check.status).toBe("warn");
});

test("Byte-for-byte mirror aktivních skillů z manifestu je ok", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("mirror-ready");
  await writeSkill(organizationRoot, "example-skill");
  await writeFile(
    join(organizationRoot, ".agents", "skills", "manifest.json"),
    JSON.stringify({
      schema_version: "conglomerate.skills.v0",
      claude_compatibility: "tracked-derived-mirror",
      skills: [{ slug: "example-skill", path: ".agents/skills/example-skill/SKILL.md" }],
    }),
  );
  await writeMirror(organizationRoot, "example-skill");

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(check.status).toBe("ok");
  expect(check.details[0]).toContain("ok/mirror_ready");
});

test("Mirror drift (obsah i cizí adresář) je repair stav, ne fail", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("mirror-drift");
  await writeSkill(organizationRoot, "example-skill", "# canonical\n");
  await writeMirror(organizationRoot, "example-skill", "# stale\n");
  await writeMirror(organizationRoot, "removed-skill");

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(check.status).toBe("warn");
  expect(check.details[0]).toContain("repair_needed/mirror_drift");
});

test("Symlink uvnitř mirroru je fail-closed", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("mirror-unsafe");
  await writeSkill(organizationRoot, "example-skill");
  await mkdir(join(organizationRoot, ".claude", "skills"), { recursive: true });
  await symlink(
    join(organizationRoot, ".agents", "skills", "example-skill"),
    join(organizationRoot, ".claude", "skills", "example-skill"),
    "junction",
  );

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(check.status).toBe("fail");
  expect(check.details[0]).toContain("blocked/mirror_unsafe_content");
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
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
    platform: "linux",
  });

  expect(check.status).toBe("warn");
  expect(check.details[0]).toContain("repair_needed/mirror_legacy_placeholder");
});

test("Doctor odmítne .claude junction mimo root Organizace", async () => {
  const { companiesRoot, organizationRoot } = await organizationFixture("escape");
  const outside = await mkdtemp(join(tmpdir(), "agent-skills-outside-"));
  tempRoots.push(outside);
  await symlink(outside, join(organizationRoot, ".claude"), "junction");

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    includeRoot: false,
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
    includeRoot: false,
    mounts: [{ path: "organizations/Example_GEN3", status: "mounted" }],
  });

  expect(check.status).toBe("warn");
  expect(check.details[0]).toContain("repair_needed/entrypoint_wrong_link");
});

test("Doctor kontroluje i root checkout Conglomerate (includeRoot default)", async () => {
  const companiesRoot = await mkdtemp(join(tmpdir(), "agent-skills-root-"));
  tempRoots.push(companiesRoot);
  await writeSkill(companiesRoot, "root-skill");
  await writeMirror(companiesRoot, "root-skill");

  const check = await agentSkillsEntrypointsDoctorCheck({
    companiesRoot,
    mounts: [],
  });

  expect(check.status).toBe("ok");
  expect(check.details[0]).toContain("root: ok/mirror_ready");
});
