import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { canonicalManifestHash, computeExecutionBundleHash, readRepositoryHead, validateShadowSnapshotPreflight } from "../scripts/preflight-shadow-snapshot.mjs";

const PACK_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACT = JSON.parse(readFileSync(join(PACK_ROOT, "pilot", "shadow-pilot-contract.json"), "utf8"));
const BASELINE = "1b7d60590fe5e6d83f63032fd64fb647a2191296";
const EXECUTION = readRepositoryHead(PACK_ROOT);
const EVIDENCE_CLASSES = CONTRACT.input.required_evidence_classes;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function withSyntheticSnapshot(callback) {
  const root = mkdtempSync(join(tmpdir(), "ceo-shadow-preflight-test-"));
  const snapshotRoot = join(root, "snapshot");
  const outputPath = join(root, "output");
  const consumptionReceiptPath = join(root, "shadow-run-001.consumed.json");
  mkdirSync(snapshotRoot);
  mkdirSync(outputPath);

  const files = EVIDENCE_CLASSES.map((evidenceClass, index) => {
    const artifactId = `artifact-${index + 1}`;
    const relativePath = `${artifactId}.json`;
    const payload = `${JSON.stringify({ synthetic: true, evidence_class: evidenceClass })}\n`;
    writeFileSync(join(snapshotRoot, relativePath), payload);
    return {
      artifact_id: artifactId,
      relative_path: relativePath,
      format: "json",
      bytes: Buffer.byteLength(payload),
      sha256: sha256(payload),
      source_ref: `snapshot://lumbio/epc-hodonin/${artifactId}`,
      observed_at: "2026-08-12T08:00:00+02:00",
      classification: "LUMBIO_INTERNAL",
      evidence_class: evidenceClass,
      lineage: "synthetic preflight fixture",
      organization_id: "lumbio",
      scope_id: "lumbio",
      legal_entity_id: "lumbio-sro",
      object_id: "epc-hodonin",
    };
  });

  const manifest = {
    schema_version: "michael.ceo_double.shadow_input_manifest.v1",
    contract_id: "PILOT-LUMBIO-SHADOW-0.2-R1",
    contract_version: "0.1.0-draft",
    manifest_id: "manifest-epc-hodonin-001",
    created_at: "2026-08-12T08:05:00+02:00",
    prepared_by_role: "approved_operator",
    cutoff_at: "2026-08-12T08:00:00+02:00",
    pilot_object: {
      organization_id: "lumbio",
      scope_id: "lumbio",
      legal_entity_id: "lumbio-sro",
      object_id: "epc-hodonin",
      object_label: "Synthetic EPC Hodonín",
      responsible_owner_id: "synthetic-project-owner",
    },
    files,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    known_gaps: ["finance evidence is an explicit synthetic gap"],
    boundary_review: {
      status: "PASS",
      reviewed_by_role: "approved_operator",
      reviewed_at: "2026-08-12T08:05:00+02:00",
    },
    secret_scan: {
      status: "PASS",
      scanner_version: "synthetic-test-scanner-v1",
      scanned_at: "2026-08-12T08:05:00+02:00",
    },
    manifest_sha256: "",
  };
  manifest.manifest_sha256 = canonicalManifestHash(manifest);
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const contractPath = join(PACK_ROOT, "pilot", "shadow-pilot-contract.json");
  const approval = {
    contract_id: "PILOT-LUMBIO-SHADOW-0.2-R1",
    contract_version: "0.1.0-draft",
    approval_status: "APPROVED_ONE_RUN",
    approval_id: "approval-shadow-run-001",
    run_id: "shadow-run-001",
    approved_at: "2026-08-12T08:00:00+02:00",
    expires_at: "2026-08-13T08:00:00+02:00",
    pack_baseline_commit: BASELINE,
    execution_commit: EXECUTION,
    pilot_contract_sha256: sha256(readFileSync(contractPath)),
    execution_bundle_sha256: computeExecutionBundleHash(PACK_ROOT),
    object_id: "epc-hodonin",
    object_label: "Synthetic EPC Hodonín",
    legal_entity_id: "lumbio-sro",
    organization_id: "lumbio",
    scope_id: "lumbio",
    responsible_owner_id: "synthetic-project-owner",
    snapshot_root: snapshotRoot,
    manifest_path: manifestPath,
    manifest_sha256: manifest.manifest_sha256,
    cutoff_at: "2026-08-12T08:00:00+02:00",
    output_path: outputPath,
    consumption_receipt_path: consumptionReceiptPath,
    human_reviewer_id: "michael-blazicek",
    retention_acknowledged: true,
    allowed: ["one_manual_read_only_shadow_run", "one_local_private_draft", "one_metadata_only_audit", "one_consumption_receipt", "one_human_review", "required_cleanup"],
    forbidden: ["second_run", "different_object_or_manifest", "live_connectors", "network", "schedule", "source_or_external_system_writes", "gbrain_write", "external_actions", "push_pr_merge_deploy_release_publish"],
  };
  const approvalPath = join(root, "approval.json");
  writeFileSync(approvalPath, `${JSON.stringify(approval, null, 2)}\n`);

  const run = () => validateShadowSnapshotPreflight({
    packRoot: PACK_ROOT,
    approvalPath,
    manifestPath,
    snapshotRoot,
    outputPath,
    consumptionReceiptPath,
    nowMs: Date.parse("2026-08-12T09:00:00+02:00"),
  });

  try {
    return callback({ root, snapshotRoot, outputPath, consumptionReceiptPath, manifestPath, approvalPath, manifest, approval, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("manual Lumbio shadow snapshot preflight", () => {
  test("přijme kompletní syntetický snapshot bez spuštění pilotu", () => withSyntheticSnapshot(({ run }) => {
    const result = run();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary.files).toBe(6);
    expect(result.summary.execution_allowed_by_preflight).toBe(true);
  }));

  test("odmítne manifest hash mismatch", () => withSyntheticSnapshot(({ manifestPath, manifest, run }) => {
    manifest.manifest_sha256 = "0".repeat(64);
    writeJson(manifestPath, manifest);
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("manifest canonical SHA-256 mismatch");
  }));

  test("odmítne file hash mismatch", () => withSyntheticSnapshot(({ snapshotRoot, run }) => {
    writeFileSync(join(snapshotRoot, "artifact-1.json"), "tampered\n");
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("file hash mismatch"))).toBe(true);
  }));

  test("odmítne symlink i když vede dovnitř snapshotu", () => withSyntheticSnapshot(({ snapshotRoot, manifestPath, manifest, approvalPath, approval, run }) => {
    const target = join(snapshotRoot, "artifact-1.json");
    const link = join(snapshotRoot, "linked.json");
    symlinkSync(target, link);
    const payload = readFileSync(target);
    manifest.files[0].relative_path = "linked.json";
    manifest.files[0].bytes = payload.length;
    manifest.files[0].sha256 = sha256(payload);
    manifest.manifest_sha256 = canonicalManifestHash(manifest);
    approval.manifest_sha256 = manifest.manifest_sha256;
    writeJson(manifestPath, manifest);
    writeJson(approvalPath, approval);
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("must be a regular non-symlink file"))).toBe(true);
  }));

  test("odmítne traversal cestu", () => withSyntheticSnapshot(({ manifestPath, manifest, approvalPath, approval, run }) => {
    manifest.files[0].relative_path = "../escape.json";
    manifest.manifest_sha256 = canonicalManifestHash(manifest);
    approval.manifest_sha256 = manifest.manifest_sha256;
    writeJson(manifestPath, manifest);
    writeJson(approvalPath, approval);
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("unsafe relative path: ../escape.json");
  }));

  test("odmítne chybějící evidence class", () => withSyntheticSnapshot(({ manifestPath, manifest, approvalPath, approval, run }) => {
    manifest.files.pop();
    manifest.total_bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    manifest.manifest_sha256 = canonicalManifestHash(manifest);
    approval.manifest_sha256 = manifest.manifest_sha256;
    writeJson(manifestPath, manifest);
    writeJson(approvalPath, approval);
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("missing required evidence class"))).toBe(true);
  }));

  test("odmítne boundary nebo object mismatch", () => withSyntheticSnapshot(({ manifestPath, manifest, approvalPath, approval, run }) => {
    manifest.files[0].organization_id = "other-org";
    manifest.files[1].object_id = "other-object";
    manifest.manifest_sha256 = canonicalManifestHash(manifest);
    approval.manifest_sha256 = manifest.manifest_sha256;
    writeJson(manifestPath, manifest);
    writeJson(approvalPath, approval);
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("boundary mismatch"))).toBe(true);
    expect(result.errors.some((error) => error.includes("object mismatch"))).toBe(true);
  }));

  test("odmítne neodpovídající execution commit, contract hash a bundle hash", () => withSyntheticSnapshot(({ approvalPath, approval, run }) => {
    approval.execution_commit = "b".repeat(40);
    approval.pilot_contract_sha256 = "0".repeat(64);
    approval.execution_bundle_sha256 = "0".repeat(64);
    writeJson(approvalPath, approval);
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("current execution commit does not match exact approval");
    expect(result.errors).toContain("pilot contract SHA-256 mismatch");
    expect(result.errors).toContain("execution bundle SHA-256 mismatch");
  }));

  test("odmítne neprázdný output adresář", () => withSyntheticSnapshot(({ outputPath, run }) => {
    writeFileSync(join(outputPath, "existing.txt"), "not empty\n");
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("output path must be an existing empty directory");
  }));

  test("odmítne expirovaný approval nebo okno delší než 24 hodin", () => withSyntheticSnapshot(({ approvalPath, approval, run }) => {
    approval.expires_at = "2026-08-14T08:00:00+02:00";
    writeJson(approvalPath, approval);
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("exact approval is not currently valid or exceeds 24 hours");
  }));

  test("odmítne kalendářně neplatné approval a manifest timestampy", () => withSyntheticSnapshot(({ manifestPath, manifest, approvalPath, approval, run }) => {
    manifest.created_at = "2026-02-30T08:05:00+02:00";
    manifest.manifest_sha256 = canonicalManifestHash(manifest);
    approval.manifest_sha256 = manifest.manifest_sha256;
    approval.approved_at = "2026-13-12T08:00:00+02:00";
    writeJson(manifestPath, manifest);
    writeJson(approvalPath, approval);
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("approval ID/run ID/time window is invalid");
    expect(result.errors).toContain("manifest identity/metadata is invalid");
  }));

  test("odmítne existující consumption receipt jako replay", () => withSyntheticSnapshot(({ consumptionReceiptPath, run }) => {
    writeFileSync(consumptionReceiptPath, "{}\n");
    const result = run();
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("consumption receipt already exists; approval/run replay is blocked");
  }));
});
