import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoots = [];
const cliPath = join(import.meta.dirname, "cli.mjs");

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("context CLI drží přesný JSON, lidský výstup a exit code", async () => {
  const root = await tempRoot("lazurio-context-golden-");
  await writeJson(join(root, "personal.gen3.json"), personalConfig());

  const json = run([process.execPath, "run", cliPath, "context", "--json", "--root", root], root);
  const human = run([process.execPath, "run", cliPath, "context", "--root", root], root);

  expect(json.exitCode).toBe(0);
  expect(json.stderr).toBe("");
  expect(normalizeContextJson(json.stdout)).toBe(await golden("context-personalspace.json"));
  expect(human.exitCode).toBe(0);
  expect(human.stderr).toBe("");
  expect(normalizeHumanContext(human.stdout)).toBe(await golden("context-personalspace.txt"));
});

test("doctor CLI drží přesný report, lidský výstup a exit code", async () => {
  const root = await tempRoot("lazurio-doctor-golden-");
  const report = doctorReport(root);
  await writeFile(
    join(root, "fixture-doctor.mjs"),
    `process.stdout.write(${JSON.stringify(JSON.stringify(report))});\nprocess.exitCode = 0;\n`,
    "utf8",
  );
  await writeJson(join(root, "personal.gen3.json"), personalConfig({
    doctor: {
      schema_version: "humanandmachines.doctor.declaration.v1",
      command: [process.execPath, "run", "fixture-doctor.mjs"],
      scope_type: "personalspace",
      timeout_ms: 5_000,
    },
  }));

  const json = run([process.execPath, "run", cliPath, "doctor", "--json", "--root", root], root);
  const human = run([process.execPath, "run", cliPath, "doctor", "--root", root], root);

  expect(json.exitCode).toBe(0);
  expect(json.stderr).toBe("");
  expect(normalizeDoctorJson(json.stdout, root)).toBe(await golden("doctor-personalspace.json"));
  expect(human.exitCode).toBe(0);
  expect(human.stderr).toBe("");
  expect(human.stdout).toBe(await golden("doctor-personalspace.txt"));
});

test("CLI error exit-code baseline rozlišuje usage a chybějící Doctor report", async () => {
  const root = await tempRoot("lazurio-exit-golden-");
  await writeJson(join(root, "personal.gen3.json"), personalConfig());

  const usage = run([process.execPath, "run", cliPath, "unknown", "--root", root], root);
  const noReport = run([process.execPath, "run", cliPath, "doctor", "--json", "--root", root], root);

  expect({ exitCode: usage.exitCode, stdout: usage.stdout }).toEqual({ exitCode: 2, stdout: "" });
  expect(usage.stderr).toContain("Neznámý příkaz 'unknown'");
  expect({ exitCode: noReport.exitCode, stdout: noReport.stdout }).toEqual({ exitCode: 3, stdout: "" });
  expect(noReport.stderr).toContain("nedeklaruje doctor");
});

async function golden(name) {
  return Bun.file(new URL(`./testdata/golden/${name}`, import.meta.url)).text();
}

function normalizeContextJson(output) {
  const context = JSON.parse(output);
  expect(context.machine.platform).toBe(process.platform);
  expect(context.machine.architecture).toBe(process.arch);
  context.machine.platform = "<platform>";
  context.machine.architecture = "<architecture>";
  return `${JSON.stringify(context, null, 2)}\n`;
}

function normalizeHumanContext(output) {
  return output.replace(
    `Mašina: ${process.platform}/${process.arch}`,
    "Mašina: <platform>/<architecture>",
  );
}

function normalizeDoctorJson(output, root) {
  const report = JSON.parse(output);
  expect(report.scope.absolute_path).toBe(root);
  report.scope.absolute_path = "<root>";
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function personalConfig(overrides = {}) {
  return {
    schema_version: "humanandmachines.personal.gen3.v1",
    personal_generation: "gen3",
    owner: {
      github_username: "fixture-owner",
      display_name: "Fixture Owner",
      type: "human",
    },
    repository: {
      github_repo: "fixture-owner/fixture-owner_GEN3",
      mount_path: "personalspace/fixture-owner_GEN3",
      visibility: "private",
      mount_strategy: "doctor-managed-nested-repo",
    },
    privacy: {
      default_share: "private",
      agent_boundary: "personal-context-only",
      shared_outputs: "metadata-only",
    },
    modules_manifest_path: "modules.manifest.json",
    workspace_path: "workspace",
    gbrain: {
      path: "gbrain",
      repository: {
        github_repo: "fixture-owner/fixture-owner-gbrain",
        visibility: "private",
        mount_strategy: "doctor-managed-nested-repo",
      },
      software: {
        github_repo: "garrytan/gbrain",
        install_source: "github:garrytan/gbrain",
      },
      default_shared: false,
      human_editor: "obsidian",
      agent_access: "mcp-only",
    },
    secrets: {
      path: "secrets",
      custody_pattern: "personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>",
      git: "ignored",
    },
    shared_spaces: [],
    ...overrides,
  };
}

function doctorReport(root) {
  return {
    schema_version: "companiesascode.doctor.report.v3",
    scope: {
      type: "personalspace",
      path: ".",
      name: "Fixture Personalspace",
      absolute_path: root,
    },
    summary: {
      status: "warn",
      ok: 0,
      warn: 1,
      fail: 0,
      not_applicable: 0,
      blocked: 0,
    },
    checks: [{
      id: "fixture.ready",
      status: "warn",
      severity: "recommended",
      title: "Fixture",
      message: "Fixture warning",
      paths: [],
      links: [],
      details: [],
    }],
    generated_at: "2026-08-11T00:00:00.000Z",
  };
}

function run(command, cwd) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}
