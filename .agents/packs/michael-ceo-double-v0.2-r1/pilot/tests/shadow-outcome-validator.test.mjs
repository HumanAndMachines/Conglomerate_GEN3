import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { canonicalManifestHash } from "../scripts/preflight-shadow-snapshot.mjs";
import { validateShadowOutcome } from "../scripts/validate-shadow-outcome.mjs";

const PACK_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REF = "snapshot://lumbio/epc-hodonin/artifact-1";
const OBSERVED_AT = "2026-08-12T08:00:00+02:00";

function validPayload() {
  const manifest = {
    schema_version: "michael.ceo_double.shadow_input_manifest.v1",
    contract_id: "PILOT-LUMBIO-SHADOW-0.2-R1",
    contract_version: "0.1.0-draft",
    manifest_id: "manifest-shadow-run-001",
    created_at: OBSERVED_AT,
    prepared_by_role: "approved_operator",
    cutoff_at: OBSERVED_AT,
    pilot_object: {
      organization_id: "lumbio",
      scope_id: "lumbio",
      legal_entity_id: "lumbio-sro",
      object_id: "epc-hodonin",
      object_label: "Synthetic EPC Hodonín",
      responsible_owner_id: "synthetic-owner",
    },
    files: [{
      artifact_id: "artifact-1",
      relative_path: "artifact-1.json",
      format: "json",
      bytes: 2,
      sha256: "a".repeat(64),
      source_ref: REF,
      observed_at: OBSERVED_AT,
      classification: "LUMBIO_INTERNAL",
      evidence_class: "object_identity",
      lineage: "synthetic",
      organization_id: "lumbio",
      scope_id: "lumbio",
      legal_entity_id: "lumbio-sro",
      object_id: "epc-hodonin",
    }],
    total_bytes: 2,
    known_gaps: [],
    boundary_review: { status: "PASS", reviewed_by_role: "approved_operator", reviewed_at: OBSERVED_AT },
    secret_scan: { status: "PASS", scanner_version: "synthetic", scanned_at: OBSERVED_AT },
    manifest_sha256: "",
  };
  manifest.manifest_sha256 = canonicalManifestHash(manifest);
  const approval = {
    contract_id: "PILOT-LUMBIO-SHADOW-0.2-R1",
    contract_version: "0.1.0-draft",
    approval_status: "APPROVED_ONE_RUN",
    approval_id: "approval-shadow-run-001",
    run_id: "shadow-run-001",
    manifest_sha256: manifest.manifest_sha256,
    object_id: "epc-hodonin",
    legal_entity_id: "lumbio-sro",
    organization_id: "lumbio",
    scope_id: "lumbio",
    human_reviewer_id: "michael-blazicek",
  };
  const output = {
    schema_version: "michael.ceo_double.shadow_output.v1",
    contract_id: "PILOT-LUMBIO-SHADOW-0.2-R1",
    contract_version: "0.1.0-draft",
    approval_id: approval.approval_id,
    run_id: approval.run_id,
    manifest_sha256: manifest.manifest_sha256,
    dry_run_only: true,
    pack_version: "0.2.0-r1",
    terminal_state: "COMPLETED",
    overall_status: "ORANGE",
    claims: [{ classification: "FACT", statement: "Synthetic fact", source_refs: [REF], observed_at: OBSERVED_AT, confidence: "HIGH" }],
    source_gaps: [],
    decision_cards: [
      { classification: "RECOMMENDATION", decision: "Synthetic decision 1", owner: "synthetic-owner", deadline: "2026-08-13", impact: "Synthetic", confidence: "HIGH", source_refs: [REF], observed_at: OBSERVED_AT },
      { classification: "CEO_DECISION_REQUIRED", decision: "Synthetic decision 2", owner: "synthetic-owner", deadline: "2026-08-13", impact: "Synthetic", confidence: "MEDIUM", source_refs: [REF], observed_at: OBSERVED_AT },
    ],
    tool_calls_executed: [],
    external_actions_executed: [],
  };
  const review = {
    schema_version: "michael.ceo_double.shadow_human_review.v1",
    contract_id: "PILOT-LUMBIO-SHADOW-0.2-R1",
    contract_version: "0.1.0-draft",
    approval_id: approval.approval_id,
    run_id: approval.run_id,
    manifest_sha256: manifest.manifest_sha256,
    reviewer_id: approval.human_reviewer_id,
    reviewed_at: "2026-08-12T09:00:00+02:00",
    terminal_state: "COMPLETED",
    outcome: "ACCEPT",
    evidence_coverage: { substantive_claims: 3, claims_with_source_refs: 3, claims_with_observed_at: 3 },
    decision_review: { total: 2, actionable: 2 },
    critical_missed_red_flags: 0,
    false_critical_red_flags: 0,
    unauthorized_mutations: 0,
    critical_arithmetic_errors: 0,
    duplicate_economic_events: 0,
    cross_boundary_records: 0,
    missing_or_stale_required_source_green_results: 0,
    tool_calls_executed: [],
    external_actions_executed: [],
    findings: [],
    cleanup: {
      raw_snapshot_deleted: true,
      draft_deletion_due_at: "2026-08-19T09:00:00+02:00",
      audit_contains_raw_source_content: false,
      consumption_receipt_created: true,
      consumption_receipt_contains_raw_source_content: false,
    },
  };
  return { manifest, approval, output, review };
}

