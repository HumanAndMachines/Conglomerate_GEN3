#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const packFile = resolve(root, "agent-pack.json");
const evalFile = resolve(root, "evals/cases.json");
const requiredFiles = [packFile, evalFile, resolve(root, "instructions.md"), resolve(root, "README.md")];
const errors = [];

for (const file of requiredFiles) if (!existsSync(file)) errors.push(`missing ${file.replace(`${root}/`, "")}`);

let pack;
let evals;
try { pack = JSON.parse(await readFile(packFile, "utf8")); } catch (error) { errors.push(`agent-pack.json: ${error.message}`); }
try { evals = JSON.parse(await readFile(evalFile, "utf8")); } catch (error) { errors.push(`evals/cases.json: ${error.message}`); }

const requiredPackFields = ["id", "display_name", "agent_kind", "purpose", "principal", "owner", "scope", "inputs", "outputs", "tools", "access", "approvals", "memory", "evals", "observability", "cost_guardrails", "release"];
if (pack) {
  if (pack.schema_version !== "humanandmachines.agent_pack.v1") errors.push("agent-pack.json: invalid schema_version");
  for (const field of requiredPackFields) if (!(field in pack)) errors.push(`agent-pack.json: missing ${field}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pack.id ?? "")) errors.push("agent-pack.json: id must be a slug");
  if (!["worker_agent", "ai_colleague_proposal"].includes(pack.agent_kind)) errors.push("agent-pack.json: invalid agent_kind");
  if (!Array.isArray(pack.scope?.in) || !Array.isArray(pack.scope?.out)) errors.push("agent-pack.json: scope.in and scope.out must be arrays");
  if (pack.agent_kind === "ai_colleague_proposal" && pack.release?.activation === "automatic") errors.push("agent-pack.json: AI colleague proposal cannot activate automatically");
}

if (evals) {
  if (evals.schema_version !== "humanandmachines.agent_evals.v1") errors.push("evals/cases.json: invalid schema_version");
  if (!Array.isArray(evals.cases)) errors.push("evals/cases.json: cases must be an array");
  const requiredCategories = ["happy_path", "boundary", "access_denied", "tool_failure", "regression"];
  const categories = new Set((evals.cases ?? []).map((item) => item.category));
  for (const category of requiredCategories) if (!categories.has(category)) errors.push(`evals/cases.json: missing ${category} case`);
  for (const [index, item] of (evals.cases ?? []).entries()) {
    for (const field of ["id", "category", "input", "expected", "forbidden", "evidence"]) if (!(field in item)) errors.push(`evals/cases.json: cases[${index}] missing ${field}`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Agent pack OK: ${pack.id}, ${(evals.cases ?? []).length} eval cases.`);
