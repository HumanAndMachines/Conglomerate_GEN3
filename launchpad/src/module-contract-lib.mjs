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
  return {
    module: {
      schema_version: manifest?.schema_version ?? null,
      id: manifest?.id ?? null,
      company: manifest?.company ?? null,
      tcp_port_policy: manifest?.tcp_port_policy ?? null,
      port_leases: leases,
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

export function materializeRuntimeFromModule({
  runtime,
  module,
  packagePath = "package.json",
}) {
  const issues = [];
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
