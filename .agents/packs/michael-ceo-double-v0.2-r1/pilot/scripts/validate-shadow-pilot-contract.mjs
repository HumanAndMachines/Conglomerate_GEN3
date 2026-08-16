#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_ID = "PILOT-LUMBIO-SHADOW-0.2-R1";
const CONTRACT_VERSION = "0.1.0-draft";
const PACK_ID = "michael-ceo-double-v0-2-r1";
const PACK_VERSION = "0.2.0-r1";
const BASELINE_COMMIT = "1b7d60590fe5e6d83f63032fd64fb647a2191296";
const REQUIRED_APPROVAL_FIELDS = [
  "contract_id",
  "contract_version",
  "approval_id",
  "run_id",
  "approved_at",
  "expires_at",
  "pack_baseline_commit",
  "execution_commit",
  "pilot_contract_sha256",
  "execution_bundle_sha256",
  "object_id",
  "object_label",
  "legal_entity_id",
  "organization_id",
  "scope_id",
  "responsible_owner_id",
  "snapshot_root",
  "manifest_path",
  "manifest_sha256",
  "cutoff_at",
  "output_path",
  "consumption_receipt_path",
  "human_reviewer_id",
  "retention_acknowledged",
];
const UNRESOLVED_APPROVAL_FIELDS = [
  "approval_id",
  "run_id",
  "approved_at",
  "expires_at",
  "execution_commit",
  "pilot_contract_sha256",
  "execution_bundle_sha256",
  "object_id",
  "object_label",
  "legal_entity_id",
  "responsible_owner_id",
  "snapshot_root",
  "manifest_path",
  "manifest_sha256",
  "cutoff_at",
  "output_path",
  "consumption_receipt_path",
];

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`invalid or missing JSON: ${path}: ${error.message}`);
    return null;
  }
}

