#!/usr/bin/env bun

import { existsSync } from "fs";
import { readdir, writeFile } from "fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { acquireModuleRuntimeLock } from "../launchpad/src/module-runtime-lock-lib.mjs";
import { normalizeModuleManifest } from "../lazurio/core/module-contract-lib.mjs";
import {
  nextFreeModulePort,
  normalizePortRegistry,
  validateModuleLeasesAgainstRegistry,
} from "../launchpad/src/port-registry-lib.mjs";

const ignored = new Set([".git", ".worktrees", "personalspace", "node_modules", "dist", "build", ".next", "coverage", "generated"]);

export async function allocateModulePort({ conglomerateRoot, moduleRoot, company, module }) {
  const root = resolve(conglomerateRoot);
  const targetRoot = resolve(moduleRoot);
  if (!existsSync(join(root, "organizations"))) {
    throw new Error(`${root} není primární Lazurio root: chybí organizations/; předej explicitní --conglomerate-root`);
  }
  const declaredRoots = await declaredModuleRoots(root);
  if (!declaredRoots.has(targetRoot)) {
    throw new Error(`${targetRoot} není modul deklarovaný v primárním Lazurio rootu; creator nesmí alokovat lease do worktree ani nedeklarovaného slotu`);
  }
  const target = join(targetRoot, "lazurio.module.json");
  if (existsSync(target)) throw new Error(`${target} už existuje; přidělený module lease se automaticky nepřepisuje`);

  const registryResult = normalizePortRegistry(
    await Bun.file(join(root, "lazurio.port-registry.json")).json(),
  );
  if (!registryResult.registry || registryResult.issues.length > 0) {
    throw new Error(`Centrální port registry je nevalidní:\n${registryResult.issues.join("\n")}`);
  }
  const lock = await acquireModuleRuntimeLock({
    root: join(root, "launchpad", "runtime", "creator-locks"),
    key: `port-registry/${company}`,
    instanceId: `creator-${process.pid}`,
  });
  try {
    const modules = await readAllModuleContracts(root);
    const existingIssues = validateModuleLeasesAgainstRegistry({ modules, registry: registryResult.registry });
    if (existingIssues.length > 0) {
      throw new Error(`Port nelze přidělit nad nevalidním registry stavem:\n${existingIssues.join("\n")}`);
    }
    const port = nextFreeModulePort({ registry: registryResult.registry, company, modules });
    const manifest = {
      schema_version: "lazurio.module.v1",
      id: module,
      company,
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port }],
    };
    const normalized = normalizeModuleManifest({ manifest, modulePath: target });
    if (normalized.issues.length > 0) throw new Error(normalized.issues.join("\n"));
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { manifest, target };
  } finally {
    await lock.release();
  }
}

export async function readAllModuleContracts(conglomerateRoot) {
  const root = resolve(conglomerateRoot);
  const modules = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || ignored.has(entry.name) || entry.name === "organizations") continue;
    const modulePath = join(root, entry.name, "lazurio.module.json");
    if (!existsSync(modulePath)) continue;
    const normalized = normalizeModuleManifest({
      manifest: await Bun.file(modulePath).json(),
      modulePath,
    });
    if (normalized.issues.length > 0) throw new Error(normalized.issues.join("\n"));
    modules.push(normalized.module);
  }

  const organizationsRoot = join(root, "organizations");
  for (const entry of await readdir(organizationsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || ignored.has(entry.name)) continue;
    const organizationRoot = join(organizationsRoot, entry.name);
    const paths = new Set();
    for (const [manifestName, collection] of [
      ["modules.manifest.json", "module_slots"],
      ["company.gen3.json", "layers"],
      ["company.gen3.json", "modules"],
    ]) {
      const manifestPath = join(organizationRoot, manifestName);
      if (!existsSync(manifestPath)) continue;
      const manifest = await Bun.file(manifestPath).json();
      for (const candidate of manifest?.[collection] ?? []) {
        if (canonicalModulePath(candidate?.path, organizationRoot)) paths.add(candidate.path);
      }
    }
    for (const modulePath of paths) {
      const path = join(organizationRoot, modulePath, "lazurio.module.json");
      if (!existsSync(path)) continue;
      const normalized = normalizeModuleManifest({
        manifest: await Bun.file(path).json(),
        modulePath: path,
      });
      if (normalized.issues.length > 0) throw new Error(normalized.issues.join("\n"));
      modules.push(normalized.module);
    }
  }
  return modules;
}

async function declaredModuleRoots(root) {
  const roots = new Set();
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !ignored.has(entry.name) && entry.name !== "organizations") {
      roots.add(resolve(root, entry.name));
    }
  }
  const organizationsRoot = join(root, "organizations");
  for (const entry of await readdir(organizationsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || ignored.has(entry.name)) continue;
    const organizationRoot = join(organizationsRoot, entry.name);
    for (const [manifestName, collection] of [
      ["modules.manifest.json", "module_slots"],
      ["company.gen3.json", "layers"],
      ["company.gen3.json", "modules"],
    ]) {
      const manifestPath = join(organizationRoot, manifestName);
      if (!existsSync(manifestPath)) continue;
      const manifest = await Bun.file(manifestPath).json();
      for (const candidate of manifest?.[collection] ?? []) {
        if (canonicalModulePath(candidate?.path, organizationRoot)) {
          roots.add(resolve(organizationRoot, candidate.path));
        }
      }
    }
  }
  return roots;
}

function canonicalModulePath(path, organizationRoot) {
  if (typeof path !== "string" || path === "" || isAbsolute(path)) return false;
  const target = resolve(organizationRoot, path);
  const withinOrganization = relative(organizationRoot, target);
  return withinOrganization !== ""
    && !withinOrganization.startsWith(`..${sep}`)
    && withinOrganization !== ".."
    && !isAbsolute(withinOrganization)
    && !withinOrganization.split(sep).some((segment) => ignored.has(segment));
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

async function main(argv) {
  if (argv[0] !== "allocate") {
    console.error("Usage: bun scripts/lazurio-module-port.mjs allocate --company <slug> --module <id> --module-root <path> [--conglomerate-root <path>]");
    process.exitCode = 2;
    return;
  }
  const company = argumentValue(argv, "--company");
  const module = argumentValue(argv, "--module");
  const moduleRoot = argumentValue(argv, "--module-root");
  const conglomerateRoot = argumentValue(argv, "--conglomerate-root") ?? resolve(import.meta.dirname, "..");
  if (!company || !module || !moduleRoot) {
    console.error("--company, --module and --module-root are required");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await allocateModulePort({ conglomerateRoot, moduleRoot, company, module });
    console.log(`allocated ${company}/${module} -> ${result.manifest.port_leases[0].port}`);
    console.log(result.target);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