function validate(payload) {
  return validateShadowOutcome({
    packRoot: PACK_ROOT,
    ...payload,
    expectedManifestSha256: payload.manifest.manifest_sha256,
  });
}

describe("manual Lumbio shadow outcome validator", () => {
  test("přijme syntetický výstup s plnou evidencí a ACCEPT review", () => {
    const result = validate(validPayload());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("odmítne source ref mimo schválený objekt a manifest", () => {
    const payload = validPayload();
    payload.output.claims[0].source_refs = ["snapshot://lumbio/other/invented-artifact"];
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("source_ref object mismatch"))).toBe(true);
    expect(result.errors.some((error) => error.includes("not present in the approved manifest"))).toBe(true);
  });

  test("odmítne observed_at, který neodpovídá manifestu", () => {
    const payload = validPayload();
    payload.output.claims[0].observed_at = "2026-08-12T07:00:00+02:00";
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("observed_at does not match"))).toBe(true);
  });

  test("odmítne kalendářně neplatný ISO timestamp", () => {
    const payload = validPayload();
    payload.manifest.files[0].observed_at = "2026-99-99T99:99:99Z";
    payload.manifest.manifest_sha256 = canonicalManifestHash(payload.manifest);
    payload.approval.manifest_sha256 = payload.manifest.manifest_sha256;
    payload.output.manifest_sha256 = payload.manifest.manifest_sha256;
    payload.review.manifest_sha256 = payload.manifest.manifest_sha256;
    payload.output.claims[0].observed_at = "2026-99-99T99:99:99Z";
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("invalid classification/statement/observed_at/confidence"))).toBe(true);
  });

  test("odmítne neúplnou evidence coverage", () => {
    const payload = validPayload();
    payload.review.evidence_coverage.claims_with_source_refs = 2;
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("human review evidence coverage must be 100%");
  });

  test("odmítne actionable ratio pod 80 procent", () => {
    const payload = validPayload();
    payload.output.decision_cards.push(
      { ...structuredClone(payload.output.decision_cards[0]), decision: "Synthetic decision 3" },
      { ...structuredClone(payload.output.decision_cards[0]), decision: "Synthetic decision 4" },
      { ...structuredClone(payload.output.decision_cards[0]), decision: "Synthetic decision 5" },
    );
    payload.review.evidence_coverage = { substantive_claims: 6, claims_with_source_refs: 6, claims_with_observed_at: 6 };
    payload.review.decision_review = { total: 5, actionable: 3 };
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("actionable decision ratio must be at least 0.8");
  });

  test("odmítne ACCEPT bez jediné decision card", () => {
    const payload = validPayload();
    payload.output.decision_cards = [];
    payload.review.evidence_coverage = { substantive_claims: 1, claims_with_source_refs: 1, claims_with_observed_at: 1 };
    payload.review.decision_review = { total: 0, actionable: 0 };
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pilot acceptance requires at least one decision card");
  });

  test("odmítne manifest, approval nebo run binding mismatch", () => {
    const payload = validPayload();
    payload.review.manifest_sha256 = "b".repeat(64);
    payload.review.run_id = "other-run";
    payload.output.approval_id = "other-approval";
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("output/review manifest binding mismatch");
    expect(result.errors).toContain("output/review run_id mismatch");
    expect(result.errors).toContain("output/review is not bound to the exact approval");
  });

  test("odmítne jiný approval scope nebo legal entity", () => {
    const payload = validPayload();
    payload.approval.scope_id = "other-org";
    payload.approval.legal_entity_id = "other-entity";
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("output/review is not bound to the exact approval");
  });

  test("odmítne potlačení known gapu ze schváleného manifestu", () => {
    const payload = validPayload();
    payload.manifest.known_gaps = ["synthetic finance gap"];
    payload.manifest.manifest_sha256 = canonicalManifestHash(payload.manifest);
    payload.approval.manifest_sha256 = payload.manifest.manifest_sha256;
    payload.output.manifest_sha256 = payload.manifest.manifest_sha256;
    payload.review.manifest_sha256 = payload.manifest.manifest_sha256;
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("every approved manifest known gap must be represented exactly in output source_gaps");
  });

  test("odmítne GREEN nebo COMPLETED při source gapu", () => {
    const payload = validPayload();
    payload.output.source_gaps = [{ gap_id: "finance-gap", state: "PARTIAL", description: "Synthetic gap", affected_metrics: ["KPI-CEO-02"] }];
    payload.output.overall_status = "GREEN";
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("source gaps forbid GREEN and COMPLETED");
  });

  test("odmítne chybějící cleanup, receipt nebo outcome jiné než ACCEPT", () => {
    const payload = validPayload();
    payload.review.outcome = "REQUIRES_CHANGES";
    payload.review.cleanup.raw_snapshot_deleted = false;
    payload.review.cleanup.consumption_receipt_created = false;
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pilot acceptance requires human outcome ACCEPT");
    expect(result.errors).toContain("raw snapshot cleanup must be verified before acceptance");
    expect(result.errors).toContain("metadata-only consumption receipt must be created and verified");
  });

  test("odmítne nenulový machine-gate incident", () => {
    const payload = validPayload();
    payload.review.duplicate_economic_events = 1;
    const result = validate(payload);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("human review zero-incident gates are not satisfied");
  });
});
