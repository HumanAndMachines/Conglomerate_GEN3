import { lstatSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  buildLaunchpadDoctorReport,
  loadRootDoctorSchema,
} from "../launchpad/src/diagnostics-lib.mjs";
import {
  declarationIssues,
  runBoundChildDoctor,
} from "../launchpad/src/doctor-children-lib.mjs";
import {
  DOCTOR_EXIT_CODES,
  exitCodeForSummaryStatus,
  readDoctorDeclaration,
} from "../launchpad/src/doctor-surface-lib.mjs";
import { validateAgainstSchema } from "../launchpad/src/json-schema-mini.mjs";

export const LAZURIO_CONTEXT_SCHEMA_VERSION = "lazurio.context.v0";

const contextSchemaUrl = new URL("./context-v0.schema.json", import.meta.url);
const githubUsernamePattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
let contextSchema;

export function detectLazurioRoot(root = process.cwd()) {
  const absolutePath = resolve(root);
  const launchpadManifest = inspectRootManifest(join(absolutePath, "launchpad.gen3.json"));
  const personalspaceManifest = inspectRootManifest(join(absolutePath, "personal.gen3.json"));
  const hasLaunchpadManifest = launchpadManifest !== "absent";
  const hasPersonalspaceManifest = personalspaceManifest !== "absent";

  if (hasLaunchpadManifest && hasPersonalspaceManifest) {
    throw new Error(
      "Root je nejednoznačný: obsahuje launchpad.gen3.json i personal.gen3.json.",
    );
  }
  if (hasLaunchpadManifest) {
    return { kind: "launchpad_root", absolutePath, manifestObservation: launchpadManifest };
  }
  if (hasPersonalspaceManifest) {
    return { kind: "personalspace", absolutePath, manifestObservation: personalspaceManifest };
  }
  throw new Error(
    "Root nelze rozpoznat: očekávám launchpad.gen3.json nebo personal.gen3.json.",
  );
}

export async function buildLazurioContext({
  root = process.cwd(),
} = {}) {
  const detected = detectLazurioRoot(root);
  const projection = detected.kind === "personalspace"
    ? await personalspaceRootContext(detected)
    : await launchpadRootContext(detected);
  const failures = await validateLazurioContext(projection);
  if (failures.length > 0) {
    throw new Error(`Lazurio context neprošel vlastním schématem: ${failures.join("; ")}`);
  }
  return projection;
}

export async function validateLazurioContext(value) {
  if (!contextSchema) contextSchema = JSON.parse(await readFile(contextSchemaUrl, "utf8"));
  return validateAgainstSchema(value, contextSchema, "context");
}

export async function buildLazurioDoctorReport({
  root = process.cwd(),
  buildLaunchpadReport = buildLaunchpadDoctorReport,
  runBoundDoctor = runBoundChildDoctor,
} = {}) {
  const detected = detectLazurioRoot(root);
  if (detected.manifestObservation !== "present") {
    throw new Error(
      `${detected.kind === "personalspace" ? "personal.gen3.json" : "launchpad.gen3.json"} `
      + "není kanonický čitelný soubor.",
    );
  }
  if (detected.kind === "launchpad_root") {
    const report = await buildLaunchpadReport({
      companiesRoot: detected.absolutePath,
      launchpadRoot: join(detected.absolutePath, "launchpad"),
    });
    return {
      root_kind: detected.kind,
      report,
      exit_code: exitCodeForSummaryStatus(report.summary.status),
    };
  }

  const manifestPath = join(detected.absolutePath, "personal.gen3.json");
  const manifest = await readJson(manifestPath, "personal.gen3.json");
  const declaration = readDoctorDeclaration(manifest);
  if (!declaration) {
    throw new Error(
      "personal.gen3.json nedeklaruje doctor; Lazurio jeho příkaz nebude hádat.",
    );
  }
  const issues = declarationIssues(declaration);
  if (issues.length > 0) {
    throw new Error(`Deklarace Personalspace doctora není validní: ${issues.join("; ")}`);
  }

  const child = runBoundDoctor({
    root: detected.absolutePath,
    declarationPath: manifestPath,
    mountPath: detected.absolutePath,
    declaration,
    schema: loadRootDoctorSchema(),
    expectedScopeType: "personalspace",
    declarationLabel: "personal.gen3.json",
    mountLabel: ".",
  });
  if (child.outcome !== "report") {
    const error = new Error(
      `Personalspace doctor nevrátil validní report (${child.outcome}): `
      + `${(child.failures ?? []).join("; ")}`,
    );
    if (child.outcome === "scope_mismatch") {
      error.lazurioExitCode = DOCTOR_EXIT_CODES.incomplete;
    }
    throw error;
  }
  if (Number.isInteger(child.exit_code_mismatch)) {
    const error = new Error(
      `Personalspace doctor skončil kódem ${child.exit_code}, ale report vyžaduje `
      + `${child.exit_code_mismatch}.`,
    );
    error.lazurioExitCode = DOCTOR_EXIT_CODES.incomplete;
    throw error;
  }
  return {
    root_kind: detected.kind,
    report: child.report,
    exit_code: child.exit_code,
  };
}

