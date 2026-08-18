import { posix } from "node:path";

const MODULE_ID = /^[a-z0-9][a-z0-9-]*$/;
const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const LEASE_ID = /^[a-z][a-z0-9-]*$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MODULE_KEYS = new Set([
  "schema_version",
  "id",
  "company",
  "tcp_port_policy",
  "port_leases",
  "apps",
  "default_app",
]);
const POLICY_KEYS = new Set(["mode", "reason"]);
const LEASE_KEYS = new Set(["id", "host", "port"]);

export function normalizeModuleManifest({
  manifest,
  modulePath = "lazurio.module.json",
}) {
  const issues = validateModuleManifest({ manifest, modulePath });
  const leases = Array.isArray(manifest?.port_leases)
    ? manifest.port_leases.map((lease) => ({ ...lease }))
    : [];
  const apps = Array.isArray(manifest?.apps) ? [...manifest.apps] : null;
  return {
    module: {
      schema_version: manifest?.schema_version ?? null,
      id: manifest?.id ?? null,
      company: manifest?.company ?? null,
      tcp_port_policy: manifest?.tcp_port_policy ?? null,
      port_leases: leases,
      apps,
      default_app: manifest?.default_app ?? null,
      app_declaration_state: apps === null ? "legacy-missing" : "explicit",
      module_path: modulePath,
    },
    issues,
  };
}

export function validateModuleManifest({
  manifest,
  modulePath = "lazurio.module.json",
}) {
  const label = `${modulePath}: lazurio.module`;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [`${label} musí být object`];
  }
  const issues = [];
  for (const key of Object.keys(manifest)) {
    if (!MODULE_KEYS.has(key)) issues.push(`${label}.${key} není povolené pole`);
  }
  for (const key of ["schema_version", "id", "company", "tcp_port_policy", "port_leases"]) {
    if (manifest[key] === undefined) issues.push(`${label}.${key} chybí`);
  }
  if (manifest.schema_version !== "lazurio.module.v1") {
    issues.push(`${label}.schema_version musí být lazurio.module.v1`);
  }
  validatePattern(manifest.id, MODULE_ID, `${label}.id`, issues);
  validatePattern(manifest.company, COMPANY_ID, `${label}.company`, issues);
  validateTcpPolicy(manifest.tcp_port_policy, `${label}.tcp_port_policy`, issues);
  validateModuleApps(manifest, label, issues);

  if (!Array.isArray(manifest.port_leases) || manifest.port_leases.length === 0) {
    issues.push(`${label}.port_leases musí být neprázdné pole`);
    return issues;
  }
  const ids = new Set();
  const ports = new Set();
  for (const [index, lease] of manifest.port_leases.entries()) {
    const leaseLabel = `${label}.port_leases[${index}]`;
    if (!lease || typeof lease !== "object" || Array.isArray(lease)) {
      issues.push(`${leaseLabel} musí být object`);
      continue;
    }
    for (const key of Object.keys(lease)) {
      if (!LEASE_KEYS.has(key)) issues.push(`${leaseLabel}.${key} není povolené pole`);
    }
    for (const key of ["id", "host", "port"]) {
      if (lease[key] === undefined) issues.push(`${leaseLabel}.${key} chybí`);
    }
    validatePattern(lease.id, LEASE_ID, `${leaseLabel}.id`, issues);
    if (typeof lease.id === "string") {
      if (ids.has(lease.id)) issues.push(`${leaseLabel}.id ${lease.id} je duplicitní`);
      ids.add(lease.id);
    }
    if (!LOOPBACK_HOSTS.has(lease.host)) {
      issues.push(`${leaseLabel}.host musí být loopback 127.0.0.1, localhost nebo ::1`);
    }
    if (!Number.isInteger(lease.port) || lease.port < 1024 || lease.port > 65_535) {
      issues.push(`${leaseLabel}.port musí být číslo 1024-65535`);
    } else {
      if (ports.has(lease.port)) issues.push(`${leaseLabel}.port ${lease.port} je v modulu duplicitní`);
      ports.add(lease.port);
    }
  }

  const mode = manifest.tcp_port_policy?.mode;
  if (mode === "single" && manifest.port_leases.length !== 1) {
    issues.push(`${label}.tcp_port_policy single vyžaduje právě jeden TCP port`);
  }
  if (mode === "single" && manifest.port_leases[0]?.id !== "main") {
    issues.push(`${label}: standardní single lease musí mít id main`);
  }
  if (mode === "exception" && manifest.port_leases.length < 2) {
    issues.push(`${label}.tcp_port_policy exception vyžaduje alespoň dva TCP porty`);
  }
  return issues;
}

