#!/usr/bin/env bun

import { existsSync } from "fs";
import { readdir, rename, writeFile } from "fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { normalizeModuleManifest } from "../launchpad/src/module-contract-lib.mjs";
import {
  normalizePortRegistry,
  validateModuleLeasesAgainstRegistry,
} from "../launchpad/src/port-registry-lib.mjs";
import { validateDeclaredRuntime } from "../lazurio/core/runtime-contract-lib.mjs";
import { readAllModuleContracts } from "./lazurio-module-port.mjs";

const ignoredDirectories = new Set([
  ".git",
  ".worktrees",
  "archive",
  "build",
  ".build",
  "coverage",
  "data",
  "dist",
  "exports",
  "generated",
  "history",
  "node_modules",
  "personalspace",
  "snapshots",
  "test",
  "tests",
  "fixture",
  "fixtures",
  "__tests__",
  "test-data",
  "testdata",
]);

export function migrateLegacyRuntimePackage(packageJson, {
  packagePath = "package.json",
  registry = null,
} = {}) {
  if (packageJson?.lazurio?.runtime && packageJson?.companyascode?.app) {
    return blocked(packageJson, `${packagePath}: package deklaruje nový i legacy runtime`);
  }
  if (packageJson?.lazurio?.runtime) {
    return migrateInlineRuntimePackage(packageJson, { packagePath, registry });
  }
  const legacy = packageJson?.companyascode?.app;
  if (!legacy) return unchanged(packageJson);

  const scripts = packageJson.scripts ?? {};
  if (typeof scripts[legacy.dev_script] !== "string" || !scripts[legacy.dev_script].trim()) {
    return blocked(packageJson, `${packagePath}: legacy dev_script ${String(legacy.dev_script)} neexistuje nebo je prázdný`);
  }
  const devCommands = selectedScriptCommands(scripts, legacy.dev_script);
  const observedPorts = [...new Set(devCommands.flatMap(commandPorts))];
  if (observedPorts.length === 1 && observedPorts[0] !== legacy.port) {
    return blocked(
      packageJson,
      `${packagePath}: dev runtime používá port ${observedPorts[0]}, ale legacy manifest deklaruje ${String(legacy.port)}; migrace vyžaduje ruční sjednocení`,
    );
  }
  const usesSplitRuntime = observedPorts.length > 1
    || devCommands.some((command) =>
      /\b(?:concurrently|npm-run-all|run-p)\b/.test(command)
      || /(?:^|\s)&(?:\s|$)|(^|[^|])\|([^|]|$)|(?:^|\s);(?:\s|$)/.test(command)
    );
  if (usesSplitRuntime) {
    return blocked(
      packageJson,
      `${packagePath}: víceprocesový runtime${observedPorts.length > 0 ? ` (${observedPorts.join("/")})` : ""} vyžaduje ruční migraci všech listenerů a zapojení LAZURIO_RUNTIME_LISTENER_<ID>_PORT do každého serveru/proxy`,
    );
  }

  const {
    schema_version: _legacySchemaVersion,
    port,
    host,
    health_path: healthPath,
    ...metadata
  } = legacy;
  const next = structuredClone(packageJson);
  next.lazurio = {
    ...(next.lazurio ?? {}),
    runtime: {
      schema_version: "lazurio.runtime.v1",
      ...metadata,
      listeners: [{
        id: "app",
        role: "entrypoint",
        lease: "main",
        protocol: "http",
        health: { kind: "http", path: healthPath },
      }],
    },
  };
  const remainingLegacy = { ...(next.companyascode ?? {}) };
  delete remainingLegacy.app;
  if (Object.keys(remainingLegacy).length === 0) delete next.companyascode;
  else next.companyascode = remainingLegacy;
  return validateMigration({
    packageJson: next,
    original: packageJson,
    packagePath,
    moduleManifest: singleModuleManifest({
      company: legacy.company,
      module: legacy.module,
      host,
      port,
      packagePath,
    }),
    registry,
  });
}