async function personalspaceRootContext(detected) {
  let manifest;
  if (detected.manifestObservation === "present") {
    try {
      manifest = await readJson(
        join(detected.absolutePath, "personal.gen3.json"),
        "personal.gen3.json",
      );
    } catch {
      manifest = null;
    }
  }
  if (!isJsonObject(manifest)) {
    const reason = "personalspace_manifest_unreadable";
    return contextDocument({
      rootKind: detected.kind,
      principal: state("not_evaluated", reason),
      personalspace: {
        mount: state("present", "personalspace_is_root", { path: "." }),
        manifest: state("not_evaluated", reason, { path: "personal.gen3.json" }),
        readiness: state("not_evaluated", reason),
        access: state("not_evaluated", "provider_authority_not_checked"),
      },
      organizationsState: state("absent", "rootless_mode"),
      sources: [],
    });
  }
  const owner = allowlistedOwner(manifest?.owner);
  const ownerConfigured = Object.hasOwn(manifest, "owner");
  const principal = owner
    ? state("present", "personalspace_manifest_owner", owner)
    : state(
      "not_evaluated",
      ownerConfigured ? "personalspace_owner_invalid" : "personalspace_owner_missing",
    );

  return contextDocument({
    rootKind: detected.kind,
    principal,
    personalspace: {
      mount: state("present", "personalspace_is_root", { path: "." }),
      manifest: state("present", "personalspace_root_manifest", { path: "personal.gen3.json" }),
      readiness: state("not_evaluated", "doctor_not_run"),
      access: state("not_evaluated", "provider_authority_not_checked"),
    },
    organizationsState: state("absent", "rootless_mode"),
    sources: ["personal.gen3.json"],
  });
}

