import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  RESIDENT_MANIFEST_PATH,
  sha256,
  validateResidentManifest,
  verifyArtifactTree,
} from "./integrity.mjs";

const LIFECYCLE_SCHEMA = "lazurio.resident.lifecycle.v1";
const LIFECYCLE_FILE = "lifecycle.v1.json";
const SUPPORTED_BUILD_CONTRACTS = new Set([1]);
const SUPPORTED_ROOT_COMPATIBILITY = new Set([1]);
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_TAR_ENTRIES = 100_000;
const MUTABLE_MOUNTS = ["organizations", "personalspace"];

export function currentResidentTarget() {
  return `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}

export async function installResidentArtifact({
  archivePath,
  checksumPath,
  installRoot,
  expectedProfile,
  expectedChannel,
  healthRunner = runResidentDoctor,
} = {}) {
  assertPosixUpdater();
  if (!archivePath || !checksumPath || !installRoot || !expectedProfile) {
    throw new Error("install requires archivePath, checksumPath, installRoot and expectedProfile");
  }

  const archive = await readVerifiedArchive(archivePath, checksumPath);
  const parsed = parseResidentArchive(archive.bytes);
  assertInstallCompatibility(parsed.manifest, {
    expectedProfile,
    expectedChannel,
    expectedTarget: currentResidentTarget(),
  });

  const layout = await prepareLayout(installRoot);
  return withUpdateLock(layout, async () => {
    const currentId = await readActiveArtifactId(layout);
    const lifecycle = await readLifecycle(layout);
    assertLifecycleMatchesActive(lifecycle, currentId, expectedProfile);

    let currentManifest = null;
    if (currentId) {
      const currentRoot = versionRoot(layout, currentId);
      const currentHealth = await assertHealthy(currentRoot, expectedProfile, healthRunner, layout);
      currentManifest = currentHealth.manifest;
    }
    if (currentManifest
      && !parsed.manifest.compatibility.rollback_from.includes(
        currentManifest.compatibility.resident_root,
      )) {
      throw new Error(
        `artifact cannot roll back from active compatibility ${currentManifest.compatibility.resident_root}`,
      );
    }

    const destination = versionRoot(layout, parsed.manifest.artifact_id);
    if (currentId === parsed.manifest.artifact_id) {
      await assertSameManifest(destination, parsed.manifestBytes);
      await assertHealthy(destination, expectedProfile, healthRunner, layout);
      return lifecycleResult("noop", layout, lifecycle ?? {
        schema_version: LIFECYCLE_SCHEMA,
        profile: expectedProfile,
        active: currentId,
        previous: null,
        last_known_good: currentId,
        updated_at: new Date().toISOString(),
      });
    }

    let staged = false;
    let stageRoot = null;
    if (await lstatOrNull(destination)) {
      await assertVersionDirectory(destination);
      await assertSameManifest(destination, parsed.manifestBytes);
      await assertHealthy(destination, expectedProfile, healthRunner, layout);
    } else {
      stageRoot = join(
        layout.versions,
        `.staging-${parsed.manifest.artifact_id}-${process.pid}-${randomBytes(6).toString("hex")}`,
      );
      assertStagingPath(layout, stageRoot);
      try {
        await extractResidentArchive(parsed, stageRoot);
        const immutable = await verifyArtifactTree(stageRoot, {
          expectedProfile,
          expectedTarget: currentResidentTarget(),
        });
        if (!immutable.ok) {
          throw new Error(`staged artifact integrity failed: ${immutable.failures.join("; ")}`);
        }
        await attachMutableMounts(stageRoot, layout);
        await assertHealthy(stageRoot, expectedProfile, healthRunner, layout);
        await rename(stageRoot, destination);
        staged = true;
      } catch (error) {
        if (stageRoot && await lstatOrNull(stageRoot)) {
          assertStagingPath(layout, stageRoot);
          await rm(stageRoot, { recursive: true, force: true });
        }
        throw error;
      }
    }

    await switchActive(layout, parsed.manifest.artifact_id);
    try {
      await assertHealthy(destination, expectedProfile, healthRunner, layout);
    } catch (error) {
      await restoreActive(layout, currentId);
      throw new Error(
        `post-switch health gate failed and active was restored${staged ? "; failed version retained for diagnosis" : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const nextLifecycle = {
      schema_version: LIFECYCLE_SCHEMA,
      profile: expectedProfile,
      active: parsed.manifest.artifact_id,
      previous: currentId,
      last_known_good: currentId ?? parsed.manifest.artifact_id,
      updated_at: new Date().toISOString(),
    };
    try {
      await writeLifecycle(layout, nextLifecycle);
    } catch (error) {
      await restoreActive(layout, currentId);
      throw new Error(`lifecycle state write failed and active was restored: ${error instanceof Error ? error.message : String(error)}`);
    }
    return lifecycleResult(currentId ? "updated" : "installed", layout, nextLifecycle);
  });
}

