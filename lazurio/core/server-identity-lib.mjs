import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const LAZURIO_SERVER_IDENTITY_SCHEMA = "lazurio.server.identity.v1";
export const LAZURIO_SERVER_PRODUCT = "lazurio-launchpad-server";
export const LEGACY_LAUNCHPAD_IDENTITY_SCHEMA = "companiesascode.launchpad.identity.v1";

const sha256Pattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const generationDirectories = ["launchpad/src", "lazurio/core"];
const generationFiles = [
  "launchpad/package.json",
  "scripts/worktree-create-lib.mjs",
  "scripts/worktree-create-lock.mjs",
];

export function computeServerRootId(canonicalRoot) {
  if (typeof canonicalRoot !== "string" || canonicalRoot === "") {
    throw new TypeError("Server root identity requires a canonical root path.");
  }
  return createHash("sha256").update(canonicalRoot).digest("hex");
}

export function computeServerInstallGeneration(codeRoot) {
  if (typeof codeRoot !== "string" || codeRoot === "") {
    throw new TypeError("Server install generation requires a code root.");
  }

  const root = resolve(codeRoot);
  const residentManifestPath = join(root, "lazurio.resident.json");
  try {
    const manifest = JSON.parse(readFileSync(residentManifestPath, "utf8"));
    const digest = manifest?.payload?.digest;
    if (manifest?.schema_version === "lazurio.resident.manifest.v1" && isSha256(digest)) {
      return digest;
    }
    throw new Error("Installed Lazurio runtime manifest has no valid payload digest.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const normalizedInputs = serverInstallGenerationInputPaths(root).map((path) => ({
    absolute: join(root, ...path.split("/")),
    relative: path,
  }));

  const hash = createHash("sha256");
  for (const input of normalizedInputs) {
    const stat = lstatSync(input.absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Server generation input is not a physical file: ${input.relative}`);
    }
    const bytes = readFileSync(input.absolute);
    hash.update(input.relative);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function serverInstallGenerationInputPaths(codeRoot) {
  if (typeof codeRoot !== "string" || codeRoot === "") {
    throw new TypeError("Server install generation requires a code root.");
  }

  const root = resolve(codeRoot);
  const inputs = [];
  for (const directory of generationDirectories) {
    const absoluteDirectory = join(root, directory);
    const directoryStat = lstatSync(absoluteDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Server generation input is not a physical directory: ${directory}`);
    }
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs") || entry.name.endsWith(".test.mjs")) continue;
      inputs.push(join(absoluteDirectory, entry.name));
    }
  }
  for (const file of generationFiles) inputs.push(join(root, file));

  const normalizedInputs = inputs
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
  if (normalizedInputs.length === 0) throw new Error("Server install generation has no source inputs.");
  return normalizedInputs;
}

export function buildServerIdentity({
  rootId,
  installGeneration,
  instanceId,
  pid,
  startedAt,
}) {
  const identity = {
    schema_version: LAZURIO_SERVER_IDENTITY_SCHEMA,
    product: LAZURIO_SERVER_PRODUCT,
    root_id: rootId,
    install_generation: installGeneration,
    instance_id: instanceId,
    pid,
    started_at: startedAt,
  };
  if (!isValidServerIdentity(identity)) {
    throw new TypeError("Cannot build an invalid Lazurio Server identity.");
  }
  return Object.freeze(identity);
}

export function classifyServerIdentity({ observed = null, legacyObserved = null, expected }) {
  assertExpectedIdentity(expected);

  if (observed !== null && observed !== undefined) {
    if (observed?.product !== LAZURIO_SERVER_PRODUCT) return "unrecognized";
    if (isSha256(observed?.root_id) && observed.root_id !== expected.rootId) return "foreign_root";
    if (observed?.root_id !== expected.rootId) return "unrecognized";
    if (observed?.schema_version !== LAZURIO_SERVER_IDENTITY_SCHEMA) return "protocol_incompatible";
    if (!isValidServerIdentity(observed)) return "protocol_incompatible";
    if (observed.install_generation !== expected.installGeneration) return "stale_install";
    return "compatible";
  }

  if (legacyObserved !== null && legacyObserved !== undefined) {
    if (legacyObserved?.schema_version !== LEGACY_LAUNCHPAD_IDENTITY_SCHEMA || !isSha256(legacyObserved?.root_id)) {
      return "unrecognized";
    }
    return legacyObserved.root_id === expected.rootId ? "legacy_same_root" : "foreign_root";
  }

  return "unrecognized";
}

export function isValidServerIdentity(identity) {
  return Boolean(
    identity
    && typeof identity === "object"
    && !Array.isArray(identity)
    && identity.schema_version === LAZURIO_SERVER_IDENTITY_SCHEMA
    && identity.product === LAZURIO_SERVER_PRODUCT
    && isSha256(identity.root_id)
    && isSha256(identity.install_generation)
    && typeof identity.instance_id === "string"
    && uuidPattern.test(identity.instance_id)
    && Number.isSafeInteger(identity.pid)
    && identity.pid > 0
    && typeof identity.started_at === "string"
    && Number.isFinite(Date.parse(identity.started_at))
  );
}

function assertExpectedIdentity(expected) {
  if (!expected || !isSha256(expected.rootId) || !isSha256(expected.installGeneration)) {
    throw new TypeError("Server identity classification requires exact root and install generations.");
  }
}

function isSha256(value) {
  return typeof value === "string" && sha256Pattern.test(value);
}
