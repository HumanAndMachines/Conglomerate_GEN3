const APP_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const MODULE_ID = /^[a-z0-9][a-z0-9-]*$/;
const LISTENER_ID = /^[a-z][a-z0-9-]*$/;
const SURFACES = new Set(["internal", "manual", "admin", "public-preview"]);
const PROTOCOLS = new Set(["http", "https", "tcp"]);
const RUNTIME_KEYS = new Set([
  "schema_version",
  "id",
  "title",
  "company",
  "module",
  "surface",
  "dev_script",
  "preview_script",
  "build_script",
  "plugin",
  "icon",
  "description",
  "group",
  "production_url",
  "tags",
  "listeners",
]);
const LISTENER_KEYS = new Set([
  "id",
  "role",
  "lease",
  "protocol",
  "health",
]);

export function normalizePackageRuntime({ packageJson, packagePath = "package.json" }) {
  const declared = packageJson?.lazurio?.runtime;
  const legacy = packageJson?.companyascode?.app;
  if (!declared && !legacy) return null;
  if (declared && legacy) {
    return {
      app: partialRuntimeApp(declared, "lazurio.runtime.v1"),
      issues: [`${packagePath}: package nesmí současně deklarovat lazurio.runtime a legacy companyascode.app`],
      warnings: [],
    };
  }
  if (declared) return normalizeDeclaredRuntime({ runtime: declared, packageJson, packagePath });
  return {
    app: normalizeLegacyApp(legacy),
    issues: [],
    warnings: [],
  };
}

export function normalizeLegacyApp(app) {
  const listener = {
    id: "entrypoint",
    role: "entrypoint",
    allocation: "static",
    host: app?.host,
    port: app?.port,
    protocol: "http",
    health: { kind: "http", path: app?.health_path },
    claim: { mode: "exclusive" },
  };
  return {
    ...app,
    listeners: [listener],
    entrypoint_listener: listener,
    runtime_contract: {
      schema_version: "companyascode.launchpad_app.v1",
      source: "companyascode.app",
      legacy: true,
      auxiliary_listeners_known: false,
      listeners: [listener],
    },
  };
}

export function normalizeDeclaredRuntime({ runtime, packageJson, packagePath = "package.json" }) {
  const issues = validateDeclaredRuntime({ runtime, packageJson, packagePath });
  const listeners = Array.isArray(runtime?.listeners)
    ? runtime.listeners.map((listener) => structuredClone(listener))
    : [];
  const entrypoint = listeners.find((listener) => listener?.role === "entrypoint") ?? null;
  return {
    app: {
      ...runtime,
      port: null,
      host: null,
      health_path: entrypoint?.health?.kind === "http" ? entrypoint.health.path : "/",
      listeners,
      entrypoint_listener: entrypoint,
      runtime_contract: {
        schema_version: runtime?.schema_version ?? null,
        source: "lazurio.runtime",
        legacy: false,
        auxiliary_listeners_known: true,
        module_lease_source: null,
        listeners,
      },
    },
    issues,
    warnings: [],
  };
}