export async function rollbackResidentArtifact({
  installRoot,
  expectedProfile,
  targetArtifactId,
  healthRunner = runResidentDoctor,
} = {}) {
  assertPosixUpdater();
  if (!installRoot || !expectedProfile) {
    throw new Error("rollback requires installRoot and expectedProfile");
  }
  const layout = await requireLayout(installRoot);
  return withUpdateLock(layout, async () => {
    const currentId = await readActiveArtifactId(layout);
    const lifecycle = await readLifecycle(layout);
    assertLifecycleMatchesActive(lifecycle, currentId, expectedProfile);
    if (!currentId || !lifecycle) throw new Error("no active resident version can be rolled back");
    const targetId = targetArtifactId ?? lifecycle.last_known_good;
    assertArtifactId(targetId);
    if (targetId === currentId) {
      throw new Error("rollback target is already active; no distinct last-known-good version exists");
    }

    const current = await assertHealthy(
      versionRoot(layout, currentId),
      expectedProfile,
      healthRunner,
      layout,
    );
    const targetRoot = versionRoot(layout, targetId);
    const target = await assertHealthy(targetRoot, expectedProfile, healthRunner, layout);
    if (!current.manifest.compatibility.rollback_from.includes(
      target.manifest.compatibility.resident_root,
    )) {
      throw new Error(
        `active artifact cannot roll back to compatibility ${target.manifest.compatibility.resident_root}`,
      );
    }

    await switchActive(layout, targetId);
    try {
      await assertHealthy(targetRoot, expectedProfile, healthRunner, layout);
    } catch (error) {
      await switchActive(layout, currentId);
      throw new Error(
        `rollback health gate failed and ${currentId} was restored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const nextLifecycle = {
      schema_version: LIFECYCLE_SCHEMA,
      profile: expectedProfile,
      active: targetId,
      previous: currentId,
      last_known_good: currentId,
      updated_at: new Date().toISOString(),
    };
    try {
      await writeLifecycle(layout, nextLifecycle);
    } catch (error) {
      await switchActive(layout, currentId);
      throw new Error(`rollback state write failed and ${currentId} was restored: ${error instanceof Error ? error.message : String(error)}`);
    }
    return lifecycleResult("rolled_back", layout, nextLifecycle);
  });
}

export async function residentStatus({
  installRoot,
  expectedProfile,
  healthRunner = runResidentDoctor,
} = {}) {
  if (!installRoot) throw new Error("status requires installRoot");
  const layout = await requireLayout(installRoot);
  const active = await readActiveArtifactId(layout);
  const lifecycle = await readLifecycle(layout);
  if (expectedProfile) assertLifecycleMatchesActive(lifecycle, active, expectedProfile);
  const installed = [];
  const entries = await readdir(layout.versions, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    installed.push(entry.name);
  }
  let health = null;
  if (active) {
    try {
      const result = await assertHealthy(
        versionRoot(layout, active),
        expectedProfile ?? lifecycle?.profile,
        healthRunner,
        layout,
      );
      health = { status: "pass", artifact_id: result.manifest.artifact_id };
    } catch (error) {
      health = {
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    schema_version: "lazurio.resident.status.v1",
    install_root: layout.root,
    active,
    previous: lifecycle?.previous ?? null,
    last_known_good: lifecycle?.last_known_good ?? null,
    profile: lifecycle?.profile ?? null,
    installed,
    health,
  };
}

export async function readVerifiedArchive(archivePath, checksumPath) {
  const archiveFile = resolve(archivePath);
  const checksumFile = resolve(checksumPath);
  const [archiveStat, checksumStat] = await Promise.all([
    lstat(archiveFile),
    lstat(checksumFile),
  ]);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw new Error("archive must be a regular non-symlink file");
  }
  if (!checksumStat.isFile() || checksumStat.isSymbolicLink()) {
    throw new Error("checksum must be a regular non-symlink file");
  }
  if (archiveStat.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive exceeds ${MAX_ARCHIVE_BYTES} byte safety limit`);
  }
  if (checksumStat.size > 4096) throw new Error("checksum sidecar is unexpectedly large");
  const [bytes, checksumText] = await Promise.all([
    readFile(archiveFile),
    readFile(checksumFile, "utf8"),
  ]);
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive exceeds ${MAX_ARCHIVE_BYTES} byte safety limit`);
  }
  const match = checksumText.match(/^([0-9a-f]{64})  ([^\r\n]+)\r?\n?$/);
  if (!match || match[2] !== basename(archiveFile)) {
    throw new Error("checksum sidecar must name the selected archive exactly");
  }
  const actual = sha256(bytes);
  if (actual !== match[1]) throw new Error("archive SHA-256 does not match its sidecar");
  return { bytes, sha256: actual };
}

export function parseResidentArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1536 || bytes.length % 512 !== 0) {
    throw new Error("resident archive is not a complete 512-byte-aligned USTAR stream");
  }
  const rawEntries = [];
  const seen = new Set();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks >= 2) break;
      continue;
    }
    if (zeroBlocks > 0) throw new Error("non-zero TAR header follows an end marker");
    if (rawEntries.length >= MAX_TAR_ENTRIES) throw new Error("resident archive has too many entries");
    verifyTarHeader(header);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    normalizeTarPath(path);
    if (seen.has(path)) throw new Error(`duplicate TAR entry ${path}`);
    seen.add(path);
    const type = readTarString(header, 156, 1) || "0";
    if (type !== "0" && type !== "5") {
      throw new Error(`unsupported TAR entry type ${type} for ${path}`);
    }
    if (readTarString(header, 157, 100) !== "") {
      throw new Error(`TAR links are forbidden: ${path}`);
    }
    const size = readTarOctal(header, 124, 12, "size");
    const mode = readTarOctal(header, 100, 8, "mode") & 0o777;
    if (size > MAX_ENTRY_BYTES) throw new Error(`TAR entry is too large: ${path}`);
    if (type === "5" && size !== 0) throw new Error(`TAR directory has data: ${path}`);
    if (type === "0" && ![0o644, 0o755].includes(mode)) {
      throw new Error(`unsupported TAR file mode for ${path}`);
    }
    if (type === "5" && mode !== 0o755) throw new Error(`unsupported TAR directory mode for ${path}`);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    const paddedEnd = contentStart + Math.ceil(size / 512) * 512;
    if (paddedEnd > bytes.length) throw new Error(`truncated TAR entry ${path}`);
    if (!bytes.subarray(contentEnd, paddedEnd).every((byte) => byte === 0)) {
      throw new Error(`non-zero TAR padding for ${path}`);
    }
    rawEntries.push({
      path,
      type,
      mode: mode.toString(8).padStart(4, "0"),
      bytes: Buffer.from(bytes.subarray(contentStart, contentEnd)),
    });
    offset = paddedEnd;
  }
  if (zeroBlocks < 2) throw new Error("resident archive lacks the two-block TAR end marker");
  if (!bytes.subarray(offset).every((byte) => byte === 0)) {
    throw new Error("resident archive has data after the TAR end marker");
  }
  if (rawEntries.length === 0) throw new Error("resident archive is empty");

  const roots = new Set(rawEntries.map((entry) => entry.path.split("/")[0]));
  if (roots.size !== 1) throw new Error("resident archive must have exactly one top-level root");
  const [rootName] = roots;
  if (!rawEntries.some((entry) => entry.path === rootName && entry.type === "5")) {
    throw new Error("resident archive is missing its explicit root directory");
  }
  const entries = rawEntries
    .filter((entry) => entry.path !== rootName)
    .map((entry) => {
      const relativePath = entry.path.slice(rootName.length + 1);
      if (!relativePath) throw new Error("invalid empty path below archive root");
      return { ...entry, path: relativePath };
    });
  const manifestEntry = entries.find(
    (entry) => entry.path === RESIDENT_MANIFEST_PATH && entry.type === "0",
  );
  if (!manifestEntry) throw new Error("resident archive has no regular manifest");
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`resident archive manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const shapeFailures = validateResidentManifest(manifest);
  if (shapeFailures.length > 0) {
    throw new Error(`resident archive manifest is invalid: ${shapeFailures.join("; ")}`);
  }
  if (manifest.artifact_id !== rootName) {
    throw new Error("archive root does not match manifest artifact_id");
  }
  return {
    rootName,
    entries,
    manifest,
    manifestBytes: manifestEntry.bytes,
  };
}

export async function runResidentDoctor(root) {
  const result = spawnSync(process.execPath, [join(root, "resident", "doctor.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  let report = null;
  try {
    report = JSON.parse(result.stdout || "null");
  } catch {
    // The raw stderr/stdout remains available in the bounded error below.
  }
  return {
    ok: result.status === 0 && report?.status === "pass",
    status: result.status,
    report,
    stderr: String(result.stderr ?? "").slice(0, 4000),
  };
}

async function extractResidentArchive(parsed, destination) {
  if (existsSync(destination)) throw new Error(`staging destination already exists: ${destination}`);
  await mkdir(destination, { mode: 0o755 });
  const directories = parsed.entries
    .filter((entry) => entry.type === "5")
    .sort((left, right) => {
      const depth = left.path.split("/").length - right.path.split("/").length;
      return depth || left.path.localeCompare(right.path);
    });
  for (const entry of directories) {
    const target = safeDestination(destination, entry.path);
    await mkdir(target, { mode: 0o755 });
  }
  const files = parsed.entries
    .filter((entry) => entry.type === "0")
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of files) {
    const target = safeDestination(destination, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, entry.bytes, {
      flag: "wx",
      mode: Number.parseInt(entry.mode, 8),
    });
    await chmod(target, Number.parseInt(entry.mode, 8));
  }
}

async function attachMutableMounts(version, layout) {
  for (const mount of MUTABLE_MOUNTS) {
    const target = join(version, mount);
    if (existsSync(target)) throw new Error(`artifact collides with mutable mount ${mount}`);
    await symlink(posix.join("..", "..", "state", mount), target, "dir");
  }
}

async function assertHealthy(root, expectedProfile, healthRunner, layout) {
  await assertVersionDirectory(root);
  const integrity = await verifyArtifactTree(root, {
    expectedProfile,
    expectedTarget: currentResidentTarget(),
  });
  if (!integrity.ok) {
    throw new Error(`resident integrity gate failed: ${integrity.failures.join("; ")}`);
  }
  await assertMutableMounts(root, layout);
  const health = await healthRunner(root);
  if (!health?.ok) {
    const detail = health?.report
      ? JSON.stringify(health.report)
      : health?.stderr || "health runner returned no passing report";
    throw new Error(`resident Doctor failed: ${detail}`);
  }
  return { manifest: integrity.manifest, health };
}

function assertInstallCompatibility(manifest, {
  expectedProfile,
  expectedChannel,
  expectedTarget,
}) {
  if (manifest.profile !== expectedProfile) {
    throw new Error(`expected profile ${expectedProfile}, received ${manifest.profile}`);
  }
  if (expectedChannel && manifest.channel !== expectedChannel) {
    throw new Error(`expected channel ${expectedChannel}, received ${manifest.channel}`);
  }
  const target = `${manifest.target.os}-${manifest.target.arch}`;
  if (target !== expectedTarget) {
    throw new Error(`artifact target ${target} is incompatible with ${expectedTarget}`);
  }
  if (!SUPPORTED_BUILD_CONTRACTS.has(manifest.build_contract)) {
    throw new Error(`unsupported build contract ${manifest.build_contract}`);
  }
  if (!SUPPORTED_ROOT_COMPATIBILITY.has(manifest.compatibility.resident_root)) {
    throw new Error(`unsupported resident root compatibility ${manifest.compatibility.resident_root}`);
  }
  if (expectedProfile === "buddy" && manifest.role_overlays.length !== 0) {
    throw new Error("Buddy artifact cannot carry role overlays");
  }
}

async function prepareLayout(installRoot) {
  const root = resolve(installRoot);
  if (root === resolve("/")) throw new Error("filesystem root cannot be a Lazurio install root");
  await ensureDirectory(root, 0o755);
  const versions = join(root, "versions");
  const state = join(root, "state");
  await ensureDirectory(versions, 0o755);
  await ensureDirectory(state, 0o700);
  for (const mount of MUTABLE_MOUNTS) {
    await ensureDirectory(join(state, mount), 0o700);
  }
  return {
    root,
    versions,
    state,
    active: join(root, "active"),
    lifecycle: join(state, LIFECYCLE_FILE),
    lock: join(state, "update.lock"),
  };
}

async function requireLayout(installRoot) {
  const root = resolve(installRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("install root must be a real directory");
  }
  const layout = {
    root,
    versions: join(root, "versions"),
    state: join(root, "state"),
    active: join(root, "active"),
    lifecycle: join(root, "state", LIFECYCLE_FILE),
    lock: join(root, "state", "update.lock"),
  };
  await assertVersionDirectory(layout.versions);
  await assertVersionDirectory(layout.state);
  return layout;
}

async function ensureDirectory(path, mode) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${path} must be a real directory`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { mode });
  }
}

async function withUpdateLock(layout, operation) {
  let handle;
  try {
    handle = await open(layout.lock, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`update lock exists at ${layout.lock}; inspect it before any manual removal`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    return await operation();
  } finally {
    if (handle) await handle.close();
    await unlink(layout.lock).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function readLifecycle(layout) {
  let value;
  try {
    value = JSON.parse(await readFile(layout.lifecycle, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`cannot read lifecycle state: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value?.schema_version !== LIFECYCLE_SCHEMA
    || typeof value?.profile !== "string"
    || (value.active !== null && typeof value.active !== "string")
    || (value.previous !== null && typeof value.previous !== "string")
    || (value.last_known_good !== null && typeof value.last_known_good !== "string")) {
    throw new Error("lifecycle state is invalid");
  }
  for (const id of [value.active, value.previous, value.last_known_good]) {
    if (id !== null) assertArtifactId(id);
  }
  return value;
}

async function writeLifecycle(layout, value) {
  const temporary = join(layout.state, `.lifecycle-${process.pid}-${randomBytes(6).toString("hex")}.json`);
  let handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, layout.lifecycle);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function assertLifecycleMatchesActive(lifecycle, active, expectedProfile) {
  if (!lifecycle && active) throw new Error("active pointer exists without lifecycle state");
  if (lifecycle && lifecycle.active !== active) {
    throw new Error(`lifecycle active ${lifecycle.active} does not match active pointer ${active}`);
  }
  if (lifecycle && lifecycle.profile !== expectedProfile) {
    throw new Error(`install root profile ${lifecycle.profile} does not match ${expectedProfile}`);
  }
}

async function readActiveArtifactId(layout) {
  let stat;
  try {
    stat = await lstat(layout.active);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isSymbolicLink()) throw new Error("active pointer must be a symbolic link");
  const target = await readlink(layout.active);
  const match = target.match(/^versions\/([^/]+)$/);
  if (!match) throw new Error(`active pointer has unsafe target ${target}`);
  assertArtifactId(match[1]);
  return match[1];
}

async function switchActive(layout, artifactId) {
  assertArtifactId(artifactId);
  await assertVersionDirectory(versionRoot(layout, artifactId));
  const activeStat = await lstatOrNull(layout.active);
  if (activeStat) {
    const stat = activeStat;
    if (!stat.isSymbolicLink()) throw new Error("refusing to replace a non-symlink active path");
  }
  const temporary = join(layout.root, `.active-${process.pid}-${randomBytes(6).toString("hex")}`);
  await symlink(posix.join("versions", artifactId), temporary, "dir");
  try {
    await rename(temporary, layout.active);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function restoreActive(layout, previousId) {
  if (previousId) {
    await switchActive(layout, previousId);
    return;
  }
  const activeStat = await lstatOrNull(layout.active);
  if (activeStat) {
    const stat = activeStat;
    if (!stat.isSymbolicLink()) throw new Error("cannot restore empty active state over non-symlink path");
    await unlink(layout.active);
  }
}

function versionRoot(layout, artifactId) {
  assertArtifactId(artifactId);
  return join(layout.versions, artifactId);
}

function assertArtifactId(value) {
  if (typeof value !== "string"
    || !/^lazurio-resident-[A-Za-z0-9.+-]+$/.test(value)
    || value.includes("..")) {
    throw new Error(`invalid resident artifact id ${String(value)}`);
  }
}

async function assertVersionDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${path} must be a real version directory`);
  }
}

async function assertSameManifest(root, expectedBytes) {
  const actual = await readFile(join(root, RESIDENT_MANIFEST_PATH));
  if (!actual.equals(expectedBytes)) {
    throw new Error("existing version directory has a different resident manifest");
  }
}

function assertStagingPath(layout, path) {
  const parent = dirname(path);
  if (parent !== layout.versions || !basename(path).startsWith(".staging-lazurio-resident-")) {
    throw new Error(`unsafe staging path ${path}`);
  }
}

function safeDestination(root, residentPath) {
  const destination = resolve(root, ...residentPath.split("/"));
  const relativePath = relative(root, destination);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${posix.sep}`)) {
    throw new Error(`archive path escapes staging root: ${residentPath}`);
  }
  return destination;
}

function normalizeTarPath(value) {
  if (typeof value !== "string"
    || value === ""
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid TAR path ${String(value)}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`TAR path escapes or is not canonical: ${value}`);
  }
  return normalized;
}