function validateModuleApps(manifest, label, issues) {
  // Missing apps remains read-compatible during the GEN3 rollout. An explicit
  // empty array is intentionally different: it says the Module has no App.
  if (manifest.apps === undefined) {
    if (manifest.default_app !== undefined) {
      issues.push(`${label}.default_app vyžaduje explicitní apps`);
    }
    return;
  }
  if (!Array.isArray(manifest.apps)) {
    issues.push(`${label}.apps musí být pole relativních package.json cest`);
    return;
  }
  const seen = new Set();
  for (const [index, appPath] of manifest.apps.entries()) {
    const appLabel = `${label}.apps[${index}]`;
    if (!validAppPackagePath(appPath)) {
      issues.push(`${appLabel} musí být bezpečná relativní POSIX cesta končící package.json`);
      continue;
    }
    if (seen.has(appPath)) issues.push(`${appLabel} ${appPath} je duplicitní`);
    seen.add(appPath);
  }
  if (manifest.apps.length === 0) {
    if (manifest.default_app !== undefined) {
      issues.push(`${label}.default_app nesmí být uvedený pro apps: []`);
    }
    return;
  }
  if (!validAppPackagePath(manifest.default_app)) {
    issues.push(`${label}.default_app musí být bezpečná relativní POSIX cesta končící package.json`);
  } else if (!seen.has(manifest.default_app)) {
    issues.push(`${label}.default_app ${manifest.default_app} musí být uvedený v apps`);
  }
}

function validAppPackagePath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return segments.at(-1) === "package.json";
}

export function materializeRuntimeFromModule({
  runtime,
  module,
  packagePath = "package.json",
}) {
  const issues = [];
  const moduleApp = resolveModuleAppDeclaration({ module, packagePath });
  issues.push(...moduleApp.issues);
  const leases = new Map((module?.port_leases ?? []).map((lease) => [lease.id, lease]));
  const referenced = new Set();
  if (runtime?.company !== module?.company) {
    issues.push(`${packagePath}: lazurio.runtime.company ${String(runtime?.company)} neodpovídá module lease company ${String(module?.company)}`);
  }
  if (runtime?.module !== module?.id) {
    issues.push(`${packagePath}: lazurio.runtime.module ${String(runtime?.module)} neodpovídá module lease id ${String(module?.id)}`);
  }
  const listeners = (runtime?.listeners ?? []).map((listener, index) => {
    if (!listener || typeof listener !== "object" || Array.isArray(listener)) {
      issues.push(`${packagePath}: lazurio.runtime.listeners[${index}] musí být object`);
      return null;
    }
    if (referenced.has(listener.lease)) {
      issues.push(`${packagePath}: module lease ${String(listener.lease)} je referencovaný více runtime listenery`);
    }
    referenced.add(listener.lease);
    const lease = leases.get(listener.lease);
    if (!lease) {
      issues.push(`${packagePath}: lazurio.runtime listener ${String(listener.id)} odkazuje na neexistující module lease ${String(listener.lease)}`);
      return { ...listener, allocation: "static", host: null, port: null, claim: { mode: "exclusive" } };
    }
    return {
      ...listener,
      allocation: "static",
      host: lease.host,
      port: lease.port,
      claim: { mode: "exclusive" },
      module_lease: {
        id: lease.id,
        module_id: module.id,
        company: module.company,
        source: module.module_path,
      },
    };
  }).filter(Boolean);
  const entrypoint = listeners.find((listener) => listener.role === "entrypoint") ?? null;
  return {
    app: {
      ...runtime,
      listeners,
      entrypoint_listener: entrypoint,
      port: entrypoint?.port ?? null,
      host: entrypoint?.host ?? null,
      health_path: entrypoint?.health?.kind === "http" ? entrypoint.health.path : "/",
      module_contract: module,
      module_app: moduleApp.app,
      runtime_contract: {
        schema_version: runtime?.schema_version ?? null,
        source: "lazurio.runtime",
        legacy: false,
        auxiliary_listeners_known: true,
        module_lease_source: module?.module_path ?? null,
        listeners,
      },
    },
    issues,
  };
}