export function migrateInlineRuntimePackage(packageJson, {
  packagePath = "package.json",
  registry = null,
} = {}) {
  const runtime = packageJson?.lazurio?.runtime;
  if (!runtime) return unchanged(packageJson);
  const listeners = Array.isArray(runtime.listeners) ? runtime.listeners : [];
  if (listeners.length === 0) return blocked(packageJson, `${packagePath}: lazurio.runtime.listeners je prázdné`);
  const alreadyReferencesLeases = listeners.every((listener) =>
    typeof listener?.lease === "string"
    && listener.allocation === undefined
    && listener.host === undefined
    && listener.port === undefined
    && listener.claim === undefined
  );
  if (alreadyReferencesLeases) return unchanged(packageJson);

  const issues = [];
  const seenPorts = new Set();
  const inlineLeases = listeners.map((listener, index) => {
    const label = `${packagePath}: lazurio.runtime.listeners[${index}]`;
    if (listener?.allocation !== "static") issues.push(`${label}.allocation musí být static pro bezpečnou migraci`);
    if (!["127.0.0.1", "localhost", "::1"].includes(listener?.host)) issues.push(`${label}.host musí být loopback`);
    if (!Number.isInteger(listener?.port) || listener.port < 1024 || listener.port > 65_535) {
      issues.push(`${label}.port musí být číslo 1024-65535`);
    } else if (seenPorts.has(listener.port)) {
      issues.push(`${label}.port ${listener.port} je duplicitní`);
    } else {
      seenPorts.add(listener.port);
    }
    return {
      id: listeners.length === 1 ? "main" : listener.id,
      host: listener.host === "localhost" ? "127.0.0.1" : listener.host,
      port: listener.port,
    };
  });
  if (issues.length > 0) return { changed: false, packageJson, moduleManifest: null, issues };

  const next = structuredClone(packageJson);
  next.lazurio.runtime.listeners = listeners.map((listener, index) => ({
    id: listener.id,
    role: listener.role,
    lease: inlineLeases[index].id,
    protocol: listener.protocol,
    health: listener.health,
  }));
  const moduleManifest = {
    schema_version: "lazurio.module.v1",
    id: runtime.module,
    company: runtime.company,
    tcp_port_policy: listeners.length === 1
      ? { mode: "single" }
      : {
          mode: "exception",
          reason: "Existing split TCP runtime retained during migration; consolidate behind one listener or local IPC in a follow-up.",
        },
    port_leases: inlineLeases,
    apps: [appPackagePathForModule(packagePath, runtime.module)],
    default_app: appPackagePathForModule(packagePath, runtime.module),
  };
  return validateMigration({ packageJson: next, original: packageJson, packagePath, moduleManifest, registry });
}

function validateMigration({ packageJson, original, packagePath, moduleManifest, registry = null }) {
  const runtimeIssues = validateDeclaredRuntime({ runtime: packageJson.lazurio.runtime, packageJson, packagePath });
  const moduleIssues = normalizeModuleManifest({
    manifest: moduleManifest,
    modulePath: `${moduleRootForPackage(packagePath, moduleManifest.id)}/lazurio.module.json`,
  }).issues;
  const registryIssues = registry
    ? validateModuleLeasesAgainstRegistry({
        modules: [{
          ...moduleManifest,
          module_path: `${moduleRootForPackage(packagePath, moduleManifest.id)}/lazurio.module.json`,
        }],
        registry,
      })
    : [];
  const issues = [...runtimeIssues, ...moduleIssues, ...registryIssues];
  if (issues.length > 0) {
    return {
      changed: false,
      packageJson: original,
      moduleManifest: null,
      issues: issues.map((issue) => `${packagePath}: migrace zablokována, ${issue}`),
    };
  }
  return { changed: true, packageJson, moduleManifest, issues: [] };
}

function singleModuleManifest({ company, module, host, port, packagePath }) {
  const appPackage = appPackagePathForModule(packagePath, module);
  return {
    schema_version: "lazurio.module.v1",
    id: module,
    company,
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: host === "localhost" ? "127.0.0.1" : host, port }],
    apps: [appPackage],
    default_app: appPackage,
  };
}

function appPackagePathForModule(packagePath, moduleId) {
  return relative(moduleRootForPackage(packagePath, moduleId), resolve(packagePath)).split(sep).join("/");
}

function unchanged(packageJson) {
  return { changed: false, packageJson, moduleManifest: null, issues: [] };
}

function blocked(packageJson, issue) {
  return { changed: false, packageJson, moduleManifest: null, issues: [issue] };
}

function selectedScriptCommands(scripts, entrypoint) {
  const commands = [];
  const visited = new Set();
  const visit = (name) => {
    if (visited.has(name) || typeof scripts?.[name] !== "string") return;
    visited.add(name);
    const command = scripts[name];
    commands.push(command);
    for (const match of command.matchAll(/\b(?:bun|npm|pnpm|yarn)\s+run\s+([A-Za-z0-9:_-]+)\b/g)) visit(match[1]);
  };
  visit(entrypoint);
  return commands;
}

