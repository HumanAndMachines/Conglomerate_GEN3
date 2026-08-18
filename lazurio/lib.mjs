import { lstatSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  buildLaunchpadAppsResponse,
  buildLaunchpadDoctorReport,
  loadRootDoctorSchema,
} from "../launchpad/src/diagnostics-lib.mjs";
import { buildGitInventory } from "../launchpad/src/git-inventory-lib.mjs";
import { readGitRepoStatuses } from "../launchpad/src/git-status-lib.mjs";
import {
  GIT_LOCAL_TIMEOUT_MS,
  mapWithConcurrency,
  runGit,
} from "../launchpad/src/git-lib.mjs";
import { githubRepositoryCoordinate } from "./core/organization-slot-scope-lib.mjs";
import { buildWorktreeIndex } from "../launchpad/src/worktree-lib.mjs";
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
import {
  identityInvariantIssues,
  isLegacyPersonalCustodyConfig,
  validatePersonalConfig,
} from "../launchpad/src/personalspace-lib.mjs";

export const LAZURIO_CONTEXT_SCHEMA_VERSION = "lazurio.context.v0";

const contextSchemaUrl = new URL("./context-v0.schema.json", import.meta.url);
const personalSchemaUrl = new URL(
  "../launchpad/schemas/personal.gen3.schema.json",
  import.meta.url,
);
const githubUsernamePattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
let contextSchema;
let personalSchema;
let legacyPersonalSchema;

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
  organization = null,
} = {}) {
  const detected = detectLazurioRoot(root);
  if (organization !== null && detected.kind !== "launchpad_root") {
    throw new Error("--organization lze použít pouze nad Launchpad rootem.");
  }
  const baseProjection = detected.kind === "personalspace"
    ? await personalspaceRootContext(detected)
    : await launchpadRootContext(detected);
  const projection = organization === null
    ? baseProjection
    : await withSelectedOrganizationContext({
        detected,
        projection: baseProjection,
        selector: organization,
      });
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
  const manifestIssues = await personalManifestIssues(manifest, {
    label: "personal.gen3.json",
  });
  if (manifestIssues.length > 0) {
    throw new Error(`Personalspace manifest není validní: ${manifestIssues.join("; ")}`);
  }
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
  const manifestIssues = await personalManifestIssues(manifest, {
    label: "personal.gen3.json",
  });
  if (manifestIssues.length > 0) {
    const reason = "personalspace_manifest_invalid";
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

  return contextDocument({
    rootKind: detected.kind,
    principal: state("present", "personalspace_manifest_owner", owner),
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
      organizationsState: state("not_evaluated", "organization_selector_not_provided"),
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
      organizationsState: state("not_evaluated", "organization_selector_not_provided"),
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
      organizationsState: state("not_evaluated", "organization_selector_not_provided"),
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
      organizationsState: state("not_evaluated", "organization_selector_not_provided"),
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
      organizationsState: state("not_evaluated", "organization_selector_not_provided"),
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
      organizationsState: state("not_evaluated", "organization_selector_not_provided"),
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
        organizationsState: state("not_evaluated", "organization_selector_not_provided"),
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
        organizationsState: state("not_evaluated", "organization_selector_not_provided"),
        sources,
      });
    }
    const configIssues = await personalManifestConfigIssues(manifest, manifestRelativePath);
    if (configIssues.length > 0) {
      const reason = "personalspace_manifest_invalid";
      return contextDocument({
        rootKind: detected.kind,
        principal: state("not_evaluated", reason),
        personalspace: {
          mount: state("present", "configured_mount_present", { path: relativeMountPath }),
          manifest: state("not_evaluated", reason, { path: manifestRelativePath }),
          readiness: state("not_evaluated", reason),
          access: state("not_evaluated", "provider_authority_not_checked"),
        },
        organizationsState: state("not_evaluated", "organization_selector_not_provided"),
        sources,
      });
    }
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
        organizationsState: state("not_evaluated", "organization_selector_not_provided"),
        sources,
      });
    }
    // Case-insensitive lookup mount pouze najde. Kanonický identity invariant
    // pak záměrně drží skutečný název adresáře 1:1 včetně casing driftu.
    const identityIssues = identityInvariantIssues(
      manifest,
      resolvedMount.directoryName,
    );
    if (identityIssues.length > 0) {
      const reason = "personalspace_manifest_invalid";
      return contextDocument({
        rootKind: detected.kind,
        principal: state("not_evaluated", reason),
        personalspace: {
          mount: state("present", "configured_mount_present", { path: relativeMountPath }),
          manifest: state("not_evaluated", reason, { path: manifestRelativePath }),
          readiness: state("not_evaluated", reason),
          access: state("not_evaluated", "provider_authority_not_checked"),
        },
        organizationsState: state("not_evaluated", "organization_selector_not_provided"),
        sources,
      });
    }
    sources.push(manifestRelativePath);
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
    organizationsState: state("not_evaluated", "organization_selector_not_provided"),
    sources,
  });
}

