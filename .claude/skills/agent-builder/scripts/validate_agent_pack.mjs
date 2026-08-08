#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const requiredPackFields = [
  "id",
  "display_name",
  "agent_kind",
  "purpose",
  "principal",
  "owner",
  "scope",
  "inputs",
  "outputs",
  "tools",
  "access",
  "approvals",
  "memory",
  "evals",
  "observability",
  "cost_guardrails",
  "release",
];
const governanceFields = ["access", "approvals", "observability", "cost_guardrails", "release"];
const requiredCategories = ["happy_path", "boundary", "access_denied", "tool_failure", "regression"];
const requiredCaseFields = ["id", "category", "input", "expected", "forbidden", "evidence"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyObject(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isMeaningfulIdentity(value) {
  return isNonEmptyString(value) || isNonEmptyObject(value);
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

async function readJson(file, label, errors) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function validatePack(pack, errors) {
  if (!isPlainObject(pack)) {
    errors.push("agent-pack.json: document must be a JSON object");
    return;
  }

  if (pack.schema_version !== "humanandmachines.agent_pack.v1") {
    errors.push("agent-pack.json: invalid schema_version");
  }
  for (const field of requiredPackFields) {
    if (!hasOwn(pack, field)) errors.push(`agent-pack.json: missing ${field}`);
  }
  if (!isNonEmptyString(pack.id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pack.id)) {
    errors.push("agent-pack.json: id must be a slug");
  }
  for (const field of ["display_name", "purpose"]) {
    if (!isNonEmptyString(pack[field])) errors.push(`agent-pack.json: ${field} must be a non-empty string`);
  }
  for (const field of ["principal", "owner"]) {
    if (!isMeaningfulIdentity(pack[field])) {
      errors.push(`agent-pack.json: ${field} must be a non-empty string or JSON object`);
    }
  }
  if (!["worker_agent", "ai_colleague_proposal"].includes(pack.agent_kind)) {
    errors.push("agent-pack.json: invalid agent_kind");
  }
  if (!isPlainObject(pack.scope)) {
    errors.push("agent-pack.json: scope must be a JSON object");
  } else if (!isStringArray(pack.scope.in) || !isStringArray(pack.scope.out)) {
    errors.push("agent-pack.json: scope.in and scope.out must be arrays of non-empty strings");
  }
  for (const field of ["inputs", "outputs", "tools"]) {
    if (!Array.isArray(pack[field])) errors.push(`agent-pack.json: ${field} must be an array`);
  }
  if (!(Array.isArray(pack.memory) || isNonEmptyObject(pack.memory))) {
    errors.push("agent-pack.json: memory must be an array or non-empty JSON object");
  }
  if (!isNonEmptyObject(pack.evals)) {
    errors.push("agent-pack.json: evals must be a non-empty JSON object");
  }
  for (const field of governanceFields) {
    if (!isNonEmptyObject(pack[field])) {
      errors.push(`agent-pack.json: ${field} must be a non-empty JSON object`);
    }
  }
  if (pack.agent_kind === "ai_colleague_proposal" && pack.release?.activation === "automatic") {
    errors.push("agent-pack.json: AI colleague proposal cannot activate automatically");
  }
}

function validateEvals(evals, errors) {
  if (!isPlainObject(evals)) {
    errors.push("evals/cases.json: document must be a JSON object");
    return;
  }

  if (evals.schema_version !== "humanandmachines.agent_evals.v1") {
    errors.push("evals/cases.json: invalid schema_version");
  }
  if (!Array.isArray(evals.cases)) {
    errors.push("evals/cases.json: cases must be an array");
    return;
  }

  const categories = new Set();
  const ids = new Set();
  for (const [index, item] of evals.cases.entries()) {
    if (!isPlainObject(item)) {
      errors.push(`evals/cases.json: cases[${index}] must be a JSON object`);
      continue;
    }
    for (const field of requiredCaseFields) {
      if (!hasOwn(item, field)) errors.push(`evals/cases.json: cases[${index}] missing ${field}`);
    }
    if (!isNonEmptyString(item.id)) {
      errors.push(`evals/cases.json: cases[${index}].id must be a non-empty string`);
    } else if (ids.has(item.id)) {
      errors.push(`evals/cases.json: duplicate case id ${item.id}`);
    } else {
      ids.add(item.id);
    }
    if (!isNonEmptyString(item.category)) {
      errors.push(`evals/cases.json: cases[${index}].category must be a non-empty string`);
    } else {
      categories.add(item.category);
    }
    for (const field of ["input", "expected", "forbidden", "evidence"]) {
      if (item[field] === null || item[field] === undefined) {
        errors.push(`evals/cases.json: cases[${index}].${field} must not be null`);
      }
    }
  }
  for (const category of requiredCategories) {
    if (!categories.has(category)) errors.push(`evals/cases.json: missing ${category} case`);
  }
}

export async function validateAgentPack(rootInput = ".") {
  const root = resolve(rootInput);
  const packFile = resolve(root, "agent-pack.json");
  const evalFile = resolve(root, "evals/cases.json");
  const requiredFiles = [packFile, evalFile, resolve(root, "instructions.md"), resolve(root, "README.md")];
  const errors = [];

  for (const file of requiredFiles) {
    if (!existsSync(file)) errors.push(`missing ${relative(root, file)}`);
  }

  const [pack, evals] = await Promise.all([
    readJson(packFile, "agent-pack.json", errors),
    readJson(evalFile, "evals/cases.json", errors),
  ]);
  if (pack !== undefined) validatePack(pack, errors);
  if (evals !== undefined) validateEvals(evals, errors);

  return {
    errors,
    packId: isPlainObject(pack) && isNonEmptyString(pack.id) ? pack.id : null,
    evalCount: isPlainObject(evals) && Array.isArray(evals.cases) ? evals.cases.length : 0,
  };
}

async function main() {
  const result = await validateAgentPack(process.argv[2] ?? ".");
  if (result.errors.length > 0) {
    console.error(result.errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Agent pack OK: ${result.packId}, ${result.evalCount} eval cases.`);
}

if (import.meta.main) await main();