async function launchpadRootContext(detected) {
  let shared;
  if (detected.manifestObservation === "present") {
    try {
      shared = await readJson(
        join(detected.absolutePath, "launchpad.gen3.json"),
        "launchpad.gen3.json",
      );
    } catch {
      shared = null;
    }
  }
  if (!isJsonObject(shared)) {
    const reason = "launchpad_manifest_unreadable";
    return contextDocument({
      rootKind: detected.kind,
      principal: state("not_evaluated", reason),
      personalspace: {
        mount: state("not_evaluated", reason),
        manifest: state("not_evaluated", reason),
        readiness: state("not_evaluated", reason),
        access: state("not_evaluated", "provider_authority_not_checked"),
      },
      organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
      sources: [],
    });
  }
  const localPath = join(detected.absolutePath, "launchpad.gen3.local.json");
  const localObservation = await inspectManifestFile(localPath);
  let local = null;
  let localInvalid = localObservation === "unreadable";
  let localParsed = false;
  if (localObservation === "present") {
    try {
      local = JSON.parse(await readFile(localPath, "utf8"));
      if (isJsonObject(local)) {
        localParsed = true;
      } else {
        local = null;
        localInvalid = true;
      }
    } catch {
      localInvalid = true;
    }
  }

  const sources = ["launchpad.gen3.json"];
  if (localParsed) sources.push("launchpad.gen3.local.json");
  let mountpoint;
  try {
    mountpoint = safeRelativePath(
      shared.personalspace_mountpoint ?? "personalspace",
      "personalspace_mountpoint",
    );
  } catch {
    const reason = "personalspace_mountpoint_invalid";
    return contextDocument({
      rootKind: detected.kind,
      principal: state("not_evaluated", reason),
      personalspace: {
        mount: state("not_evaluated", reason),
        manifest: state("not_evaluated", reason),
        readiness: state("not_evaluated", reason),
        access: state("not_evaluated", "provider_authority_not_checked"),
      },
      organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
      sources,
    });
  }
  const ownerConfigured = local !== null && Object.hasOwn(local, "personalspace_owner");
  const username = normalizedGithubUsername(local?.personalspace_owner);

  if (!username) {
    const reason = localInvalid
      ? "local_override_invalid"
      : ownerConfigured
        ? "personalspace_owner_invalid"
        : "personalspace_owner_not_configured";
    return contextDocument({
      rootKind: detected.kind,
      principal: state("not_evaluated", reason),
      personalspace: {
        mount: state("not_evaluated", reason),
        manifest: state("not_evaluated", reason),
        readiness: state("not_evaluated", reason),
        access: state("not_evaluated", "provider_authority_not_checked"),
      },
      organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
      sources,
    });
  }

  const resolvedMount = await resolveConfiguredPersonalspace({
    root: detected.absolutePath,
    mountpoint,
    username,
  });
  if (resolvedMount.status === "ambiguous") {
    return contextDocument({
      rootKind: detected.kind,
      principal: state("not_evaluated", "configured_mount_ambiguous"),
      personalspace: {
        mount: state("not_evaluated", "configured_mount_ambiguous"),
        manifest: state("not_evaluated", "configured_mount_ambiguous"),
        readiness: state("not_evaluated", "configured_mount_ambiguous"),
        access: state("not_evaluated", "provider_authority_not_checked"),
      },
      organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
      sources,
    });
  }
  if (resolvedMount.status === "unreadable" || resolvedMount.status === "non_canonical") {
    const reason = resolvedMount.status === "unreadable"
      ? "personalspace_mountpoint_unreadable"
      : "personalspace_mount_non_canonical";
    const relativeMountPath = `${mountpoint}/${resolvedMount.directoryName}`;
    return contextDocument({
      rootKind: detected.kind,
      principal: state("not_evaluated", reason),
      personalspace: {
        mount: state("not_evaluated", reason, { path: relativeMountPath }),
        manifest: state("not_evaluated", reason),
        readiness: state("not_evaluated", reason),
        access: state("not_evaluated", "provider_authority_not_checked"),
      },
      organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
      sources,
    });
  }

  const relativeMountPath = `${mountpoint}/${resolvedMount.directoryName}`;
  const absoluteMountPath = join(detected.absolutePath, mountpoint, resolvedMount.directoryName);
  const manifestRelativePath = `${relativeMountPath}/personal.gen3.json`;
  const mountPresent = resolvedMount.status === "present";
  const manifestObservation = mountPresent
    ? await inspectManifestFile(join(absoluteMountPath, "personal.gen3.json"))
    : "absent";
  const manifestPresent = manifestObservation === "present";
  let manifestOwner = null;
  if (manifestObservation === "unreadable") {
    const reason = "personalspace_manifest_unreadable";
    return contextDocument({
      rootKind: detected.kind,
      principal: state("not_evaluated", reason),
      personalspace: {
        mount: state("present", "configured_mount_present", { path: relativeMountPath }),
        manifest: state("not_evaluated", reason, { path: manifestRelativePath }),
        readiness: state("not_evaluated", reason),
        access: state("not_evaluated", "provider_authority_not_checked"),
      },
      organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
      sources,
    });
  }
  if (manifestPresent) {
    let manifest;
    try {
      manifest = await readJson(
        join(absoluteMountPath, "personal.gen3.json"),
        manifestRelativePath,
      );
    } catch {
      const reason = "personalspace_manifest_unreadable";
      return contextDocument({
        rootKind: detected.kind,
        principal: state("not_evaluated", reason),
        personalspace: {
          mount: state("present", "configured_mount_present", { path: relativeMountPath }),
          manifest: state("not_evaluated", reason, { path: manifestRelativePath }),
          readiness: state("not_evaluated", reason),
          access: state("not_evaluated", "provider_authority_not_checked"),
        },
        organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
        sources,
      });
    }
    if (!isJsonObject(manifest)) {
      const reason = "personalspace_manifest_unreadable";
      return contextDocument({
        rootKind: detected.kind,
        principal: state("not_evaluated", reason),
        personalspace: {
          mount: state("present", "configured_mount_present", { path: relativeMountPath }),
          manifest: state("not_evaluated", reason, { path: manifestRelativePath }),
          readiness: state("not_evaluated", reason),
          access: state("not_evaluated", "provider_authority_not_checked"),
        },
        organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
        sources,
      });
    }
    sources.push(manifestRelativePath);
    manifestOwner = allowlistedOwner(manifest?.owner);
    const ownerConfigured = Object.hasOwn(manifest, "owner");
    if (
      !manifestOwner
      || manifestOwner.github_username.toLowerCase() !== username.toLowerCase()
    ) {
      const reason = manifestOwner
        ? "personalspace_owner_mismatch"
        : ownerConfigured
          ? "personalspace_owner_invalid"
          : "personalspace_owner_missing";
      return contextDocument({
        rootKind: detected.kind,
        principal: state("not_evaluated", reason),
        personalspace: {
          mount: state("not_evaluated", reason, { path: relativeMountPath }),
          manifest: state("not_evaluated", reason, { path: manifestRelativePath }),
          readiness: state("not_evaluated", reason),
          access: state("not_evaluated", "provider_authority_not_checked"),
        },
        organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
        sources,
      });
    }
  }

  return contextDocument({
    rootKind: detected.kind,
    principal: manifestOwner
      ? state("present", "personalspace_manifest_owner", manifestOwner)
      : state("present", "launchpad_local_owner", { github_username: username }),
    personalspace: {
      mount: state(
        mountPresent ? "present" : "absent",
        mountPresent ? "configured_mount_present" : "configured_mount_absent",
        { path: relativeMountPath },
      ),
      manifest: state(
        manifestPresent ? "present" : "absent",
        manifestPresent ? "configured_manifest_present" : "configured_manifest_absent",
        { path: manifestRelativePath },
      ),
      readiness: manifestPresent
        ? state("not_evaluated", "doctor_not_run")
        : state("absent", "personalspace_manifest_absent"),
      access: state("not_evaluated", "provider_authority_not_checked"),
    },
    organizationsState: state("not_evaluated", "organization_context_deferred_cac_0093"),
    sources,
  });
}