async function withSelectedOrganizationContext({ detected, projection, selector }) {
  const normalizedSelector = normalizedOrganizationSelector(selector);
  if (!normalizedSelector) {
    throw new Error("--organization vyžaduje platný Organization slug.");
  }

  const appsResponse = await buildLaunchpadAppsResponse({
    companiesRoot: detected.absolutePath,
    organization: normalizedSelector,
    includeGit: false,
    runtimeManager: {
      appsWithRuntime: async (apps) => apps,
    },
  });
  const matches = (appsResponse.organizations ?? []).filter(
    (organization) =>
      organization.status !== "planned"
      && typeof organization.path === "string"
      && organization.slug.toLowerCase() === normalizedSelector.toLowerCase(),
  );
  if (matches.length === 0) {
    throw new Error(
      `Organization '${selector}' nebyla mezi lokálně objevenými Organizacemi.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`Organization selector '${selector}' je nejednoznačný.`);
  }

  const [selected] = matches;
  const discoveryFailures = (appsResponse.failures ?? []).filter(
    (failure) =>
      failure.startsWith(`${selected.path}:`)
      || failure.startsWith(`${selected.path}/`),
  );
  if (discoveryFailures.length > 0) {
    throw new Error(
      `Organization '${selected.slug}' neprošla lokálním discovery: ${discoveryFailures.join("; ")}`,
    );
  }
  const inventory = await buildGitInventory({
    companiesRoot: detected.absolutePath,
    organizations: [selected],
  });
  const statuses = await readGitRepoStatuses(inventory.repos);
  const statusByKey = new Map(statuses.map((status) => [status.key, status]));
  const originByKey = await observeGitOrigins(inventory.repos, statusByKey);
  const worktreeIndex = await buildWorktreeIndex({
    companiesRoot: detected.absolutePath,
    organization: selected.slug,
    inventoryOrganizations: [selected],
  });
  const organization = selectedOrganizationProjection({
    companiesRoot: detected.absolutePath,
    selected,
    apps: appsResponse.apps ?? [],
    inventory,
    statusByKey,
    originByKey,
    worktreeIndex,
  });
  const contextSources = [
    ...projection.provenance.context_sources,
    ...organization.provenance.manifest_paths,
    ...organization.apps.map((app) => app.package_path),
    ...worktreeIndex.worktrees
      .filter((worktree) => worktree.metadata)
      .map((worktree) => worktree.sidecar_path),
  ];

  return {
    ...projection,
    organizations: [organization],
    organizations_scope: "selected",
    organization_selector: selected.slug,
    organizations_state: state("present", "selected_organization_observed"),
    provenance: {
      ...projection.provenance,
      context_sources: [...new Set(contextSources)].sort((left, right) => left.localeCompare(right)),
    },
  };
}

function selectedOrganizationProjection({
  companiesRoot,
  selected,
  apps,
  inventory,
  statusByKey,
  originByKey,
  worktreeIndex,
}) {
  const repositoryByPath = new Map([
    ...inventory.repos
      .filter((repo) => repo.slot_path)
      .map((repo) => [repo.slot_path, repo]),
    ...inventory.planned
      .filter((repo) => repo.slot_path)
      .map((repo) => [repo.slot_path, repo]),
  ]);
  const declarations = Array.isArray(selected.module_declarations)
    ? selected.module_declarations
    : [];
  const modules = declarations
    .map((declaration) => {
      const repo = repositoryByPath.get(declaration.path) ?? null;
      const repository = repositoryName(declaration.repo);
      return {
        slug: declaration.slug,
        name: declaration.name,
        path: `${selected.path}/${declaration.path}`,
        space: declaration.space,
        teams: [...(declaration.teams ?? [])].sort((left, right) => left.localeCompare(right)),
        ...(repository ? { repository } : {}),
        ...(declaration.branch ? { declared_branch: declaration.branch } : {}),
        materialization: moduleMaterialization(declaration),
        access: providerAccessNotEvaluated(),
        ...(declaration.apps ? { apps: structuredClone(declaration.apps) } : {}),
        git: gitProjection({
          repo,
          status: repo ? statusByKey.get(repo.key) : null,
          observedOrigin: repo ? originByKey.get(repo.key) : null,
          materialization: declaration.status,
          repositoryDeclared: repository !== null,
        }),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const moduleBySlug = new Map(modules.map((module) => [module.slug, module]));
  const rootRepo = inventory.repos.find((repo) => repo.repo_kind === "organization_root") ?? null;
  const organizationRepository = repositoryName(selected.repository);
  const manifestPaths = observedOrganizationManifestPaths({
    companiesRoot,
    organizationPath: selected.path,
  });
  const organizationApps = apps
    .filter(
      (app) =>
        app.manifest_state !== "invalid_manifest"
        && app.company.toLowerCase() === selected.slug.toLowerCase(),
    )
    .map((app) => ({
      id: app.id,
      title: app.title,
      ...(typeof app.module === "string" ? { module: app.module } : {}),
      path: app.cwd,
      space: app.space,
      teams: [...(app.teams ?? [])].sort((left, right) => left.localeCompare(right)),
      package_path: app.package_path,
      ...(app.module_app ? { module_app: structuredClone(app.module_app) } : {}),
      access: providerAccessNotEvaluated(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    slug: selected.slug,
    display_name: selected.display_name,
    path: selected.path,
    ...(organizationRepository ? { repository: organizationRepository } : {}),
    access: providerAccessNotEvaluated(),
    git: gitProjection({
      repo: rootRepo,
      status: rootRepo ? statusByKey.get(rootRepo.key) : null,
      observedOrigin: rootRepo ? originByKey.get(rootRepo.key) : null,
      materialization: "available",
      repositoryDeclared: organizationRepository !== null,
    }),
    teams: (selected.teams ?? [])
      .map((team) => ({
        slug: team.slug,
        display_name: team.display_name,
        default: team.default === true,
        modules: [...new Set((team.modules ?? []).map((module) => module.slug))]
          .sort((left, right) => left.localeCompare(right)),
        access: providerAccessNotEvaluated(),
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
    modules,
    apps: organizationApps,
    worktrees: (worktreeIndex.worktrees ?? [])
      .map((worktree) => compactWorktree(worktree))
      .sort((left, right) => left.path.localeCompare(right.path)),
    entrypoints: {
      agents: pathStateFromObservation({
        absolutePath: join(companiesRoot, selected.path, "AGENTS.md"),
        relativePath: `${selected.path}/AGENTS.md`,
      }),
      mission_control: moduleEntrypointState(moduleBySlug.get("mission-control")),
      knowledgebase: moduleEntrypointState(moduleBySlug.get("knowledgebase")),
    },
    provenance: {
      manifest_paths: manifestPaths,
      discovery: "launchpad_scan_first",
      git: "local_only",
      access: "not_evaluated",
    },
  };
}

function observedOrganizationManifestPaths({ companiesRoot, organizationPath }) {
  const paths = [`${organizationPath}/company.gen3.json`];
  for (const candidate of [
    "modules.manifest.json",
    "company/scripts/modules.manifest.json",
  ]) {
    if (inspectRootManifest(join(companiesRoot, organizationPath, candidate)) !== "present") {
      continue;
    }
    paths.push(`${organizationPath}/${candidate}`);
    break;
  }
  return paths;
}

async function observeGitOrigins(repos, statusByKey) {
  const pairs = await mapWithConcurrency(repos, 4, async (repo) => {
    const status = statusByKey.get(repo.key);
    if (!status || status.status === "repo_missing") return [repo.key, null];
    const result = await runGit(["remote", "get-url", "origin"], {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    return [repo.key, result.ok ? repositoryName(result.stdout) : null];
  });
  return new Map(pairs);
}

function gitProjection({
  repo,
  status,
  observedOrigin,
  materialization,
  repositoryDeclared,
}) {
  if (materialization === "planned_slot") {
    return {
      status: "absent",
      reason: "repository_not_declared",
      origin: state("absent", "repository_not_declared"),
    };
  }
  if (!repo) {
    return repositoryDeclared
      ? {
          status: "not_evaluated",
          reason: "git_inventory_excluded",
          origin: state("not_evaluated", "git_inventory_excluded"),
        }
      : {
          status: "absent",
          reason: "repository_not_declared",
          origin: state("absent", "repository_not_declared"),
        };
  }
  if (!status || status.status === "repo_missing") {
    return {
      status: "absent",
      reason: "checkout_absent",
      origin: state("absent", "checkout_absent"),
    };
  }
  if (["git_unavailable", "check_failed"].includes(status.status)) {
    return {
      status: "not_evaluated",
      reason: "local_git_probe_failed",
      origin: state("not_evaluated", "local_git_probe_failed"),
    };
  }
  return {
    status: "present",
    reason: "local_git_observed",
    ...(status.branch ? { branch: status.branch } : {}),
    ...(status.expected_branch ? { expected_branch: status.expected_branch } : {}),
    ...(status.head?.sha ? { head: status.head.sha } : {}),
    state: status.status,
    changed_files: status.counts?.changed_files ?? 0,
    untracked_files: status.counts?.untracked_files ?? 0,
    origin: observedOrigin
      ? state("present", "local_origin_observed", { repository: observedOrigin })
      : state("not_evaluated", "origin_not_observed"),
  };
}

function moduleMaterialization(declaration) {
  if (declaration.status === "available") {
    return state("present", "checkout_present");
  }
  if (declaration.status === "planned_slot") {
    return state("absent", "repository_not_declared");
  }
  return state("absent", "checkout_absent");
}

function moduleEntrypointState(module) {
  if (!module) return state("absent", "entrypoint_not_declared");
  return {
    ...module.materialization,
    path: module.path,
  };
}

function pathStateFromObservation({ absolutePath, relativePath }) {
  const observation = inspectRootManifest(absolutePath);
  if (observation === "present") {
    return state("present", "entrypoint_present", { path: relativePath });
  }
  if (observation === "absent") {
    return state("absent", "entrypoint_absent", { path: relativePath });
  }
  return state("not_evaluated", "entrypoint_unreadable", { path: relativePath });
}

function compactWorktree(worktree) {
  return {
    slug: worktree.slug,
    path: worktree.path,
    workspace: worktree.workspace,
    module: worktree.module,
    ...(worktree.branch ? { branch: worktree.branch } : {}),
    ...(worktree.plan_code ? { plan_code: worktree.plan_code } : {}),
    ownership_status: worktree.ownership_status,
    status: worktree.status,
  };
}

function providerAccessNotEvaluated() {
  return state("not_evaluated", "provider_authority_not_checked");
}

function repositoryName(remote) {
  return githubRepositoryCoordinate(remote)?.ownerRepo ?? null;
}

function normalizedOrganizationSelector(value) {
  const normalized = normalizedText(value);
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)
    ? normalized
    : null;
}

function contextDocument({
  rootKind,
  principal,
  personalspace,
  organizationsState,
  sources,
  organizations = [],
  organizationsScope = "none",
  organizationSelector = null,
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
    organizations,
    organizations_scope: organizationsScope,
    organization_selector: organizationSelector,
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

async function personalManifestIssues(manifest, { label }) {
  const configIssues = await personalManifestConfigIssues(manifest, label);
  if (configIssues.length > 0) return configIssues;
  // Rootless režim nemá fyzický mount adresář. Jeho identity gate proto
  // ověřuje deklarované repo/mount/gbrain vazby přímo proti ownerovi.
  const identityDirectoryName = `${manifest?.owner?.github_username ?? ""}_GEN3`;
  return identityInvariantIssues(manifest, identityDirectoryName);
}

async function personalManifestConfigIssues(manifest, label) {
  if (!personalSchema) {
    personalSchema = JSON.parse(await readFile(personalSchemaUrl, "utf8"));
  }
  const schemaFailures = validateAgainstSchema(
    manifest,
    personalSchemaFor(manifest),
    label,
  );
  if (schemaFailures.length > 0) return schemaFailures;
  return validatePersonalConfig(manifest, personalSchema, label);
}

function personalSchemaFor(manifest) {
  if (!isLegacyPersonalCustodyConfig(manifest)) return personalSchema;
  if (!legacyPersonalSchema) {
    legacyPersonalSchema = JSON.parse(JSON.stringify(personalSchema));
    legacyPersonalSchema.required = legacyPersonalSchema.required.filter(
      (key) => key !== "schema_version",
    );
    legacyPersonalSchema.properties.repository.required =
      legacyPersonalSchema.properties.repository.required.filter(
        (key) => key !== "mount_strategy",
      );
    legacyPersonalSchema.properties.gbrain.required =
      legacyPersonalSchema.properties.gbrain.required.filter(
        (key) => !["repository", "software"].includes(key),
      );
    legacyPersonalSchema.properties.buddy.required =
      legacyPersonalSchema.properties.buddy.required.filter(
        (key) => !["path", "repository", "runtime", "hermes"].includes(key),
      );
  }
  return legacyPersonalSchema;
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