function verifyTarHeader(header) {
  const magic = header.subarray(257, 263).toString("binary");
  if (magic !== "ustar\0") throw new Error("resident archive must use the USTAR format");
  const expected = readTarOctal(header, 148, 8, "checksum");
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected) throw new Error("TAR header checksum mismatch");
}

function readTarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  const content = zero >= 0 ? field.subarray(0, zero) : field;
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

function readTarOctal(header, offset, length, label) {
  const value = readTarString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`invalid TAR ${label}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid TAR ${label}`);
  return parsed;
}

function lifecycleResult(status, layout, lifecycle) {
  return {
    schema_version: "lazurio.resident.updater-result.v1",
    status,
    install_root: layout.root,
    active: lifecycle.active,
    previous: lifecycle.previous,
    last_known_good: lifecycle.last_known_good,
    profile: lifecycle.profile,
  };
}

function assertPosixUpdater() {
  if (process.platform === "win32") {
    throw new Error("updater v1 requires the POSIX atomic-symlink adapter; Windows resident lifecycle is not enabled yet");
  }
}

async function assertMutableMounts(root, layout) {
  for (const mount of MUTABLE_MOUNTS) {
    const mountPath = join(root, mount);
    const stat = await lstat(mountPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${mount} must be the updater-managed mutable mount link`);
    }
    const target = await readlink(mountPath);
    const expected = posix.join("..", "..", "state", mount);
    if (target !== expected) {
      throw new Error(`${mount} mutable mount has unsafe target ${target}`);
    }
    const stateStat = await lstat(join(layout.state, mount));
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
      throw new Error(`${mount} persistent state must be a real directory`);
    }
  }
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