export function validateDeclaredRuntime({ runtime, packageJson, packagePath = "package.json" }) {
  const issues = [];
  const label = `${packagePath}: lazurio.runtime`;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    return [`${label} musí být object`];
  }
  for (const key of Object.keys(runtime)) {
    if (!RUNTIME_KEYS.has(key)) issues.push(`${label}.${key} není povolené pole`);
  }
  for (const key of ["schema_version", "id", "title", "company", "module", "surface", "dev_script", "tags", "listeners"]) {
    if (runtime[key] === undefined) issues.push(`${label}.${key} chybí`);
  }
  if (runtime.schema_version !== "lazurio.runtime.v1") {
    issues.push(`${label}.schema_version musí být lazurio.runtime.v1`);
  }
  validatePattern(runtime.id, APP_ID, `${label}.id`, issues);
  validateNonEmpty(runtime.title, `${label}.title`, issues);
  validatePattern(runtime.company, COMPANY_ID, `${label}.company`, issues);
  validatePattern(runtime.module, MODULE_ID, `${label}.module`, issues);
  if (!SURFACES.has(runtime.surface)) issues.push(`${label}.surface není podporovaný`);
  for (const key of ["dev_script", "preview_script", "build_script"]) {
    if (runtime[key] === undefined) continue;
    validateNonEmpty(runtime[key], `${label}.${key}`, issues);
    if (typeof runtime[key] === "string" && !packageJson?.scripts?.[runtime[key]]) {
      issues.push(`${label}.${key} ${runtime[key]} neexistuje v scripts`);
    }
    if (typeof runtime[key] === "string") {
      validateInjectedScript(
        packageJson?.scripts?.[runtime[key]],
        `${label}.${key}`,
        issues,
      );
    }
  }
  if (runtime.plugin !== undefined) {
    validateNonEmpty(runtime.plugin, `${label}.plugin`, issues);
    if (typeof runtime.plugin === "string" && !runtime.plugin.endsWith(".json")) {
      issues.push(`${label}.plugin musí končit .json`);
    }
  }
  if (!Array.isArray(runtime.tags)) issues.push(`${label}.tags musí být pole`);
  else runtime.tags.forEach((tag, index) => validatePattern(tag, MODULE_ID, `${label}.tags[${index}]`, issues));
  if (!Array.isArray(runtime.listeners) || runtime.listeners.length === 0) {
    issues.push(`${label}.listeners musí být neprázdné pole`);
    return issues;
  }
  const entrypoints = runtime.listeners.filter((listener) => listener?.role === "entrypoint");
  if (entrypoints.length !== 1) issues.push(`${label}.listeners musí obsahovat právě jeden entrypoint`);
  const listenerIds = new Set();
  runtime.listeners.forEach((listener, index) => {
    const listenerLabel = `${label}.listeners[${index}]`;
    validateListener(listener, listenerLabel, issues);
    if (typeof listener?.id === "string") {
      if (listenerIds.has(listener.id)) issues.push(`${listenerLabel}.id ${listener.id} je duplicitní`);
      listenerIds.add(listener.id);
    }
  });
  const entrypoint = entrypoints[0];
  if (entrypoint && !["http", "https"].includes(entrypoint.protocol)) {
    issues.push(`${label}.listeners entrypoint musí používat http nebo https`);
  }
  return issues;
}

function validateInjectedScript(command, label, issues) {
  if (typeof command !== "string") return;
  for (const variable of ["HOST", "PORT"]) {
    if (
      command.includes(`$${variable}`) &&
      !command.includes(`process.env.${variable}`)
    ) {
      issues.push(
        `${label} používá $${variable} bez přenositelné fail-closed kontroly process.env.${variable}`,
      );
    }
  }
}

function validateListener(listener, label, issues) {
  if (!listener || typeof listener !== "object" || Array.isArray(listener)) {
    issues.push(`${label} musí být object`);
    return;
  }
  for (const key of Object.keys(listener)) {
    if (!LISTENER_KEYS.has(key)) issues.push(`${label}.${key} není povolené pole`);
  }
  for (const key of ["id", "role", "lease", "protocol", "health"]) {
    if (listener[key] === undefined) issues.push(`${label}.${key} chybí`);
  }
  validatePattern(listener.id, LISTENER_ID, `${label}.id`, issues);
  validatePattern(listener.lease, LISTENER_ID, `${label}.lease`, issues);
  if (!["entrypoint", "auxiliary"].includes(listener.role)) issues.push(`${label}.role není podporovaný`);
  if (!PROTOCOLS.has(listener.protocol)) issues.push(`${label}.protocol není podporovaný`);
  validateHealth(listener.health, listener.protocol, `${label}.health`, issues);
}

function validateHealth(health, protocol, label, issues) {
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    issues.push(`${label} musí být object`);
    return;
  }
  if (!["http", "tcp"].includes(health.kind)) issues.push(`${label}.kind musí být http nebo tcp`);
  if (health.kind === "http") {
    if (!/^(http|https)$/.test(protocol)) issues.push(`${label}.kind http vyžaduje http(s) protocol`);
    if (typeof health.path !== "string" || !health.path.startsWith("/")) {
      issues.push(`${label}.path musí začínat /`);
    }
    for (const key of Object.keys(health)) if (!["kind", "path"].includes(key)) issues.push(`${label}.${key} není povolené pole`);
  } else {
    for (const key of Object.keys(health)) if (key !== "kind") issues.push(`${label}.${key} není povolené pole`);
  }
}

function partialRuntimeApp(runtime, schemaVersion) {
  const entrypoint = Array.isArray(runtime?.listeners)
    ? runtime.listeners.find((listener) => listener?.role === "entrypoint")
    : null;
  return {
    ...runtime,
    schema_version: schemaVersion,
    port: null,
    host: null,
    health_path: entrypoint?.health?.path ?? null,
    listeners: Array.isArray(runtime?.listeners) ? runtime.listeners : [],
  };
}

function validatePattern(value, pattern, label, issues) {
  if (typeof value !== "string" || !pattern.test(value)) issues.push(`${label} není validní`);
}

function validateNonEmpty(value, label, issues) {
  if (typeof value !== "string" || value.trim() === "") issues.push(`${label} musí být neprázdný string`);
}
