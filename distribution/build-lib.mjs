import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { trustedGitExecutable } from "../scripts/agent-skills-entrypoint.mjs";
import { verifyArtifactTree } from "./runtime/integrity.mjs";

export { verifyArtifactTree } from "./runtime/integrity.mjs";

const CONTRACT_PATH = "distribution/contract.v1.json";
const MANIFEST_PATH = "lazurio.resident.json";
const SECRET_PATTERNS = [
  { label: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "github-token", pattern: /(?:github_pat_|gh[oprsu]_[A-Za-z0-9_]{20,})/ },
  { label: "openai-token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "tailscale-auth-key", pattern: /\btskey-[A-Za-z0-9_-]{20,}\b/ },
];
const TEXT_EXTENSIONS = new Set([
  "",
  ".astro",
  ".cmd",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export function normalizeTarget(value = `${normalizeOperatingSystem(process.platform)}-${process.arch}`) {
  if (typeof value !== "string" || !/^[a-z0-9]+-[a-z0-9]+$/.test(value)) {
    throw new Error(`invalid target ${String(value)}`);
  }
  const [os, arch] = value.split("-");
  if (!["linux", "darwin", "windows"].includes(os)) {
    throw new Error(`unsupported target OS ${os}`);
  }
  if (!["x64", "arm64"].includes(arch)) {
    throw new Error(`unsupported target architecture ${arch}`);
  }
  return { id: `${os}-${arch}`, os, arch };
}

export async function buildResidentArtifact({
  cwd = process.cwd(),
  profile = "buddy",
  target,
  artifactVersion,
  channel = "candidate",
  outputRoot = "dist/resident",
  forbiddenTerms = [],
} = {}) {
  const repositoryRoot = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const sourceCommit = gitText(repositoryRoot, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
    throw new Error("source commit is not an exact Git object id");
  }
  const status = gitText(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error("resident build requires a clean source checkout");
  }

  const tree = readGitTree(repositoryRoot, sourceCommit);
  const contract = readJsonBlob(repositoryRoot, tree, CONTRACT_PATH);
  if (contract.schema_version !== "lazurio.resident.build-contract.v1") {
    throw new Error("unsupported resident build contract");
  }
  const sourceRepository = validateSourceRepository(contract.source_repository);
  const normalizedTarget = normalizeTarget(target);
  if (!contract.supported_targets.includes(normalizedTarget.id)) {
    throw new Error(`target ${normalizedTarget.id} is not declared by the build contract`);
  }
  if (!contract.channels.includes(channel)) {
    throw new Error(`channel ${channel} is not declared by the build contract`);
  }
  const profileContract = contract.profiles?.[profile];
  if (!profileContract) throw new Error(`unknown resident profile ${profile}`);

  const profileDescriptor = readJsonBlob(
    repositoryRoot,
    tree,
    profileContract.descriptor,
  );
  if (
    profileDescriptor.schema_version !== "lazurio.resident.profile.v1"
    || profileDescriptor.id !== profile
  ) {
    throw new Error(`profile descriptor does not match ${profile}`);
  }
  if ((profileDescriptor.allowed_role_overlays ?? []).length !== 0) {
    throw new Error(`profile ${profile} declares overlays that build v1 cannot compose safely`);
  }
  validateProfileEvals(
    profile,
    profileDescriptor,
    readJsonBlob(repositoryRoot, tree, profileContract.evals),
  );
  const hermes = readJsonBlob(
    repositoryRoot,
    tree,
    "distribution/dependencies/hermes.json",
  );
  validateHermesPin(hermes, contract.artifact_contract_version);
  const gbrain = readJsonBlob(
    repositoryRoot,
    tree,
    "distribution/dependencies/gbrain.json",
  );
  validateGbrainPin(gbrain, contract.artifact_contract_version);
  const toolchain = readJsonBlob(
    repositoryRoot,
    tree,
    "distribution/dependencies/toolchain.json",
  );
  validateToolchainPins(toolchain);

  const version = artifactVersion ?? `0.0.0-dev.${sourceCommit.slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version)) {
    throw new Error(`invalid artifact version ${version}`);
  }
  const artifactId = `lazurio-resident-${profile}-${version}-${normalizedTarget.id}`;
  const destinationRoot = resolve(repositoryRoot, outputRoot);
  const artifactRoot = join(destinationRoot, artifactId);
  const archivePath = join(destinationRoot, `${artifactId}.tar`);
  const checksumPath = `${archivePath}.sha256`;
  for (const path of [artifactRoot, archivePath, checksumPath]) {
    if (existsSync(path)) {
      throw new Error(`build output already exists and will not be overwritten: ${path}`);
    }
  }

  const entries = selectSourceEntries(repositoryRoot, tree, contract);
  if (profile === "workspace") pruneWorkspaceRuntimeSources(entries);
  addGeneratedEntry(entries, "AGENTS.md", readBlob(repositoryRoot, tree, profileContract.root_instructions), "0644");
  addGeneratedEntry(entries, "package.json", residentPackageJson(profile), "0644");
  addGeneratedEntry(
    entries,
    "resident/doctor.mjs",
    readBlob(repositoryRoot, tree, "distribution/runtime/doctor.mjs"),
    "0755",
  );
  addGeneratedEntry(
    entries,
    "resident/integrity.mjs",
    readBlob(repositoryRoot, tree, "distribution/runtime/integrity.mjs"),
    "0644",
  );
  if (profile !== "workspace") {
    addGeneratedEntry(
      entries,
      "resident/updater-lib.mjs",
      readBlob(repositoryRoot, tree, "distribution/runtime/updater-lib.mjs"),
      "0644",
    );
    addGeneratedEntry(
      entries,
      "resident/updater.mjs",
      readBlob(repositoryRoot, tree, "distribution/runtime/updater.mjs"),
      "0755",
    );
    addGeneratedEntry(
      entries,
      "resident/services/buddy-bridge.service.template",
      readBlob(repositoryRoot, tree, "distribution/runtime/buddy-bridge.service.template"),
      "0644",
    );
    addGeneratedEntry(
      entries,
      "resident/services/hermes-lazurio-root.conf.template",
      readBlob(repositoryRoot, tree, "distribution/runtime/hermes-lazurio-root.conf.template"),
      "0644",
    );
    addGeneratedEntry(
      entries,
      "resident/buddy-service-lib.mjs",
      readBlob(repositoryRoot, tree, "distribution/runtime/buddy-service-lib.mjs"),
      "0644",
    );
    addGeneratedEntry(
      entries,
      "resident/buddy-service.mjs",
      readBlob(repositoryRoot, tree, "distribution/runtime/buddy-service.mjs"),
      "0755",
    );
    addGeneratedEntry(
      entries,
      "resident/buddy-rollout-lib.mjs",
      readBlob(repositoryRoot, tree, "distribution/runtime/buddy-rollout-lib.mjs"),
      "0644",
    );
    addGeneratedEntry(
      entries,
      "resident/buddy-rollout.mjs",
      readBlob(repositoryRoot, tree, "distribution/runtime/buddy-rollout.mjs"),
      "0755",
    );
  }
  addGeneratedEntry(
    entries,
    "resident/manifest.schema.json",
    readBlob(repositoryRoot, tree, "distribution/manifest.schema.json"),
    "0644",
  );
  addGeneratedEntry(
    entries,
    "resident/profile.json",
    readBlob(repositoryRoot, tree, profileContract.descriptor),
    "0644",
  );
  addGeneratedEntry(
    entries,
    "resident/dependencies/hermes.json",
    readBlob(repositoryRoot, tree, "distribution/dependencies/hermes.json"),
    "0644",
  );
  addGeneratedEntry(
    entries,
    "resident/dependencies/gbrain.json",
    readBlob(repositoryRoot, tree, "distribution/dependencies/gbrain.json"),
    "0644",
  );
  addGeneratedEntry(
    entries,
    "resident/dependencies/toolchain.json",
    readBlob(repositoryRoot, tree, "distribution/dependencies/toolchain.json"),
    "0644",
  );
  addGeneratedEntry(
    entries,
    "lazurio/search-scopes.v1.json",
    readBlob(repositoryRoot, tree, "distribution/runtime/search-scopes.empty.v1.json"),
    "0644",
  );

  const scan = scanArtifactEntries(entries, {
    forbiddenPathSegments: contract.forbidden_path_segments,
    forbiddenTerms: [repositoryRoot, ...forbiddenTerms],
  });
  if (!scan.ok) {
    throw new Error(`artifact privacy scan failed: ${scan.failures.slice(0, 5).join("; ")}`);
  }
  const agentFiles = [...entries.keys()].filter((path) => basename(path) === "AGENTS.md");
  if (agentFiles.length !== 1 || agentFiles[0] !== "AGENTS.md") {
    throw new Error(`artifact must contain exactly one root AGENTS.md, found ${agentFiles.join(", ")}`);
  }

  const commitEpoch = Number(gitText(repositoryRoot, [
    "show",
    "-s",
    "--format=%ct",
    sourceCommit,
  ]));
  if (!Number.isSafeInteger(commitEpoch) || commitEpoch < 0) {
    throw new Error("source commit timestamp is invalid");
  }
  const payloadFiles = inventoryEntries(entries);
  const payloadDigest = digestInventory(payloadFiles);
  const manifest = {
    schema_version: "lazurio.resident.manifest.v1",
    artifact_id: artifactId,
    artifact_version: version,
    channel,
    profile,
    role_overlays: [],
    target: {
      os: normalizedTarget.os,
      arch: normalizedTarget.arch,
    },
    source: {
      repository: sourceRepository,
      commit: sourceCommit,
      commit_epoch: commitEpoch,
    },
    build_contract: contract.artifact_contract_version,
    compatibility: {
      resident_root: contract.compatibility_version,
      rollback_from: [contract.compatibility_version],
    },
    dependencies: {
      hermes: {
        repository: hermes.repository,
        release_tag: hermes.release_tag,
        commit: hermes.commit,
        lock_sha256: hermes.lock_sha256,
      },
      gbrain: {
        repository: gbrain.repository,
        release_tag: gbrain.release_tag,
        version: gbrain.version,
        commit: gbrain.commit,
        lock_sha256: gbrain.lock_sha256,
        engine: gbrain.runtime.engine,
        transport: gbrain.runtime.transport,
      },
      toolchain: {
        bun: toolchain.tools.bun.version,
        uv: toolchain.tools.uv.version,
      },
    },
    mutable_mounts: [...contract.mutable_mounts],
    payload: {
      hash_algorithm: "sha256",
      digest: payloadDigest,
      manifest_excluded_from_inventory: true,
      files: payloadFiles,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await mkdir(artifactRoot, { recursive: true });
  for (const [path, entry] of sortedEntries(entries)) {
    const destination = join(artifactRoot, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes, { mode: Number.parseInt(entry.mode, 8) });
    await chmod(destination, Number.parseInt(entry.mode, 8));
  }
  await writeFile(join(artifactRoot, MANIFEST_PATH), manifestBytes, { mode: 0o644 });

  const archiveEntries = new Map(entries);
  archiveEntries.set(MANIFEST_PATH, { bytes: manifestBytes, mode: "0644" });
  const archiveBytes = createDeterministicTar(artifactId, archiveEntries, commitEpoch);
  await writeFile(archivePath, archiveBytes, { mode: 0o644 });
  const archiveSha256 = sha256(archiveBytes);
  await writeFile(
    checksumPath,
    `${archiveSha256}  ${basename(archivePath)}\n`,
    { mode: 0o644 },
  );

  const verification = await verifyArtifactTree(artifactRoot);
  if (!verification.ok) {
    throw new Error(`built artifact verification failed: ${verification.failures.join("; ")}`);
  }
  return {
    artifact_id: artifactId,
    artifact_root: artifactRoot,
    archive_path: archivePath,
    checksum_path: checksumPath,
    archive_sha256: archiveSha256,
    manifest,
  };
}

function selectSourceEntries(repositoryRoot, tree, contract) {
  const entries = new Map();
  for (const [path, source] of tree) {
    if (!contract.source_includes.some((include) => matchesInclude(path, include))) continue;
    if (isSourceExcluded(path, contract.source_excludes)) continue;
    if (source.type !== "blob") {
      throw new Error(`selected source is not a regular Git blob: ${path}`);
    }
    if (!/^(100644|100755)$/.test(source.mode)) {
      throw new Error(`selected source has unsupported mode ${source.mode}: ${path}`);
    }
    addGeneratedEntry(
      entries,
      path,
      gitBytes(repositoryRoot, ["cat-file", "blob", source.object]),
      source.mode === "100755" ? "0755" : "0644",
    );
  }
  return entries;
}

function matchesInclude(path, include) {
  return include.endsWith("/") ? path.startsWith(include) : path === include;
}

function isSourceExcluded(path, exclusions = {}) {
  if ((exclusions.exact_paths ?? []).includes(path)) return true;
  if ((exclusions.basenames ?? []).includes(posix.basename(path))) return true;
  return (exclusions.suffixes ?? []).some((suffix) => path.endsWith(suffix));
}

function pruneWorkspaceRuntimeSources(entries) {
  for (const path of [...entries.keys()]) {
    if (path.startsWith("bridge/") || path === "manual/update-installed-resident.md") {
      entries.delete(path);
    }
  }
}

function addGeneratedEntry(entries, path, value, mode) {
  const normalized = normalizeArtifactPath(path);
  if (entries.has(normalized)) throw new Error(`artifact path collision: ${normalized}`);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  entries.set(normalized, { bytes, mode });
}

function residentPackageJson(profile) {
  const workspace = profile === "workspace";
  return `${JSON.stringify({
    name: `lazurio-resident-${profile}`,
    private: true,
    type: "module",
    scripts: {
      doctor: "bun resident/doctor.mjs",
      "doctor:json": "bun resident/doctor.mjs --json",
      launchpad: "bun launchpad/src/server.mjs --open",
      "launchpad:serve": "bun launchpad/src/server.mjs --reuse",
      "launchpad:dev": "bun launchpad/src/server.mjs",
      lazurio: "bun lazurio/cli.mjs",
      "resident:doctor": "bun resident/doctor.mjs",
      ...(!workspace ? {
        "resident:install": "bun resident/updater.mjs install",
        "resident:update": "bun resident/updater.mjs update",
        "resident:rollback": "bun resident/updater.mjs rollback",
        "resident:status": "bun resident/updater.mjs status",
        "buddy:bridge": "bun bridge/run.ts",
        "buddy:service": "bun resident/buddy-service.mjs",
        "buddy:rollout": "bun resident/buddy-rollout.mjs",
      } : {}),
    },
  }, null, 2)}\n`;
}

function validateHermesPin(hermes, artifactContractVersion) {
  if (
    hermes?.schema_version !== "lazurio.resident.dependency-pin.v1"
    || hermes?.id !== "hermes"
    || hermes?.repository !== "Lazurio/hermes-agent"
    || hermes?.upstream_repository !== "NousResearch/hermes-agent"
    || !/^[0-9a-f]{40}$/.test(hermes?.commit ?? "")
    || !/^[0-9a-f]{64}$/.test(hermes?.lock_sha256 ?? "")
    || !hermes?.compatibility?.artifact_contract_versions?.includes(artifactContractVersion)
    || hermes?.compatibility?.independent_self_update_allowed !== false
  ) {
    throw new Error("Hermes dependency pin is incomplete or incompatible");
  }
}

function validateGbrainPin(gbrain, artifactContractVersion) {
  if (
    gbrain?.schema_version !== "lazurio.resident.dependency-pin.v1"
    || gbrain?.id !== "gbrain"
    || gbrain?.repository !== "Lazurio/gbrain"
    || gbrain?.upstream_repository !== "garrytan/gbrain"
    || !/^\d+\.\d+\.\d+\.\d+$/.test(gbrain?.version ?? "")
    || !/^[0-9a-f]{40}$/.test(gbrain?.commit ?? "")
    || !/^[0-9a-f]{64}$/.test(gbrain?.lock_sha256 ?? "")
    || gbrain?.runtime?.engine !== "pglite"
    || gbrain?.runtime?.transport !== "stdio"
    || !["put_page", "search", "get_page"].every((tool) => gbrain?.runtime?.required_tools?.includes(tool))
    || !gbrain?.compatibility?.artifact_contract_versions?.includes(artifactContractVersion)
    || gbrain?.compatibility?.independent_self_update_allowed !== false
  ) {
    throw new Error("GBrain dependency pin is incomplete or incompatible");
  }
}

function validateToolchainPins(toolchain) {
  const requiredTargets = ["linux-x64", "linux-arm64"];
  if (toolchain?.schema_version !== "lazurio.resident.toolchain-pins.v1") {
    throw new Error("Resident toolchain pins are missing or invalid");
  }
  for (const [name, tool] of Object.entries(toolchain.tools ?? {})) {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(tool?.version ?? "")) {
      throw new Error(`Resident ${name} version pin is invalid`);
    }
    for (const target of requiredTargets) {
      const descriptor = tool.targets?.[target];
      if (
        !descriptor?.archive?.startsWith("https://github.com/")
        || !/^[0-9a-f]{64}$/.test(descriptor?.sha256 ?? "")
        || !descriptor?.binary
      ) {
        throw new Error(`Resident ${name} pin is incomplete for ${target}`);
      }
    }
  }
  for (const required of ["bun", "uv"]) {
    if (!toolchain.tools?.[required]) throw new Error(`Resident toolchain is missing ${required}`);
  }
}

function validateProfileEvals(profile, descriptor, evals) {
  if (
    evals?.schema_version !== "lazurio.resident.profile-evals.v1"
    || evals?.profile !== profile
    || !Array.isArray(evals?.cases)
    || evals.cases.length === 0
  ) {
    throw new Error(`profile ${profile} eval pack is missing or invalid`);
  }
  const requiredKinds = new Set([
    "normal",
    "boundary",
    "access-denied",
    "tool-failure",
    "regression",
    "role-bleed",
  ]);
  const observedKinds = new Set(evals.cases.map((item) => item.kind));
  for (const kind of requiredKinds) {
    if (!observedKinds.has(kind)) throw new Error(`profile ${profile} eval pack is missing ${kind}`);
  }
  const invariants = new Set(descriptor.behavior_invariants ?? []);
  const ids = new Set();
  for (const item of evals.cases) {
    if (typeof item.id !== "string" || ids.has(item.id)) {
      throw new Error(`profile ${profile} eval ids must be non-empty and unique`);
    }
    ids.add(item.id);
    for (const invariant of item.must_follow ?? []) {
      if (!invariants.has(invariant)) {
        throw new Error(`profile ${profile} eval ${item.id} references undeclared invariant ${invariant}`);
      }
    }
  }
}

function validateSourceRepository(value) {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/.test(value)
  ) {
    throw new Error("resident build contract source_repository must be a canonical owner/repository identity");
  }
  return value;
}

export function scanArtifactEntries(entries, {
  forbiddenPathSegments = [],
  forbiddenTerms = [],
} = {}) {
  const failures = [];
  const normalizedForbiddenTerms = forbiddenTerms
    .filter((term) => typeof term === "string" && term.trim() !== "")
    .map((term) => term.toLocaleLowerCase("en-US"));
  for (const [path, entry] of sortedEntries(entries)) {
    let normalized;
    try {
      normalized = normalizeArtifactPath(path);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const segments = normalized.split("/");
    for (const segment of forbiddenPathSegments) {
      if (segments.includes(segment)) failures.push(`${normalized}: forbidden path segment ${segment}`);
    }
    const base = basename(normalized);
    if (base === ".env" || base.startsWith(".env.")) {
      failures.push(`${normalized}: environment file is forbidden`);
    }
    if (base === "AGENTS.md" && normalized !== "AGENTS.md") {
      failures.push(`${normalized}: nested AGENTS.md is forbidden`);
    }
    if (!isProbablyText(normalized, entry.bytes)) continue;
    const text = entry.bytes.toString("utf8");
    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(text)) failures.push(`${normalized}: matched ${secret.label}`);
    }
    const lower = text.toLocaleLowerCase("en-US");
    for (const term of normalizedForbiddenTerms) {
      if (lower.includes(term)) failures.push(`${normalized}: matched caller-forbidden term`);
    }
  }
  return { ok: failures.length === 0, failures };
}

function isProbablyText(path, bytes) {
  if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) return false;
  return TEXT_EXTENSIONS.has(extname(path).toLocaleLowerCase("en-US"));
}

function inventoryEntries(entries) {
  return sortedEntries(entries).map(([path, entry]) => ({
    path,
    mode: entry.mode,
    size: entry.bytes.length,
    sha256: sha256(entry.bytes),
  }));
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

export function createDeterministicTar(rootName, entries, mtime) {
  const blocks = [];
  const directories = new Set([rootName]);
  for (const path of entries.keys()) {
    const parts = `${rootName}/${path}`.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  for (const directory of [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || left.localeCompare(right);
  })) {
    blocks.push(tarHeader(directory, 0, "0755", mtime, "5"));
  }
  for (const [path, entry] of sortedEntries(entries)) {
    const tarPath = `${rootName}/${path}`;
    blocks.push(tarHeader(tarPath, entry.bytes.length, entry.mode, mtime, "0"));
    blocks.push(entry.bytes);
    const remainder = entry.bytes.length % 512;
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function tarHeader(path, size, mode, mtime, type) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(path);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, Number.parseInt(mode, 8));
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, type);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeTarString(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const slashes = [...path.matchAll(/\//g)].map((match) => match.index);
  for (const index of slashes.reverse()) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`artifact path cannot be represented in ustar: ${path}`);
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new Error(`tar numeric field overflow: ${value}`);
  writeTarString(buffer, offset, length - 1, text);
  buffer[offset + length - 1] = 0;
}

function readGitTree(repositoryRoot, sourceCommit) {
  const output = gitBytes(repositoryRoot, ["ls-tree", "-rz", "--full-tree", sourceCommit]);
  const tree = new Map();
  for (const raw of output.toString("utf8").split("\0")) {
    if (!raw) continue;
    const separator = raw.indexOf("\t");
    if (separator < 0) throw new Error("cannot parse Git tree entry");
    const metadata = raw.slice(0, separator).split(" ");
    const path = raw.slice(separator + 1);
    if (metadata.length !== 3) throw new Error(`cannot parse Git tree metadata for ${path}`);
    normalizeArtifactPath(path);
    tree.set(path, {
      mode: metadata[0],
      type: metadata[1],
      object: metadata[2],
    });
  }
  return tree;
}

function readJsonBlob(repositoryRoot, tree, path) {
  try {
    return JSON.parse(readBlob(repositoryRoot, tree, path).toString("utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readBlob(repositoryRoot, tree, path) {
  const entry = tree.get(path);
  if (!entry || entry.type !== "blob") throw new Error(`source blob is missing: ${path}`);
  return gitBytes(repositoryRoot, ["cat-file", "blob", entry.object]);
}

function normalizeArtifactPath(path) {
  if (
    typeof path !== "string"
    || path === ""
    || isAbsolute(path)
    || path.includes("\\")
    || path.includes("\0")
  ) {
    throw new Error(`invalid artifact path ${String(path)}`);
  }
  const normalized = posix.normalize(path);
  if (
    normalized !== path
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`artifact path escapes or is not canonical: ${path}`);
  }
  return normalized;
}

function sortedEntries(entries) {
  return [...entries.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeOperatingSystem(platform) {
  if (platform === "win32") return "windows";
  return platform;
}

function gitText(cwd, args) {
  return gitBytes(cwd, args).toString("utf8").trim();
}

function gitBytes(cwd, args) {
  const executable = trustedGitExecutable();
  if (!executable) {
    throw new Error("resident build requires Git from a trusted system-owned path");
  }
  const safeArgs = [
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.gitProxy=",
    "-c", "protocol.ext.allow=never",
    ...args,
  ];
  const result = spawnSync(executable, safeArgs, {
    cwd,
    env: residentBuildGitEnvironment(),
    encoding: args.includes("cat-file") || args.includes("ls-tree") ? null : "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr ?? "");
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(String(result.stdout ?? ""), "utf8");
}

function residentBuildGitEnvironment(base = process.env) {
  const environment = {};
  for (const key of ["TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (typeof base[key] === "string") environment[key] = base[key];
  }
  environment.LC_ALL = "C";
  environment.LANG = "C";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_COUNT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "cat";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}
