#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_ID = "PILOT-LUMBIO-SHADOW-0.2-R1";
const CONTRACT_VERSION = "0.1.0-draft";
const BASELINE_COMMIT = "1b7d60590fe5e6d83f63032fd64fb647a2191296";
const ALLOWED_FORMATS = new Set(["json", "csv", "xlsx", "pdf", "md"]);
const ALLOWED_CLASSIFICATIONS = new Set(["LUMBIO_INTERNAL", "LUMBIO_CONFIDENTIAL", "LUMBIO_FINANCE_RESTRICTED"]);
const ALLOWED_PREPARER_ROLES = new Set(["principal", "approved_lumbio_data_owner", "approved_operator"]);
const ALLOWED = ["one_manual_read_only_shadow_run", "one_local_private_draft", "one_metadata_only_audit", "one_consumption_receipt", "one_human_review", "required_cleanup"];
const FORBIDDEN = ["second_run", "different_object_or_manifest", "live_connectors", "network", "schedule", "source_or_external_system_writes", "gbrain_write", "external_actions", "push_pr_merge_deploy_release_publish"];
const SOURCE_REF = /^snapshot:\/\/lumbio\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseStrictIsoDateTime(value) {
  if (typeof value !== "string") return Number.NaN;
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return Number.NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return Number.NaN;
  if (zone !== "Z") {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return Number.NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isStrictIsoDateTime(value) {
  return Number.isFinite(parseStrictIsoDateTime(value));
}

function findRepositoryRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Git repository root not found");
    current = parent;
  }
}

function resolveGitDir(repoRoot) {
  const marker = join(repoRoot, ".git");
  const stat = lstatSync(marker);
  if (stat.isDirectory()) return realpathSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsupported .git marker");
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, "utf8"));
  if (!match) throw new Error("Invalid .git file");
  return realpathSync(resolve(repoRoot, match[1].trim()));
}

export function readRepositoryHead(packRootInput) {
  const repoRoot = findRepositoryRoot(packRootInput);
  const gitDir = resolveGitDir(repoRoot);
  const commonDirPath = join(gitDir, "commondir");
  const commonDir = existsSync(commonDirPath)
    ? realpathSync(resolve(gitDir, readFileSync(commonDirPath, "utf8").trim()))
    : gitDir;
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  const refMatch = /^ref:\s*(.+)$/.exec(head);
  if (!refMatch) throw new Error("Unsupported Git HEAD format");
  const ref = refMatch[1];
  for (const refRoot of [...new Set([gitDir, commonDir])]) {
    const looseRef = join(refRoot, ...ref.split("/"));
    if (existsSync(looseRef)) {
      const value = readFileSync(looseRef, "utf8").trim();
      if (/^[a-f0-9]{40}$/.test(value)) return value;
    }
  }
  for (const refRoot of [...new Set([gitDir, commonDir])]) {
    const packedRefsPath = join(refRoot, "packed-refs");
    if (existsSync(packedRefsPath)) {
      for (const line of readFileSync(packedRefsPath, "utf8").split(/\r?\n/)) {
        if (line.startsWith("#") || line.startsWith("^") || line.trim() === "") continue;
        const [value, name] = line.split(" ");
        if (name === ref && /^[a-f0-9]{40}$/.test(value)) return value;
      }
    }
  }
  throw new Error(`Unable to resolve Git HEAD ref: ${ref}`);
}

function listBundleFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) throw new Error(`Execution bundle contains symlink: ${relative(root, fullPath)}`);
    if (stat.isDirectory()) files.push(...listBundleFiles(root, fullPath));
    else if (stat.isFile()) files.push(fullPath);
    else throw new Error(`Execution bundle contains non-regular entry: ${relative(root, fullPath)}`);
  }
  return files;
}