export function resolveModuleAppDeclaration({ module, packagePath }) {
  const moduleRoot = posix.dirname(String(module?.module_path ?? "lazurio.module.json").replace(/\\/g, "/"));
  const normalizedPackagePath = String(packagePath ?? "").replace(/\\/g, "/");
  const relativePackage = posix.relative(moduleRoot, normalizedPackagePath);
  if (module?.apps === null || module?.apps === undefined) {
    return {
      app: { package: relativePackage, declared: false, default: false, state: "legacy-missing" },
      issues: [],
    };
  }
  if (!module.apps.includes(relativePackage)) {
    return {
      app: { package: relativePackage, declared: false, default: false, state: "not-declared" },
      issues: [`${packagePath}: package není uvedený v ${module.module_path}#apps`],
    };
  }
  return {
    app: {
      package: relativePackage,
      declared: true,
      default: module.default_app === relativePackage,
      state: "explicit",
    },
    issues: [],
  };
}

/**
 * Canonical Module -> Apps projection shared by CLI and UI adapters.
 *
 * `moduleRootPath` and every app package path are companies-root-relative POSIX
 * paths. `moduleRootPaths` lets Core assign legacy packages to the most
 * specific declared Module root, so a nested repository never becomes an App
 * of its parent merely because it lives below the same filesystem prefix.
 */
export function resolveModuleApplications({
  module = null,
  moduleRootPath,
  moduleRootPaths = [moduleRootPath],
  contractPath = module?.module_path ?? null,
  contractIssues = [],
  apps = [],
} = {}) {
  const root = normalizedRelativePath(moduleRootPath);
  const roots = [...new Set(moduleRootPaths.map(normalizedRelativePath).filter(Boolean))];
  const normalizedContractPath = normalizedRelativePath(contractPath);
  const ownedApps = apps
    .map((app, index) => moduleApplicationRecord({ app, index, root, roots, contractPath: normalizedContractPath }))
    .filter(Boolean);
  const invalidContract = contractIssues.length > 0;

  if (invalidContract) {
    return moduleApplicationsProjection({
      state: "unresolved-invalid",
      contractPath: normalizedContractPath,
      items: discoveredApplicationItems(ownedApps),
    });
  }

  if (!module || module.apps === null || module.apps === undefined) {
    const items = discoveredApplicationItems(ownedApps);
    const openTarget = legacyOpenTarget(ownedApps);
    return moduleApplicationsProjection({
      state: "legacy-missing",
      contractPath: normalizedContractPath,
      items,
      openTarget,
    });
  }

  if (module.apps.length === 0) {
    return moduleApplicationsProjection({
      state: "explicit-none",
      contractPath: normalizedContractPath,
      items: discoveredApplicationItems(ownedApps),
    });
  }

  const declared = new Set(module.apps);
  const items = module.apps.map((packagePath) => declaredApplicationItem({
    packagePath,
    isDefault: module.default_app === packagePath,
    matches: ownedApps.filter((candidate) => candidate.packagePath === packagePath),
  }));
  for (const candidate of ownedApps) {
    if (declared.has(candidate.packagePath)) continue;
    items.push(applicationItem(candidate, { declared: false, isDefault: false }));
  }
  const defaultApp = items.find((item) => item.default) ?? null;
  const openTarget = defaultApp?.record === "valid" && defaultApp.app_id
    ? { appId: defaultApp.app_id, source: "declared-default" }
    : null;
  return moduleApplicationsProjection({
    state: "declared",
    contractPath: normalizedContractPath,
    items,
    defaultApp,
    openTarget,
  });
}

