#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalManifestHash, parseStrictIsoDateTime } from "./preflight-shadow-snapshot.mjs";

const CONTRACT_ID = "PILOT-LUMBIO-SHADOW-0.2-R1";
const CONTRACT_VERSION = "0.1.0-draft";
const PACK_VERSION = "0.2.0-r1";
const HASH = /^[a-f0-9]{64}$/;

const SOURCE_REF = /^snapshot:\/\/lumbio\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/;
const CLAIM_CLASSES = new Set(["FACT", "ASSUMPTION", "INTERPRETATION", "RECOMMENDATION", "CEO_DECISION_REQUIRED"]);
const DECISION_CLASSES = new Set(["RECOMMENDATION", "CEO_DECISION_REQUIRED"]);
const CONFIDENCE = new Set(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]);
const TERMINAL = new Set(["COMPLETED", "PARTIAL", "BLOCKED", "FAILED", "CANCELLED"]);
const STATUS = new Set(["GREEN", "ORANGE", "RED", "GRAY_UNKNOWN"]);
const OUTCOMES = new Set(["ACCEPT", "REJECT", "REQUIRES_CHANGES"]);
const GAP_STATES = new Set(["PARTIAL", "BLOCKED", "ACCESS_MISSING", "ACCESS_UNVERIFIED", "STALE", "CONFLICTED", "NEZNÁMÉ"]);
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function readJson(path, errors, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label} invalid or unreadable: ${error.message}`);
    return null;
  }
}

function emptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function validateSourceRefs(refs, expectedObjectId, manifestSources, observedAt, errors, label) {
  if (!Array.isArray(refs) || refs.length === 0) {
    errors.push(`${label}: source_refs must be a non-empty array`);
    return;
  }
  const sourceTimes = [];
  for (const ref of refs) {
    const match = SOURCE_REF.exec(ref ?? "");
    if (!match) errors.push(`${label}: invalid snapshot source_ref`);
    else if (expectedObjectId && match[1] !== expectedObjectId) errors.push(`${label}: source_ref object mismatch`);
    const manifestSource = manifestSources.get(ref);
    if (!manifestSource) errors.push(`${label}: source_ref is not present in the approved manifest`);
    else sourceTimes.push(manifestSource.observed_at);
  }
  if (sourceTimes.length === refs.length) {
    const expectedObservedAt = [...sourceTimes].sort((a, b) => parseStrictIsoDateTime(b) - parseStrictIsoDateTime(a))[0];
    if (observedAt !== expectedObservedAt) errors.push(`${label}: observed_at does not match latest referenced manifest observation`);
  }
}

export function validateShadowOutcome(options) {
  const errors = [];
  const output = options.output;
  const review = options.review;
  const manifest = options.manifest;
  const approval = options.approval;
  const expectedManifestSha256 = options.expectedManifestSha256;
  const expectedObjectId = approval?.object_id ?? options.expectedObjectId;
  if (!output || typeof output !== "object" || Array.isArray(output) ||
      !review || typeof review !== "object" || Array.isArray(review) ||
      !manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      !approval || typeof approval !== "object" || Array.isArray(approval)) {
    return { ok: false, errors: ["output, review, manifest and approval objects are required"], summary: {} };
  }

  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const claims = Array.isArray(output.claims) ? output.claims : [];
  const decisionCards = Array.isArray(output.decision_cards) ? output.decision_cards : [];
  const sourceGaps = Array.isArray(output.source_gaps) ? output.source_gaps : [];
  const manifestKnownGaps = Array.isArray(manifest.known_gaps) ? manifest.known_gaps : [];
  const manifestSources = new Map(manifestFiles.map((file) => [file?.source_ref, file]));
  if (manifest.manifest_sha256 !== canonicalManifestHash(manifest) || manifest.manifest_sha256 !== expectedManifestSha256) {
    errors.push("approved manifest canonical hash mismatch");
  }
  const manifestObject = manifest.pilot_object ?? {};
  if (approval.contract_id !== CONTRACT_ID || approval.contract_version !== CONTRACT_VERSION ||
      approval.approval_status !== "APPROVED_ONE_RUN" || approval.organization_id !== "lumbio" || approval.scope_id !== "lumbio" ||
      approval.manifest_sha256 !== expectedManifestSha256 ||
      approval.run_id !== output.run_id || approval.approval_id !== output.approval_id ||
      approval.human_reviewer_id !== review.reviewer_id || manifest.contract_id !== CONTRACT_ID ||
      manifest.contract_version !== CONTRACT_VERSION || manifestObject.organization_id !== "lumbio" ||
      manifestObject.scope_id !== "lumbio" || manifestObject.object_id !== approval.object_id ||
      manifestObject.legal_entity_id !== approval.legal_entity_id) {
    errors.push("output/review is not bound to the exact approval");
  }

  if (output.schema_version !== "michael.ceo_double.shadow_output.v1" ||
      output.contract_id !== CONTRACT_ID || output.contract_version !== CONTRACT_VERSION ||
      output.dry_run_only !== true || output.pack_version !== PACK_VERSION ||
      output.approval_id !== approval.approval_id ||
      typeof output.run_id !== "string" || output.run_id.length === 0 ||
      !HASH.test(output.manifest_sha256 ?? "") || !TERMINAL.has(output.terminal_state) ||
      !STATUS.has(output.overall_status)) errors.push("shadow output identity/status fields are invalid");
  if (output.manifest_sha256 !== expectedManifestSha256) errors.push("output manifest does not match expected manifest hash");
  if (!emptyArray(output.tool_calls_executed)) errors.push("output tool calls must be empty");
  if (!emptyArray(output.external_actions_executed)) errors.push("output external actions must be empty");

  if (!Array.isArray(output.claims)) errors.push("claims must be an array");
  for (const [index, claim] of claims.entries()) {
    const label = `claim ${index}`;
    if (!claim || typeof claim !== "object" || !CLAIM_CLASSES.has(claim.classification) ||
        typeof claim.statement !== "string" || claim.statement.length === 0 ||
        !Number.isFinite(parseStrictIsoDateTime(claim.observed_at)) || !CONFIDENCE.has(claim.confidence)) {
      errors.push(`${label}: invalid classification/statement/observed_at/confidence`);
    }
    validateSourceRefs(claim.source_refs, expectedObjectId, manifestSources, claim.observed_at, errors, label);
  }

  if (!Array.isArray(output.decision_cards) || output.decision_cards.length > 5) {
    errors.push("decision_cards must be an array with at most 5 items");
  }
  for (const [index, card] of decisionCards.entries()) {
    const label = `decision ${index}`;
    if (!card || typeof card !== "object" || !DECISION_CLASSES.has(card.classification) ||
        [card.decision, card.owner, card.deadline, card.impact].some((value) => typeof value !== "string" || value.length === 0) ||
        !Number.isFinite(parseStrictIsoDateTime(card.observed_at)) || !CONFIDENCE.has(card.confidence)) {
      errors.push(`${label}: invalid fields`);
    }
    validateSourceRefs(card.source_refs, expectedObjectId, manifestSources, card.observed_at, errors, label);
  }

  if (!Array.isArray(output.source_gaps)) errors.push("source_gaps must be an array");
  const outputGapDescriptions = new Set(sourceGaps.map((gap) => gap?.description));
  if (manifestKnownGaps.some((gap) => !outputGapDescriptions.has(gap))) {
    errors.push("every approved manifest known gap must be represented exactly in output source_gaps");
  }
  if ((output.source_gaps?.length ?? 0) > 0 && (output.overall_status === "GREEN" || output.terminal_state === "COMPLETED")) {
    errors.push("source gaps forbid GREEN and COMPLETED");
  }

  if (review.schema_version !== "michael.ceo_double.shadow_human_review.v1" ||
      review.contract_id !== CONTRACT_ID || review.contract_version !== CONTRACT_VERSION ||
      review.approval_id !== approval.approval_id ||
      typeof review.reviewer_id !== "string" || review.reviewer_id.length === 0 ||
      !Number.isFinite(parseStrictIsoDateTime(review.reviewed_at)) || !TERMINAL.has(review.terminal_state) ||
      !OUTCOMES.has(review.outcome)) errors.push("human review identity/status fields are invalid");
  if (review.run_id !== output.run_id) errors.push("output/review run_id mismatch");
  if (review.manifest_sha256 !== output.manifest_sha256 || review.manifest_sha256 !== expectedManifestSha256) {
    errors.push("output/review manifest binding mismatch");
  }
  if (review.terminal_state !== output.terminal_state) errors.push("output/review terminal_state mismatch");
  if (!emptyArray(review.tool_calls_executed) || !emptyArray(review.external_actions_executed)) {
    errors.push("human review tool calls and external actions must be empty");
  }
  if (review.critical_missed_red_flags !== 0 || review.false_critical_red_flags !== 0 || review.unauthorized_mutations !== 0 ||
      review.critical_arithmetic_errors !== 0 || review.duplicate_economic_events !== 0 ||
      review.cross_boundary_records !== 0 || review.missing_or_stale_required_source_green_results !== 0) {
    errors.push("human review zero-incident gates are not satisfied");
  }

  const coverage = review.evidence_coverage ?? {};
  const actualSubstantiveClaims = (output.claims?.length ?? 0) + (output.decision_cards?.length ?? 0);
  if (!Number.isInteger(coverage.substantive_claims) || coverage.substantive_claims !== actualSubstantiveClaims ||
      coverage.claims_with_source_refs !== coverage.substantive_claims ||
      coverage.claims_with_observed_at !== coverage.substantive_claims) {
    errors.push("human review evidence coverage must be 100%");
  }
  const decisionReview = review.decision_review ?? {};
  if (!Number.isInteger(decisionReview.total) || decisionReview.total !== (output.decision_cards?.length ?? 0) ||
      !Number.isInteger(decisionReview.actionable) || decisionReview.actionable < 0 || decisionReview.actionable > decisionReview.total) {
    errors.push("human decision review totals must match the output");
  } else if (decisionReview.total < 1) {
    errors.push("pilot acceptance requires at least one decision card");
  } else if (decisionReview.actionable / decisionReview.total < 0.8) {
    errors.push("actionable decision ratio must be at least 0.8");
  }

  if (review.outcome !== "ACCEPT") errors.push("pilot acceptance requires human outcome ACCEPT");
  if (review.cleanup?.raw_snapshot_deleted !== true) errors.push("raw snapshot cleanup must be verified before acceptance");
  if (!Number.isFinite(parseStrictIsoDateTime(review.cleanup?.draft_deletion_due_at))) errors.push("draft deletion deadline is missing or invalid");
  if (review.cleanup?.audit_contains_raw_source_content !== false) errors.push("audit must not contain raw source content");
  if (review.cleanup?.consumption_receipt_created !== true ||
      review.cleanup?.consumption_receipt_contains_raw_source_content !== false) {
    errors.push("metadata-only consumption receipt must be created and verified");
  }
  const reviewTime = parseStrictIsoDateTime(review.reviewed_at);
  const deletionTime = parseStrictIsoDateTime(review.cleanup?.draft_deletion_due_at);
  if (Number.isFinite(reviewTime) && Number.isFinite(deletionTime) &&
      (deletionTime < reviewTime || deletionTime - reviewTime > 7 * 24 * 60 * 60 * 1000)) {
    errors.push("draft deletion deadline must be within 7 days after review");
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      contract_id: CONTRACT_ID,
      run_id: output.run_id,
      terminal_state: output.terminal_state,
      outcome: review.outcome,
      claims: output.claims?.length ?? 0,
      decisions: output.decision_cards?.length ?? 0,
      actionable: decisionReview.actionable,
      accepted: errors.length === 0,
      note: "Outcome validation closes one reviewed run only; it does not authorize another run or runtime activation.",
    },
  };
}

if (import.meta.main) {
  const [outputPath, reviewPath, manifestPath, approvalPath] = process.argv.slice(2);
  if (![outputPath, reviewPath, manifestPath, approvalPath].every(Boolean)) {
    process.stderr.write("Usage: validate-shadow-outcome.mjs <output.json> <review.json> <manifest.json> <approval.json>\n");
    process.exitCode = 2;
  } else {
    const errors = [];
    const output = readJson(resolve(outputPath), errors, "output");
    const review = readJson(resolve(reviewPath), errors, "review");
    const manifest = readJson(resolve(manifestPath), errors, "manifest");
    const approval = readJson(resolve(approvalPath), errors, "approval");
    const result = errors.length ? { ok: false, errors, summary: {} } : validateShadowOutcome({
      packRoot: fileURLToPath(new URL("../../", import.meta.url)),
      output,
      review,
      manifest,
      approval,
      expectedManifestSha256: manifest.manifest_sha256,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}
