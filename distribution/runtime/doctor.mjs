#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const json = process.argv.includes("--json");
const failures = [];
const checks = [];

function check(id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
  if (!ok) failures.push(`${id}: ${detail}`);
}

let manifest;
try {
  manifest = JSON.parse(await readFile(join(root, "lazurio.resident.json"), "utf8"));
  check(
    "manifest-shape",
    manifest?.schema_version === "lazurio.resident.manifest.v1"
      && typeof manifest?.profile === "string"
      && Array.isArray(manifest?.payload?.files),
    "lazurio.resident.manifest.v1 with profile and payload inventory",
  );
} catch (error) {
  check(
    "manifest-shape",
    false,
    `manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (manifest) {
  const currentTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const declaredTarget = `${manifest.target?.os}-${manifest.target?.arch}`;
  check(
    "platform-compatibility",
    currentTarget === declaredTarget,
    `running ${currentTarget}; artifact ${declaredTarget}`,
  );
  check(
    "no-git-root",
    !existsSync(join(root, ".git")),
    ".git must not exist in the resident root",
  );

  const expected = new Set(["lazurio.resident.json"]);
  for (const file of manifest.payload?.files ?? []) {
    expected.add(file.path);
    const path = join(root, ...String(file.path).split("/"));
    try {
      const stat = await lstat(path);
      const regular = stat.isFile() && !stat.isSymbolicLink();
      if (!regular) {
        check(`payload:${file.path}`, false, "not a regular immutable file");
        continue;
      }
      const bytes = await readFile(path);
      check(
        `payload:${file.path}`,
        bytes.length === file.size && sha256(bytes) === file.sha256,
        bytes.length === file.size && sha256(bytes) === file.sha256
          ? "size and sha256 match"
          : "size or sha256 mismatch",
      );
    } catch {
      check(`payload:${file.path}`, false, "missing immutable payload file");
    }
  }

  const mutableMounts = new Set(manifest.mutable_mounts ?? []);
  const actual = await listImmutableFiles(root, mutableMounts, failures);
  for (const path of actual) {
    if (!expected.has(path)) check(`unexpected:${path}`, false, "unexpected immutable file");
  }
  for (const path of expected) {
    if (!actual.includes(path)) check(`missing:${path}`, false, "manifest entry is absent");
  }
  const agents = actual.filter((path) => basename(path) === "AGENTS.md");
  check(
    "profile-boundary",
    agents.length === 1 && agents[0] === "AGENTS.md",
    "exactly one root AGENTS.md must exist",
  );

  const payloadDigest = digestInventory(manifest.payload?.files ?? []);
  check(
    "payload-inventory",
    payloadDigest === manifest.payload?.digest,
    payloadDigest === manifest.payload?.digest ? "inventory digest matches" : "inventory digest mismatch",
  );

  try {
    const profile = JSON.parse(await readFile(join(root, "resident", "profile.json"), "utf8"));
    check(
      "profile-id",
      profile?.schema_version === "lazurio.resident.profile.v1"
        && profile?.id === manifest.profile,
      `profile descriptor must match ${manifest.profile}`,
    );
  } catch (error) {
    check(
      "profile-id",
      false,
      `profile descriptor cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const hermes = JSON.parse(
      await readFile(join(root, "resident", "dependencies", "hermes.json"), "utf8"),
    );
    check(
      "hermes-pin",
      hermes?.repository === manifest.dependencies?.hermes?.repository
        && hermes?.commit === manifest.dependencies?.hermes?.commit
        && hermes?.lock_sha256 === manifest.dependencies?.hermes?.lock_sha256
        && hermes?.compatibility?.independent_self_update_allowed === false,
      "exact fork commit and lock digest match the artifact manifest",
    );
  } catch (error) {
    check(
      "hermes-pin",
      false,
      `Hermes pin cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const report = {
  schema_version: "lazurio.resident.doctor.v1",
  status: failures.length === 0 ? "pass" : "fail",
  artifact_id: manifest?.artifact_id ?? null,
  profile: manifest?.profile ?? null,
  checks,
  failure_count: failures.length,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`${report.status === "pass" ? "PASS" : "FAIL"} - Lazurio Resident Doctor`);
  console.log(`artifact: ${report.artifact_id ?? "unknown"}`);
  console.log(`profile: ${report.profile ?? "unknown"}`);
  for (const item of checks) {
    console.log(`${item.status === "pass" ? "ok" : "fail"} - ${item.id}: ${item.detail}`);
  }
}

if (failures.length > 0) process.exitCode = 1;

async function listImmutableFiles(directory, mutableMounts, scanFailures, prefix = "") {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && mutableMounts.has(entry.name)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        scanFailures.push(`${relativePath}: mutable mount must be a directory or link`);
      }
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.name === ".git") {
      scanFailures.push(`${relativePath}: Git metadata is forbidden in the immutable root`);
      continue;
    }
    if (entry.isSymbolicLink()) {
      scanFailures.push(`${relativePath}: symlink is allowed only for declared mutable mounts`);
      output.push(relativePath);
    } else if (entry.isDirectory()) {
      output.push(...await listImmutableFiles(path, mutableMounts, scanFailures, relativePath));
    } else if (entry.isFile()) {
      output.push(relativePath);
    } else {
      scanFailures.push(`${relativePath}: unsupported filesystem entry`);
    }
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function digestInventory(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.mode);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\n");
  }
  return digest.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
