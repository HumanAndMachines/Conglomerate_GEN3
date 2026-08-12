import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { basename, isAbsolute, join, posix } from "node:path";

export const RESIDENT_MANIFEST_PATH = "lazurio.resident.json";
const ALLOWED_MUTABLE_MOUNTS = new Set(["organizations", "personalspace"]);

export async function verifyArtifactTree(artifactRoot, {
  expectedProfile,
  expectedTarget,
} = {}) {
  const failures = [];
  const checks = [];
  const check = (id, ok, detail) => {
    checks.push({ id, status: ok ? "pass" : "fail", detail });
    if (!ok) failures.push(`${id}: ${detail}`);
  };

  let manifest;
  try {
    const manifestPath = join(artifactRoot, RESIDENT_MANIFEST_PATH);
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("manifest is not a regular file");
    }
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    check("manifest-readable", true, "resident manifest is a regular JSON file");
  } catch (error) {
    check(
      "manifest-readable",
      false,
      `manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, failures, checks, manifest: null };
  }

  const shapeFailures = validateResidentManifest(manifest);
  check(
    "manifest-shape",
    shapeFailures.length === 0,
    shapeFailures.length === 0
      ? "lazurio.resident.manifest.v1 contract is valid"
      : shapeFailures.join("; "),
  );
  if (shapeFailures.length > 0) {
    return { ok: false, failures, checks, manifest };
  }

  if (expectedProfile !== undefined) {
    check(
      "profile-compatibility",
      manifest.profile === expectedProfile,
      `expected ${expectedProfile}; artifact ${manifest.profile}`,
    );
  }
  if (expectedTarget !== undefined) {
    const declaredTarget = `${manifest.target.os}-${manifest.target.arch}`;
    check(
      "platform-compatibility",
      declaredTarget === expectedTarget,
      `running ${expectedTarget}; artifact ${declaredTarget}`,
    );
  }

  const expectedFiles = new Set([RESIDENT_MANIFEST_PATH]);
  const expectedDirectories = new Set(["."]);
  for (const file of manifest.payload.files) {
    expectedFiles.add(file.path);
    let parent = posix.dirname(file.path);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = posix.dirname(parent);
    }
    const path = join(artifactRoot, ...file.path.split("/"));
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        check(`payload:${file.path}`, false, "not a regular immutable file");
        continue;
      }
      const bytes = await readFile(path);
      const contentMatches = bytes.length === file.size && sha256(bytes) === file.sha256;
      const modeMatches = process.platform === "win32"
        || (stat.mode & 0o777) === Number.parseInt(file.mode, 8);
      check(
        `payload:${file.path}`,
        contentMatches && modeMatches,
        contentMatches && modeMatches
          ? "size, sha256 and mode match"
          : "size, sha256 or mode mismatch",
      );
    } catch {
      check(`payload:${file.path}`, false, "missing immutable payload file");
    }
  }

  const scan = await scanArtifactTree(
    artifactRoot,
    new Set(manifest.mutable_mounts),
    expectedFiles,
    expectedDirectories,
  );
  for (const failure of scan.failures) check(`filesystem:${failure.path}`, false, failure.detail);
  if (scan.failures.length === 0) {
    check("filesystem-layout", true, "no unexpected immutable entries or Git metadata");
  }

  const payloadDigest = digestInventory(manifest.payload.files);
  check(
    "payload-inventory",
    payloadDigest === manifest.payload.digest,
    payloadDigest === manifest.payload.digest ? "inventory digest matches" : "inventory digest mismatch",
  );
  const agents = manifest.payload.files
    .map((file) => file.path)
    .filter((path) => basename(path) === "AGENTS.md");
  check(
    "profile-boundary",
    agents.length === 1 && agents[0] === "AGENTS.md",
    "exactly one root AGENTS.md must exist",
  );

  try {
    const profile = JSON.parse(
      await readFile(join(artifactRoot, "resident", "profile.json"), "utf8"),
    );
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
      await readFile(join(artifactRoot, "resident", "dependencies", "hermes.json"), "utf8"),
    );
    check(
      "hermes-pin",
      hermes?.repository === manifest.dependencies.hermes.repository
        && hermes?.release_tag === manifest.dependencies.hermes.release_tag
        && hermes?.commit === manifest.dependencies.hermes.commit
        && hermes?.lock_sha256 === manifest.dependencies.hermes.lock_sha256
        && hermes?.compatibility?.independent_self_update_allowed === false,
      "exact fork release, commit and lock digest match the artifact manifest",
    );
  } catch (error) {
    check(
      "hermes-pin",
      false,
      `Hermes pin cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ok: failures.length === 0, failures, checks, manifest };
}