export function computeExecutionBundleHash(packRootInput) {
  const packRoot = realpathSync(resolve(packRootInput));
  const hash = createHash("sha256");
  for (const path of listBundleFiles(packRoot).sort((a, b) => relative(packRoot, a).localeCompare(relative(packRoot, b), "en"))) {
    const rel = relative(packRoot, path).split(sep).join("/");
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(rel)}:${rel}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalManifestHash(manifest) {
  const payload = structuredClone(manifest);
  delete payload.manifest_sha256;
  return sha256(JSON.stringify(canonicalize(payload)));
}

function readJson(path, errors, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label} is invalid or unreadable: ${error.message}`);
    return null;
  }
}

function exactArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment));
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateApproval(approval, contractBytes, currentCommit, executionBundleSha256, expectedPaths, nowMs, errors) {
  if (approval.contract_id !== CONTRACT_ID || approval.contract_version !== CONTRACT_VERSION ||
      approval.approval_status !== "APPROVED_ONE_RUN") errors.push("exact approval identity/status mismatch");
  if (approval.pack_baseline_commit !== BASELINE_COMMIT) errors.push("pack baseline commit mismatch");
  if (approval.execution_commit !== currentCommit) errors.push("current execution commit does not match exact approval");
  if (approval.pilot_contract_sha256 !== sha256(contractBytes)) errors.push("pilot contract SHA-256 mismatch");
  if (approval.execution_bundle_sha256 !== executionBundleSha256) errors.push("execution bundle SHA-256 mismatch");
  if (!SAFE_ID.test(approval.approval_id ?? "") || !SAFE_ID.test(approval.run_id ?? "") ||
      !isStrictIsoDateTime(approval.approved_at) || !isStrictIsoDateTime(approval.expires_at)) {
    errors.push("approval ID/run ID/time window is invalid");
  } else {
    const approvedAt = parseStrictIsoDateTime(approval.approved_at);
    const expiresAt = parseStrictIsoDateTime(approval.expires_at);
    if (expiresAt <= approvedAt || expiresAt - approvedAt > 24 * 60 * 60 * 1000 || nowMs < approvedAt || nowMs >= expiresAt) {
      errors.push("exact approval is not currently valid or exceeds 24 hours");
    }
  }
  if (!SAFE_ID.test(approval.object_id ?? "") || typeof approval.object_label !== "string" || approval.object_label.length === 0 ||
      typeof approval.legal_entity_id !== "string" || approval.legal_entity_id.length === 0 ||
      approval.organization_id !== "lumbio" || approval.scope_id !== "lumbio" ||
      typeof approval.responsible_owner_id !== "string" || approval.responsible_owner_id.length === 0 ||
      typeof approval.human_reviewer_id !== "string" || approval.human_reviewer_id.length === 0) {
    errors.push("exact approval object/scope/owner fields are missing or invalid");
  }
  if (!SHA256.test(approval.manifest_sha256 ?? "") || !isStrictIsoDateTime(approval.cutoff_at) ||
      approval.retention_acknowledged !== true) errors.push("exact approval hash/cutoff/retention fields are invalid");
  if (approval.snapshot_root !== expectedPaths.snapshotRoot || approval.manifest_path !== expectedPaths.manifestPath ||
      approval.output_path !== expectedPaths.outputPath || approval.consumption_receipt_path !== expectedPaths.consumptionReceiptPath) {
    errors.push("exact approval paths do not match requested preflight paths");
  }
  if (!exactArray(approval.allowed, ALLOWED) || !exactArray(approval.forbidden, FORBIDDEN)) {
    errors.push("exact approval allowed/forbidden scope mismatch");
  }
}

export function validateShadowSnapshotPreflight(options) {
  const packRoot = realpathSync(resolve(options.packRoot));
  const approvalPath = resolve(options.approvalPath);
  const manifestPath = resolve(options.manifestPath);
  const snapshotRoot = resolve(options.snapshotRoot);
  const outputPath = resolve(options.outputPath);
  const consumptionReceiptPath = resolve(options.consumptionReceiptPath);
  const errors = [];
  const contractPath = join(packRoot, "pilot", "shadow-pilot-contract.json");
  const contractBytes = readFileSync(contractPath);
  const contract = readJson(contractPath, errors, "pilot contract");
  const approval = readJson(approvalPath, errors, "exact approval");
  const manifest = readJson(manifestPath, errors, "snapshot manifest");
  if (!contract || !approval || !manifest) return { ok: false, errors, summary: {} };

  let currentCommit;
  let executionBundleSha256;
  try {
    currentCommit = readRepositoryHead(packRoot);
    executionBundleSha256 = computeExecutionBundleHash(packRoot);
  } catch (error) {
    errors.push(`execution identity unavailable: ${error.message}`);
  }
  validateApproval(
    approval,
    contractBytes,
    currentCommit,
    executionBundleSha256,
    { snapshotRoot, manifestPath, outputPath, consumptionReceiptPath },
    options.nowMs ?? Date.now(),
    errors,
  );
  if (contract.execution?.enabled !== false || contract.execution?.network_enabled !== false ||
      contract.execution?.live_connectors_enabled !== false || contract.execution?.writes_enabled !== false ||
      contract.execution?.gbrain_write_enabled !== false || contract.execution?.external_actions_enabled !== false ||
      !Array.isArray(contract.execution?.callable_tools) || contract.execution.callable_tools.length !== 0 ||
      contract.execution?.max_runs !== 1) errors.push("pilot contract is not safely disabled/one-shot");

  let snapshotReal;
  let outputReal;
  try {
    const snapshotStat = lstatSync(snapshotRoot);
    if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink()) errors.push("snapshot root must be a non-symlink directory");
    snapshotReal = realpathSync(snapshotRoot);
  } catch (error) {
    errors.push(`snapshot root is unavailable: ${error.message}`);
  }
  try {
    const outputStat = lstatSync(outputPath);
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || readdirSync(outputPath).length !== 0) {
      errors.push("output path must be an existing empty directory");
    }
    outputReal = realpathSync(outputPath);
  } catch (error) {
    errors.push(`output path is unavailable: ${error.message}`);
  }
  if (snapshotReal && outputReal && (isInside(snapshotReal, outputReal) || isInside(outputReal, snapshotReal))) {
    errors.push("snapshot and output paths must be disjoint");
  }
  const gbrainMarkers = ["/gbrain/", "/.spectoda-brain/"];
  if (gbrainMarkers.some((marker) => `${outputPath}/`.includes(marker))) errors.push("output path must remain outside GBrain");
  if (gbrainMarkers.some((marker) => `${consumptionReceiptPath}/`.includes(marker)) ||
      (snapshotReal && isInside(snapshotReal, consumptionReceiptPath)) ||
      consumptionReceiptPath === outputPath || isInside(outputPath, consumptionReceiptPath)) {
    errors.push("consumption receipt path must remain outside snapshot, output and GBrain");
  }
  if (existsSync(consumptionReceiptPath)) errors.push("consumption receipt already exists; approval/run replay is blocked");
  try {
    const receiptParent = realpathSync(dirname(consumptionReceiptPath));
    if (snapshotReal && isInside(snapshotReal, receiptParent)) errors.push("consumption receipt parent resolves inside snapshot");
  } catch (error) {
    errors.push(`consumption receipt parent is unavailable: ${error.message}`);
  }

  if (manifest.schema_version !== "michael.ceo_double.shadow_input_manifest.v1" ||
      manifest.contract_id !== CONTRACT_ID || manifest.contract_version !== CONTRACT_VERSION ||
      !SAFE_ID.test(manifest.manifest_id ?? "") || !isStrictIsoDateTime(manifest.created_at) ||
      !isStrictIsoDateTime(manifest.cutoff_at) || !ALLOWED_PREPARER_ROLES.has(manifest.prepared_by_role)) {
    errors.push("manifest identity/metadata is invalid");
  }
  if (manifest.manifest_sha256 !== canonicalManifestHash(manifest) || approval.manifest_sha256 !== manifest.manifest_sha256) {
    errors.push("manifest canonical SHA-256 mismatch");
  }
  if (manifest.cutoff_at !== approval.cutoff_at) errors.push("manifest cutoff does not match exact approval");
  const object = manifest.pilot_object ?? {};
  if (object.organization_id !== "lumbio" || object.scope_id !== "lumbio" ||
      object.legal_entity_id !== approval.legal_entity_id || object.object_id !== approval.object_id ||
      object.object_label !== approval.object_label || object.responsible_owner_id !== approval.responsible_owner_id) {
    errors.push("manifest pilot object does not match exact approval");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 40) {
    errors.push("manifest must contain 1 to 40 files");
  }
  if (manifest.boundary_review?.status !== "PASS" || !isStrictIsoDateTime(manifest.boundary_review?.reviewed_at) ||
      typeof manifest.boundary_review?.reviewed_by_role !== "string" || manifest.boundary_review.reviewed_by_role.length === 0) {
    errors.push("manifest requires an explicit PASS boundary review attestation");
  }
  if (manifest.secret_scan?.status !== "PASS" || !isStrictIsoDateTime(manifest.secret_scan?.scanned_at) ||
      typeof manifest.secret_scan?.scanner_version !== "string" || manifest.secret_scan.scanner_version.length === 0) {
    errors.push("manifest requires an explicit PASS secret scan attestation");
  }

  const requiredEvidence = new Set(contract.input?.required_evidence_classes ?? []);
  const foundEvidence = new Set();
  const artifactIds = new Set();
  const relativePaths = new Set();
  const sourceRefs = new Set();
  let computedTotal = 0;

  for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
    const prefix = `artifact ${file?.artifact_id ?? "<unknown>"}`;
    if (!SAFE_ID.test(file?.artifact_id ?? "") || artifactIds.has(file.artifact_id)) errors.push(`${prefix}: invalid or duplicate artifact_id`);
    else artifactIds.add(file.artifact_id);
    if (!safeRelativePath(file?.relative_path)) {
      errors.push(`unsafe relative path: ${file?.relative_path}`);
      continue;
    }
    if (relativePaths.has(file.relative_path)) errors.push(`${prefix}: duplicate relative path`);
    relativePaths.add(file.relative_path);
    if (!ALLOWED_FORMATS.has(file.format) || !Number.isInteger(file.bytes) || file.bytes < 1 ||
        !SHA256.test(file.sha256 ?? "") || !isStrictIsoDateTime(file.observed_at) ||
        !ALLOWED_CLASSIFICATIONS.has(file.classification) || typeof file.lineage !== "string" || file.lineage.length === 0) {
      errors.push(`${prefix}: invalid format/bytes/hash/time/classification/lineage`);
    }
    const sourceMatch = SOURCE_REF.exec(file.source_ref ?? "");
    if (!sourceMatch || sourceMatch[1] !== approval.object_id || sourceMatch[2] !== file.artifact_id || sourceRefs.has(file.source_ref)) {
      errors.push(`${prefix}: invalid, duplicate or mismatched source_ref`);
    }
    sourceRefs.add(file.source_ref);
    if (file.organization_id !== "lumbio" || file.scope_id !== "lumbio") errors.push(`${prefix}: boundary mismatch`);
    if (file.legal_entity_id !== approval.legal_entity_id) errors.push(`${prefix}: legal entity mismatch`);
    if (file.object_id !== approval.object_id) errors.push(`${prefix}: object mismatch`);
    if (!requiredEvidence.has(file.evidence_class)) errors.push(`${prefix}: unknown evidence class`);
    else foundEvidence.add(file.evidence_class);
    const observed = parseStrictIsoDateTime(file.observed_at);
    const cutoff = parseStrictIsoDateTime(approval.cutoff_at);
    if (Number.isFinite(observed) && Number.isFinite(cutoff) && observed > cutoff) errors.push(`${prefix}: observed_at is after approved cutoff`);

    if (snapshotReal) {
      const fullPath = resolve(snapshotRoot, file.relative_path);
      if (!isInside(snapshotRoot, fullPath)) {
        errors.push(`unsafe relative path: ${file.relative_path}`);
      } else {
        try {
          const stat = lstatSync(fullPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            errors.push(`${prefix}: must be a regular non-symlink file`);
          } else {
            const real = realpathSync(fullPath);
            if (!isInside(snapshotReal, real)) errors.push(`${prefix}: resolved path escapes snapshot root`);
            const bytes = readFileSync(fullPath);
            if (stat.size !== file.bytes) errors.push(`${prefix}: file size mismatch`);
            if (sha256(bytes) !== file.sha256) errors.push(`${prefix}: file hash mismatch`);
            computedTotal += stat.size;
          }
        } catch (error) {
          errors.push(`${prefix}: file unavailable: ${error.message}`);
        }
      }
    }
  }

  for (const evidence of requiredEvidence) {
    if (!foundEvidence.has(evidence)) errors.push(`missing required evidence class: ${evidence}`);
  }
  if (!Number.isInteger(manifest.total_bytes) || manifest.total_bytes !== computedTotal || manifest.total_bytes > 52428800) {
    errors.push("manifest total_bytes mismatch or limit exceeded");
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      contract_id: CONTRACT_ID,
      object_id: approval.object_id,
      manifest_sha256: manifest.manifest_sha256,
      files: Array.isArray(manifest.files) ? manifest.files.length : 0,
      total_bytes: manifest.total_bytes,
      evidence_classes: [...foundEvidence].sort(),
      execution_allowed_by_preflight: errors.length === 0,
      note: "Preflight success only satisfies static input gates; it does not start the pilot.",
    },
  };
}

if (import.meta.main) {
  const [approvalPath, manifestPath, snapshotRoot, outputPath, consumptionReceiptPath, packRootArg] = process.argv.slice(2);
  if (![approvalPath, manifestPath, snapshotRoot, outputPath, consumptionReceiptPath].every(Boolean)) {
    process.stderr.write("Usage: preflight-shadow-snapshot.mjs <approval.json> <manifest.json> <snapshot-root> <output-dir> <consumption-receipt-path> [pack-root]\n");
    process.exitCode = 2;
  } else {
    const packRoot = packRootArg ?? fileURLToPath(new URL("../../", import.meta.url));
    const result = validateShadowSnapshotPreflight({ packRoot, approvalPath, manifestPath, snapshotRoot, outputPath, consumptionReceiptPath });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}