function commandPorts(command) {
  const source = String(command ?? "");
  return [
    ...source.matchAll(/--port(?:=|\s+)(\d{4,5})\b/g),
    ...source.matchAll(/(?:^|\s)-p\s+(\d{4,5})\b/g),
    ...source.matchAll(/(?:^|\s)(?:PORT|[A-Za-z][A-Za-z0-9_]*_PORT)\s*=\s*(\d{4,5})\b/g),
  ].map((match) => Number(match[1]));
}

export async function packagePathsBelow(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "package.json") output.push(path);
    }
  }
  await walk(root);
  return output.sort();
}

export function moduleRootForPackage(packagePath, moduleId = null) {
  const absolute = resolve(packagePath);
  const packageDirectory = dirname(absolute);
  const parts = absolute.split(sep);
  const organizationsIndex = parts.findLastIndex((part, index) =>
    part === "organizations"
    && ["workspace", "modules"].includes(parts[index + 2])
    && index + 3 < parts.length - 1
  );
  if (organizationsIndex >= 0) {
    const moduleRoot = parts.slice(0, organizationsIndex + 4).join(sep) || sep;
    return moduleRoot;
  }
  // A module may itself be named `app`. In that case a root package belongs
  // beside its lazurio.module.json and must not be mistaken for <module>/app.
  // A standalone double `app/app/package.json` keeps the outer matching root;
  // canonical Organization paths above are authoritative when available.
  if (moduleId && basename(packageDirectory) === moduleId) {
    const parent = dirname(packageDirectory);
    return moduleId === "app" && basename(parent) === moduleId ? parent : packageDirectory;
  }
  const appIndex = parts.findLastIndex((part, index) =>
    part === "app"
    && (index === parts.length - 2 || /^v\d+$/.test(parts[index + 1] ?? ""))
  );
  if (appIndex > 0) {
    const candidate = parts.slice(0, appIndex).join(sep) || sep;
    return candidate;
  }
  return packageDirectory;
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function rewriteRuntimeScriptsFromModule(packageJson, moduleManifest) {
  const runtime = packageJson?.lazurio?.runtime;
  if (!runtime || !moduleManifest || !packageJson?.scripts) return { changed: false, packageJson };
  const leases = new Map((moduleManifest.port_leases ?? []).map((lease) => [lease.id, lease]));
  const replacements = [];
  for (const listener of runtime.listeners ?? []) {
    const lease = leases.get(listener.lease);
    if (!Number.isInteger(lease?.port)) continue;
    const env = listener.role === "entrypoint"
      ? "$PORT"
      : `$LAZURIO_RUNTIME_LISTENER_${String(listener.id).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PORT`;
    replacements.push([lease.port, env]);
  }
  const next = structuredClone(packageJson);
  let changed = false;
  for (const [name, command] of Object.entries(next.scripts)) {
    if (typeof command !== "string") continue;
    let rewritten = command;
    for (const [port, env] of replacements) {
      rewritten = rewritten.replace(
        new RegExp(`(--port(?:=|\\s+))(?:\")?${port}(?:\")?`, "g"),
        `$1\"${env}\"`,
      );
      rewritten = rewritten.replace(
        new RegExp(`((?:^|\\s)(?:PORT|[A-Za-z][A-Za-z0-9_]*_PORT)=)(?:\")?${port}(?:\")?`, "g"),
        `$1\"${env}\"`,
      );
    }
    if (rewritten !== command) {
      next.scripts[name] = rewritten;
      changed = true;
    }
  }
  return { changed, packageJson: next };
}

async function main(argv) {
  const write = argv.includes("--write");
  const rootFlagIndex = argv.indexOf("--conglomerate-root");
  const explicitConglomerateRoot = rootFlagIndex >= 0 ? argv[rootFlagIndex + 1] : null;
  const roots = argv
    .filter((argument, index) =>
      argument !== "--write"
      && argument !== "--conglomerate-root"
      && index !== rootFlagIndex + 1
    )
    .map((argument) => resolve(argument));
  if (roots.length === 0) {
    console.error("Usage: bun scripts/lazurio-runtime-migrate.mjs [--write] <package.json|directory> [...]");
    process.exitCode = 2;
    return;
  }
  const paths = [];
  const conglomerateRoot = resolve(explicitConglomerateRoot ?? resolve(import.meta.dirname, ".."));
  if (!existsSync(join(conglomerateRoot, "organizations"))) {
    console.error(`${conglomerateRoot} není primární Conglomerate root: chybí organizations/; předej --conglomerate-root`);
    process.exitCode = 2;
    return;
  }
  const registryResult = normalizePortRegistry(
    await Bun.file(join(conglomerateRoot, "lazurio.port-registry.json")).json(),
  );
  if (!registryResult.registry || registryResult.issues.length > 0) {
    console.error(`Centrální port registry je nevalidní:\n${registryResult.issues.join("\n")}`);
    process.exitCode = 2;
    return;
  }
  for (const root of roots) {
    if (!existsSync(root)) {
      console.error(`missing: ${root}`);
      process.exitCode = 2;
      continue;
    }
    if (root.endsWith("package.json")) paths.push(root);
    else paths.push(...await packagePathsBelow(root));
  }

  let pending = 0;
  let blockedCount = 0;
  const modules = new Map();
  const packageWrites = [];
  for (const packagePath of [...new Set(paths)].sort()) {
    let packageJson;
    try {
      packageJson = await Bun.file(packagePath).json();
    } catch (error) {
      console.warn(`warning: ${packagePath}: package.json nejde přečíst: ${error.message}`);
      blockedCount += 1;
      continue;
    }
    const result = migrateLegacyRuntimePackage(packageJson, {
      packagePath,
      registry: registryResult.registry,
    });
    if (!result.changed && result.issues.length > 0) blockedCount += 1;
    let moduleManifest = result.moduleManifest;
    let candidatePackageJson = result.packageJson;
    const runtime = candidatePackageJson?.lazurio?.runtime;
    if (!moduleManifest && runtime) {
      const existingModulePath = join(moduleRootForPackage(packagePath, runtime.module), "lazurio.module.json");
      if (existsSync(existingModulePath)) {
        try {
          moduleManifest = await Bun.file(existingModulePath).json();
        } catch (error) {
          console.warn(`warning: ${existingModulePath}: lazurio.module.json nejde přečíst: ${error.message}`);
          blockedCount += 1;
          continue;
        }
      }
    }
    const scriptsRewrite = rewriteRuntimeScriptsFromModule(candidatePackageJson, moduleManifest);
    candidatePackageJson = scriptsRewrite.packageJson;
    if (result.changed || scriptsRewrite.changed) {
      const moduleRoot = moduleRootForPackage(packagePath, moduleManifest.id);
      const modulePath = join(moduleRoot, "lazurio.module.json");
      const existing = modules.get(modulePath);
      if (existing && !sameJson(existing, moduleManifest)) {
        result.issues.push(`${packagePath}: verze modulu driftuje proti ${relative(process.cwd(), modulePath)}; port leases se liší`);
        blockedCount += 1;
      } else {
        modules.set(modulePath, moduleManifest);
        packageWrites.push([packagePath, candidatePackageJson]);
        pending += 1;
      }
    }
    for (const issue of result.issues) console.warn(`warning: ${issue}`);
  }

  if (blockedCount === 0) {
    for (const [modulePath, manifest] of modules) {
      if (existsSync(modulePath)) {
        const current = await Bun.file(modulePath).json();
        if (!sameJson(current, manifest)) {
          console.warn(`warning: ${modulePath}: existující lazurio.module.json driftuje proti migrovaným app verzím`);
          blockedCount += 1;
        }
      }
    }
  }
  if (blockedCount === 0 && modules.size > 0) {
    const candidates = [];
    for (const [modulePath, manifest] of modules) {
      const normalized = normalizeModuleManifest({ manifest, modulePath });
      if (normalized.module) candidates.push(normalized.module);
    }
    const registryIssues = validateModuleLeasesAgainstRegistry({
      modules: [...await readAllModuleContracts(conglomerateRoot), ...candidates],
      registry: registryResult.registry,
    });
    if (registryIssues.length > 0) {
      for (const issue of registryIssues) console.warn(`warning: ${issue}`);
      blockedCount += registryIssues.length;
    }
  }
  if (blockedCount === 0) {
    for (const [modulePath, manifest] of modules) {
      if (write) await atomicJsonWrite(modulePath, manifest);
      console.log(`${write ? "wrote" : "would write"}: ${modulePath}`);
    }
    for (const [packagePath, packageJson] of packageWrites) {
      if (write) await atomicJsonWrite(packagePath, packageJson);
      console.log(`${write ? "migrated" : "would migrate"}: ${packagePath}`);
    }
  }
  console.log(`lazurio module/runtime migration: ${pending} ${write ? "migrated" : "pending"}, ${blockedCount} blocked`);
  if (!write && pending > 0) process.exitCode = 1;
  if (blockedCount > 0) process.exitCode = 2;
}

async function atomicJsonWrite(path, value) {
  const temporary = `${path}.lazurio-migrate-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

if (import.meta.main) await main(process.argv.slice(2));