function contextDocument({
  rootKind,
  principal,
  personalspace,
  organizationsState,
  sources,
}) {
  return {
    schema_version: LAZURIO_CONTEXT_SCHEMA_VERSION,
    unstable: true,
    root: { kind: rootKind },
    principal,
    machine: {
      status: "present",
      reason: "runtime_observed",
      platform: process.platform,
      architecture: process.arch,
    },
    personalspace,
    organizations: [],
    organizations_state: organizationsState,
    provenance: {
      context_sources: sources,
      machine_sources: ["process.platform", "process.arch"],
    },
  };
}

function allowlistedOwner(owner) {
  const githubUsername = normalizedGithubUsername(owner?.github_username);
  if (!githubUsername) return null;
  const result = { github_username: githubUsername };
  const displayName = normalizedText(owner?.display_name);
  const type = normalizedText(owner?.type);
  if (displayName) result.display_name = displayName;
  if (type) result.type = type;
  return result;
}

function normalizedGithubUsername(value) {
  const normalized = normalizedText(value);
  return normalized && githubUsernamePattern.test(normalized) ? normalized : null;
}

function normalizedText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} musí být neprázdná relativní cesta.`);
  }
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || segments.some(
      (segment) => segment === ""
        || segment === "."
        || segment === ".."
        || !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    throw new Error(`${label} musí zůstat uvnitř Lazurio rootu.`);
  }
  return normalized;
}

async function resolveConfiguredPersonalspace({ root, mountpoint, username }) {
  const mountRoot = join(root, mountpoint);
  const expectedDirectoryName = `${username}_GEN3`;
  const mountpointStatus = await inspectMountpoint(root, mountRoot);
  if (mountpointStatus !== "present") {
    return { status: mountpointStatus, directoryName: expectedDirectoryName };
  }
  let entries;
  try {
    entries = await readdir(mountRoot, { withFileTypes: true });
  } catch {
    return { status: "unreadable", directoryName: expectedDirectoryName };
  }
  const matches = entries
    .filter((entry) => entry.name.toLowerCase() === expectedDirectoryName.toLowerCase())
    .sort((left, right) => left.name.localeCompare(right.name));
  if (matches.length > 1) {
    return { status: "ambiguous", directoryName: expectedDirectoryName };
  }
  if (matches.length === 0) return { status: "absent", directoryName: expectedDirectoryName };
  const [match] = matches;
  return {
    status: match.isDirectory() ? "present" : "non_canonical",
    directoryName: match.name,
  };
}

async function inspectMountpoint(root, mountRoot) {
  let metadata;
  try {
    metadata = await lstat(mountRoot);
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR"
      ? "absent"
      : "unreadable";
  }
  if (!metadata.isDirectory()) return "non_canonical";

  try {
    const [canonicalRoot, canonicalMount] = await Promise.all([realpath(root), realpath(mountRoot)]);
    const expectedMount = resolve(canonicalRoot, relative(resolve(root), resolve(mountRoot)));
    return isPathInside(canonicalRoot, canonicalMount)
      && samePath(expectedMount, canonicalMount)
      ? "present"
      : "non_canonical";
  } catch {
    return "unreadable";
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} nejde přečíst jako JSON: ${error.message}`);
  }
}

async function inspectManifestFile(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() ? "present" : "unreadable";
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR"
      ? "absent"
      : "unreadable";
  }
}

function inspectRootManifest(path) {
  try {
    return lstatSync(path).isFile() ? "present" : "unreadable";
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR"
      ? "absent"
      : "unreadable";
  }
}

function isPathInside(root, candidate) {
  const offset = relative(root, candidate);
  return offset !== ""
    && offset !== ".."
    && !offset.startsWith(`..${sep}`)
    && !isAbsolute(offset);
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function state(status, reason, extra = {}) {
  return { status, reason, ...extra };
}