function sameMembers(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function requireFalse(value, message, errors) {
  if (value !== false) errors.push(message);
}

function requireEmptyArray(value, message, errors) {
  if (!Array.isArray(value) || value.length !== 0) errors.push(message);
}

export function validateShadowPilotContract(packRootInput) {
  const packRoot = resolve(packRootInput);
  const errors = [];
  const pack = readJson(join(packRoot, "agent-pack.json"), errors);
  const contract = readJson(join(packRoot, "pilot", "shadow-pilot-contract.json"), errors);
  const manifestSchema = readJson(join(packRoot, "pilot", "schemas", "shadow-input-manifest.schema.json"), errors);
  const reviewSchema = readJson(join(packRoot, "pilot", "schemas", "shadow-human-review.schema.json"), errors);
  const outputSchema = readJson(join(packRoot, "pilot", "schemas", "shadow-output.schema.json"), errors);
  const approvalSchema = readJson(join(packRoot, "pilot", "schemas", "exact-run-approval.schema.json"), errors);
  const pendingManifest = readJson(join(packRoot, "pilot", "templates", "shadow-input-manifest.pending.json"), errors);
  const approval = readJson(join(packRoot, "pilot", "templates", "exact-run-approval.pending.json"), errors);

  if (!pack || !contract || !manifestSchema || !reviewSchema || !outputSchema || !approvalSchema || !pendingManifest || !approval) {
    return { ok: false, errors, summary: {} };
  }

  if (pack.id !== PACK_ID || pack.pack_version !== PACK_VERSION) {
    errors.push("pilot contract pack identity does not match the inactive pack");
  }
  if (pack.release?.runtime_enabled !== false || pack.release?.schedule_enabled !== false ||
      pack.release?.writes_enabled !== false || pack.release?.connectors_enabled !== false ||
      pack.release?.gbrain_write_enabled !== false) {
    errors.push("inactive pack release flags must remain explicitly false");
  }
  requireEmptyArray(pack.tools, "inactive pack tools must remain an empty array", errors);
  requireEmptyArray(pack.access?.current_callable_tools, "inactive pack callable tools must remain an empty array", errors);

  if (contract.contract_id !== CONTRACT_ID || contract.contract_version !== CONTRACT_VERSION ||
      contract.status !== "DESIGN_ONLY_NOT_EXECUTABLE") {
    errors.push("contract identity/version/status must remain the reviewed design-only values");
  }
  if (contract.architecture_id !== "ARCH-CEO-DOUBLE-0.2-R1") {
    errors.push("contract architecture ID must remain ARCH-CEO-DOUBLE-0.2-R1");
  }
  if (contract.pack?.id !== PACK_ID || contract.pack?.version !== PACK_VERSION) {
    errors.push("contract pack identity/version mismatch");
  }
  if (contract.pack?.baseline_commit !== BASELINE_COMMIT) {
    errors.push("pack baseline commit must match the approved inactive-pack commit");
  }

  if (reviewSchema.properties?.cleanup?.properties?.raw_snapshot_deleted?.const !== true) {
    errors.push("human review schema must require verified raw snapshot deletion");
  }

  requireFalse(contract.execution?.enabled, "execution.enabled must remain false", errors);
  if (contract.execution?.mode !== "manual_one_shot_shadow" || contract.execution?.max_runs !== 1) {
    errors.push("execution must remain one manual one-shot shadow run");
  }
  for (const [key, label] of [
    ["schedule_enabled", "schedule"],
    ["live_connectors_enabled", "live connectors"],
    ["network_enabled", "network"],
    ["writes_enabled", "writes"],
    ["gbrain_write_enabled", "GBrain write"],
    ["external_actions_enabled", "external actions"],
  ]) requireFalse(contract.execution?.[key], `execution.${key} must remain false`, errors);
  requireEmptyArray(contract.execution?.callable_tools, "execution callable_tools must be an empty array", errors);
  if (contract.execution?.runtime_configuration !== "NOT_CREATED" ||
      contract.execution?.approval !== "SEPARATE_EXACT_APPROVAL_REQUIRED") {
    errors.push("runtime must remain uncreated and separately approval-gated");
  }

  if (contract.pilot_object?.selection_status !== "PENDING_EXACT_APPROVAL" ||
      contract.pilot_object?.organization_id !== "lumbio" ||
      contract.pilot_object?.scope_id !== "lumbio") {
    errors.push("pilot object must remain pending and restricted to Lumbio");
  }
  if ([contract.pilot_object?.object_id, contract.pilot_object?.legal_entity_id,
       contract.pilot_object?.responsible_owner_id].some((value) => value !== null)) {
    errors.push("pilot object identifiers must remain null before exact approval");
  }

  if (contract.input?.delivery_mode !== "operator_curated_immutable_local_snapshot" ||
      contract.input?.manifest_required !== true || contract.input?.maximum_files !== 40 ||
      contract.input?.maximum_total_bytes !== 52428800) {
    errors.push("input must remain a bounded operator-curated immutable local snapshot");
  }
  if ([contract.input?.manifest_path, contract.input?.manifest_sha256,
       contract.input?.snapshot_root, contract.input?.cutoff_at].some((value) => value !== null)) {
    errors.push("exact snapshot fields must remain null before run approval");
  }
  if (contract.input?.source_ref_pattern !== "^snapshot://lumbio/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$") {
    errors.push("source_ref pattern must remain exact Lumbio snapshot-only");
  }

  if (contract.boundary?.default !== "deny" ||
      !sameMembers(contract.boundary?.allowed_organization_ids, ["lumbio"]) ||
      !sameMembers(contract.boundary?.allowed_scope_ids, ["lumbio"]) ||
      contract.boundary?.exact_legal_entity_required !== true ||
      contract.boundary?.personalspace_raw_data !== "FORBIDDEN" ||
      contract.boundary?.cross_organization_raw_data !== "FORBIDDEN" ||
      contract.boundary?.credentials_and_secrets !== "FORBIDDEN") {
    errors.push("boundary must remain default-deny and Lumbio-only");
  }

  if (contract.processing?.agent_count !== 1 || contract.processing?.agent_kind !== "worker_agent" ||
      contract.processing?.read_only !== true || contract.processing?.max_decision_cards !== 5 ||
      contract.processing?.max_source_records !== 500 || contract.processing?.deadline_seconds !== 900 ||
      contract.processing?.max_cost_usd !== 2 || contract.processing?.missing_is_zero !== false ||
      contract.processing?.incomplete_can_be_green !== false || contract.processing?.repair_attempts !== 1 ||
      contract.processing?.on_limit !== "PARTIAL") {
    errors.push("processing guardrails do not match the approved fail-closed design");
  }

  if (contract.output?.destination !== null ||
      contract.output?.destination_rule !== "EXACT_LOCAL_PATH_REQUIRED_IN_RUN_APPROVAL" ||
      contract.output?.visibility !== "PRIVATE_LOCAL_REVIEW_ONLY" ||
      contract.output?.publication !== "FORBIDDEN" ||
      contract.output?.source_bodies_in_audit !== "FORBIDDEN") {
    errors.push("output must remain unresolved, local, private and unpublished");
  }
  requireEmptyArray(contract.output?.tool_calls_executed, "contract output tool calls must remain empty", errors);
  requireEmptyArray(contract.output?.external_actions_executed, "contract output external actions must remain empty", errors);

  if (contract.acceptance?.machine_gates?.explicit_terminal_state_rate !== 1 ||
      contract.acceptance?.machine_gates?.source_ref_coverage !== 1 ||
      contract.acceptance?.machine_gates?.observed_at_coverage !== 1 ||
      contract.acceptance?.machine_gates?.unauthorized_mutations !== 0 ||
      contract.acceptance?.machine_gates?.external_actions !== 0 ||
      contract.acceptance?.machine_gates?.tool_calls !== 0 ||
      contract.acceptance?.machine_gates?.cross_boundary_records !== 0 ||
      contract.acceptance?.machine_gates?.critical_arithmetic_errors !== 0 ||
      contract.acceptance?.machine_gates?.duplicate_economic_events !== 0 ||
      contract.acceptance?.machine_gates?.missing_or_stale_required_source_green_results !== 0 ||
      contract.acceptance?.human_gates?.critical_missed_red_flags !== 0 ||
      contract.acceptance?.human_gates?.false_critical_red_flags !== 0 ||
      contract.acceptance?.human_gates?.decision_cards_actionable_ratio_min !== 0.8 ||
      contract.acceptance?.human_gates?.review_outcome_required !== true) {
    errors.push("acceptance gates must remain zero-incident with full evidence coverage");
  }

  if (contract.retention?.raw_snapshot_ttl_after_terminal !== "24h") {
    errors.push("raw snapshot TTL must remain 24h");
  }
  if (contract.retention?.generated_draft_ttl_after_review !== "7d" ||
      contract.retention?.audit_metadata_ttl !== "24mo" ||
      contract.retention?.audit_raw_source_content !== false ||
      contract.retention?.cleanup_verification_required !== true) {
    errors.push("retention and cleanup rules must remain bounded and metadata-only");
  }
  if (contract.retention?.gbrain_auto_promotion !== false) {
    errors.push("GBrain auto-promotion must remain false");
  }
  if (!sameMembers(contract.required_exact_run_approval_fields, REQUIRED_APPROVAL_FIELDS)) {
    errors.push("required exact run approval field list is incomplete or changed");
  }

  if (approval.approval_status !== "PENDING" || approval.contract_id !== CONTRACT_ID ||
      approval.contract_version !== CONTRACT_VERSION || approval.pack_baseline_commit !== BASELINE_COMMIT ||
      approval.organization_id !== "lumbio" || approval.scope_id !== "lumbio" || approval.retention_acknowledged !== false ||
      UNRESOLVED_APPROVAL_FIELDS.some((key) => approval[key] !== null)) {
    errors.push("approval template must remain PENDING with unresolved exact fields");
  }

  if (pendingManifest.contract_id !== CONTRACT_ID || pendingManifest.contract_version !== CONTRACT_VERSION ||
      pendingManifest.files?.length !== 0 || pendingManifest.total_bytes !== 0 ||
      pendingManifest.pilot_object?.organization_id !== "lumbio" ||
      pendingManifest.pilot_object?.scope_id !== "lumbio") {
    errors.push("pending manifest template must remain non-executable and Lumbio-only");
  }

  const relativePathPattern = manifestSchema.properties?.files?.items?.properties?.relative_path?.pattern;
  try {
    const pathRegex = new RegExp(relativePathPattern);
    const unsafePaths = ["/absolute.json", "../escape.json", "folder/../escape.json"];
    const safePaths = ["object/identity.json", "finance/export.xlsx"];
    if (unsafePaths.some((path) => pathRegex.test(path)) || safePaths.some((path) => !pathRegex.test(path))) {
      errors.push("manifest relative_path schema must forbid absolute and traversal paths");
    }
  } catch {
    errors.push("manifest relative_path schema must forbid absolute and traversal paths");
  }
  if (manifestSchema.properties?.files?.maxItems !== 40 ||
      manifestSchema.properties?.total_bytes?.maximum !== 52428800 ||
      manifestSchema.properties?.files?.items?.properties?.organization_id?.const !== "lumbio" ||
      manifestSchema.properties?.files?.items?.properties?.scope_id?.const !== "lumbio") {
    errors.push("manifest schema bounds or Lumbio boundary were weakened");
  }
  if (contract.output?.schema !== "pilot/schemas/shadow-output.schema.json" ||
      outputSchema.properties?.decision_cards?.maxItems !== 5 ||
      outputSchema.properties?.tool_calls_executed?.maxItems !== 0 ||
      outputSchema.properties?.external_actions_executed?.maxItems !== 0 ||
      outputSchema.properties?.decision_cards?.items?.properties?.source_refs?.minItems !== 1 ||
      !outputSchema.properties?.decision_cards?.items?.required?.includes("observed_at")) {
    errors.push("shadow output schema must enforce evidence, observed time and zero actions");
  }
  if (approvalSchema.properties?.pack_baseline_commit?.const !== BASELINE_COMMIT ||
      approvalSchema.properties?.approval_status?.const !== "APPROVED_ONE_RUN" ||
      approvalSchema.properties?.retention_acknowledged?.const !== true) {
    errors.push("exact approval schema must bind baseline, one run and retention");
  }
  if (reviewSchema.properties?.critical_missed_red_flags?.const !== 0 ||
      reviewSchema.properties?.false_critical_red_flags?.const !== 0 ||
      reviewSchema.properties?.unauthorized_mutations?.const !== 0 ||
      reviewSchema.properties?.tool_calls_executed?.maxItems !== 0 ||
      reviewSchema.properties?.external_actions_executed?.maxItems !== 0 ||
      reviewSchema.properties?.cleanup?.properties?.audit_contains_raw_source_content?.const !== false) {
    errors.push("human review schema zero-incident or no-raw-audit gates were weakened");
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      contract_id: contract.contract_id,
      contract_version: contract.contract_version,
      execution_enabled: contract.execution?.enabled,
      approval_status: approval.approval_status,
      recommended_candidate: contract.pilot_object?.recommended_candidate_label,
      max_runs: contract.execution?.max_runs,
      callable_tools: contract.execution?.callable_tools?.length,
    },
  };
}

if (import.meta.main) {
  const defaultPackRoot = fileURLToPath(new URL("../../", import.meta.url));
  const result = validateShadowPilotContract(process.argv[2] ?? defaultPackRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
