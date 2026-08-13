import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const schemaVersion = "lazurio.launchpad.desired_module.v1";
const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const canonicalWorktreeSlugPattern = /^(?!.*\.\.)[A-Za-z0-9._-]{1,200}$/;
const allowedKeys = new Set([
  "schema_version",
  "company",
  "module",
  "module_lease_key",
  "app_id",
  "enabled",
  "source",
  "status",
  "revision",
  "accepted_at",
  "updated_at",
  "last_reconciled_at",
  "last_error",
  "failure_kind",
]);

export function desiredModuleLeaseKey(company, module) {
  return `${company}/${module}`;
}

export function desiredModuleStatePath(root, company, module) {
  return join(root, `${encodeURIComponent(company)}--${encodeURIComponent(module)}.json`);
}

export function normalizeDesiredSource(source) {
  if (!source || source.type === "main") return { type: "main" };
  if (
    source.type !== "worktree"
    || typeof source.slug !== "string"
    || source.slug !== source.slug.trim()
    || !canonicalWorktreeSlugPattern.test(source.slug)
  ) {
    throw new Error("Desired source must be main or a canonical worktree slug using 1-200 letters, digits, dot, underscore or hyphen characters without '..'.");
  }
  return { type: "worktree", slug: source.slug };
}

export function validateDesiredModuleState(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["desired state must be a JSON object"];
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`unknown property: ${key}`);
  }
  if (value.schema_version !== schemaVersion) errors.push(`schema_version must be ${schemaVersion}`);
  if (!validIdentity(value.company)) errors.push("company must be a non-empty string of at most 128 characters");
  if (!validIdentity(value.module)) errors.push("module must be a non-empty string of at most 128 characters");
  if (value.module_lease_key !== desiredModuleLeaseKey(value.company, value.module)) {
    errors.push("module_lease_key must match company/module");
  }
  if (!appIdPattern.test(value.app_id ?? "")) errors.push("app_id is invalid");
  if (typeof value.enabled !== "boolean") errors.push("enabled must be boolean");
  try {
    const normalized = normalizeDesiredSource(value.source);
    if (JSON.stringify(normalized) !== JSON.stringify(value.source)) errors.push("source contains non-canonical properties");
  } catch (error) {
    errors.push(error.message);
  }
  if (!["active", "disabled", "degraded"].includes(value.status)) errors.push("status is invalid");
  if (!isUuid(value.revision)) errors.push("revision must be a UUID");
  for (const key of ["accepted_at", "updated_at"]) {
    if (!isDateTime(value[key])) errors.push(`${key} must be an ISO date-time`);
  }
  if (value.last_reconciled_at !== null && !isDateTime(value.last_reconciled_at)) {
    errors.push("last_reconciled_at must be null or an ISO date-time");
  }
  if (value.last_error !== null && (typeof value.last_error !== "string" || value.last_error.length > 2000)) {
    errors.push("last_error must be null or a string of at most 2000 characters");
  }
  if (value.failure_kind !== null && (typeof value.failure_kind !== "string" || value.failure_kind.length > 128)) {
    errors.push("failure_kind must be null or a string of at most 128 characters");
  }
  if (value.enabled === false && value.status !== "disabled") errors.push("disabled desired state must have status disabled");
  if (value.enabled === true && value.status === "disabled") errors.push("enabled desired state cannot have status disabled");
  return errors;
}

export function buildDesiredModuleState({
  app,
  source,
  enabled = true,
  status = enabled ? "active" : "disabled",
  previous = null,
  reconciled = false,
  error = null,
  failureKind = null,
  now = new Date().toISOString(),
}) {
  const state = {
    schema_version: schemaVersion,
    company: app.company,
    module: app.module,
    module_lease_key: desiredModuleLeaseKey(app.company, app.module),
    app_id: app.id,
    enabled,
    source: normalizeDesiredSource(source),
    status,
    revision: randomUUID(),
    accepted_at: previous?.accepted_at ?? now,
    updated_at: now,
    last_reconciled_at: reconciled ? now : (previous?.last_reconciled_at ?? null),
    last_error: error ? String(error).slice(0, 2000) : null,
    failure_kind: failureKind ? String(failureKind).slice(0, 128) : null,
  };
  const errors = validateDesiredModuleState(state);
  if (errors.length > 0) throw new Error(`Desired module state is invalid: ${errors.join("; ")}`);
  return state;
}

export async function readDesiredModuleState({ root, company, module }) {
  const path = desiredModuleStatePath(root, company, module);
  if (!existsSync(path)) return null;
  return readAndValidateDesiredState(path);
}

export async function listDesiredModuleStates({ root }) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const path = join(root, entry.name);
      try {
        return { ok: true, path, state: await readAndValidateDesiredState(path) };
      } catch (error) {
        return { ok: false, path, file: basename(path), error: error.message };
      }
    }));
}

export async function writeDesiredModuleState({
  root,
  state,
  writeFileFn = writeFile,
  renameFn = rename,
  removeFileFn = rm,
}) {
  const errors = validateDesiredModuleState(state);
  if (errors.length > 0) throw new Error(`Desired module state is invalid: ${errors.join("; ")}`);
  await mkdir(root, { recursive: true });
  const target = desiredModuleStatePath(root, state.company, state.module);
  const temporary = join(root, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFileFn(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await renameFn(temporary, target);
  } finally {
    await removeFileFn(temporary, { force: true }).catch(() => {});
  }
  return target;
}

async function readAndValidateDesiredState(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Desired state ${basename(path)} is not valid JSON: ${error.message}`);
  }
  const errors = validateDesiredModuleState(parsed);
  if (errors.length > 0) throw new Error(`Desired state ${basename(path)} is schema-invalid: ${errors.join("; ")}`);
  return parsed;
}

function validIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isDateTime(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