function moduleApplicationsProjection({
  state,
  contractPath,
  items,
  defaultApp = null,
  openTarget = null,
}) {
  return {
    state,
    contract_path: contractPath,
    items,
    default_app: defaultApp
      ? {
          package_path: defaultApp.package_path,
          app_id: defaultApp.app_id,
          record: defaultApp.record,
        }
      : null,
    open_target_app_id: openTarget?.appId ?? null,
    open_target_source: openTarget?.source ?? null,
  };
}

function normalizedRelativePath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = posix.normalize(value.trim().replace(/\\/g, "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }
  return normalized;
}

function pathWithin(root, candidate) {
  return Boolean(root && candidate && (candidate === root || candidate.startsWith(`${root}/`)));
}

function owningModuleRoot(packagePath, roots) {
  return roots
    .filter((candidate) => pathWithin(candidate, packagePath))
    .sort((left, right) => right.length - left.length)[0] ?? null;
}

function moduleApplicationRecord({ app, index, root, roots, contractPath }) {
  const packagePath = normalizedRelativePath(app?.package_path);
  if (!packagePath || !root || owningModuleRoot(packagePath, roots) !== root) return null;
  const appContractPath = normalizedRelativePath(app?.module_contract?.module_path);
  if (appContractPath && contractPath && appContractPath !== contractPath) return null;
  const relativePackage = posix.relative(root, packagePath);
  if (!relativePackage || relativePackage === ".." || relativePackage.startsWith("../")) return null;
  return {
    app,
    index,
    packagePath: app?.module_app?.package ?? relativePackage,
    record: app?.manifest_state === "invalid_manifest" ? "invalid" : "valid",
  };
}

function applicationItem(candidate, { declared, isDefault }) {
  return {
    package_path: candidate.packagePath,
    app_id: candidate.record === "valid" && typeof candidate.app?.id === "string"
      ? candidate.app.id
      : null,
    declared,
    default: isDefault,
    record: candidate.record,
  };
}

function discoveredApplicationItems(candidates) {
  return candidates.map((candidate) => applicationItem(candidate, {
    declared: false,
    isDefault: false,
  }));
}

function declaredApplicationItem({ packagePath, isDefault, matches }) {
  const valid = matches.filter((candidate) => candidate.record === "valid");
  if (matches.length === 1 && valid.length === 1) {
    return applicationItem(valid[0], { declared: true, isDefault });
  }
  return {
    package_path: packagePath,
    app_id: null,
    declared: true,
    default: isDefault,
    record: matches.length === 0 ? "missing" : "invalid",
  };
}

function legacyOpenTarget(candidates) {
  const valid = candidates.filter(
    (candidate) => candidate.record === "valid" && typeof candidate.app?.id === "string",
  );
  if (valid.length === 0) return null;
  const ordered = [...valid].sort((left, right) => {
    const versionDifference = legacyAppTitleVersion(right.app) - legacyAppTitleVersion(left.app);
    return versionDifference || left.index - right.index;
  });
  return { appId: ordered[0].app.id, source: "legacy-fallback" };
}

function legacyAppTitleVersion(app) {
  const match = String(app?.title ?? "").match(/\sv(\d+)$/i);
  return match ? Number(match[1]) : -1;
}

function validateTcpPolicy(policy, label, issues) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    issues.push(`${label} musí být object`);
    return;
  }
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) issues.push(`${label}.${key} není povolené pole`);
  }
  if (!["single", "exception"].includes(policy.mode)) {
    issues.push(`${label}.mode musí být single nebo exception`);
  }
  if (policy.mode === "exception" && (typeof policy.reason !== "string" || policy.reason.trim().length < 20)) {
    issues.push(`${label}.reason musí u výjimky obsahovat konkrétní zdůvodnění`);
  }
  if (policy.mode === "single" && policy.reason !== undefined) {
    issues.push(`${label}.reason je povolené jen pro exception`);
  }
}

function validatePattern(value, pattern, label, issues) {
  if (typeof value !== "string" || !pattern.test(value)) issues.push(`${label} není validní`);
}