export function validateResidentManifest(manifest) {
  const failures = [];
  if (manifest?.schema_version !== "lazurio.resident.manifest.v1") {
    failures.push("unsupported schema_version");
    return failures;
  }
  const profile = manifest.profile;
  const version = manifest.artifact_version;
  const os = manifest.target?.os;
  const arch = manifest.target?.arch;
  if (typeof profile !== "string" || !/^[a-z][a-z0-9-]*$/.test(profile)) {
    failures.push("invalid profile");
  }
  if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version)) {
    failures.push("invalid artifact_version");
  }
  if (!["candidate", "stable"].includes(manifest.channel)) failures.push("invalid channel");
  if (!["linux", "darwin", "windows"].includes(os)) failures.push("invalid target OS");
  if (!["x64", "arm64"].includes(arch)) failures.push("invalid target architecture");
  const expectedId = `lazurio-resident-${profile}-${version}-${os}-${arch}`;
  if (manifest.artifact_id !== expectedId || !/^[A-Za-z0-9.+-]+$/.test(manifest.artifact_id ?? "")) {
    failures.push("artifact_id does not match profile, version and target");
  }
  if (!Array.isArray(manifest.role_overlays)
    || manifest.role_overlays.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]*$/.test(item))
    || new Set(manifest.role_overlays).size !== manifest.role_overlays.length) {
    failures.push("invalid role_overlays");
  }
  if (!Number.isInteger(manifest.build_contract) || manifest.build_contract < 1) {
    failures.push("invalid build_contract");
  }
  if (!Number.isInteger(manifest.compatibility?.resident_root)
    || manifest.compatibility.resident_root < 1
    || !Array.isArray(manifest.compatibility?.rollback_from)
    || manifest.compatibility.rollback_from.some((item) => !Number.isInteger(item) || item < 1)) {
    failures.push("invalid compatibility contract");
  }
  if (typeof manifest.source?.repository !== "string"
    || manifest.source.repository.length === 0
    || !/^[0-9a-f]{40,64}$/.test(manifest.source?.commit ?? "")
    || !Number.isSafeInteger(manifest.source?.commit_epoch)
    || manifest.source.commit_epoch < 0) {
    failures.push("invalid source provenance");
  }
  const hermes = manifest.dependencies?.hermes;
  if (hermes?.repository !== "Lazurio/hermes-agent"
    || typeof hermes?.release_tag !== "string"
    || hermes.release_tag.length === 0
    || !/^[0-9a-f]{40}$/.test(hermes?.commit ?? "")
    || !/^[0-9a-f]{64}$/.test(hermes?.lock_sha256 ?? "")) {
    failures.push("invalid Hermes dependency pin");
  }
  if (!Array.isArray(manifest.mutable_mounts)
    || manifest.mutable_mounts.some((item) => !ALLOWED_MUTABLE_MOUNTS.has(item))
    || new Set(manifest.mutable_mounts).size !== manifest.mutable_mounts.length) {
    failures.push("invalid mutable_mounts");
  }
  if (manifest.payload?.hash_algorithm !== "sha256"
    || manifest.payload?.manifest_excluded_from_inventory !== true
    || !/^[0-9a-f]{64}$/.test(manifest.payload?.digest ?? "")
    || !Array.isArray(manifest.payload?.files)
    || manifest.payload.files.length === 0) {
    failures.push("invalid payload inventory");
    return failures;
  }
  const seen = new Set();
  let previous = null;
  for (const file of manifest.payload.files) {
    let normalized;
    try {
      normalized = normalizeResidentPath(file?.path);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (normalized === RESIDENT_MANIFEST_PATH) failures.push("manifest cannot inventory itself");
    if (manifest.mutable_mounts.some((mount) => normalized === mount || normalized.startsWith(`${mount}/`))) {
      failures.push(`${normalized}: mutable data cannot be immutable payload`);
    }
    if (seen.has(normalized)) failures.push(`${normalized}: duplicate payload path`);
    if (previous !== null && previous.localeCompare(normalized) >= 0) {
      failures.push("payload files are not strictly sorted");
    }
    seen.add(normalized);
    previous = normalized;
    if (!["0644", "0755"].includes(file?.mode)
      || !Number.isSafeInteger(file?.size)
      || file.size < 0
      || !/^[0-9a-f]{64}$/.test(file?.sha256 ?? "")) {
      failures.push(`${normalized}: invalid payload metadata`);
    }
  }
  return failures;
}

export function normalizeResidentPath(value) {
  if (typeof value !== "string"
    || value === ""
    || isAbsolute(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid resident path ${String(value)}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`resident path escapes or is not canonical: ${value}`);
  }
  return normalized;
}

export function digestInventory(files) {
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

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function scanArtifactTree(root, mutableMounts, expectedFiles, expectedDirectories) {
  const failures = [];
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (!prefix && mutableMounts.has(entry.name)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          failures.push({ path: relativePath, detail: "mutable mount must be a directory or symbolic link" });
        } else if (entry.isSymbolicLink()) {
          const target = await readlink(path);
          const expected = posix.join("..", "..", "state", entry.name);
          if (target !== expected) {
            failures.push({ path: relativePath, detail: `mutable mount link must target ${expected}` });
          }
        }
        continue;
      }
      if (entry.name === ".git") {
        failures.push({ path: relativePath, detail: "Git metadata is forbidden" });
        continue;
      }
      if (entry.isSymbolicLink()) {
        failures.push({ path: relativePath, detail: "symbolic link is allowed only for a declared top-level mutable mount" });
      } else if (entry.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) {
          failures.push({ path: relativePath, detail: "unexpected immutable directory" });
        }
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        if (!expectedFiles.has(relativePath)) {
          failures.push({ path: relativePath, detail: "unexpected immutable file" });
        }
      } else {
        failures.push({ path: relativePath, detail: "unsupported filesystem entry" });
      }
    }
  };
  if (!existsSync(root)) {
    failures.push({ path: ".", detail: "artifact root does not exist" });
    return { failures };
  }
  await visit(root);
  for (const path of expectedFiles) {
    if (!existsSync(join(root, ...path.split("/")))) {
      failures.push({ path, detail: "manifest entry is absent" });
    }
  }
  return { failures };
}
