import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateAgentPack } from "../.agents/skills/agent-builder/scripts/validate_agent_pack.mjs";

const temporaryRoots = [];

const validPack = {
  schema_version: "humanandmachines.agent_pack.v1",
  id: "support-triage",
  display_name: "Support triage",
  agent_kind: "worker_agent",
  purpose: "Prepare a reviewable support response draft.",
  principal: "support-lead",
  owner: "support-platform",
  scope: { in: ["org/support"], out: ["personalspace"] },
  inputs: [{ type: "ticket" }],
  outputs: [{ type: "response_draft" }],
  tools: [],
  access: { source: "github" },
  approvals: { publish: "principal" },
  memory: { mode: "none" },
  evals: { cases: "evals/cases.json" },
  observability: { trace: "metadata_only" },
  cost_guardrails: { max_usd_per_run: 1 },
  release: { activation: "manual" },
};

const categories = ["happy_path", "boundary", "access_denied", "tool_failure", "regression"];
const validEvals = {
  schema_version: "humanandmachines.agent_evals.v1",
  cases: categories.map((category) => ({
    id: `${category.replaceAll("_", "-")}-case`,
    category,
    input: {},
    expected: ["reviewable draft"],
    forbidden: ["publish"],
    evidence: ["trace-id"],
  })),
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createPack({ pack = validPack, evals = validEvals } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-pack-validator-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "evals"));
  await Promise.all([
    writeFile(join(root, "agent-pack.json"), JSON.stringify(pack)),
    writeFile(join(root, "evals", "cases.json"), JSON.stringify(evals)),
    writeFile(join(root, "instructions.md"), "# Instructions\n"),
    writeFile(join(root, "README.md"), "# Agent pack\n"),
  ]);
  return root;
}

describe("validateAgentPack", () => {
  test("accepts a complete, fail-closed pack", async () => {
    const result = await validateAgentPack(await createPack());

    expect(result.errors).toEqual([]);
    expect(result.packId).toBe("support-triage");
    expect(result.evalCount).toBe(5);
  });

  test.each([
    ["null pack", null, validEvals, "agent-pack.json: document must be a JSON object"],
    ["primitive pack", "invalid", validEvals, "agent-pack.json: document must be a JSON object"],
    ["null eval document", validPack, null, "evals/cases.json: document must be a JSON object"],
    ["primitive eval document", validPack, 42, "evals/cases.json: document must be a JSON object"],
  ])("diagnoses %s without throwing", async (_label, pack, evals, diagnostic) => {
    const result = await validateAgentPack(await createPack({ pack, evals }));

    expect(result.errors).toContain(diagnostic);
  });

  test.each([
    ["a numeric id", { ...validPack, id: 123 }, "agent-pack.json: id must be a slug"],
    [
      "a non-string scope entry",
      { ...validPack, scope: { in: [null], out: [] } },
      "agent-pack.json: scope.in and scope.out must be arrays of non-empty strings",
    ],
  ])("rejects %s without coercing its type", async (_label, pack, diagnostic) => {
    const result = await validateAgentPack(await createPack({ pack }));

    expect(result.errors).toContain(diagnostic);
  });

  test.each([
    ["null", null],
    ["primitive", "invalid"],
  ])("diagnoses a %s eval case without throwing", async (_label, item) => {
    const root = await createPack({ evals: { ...validEvals, cases: [item, ...validEvals.cases] } });

    const result = await validateAgentPack(root);

    expect(result.errors).toContain("evals/cases.json: cases[0] must be a JSON object");
  });

  test.each([
    ["access", null],
    ["approvals", {}],
    ["observability", "trace later"],
    ["cost_guardrails", []],
    ["release", false],
  ])("rejects an empty or mistyped %s governance block", async (field, value) => {
    const root = await createPack({ pack: { ...validPack, [field]: value } });

    const result = await validateAgentPack(root);

    expect(result.errors).toContain(`agent-pack.json: ${field} must be a non-empty JSON object`);
  });

  test("the CLI emits a file-specific diagnostic without an internal stack trace", async () => {
    const root = await createPack({ pack: null });
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "..", ".agents", "skills", "agent-builder", "scripts", "validate_agent_pack.mjs"),
      root,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("agent-pack.json: document must be a JSON object");
    expect(stderr).not.toContain("TypeError");
    expect(stderr).not.toContain(" at ");
  });
});
