#!/usr/bin/env bun

import { resolve } from "node:path";
import { verifyArtifactTree } from "./integrity.mjs";

const root = resolve(import.meta.dirname, "..");
const json = process.argv.includes("--json");
const expectedTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const result = await verifyArtifactTree(root, { expectedTarget });
const report = {
  schema_version: "lazurio.resident.doctor.v1",
  status: result.ok ? "pass" : "fail",
  artifact_id: result.manifest?.artifact_id ?? null,
  profile: result.manifest?.profile ?? null,
  checks: result.checks,
  failure_count: result.failures.length,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`${report.status === "pass" ? "PASS" : "FAIL"} - Lazurio Resident Doctor`);
  console.log(`artifact: ${report.artifact_id ?? "unknown"}`);
  console.log(`profile: ${report.profile ?? "unknown"}`);
  for (const item of report.checks) {
    console.log(`${item.status === "pass" ? "ok" : "fail"} - ${item.id}: ${item.detail}`);
  }
}

if (!result.ok) process.exitCode = 1;
