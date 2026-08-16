#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { normalizeModuleManifest } from "../launchpad/src/module-contract-lib.mjs";
import { packagePathsBelow } from "./lazurio-runtime-migrate.mjs";

function posixRelative(parent, child) {
  return relative(parent, child).split(sep).join("/");
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function moduleExclusionReason(slot) {
  const path = typeof slot?.path === "string" ? slot.path : "";
  if (path.startsWith("productionspace/")) return "productionspace";
  if (!(path.startsWith("workspace/") || path.startsWith("modules/"))) return "not-workspace-module";
  if (String(slot?.classification ?? "").includes("repository-db-data")) return "nested-db";
  if (typeof slot?.repo !== "string" || slot.repo.trim() === "") return "planned-slot";
  return null;
}

function numericPorts(command) {
  const source = String(command ?? "");
  return [
    ...source.matchAll(/--port(?:=|\s+)["']?(\d{4,5})\b/g),
    ...source.matchAll(/(?:^|\s)-p\s+["']?(\d{4,5})\b/g),
    ...source.matchAll(/(?:^|\s)(?:PORT|[A-Za-z][A-Za-z0-9_]*_PORT)\s*=\s*["']?(\d{4,5})\b/g),
  ].map((match) => Number(match[1]));
}

function proposedDefaultApp(paths) {
  if (paths.length === 0) return null;
  if (paths.length === 1) return paths[0];
  const versioned = paths
    .map((path) => ({ path, version: Number(path.match(/^app\/v(\d+)\/package\.json$/)?.[1] ?? -1) }))
    .filter((entry) => entry.version >= 0)
    .sort((left, right) => right.version - left.version);
  if (versioned.length > 0) return versioned[0].path;
  return paths.includes("app/package.json") ? "app/package.json" : null;
}

async function packageCensus(moduleRoot) {
  const packages = [];
  for (const packagePath of await packagePathsBelow(moduleRoot)) {
    let packageJson;
    try {
      packageJson = await Bun.file(packagePath).json();
    } catch (error) {
      packages.push({
        path: posixRelative(moduleRoot, packagePath),
        declaration: "invalid-package-json",
        issues: [error.message],
        port_candidates: [],
      });
      continue;
    }
    const runtime = packageJson?.lazurio?.runtime;
    const legacy = packageJson?.companyascode?.app;
    const relativePath = posixRelative(moduleRoot, packagePath);
    const appShaped = /^(?:app(?:\/v\d+)?|editor(?:\/v\d+)?)\/package\.json$/.test(relativePath);
    if (!runtime && !legacy && !(appShaped && typeof packageJson?.scripts?.dev === "string")) continue;
    const commands = Object.values(packageJson?.scripts ?? {}).filter((command) => typeof command === "string");
    const ports = new Set(commands.flatMap(numericPorts));
    if (Number.isInteger(legacy?.port)) ports.add(legacy.port);
    packages.push({
      path: relativePath,
      declaration: runtime ? "lazurio.runtime" : legacy ? "companyascode.app" : "runnable-undeclared",
      id: runtime?.id ?? legacy?.id ?? null,
      module: runtime?.module ?? legacy?.module ?? null,
      port_candidates: [...ports].sort((left, right) => left - right),
    });
  }
  return packages.sort((left, right) => left.path.localeCompare(right.path));
}

export async function inventoryLazurioModules(conglomerateRoot, { organization = null } = {}) {
  const root = resolve(conglomerateRoot);
  const organizationsRoot = join(root, "organizations");
  const modules = [];
  const excluded = [];
  for (const entry of await readdir(organizationsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const organizationRoot = join(organizationsRoot, entry.name);
    const companyPath = join(organizationRoot, "company.gen3.json");
    if (!existsSync(companyPath)) continue;
    const companyManifest = await Bun.file(companyPath).json();
    const company = companyManifest?.company?.slug;
    if (organization && ![entry.name, company].includes(organization)) continue;
    for (const slot of companyManifest?.modules ?? []) {
      const reason = moduleExclusionReason(slot);
      const record = {
        organization: entry.name,
        company,
        module: slot?.slug ?? null,
        path: slot?.path ?? null,
        repository: slot?.repo ?? null,
        classification: slot?.classification ?? null,
      };
      if (reason) {
        excluded.push({ ...record, reason });
        continue;
      }
      const moduleRoot = join(organizationRoot, slot.path);
      const materialized = existsSync(moduleRoot) && existsSync(join(moduleRoot, ".git"));
      const manifestPath = join(moduleRoot, "lazurio.module.json");
      let contract = { state: "missing", issues: [], apps: null, default_app: null, leases: [] };
      if (materialized && existsSync(manifestPath)) {
        try {
          const normalized = normalizeModuleManifest({
            manifest: await Bun.file(manifestPath).json(),
            modulePath: posixRelative(root, manifestPath),
          });
          contract = {
            state: normalized.issues.length > 0
              ? "invalid"
              : normalized.module.app_declaration_state === "explicit"
                ? "explicit"
                : "legacy-missing-apps",
            issues: normalized.issues,
            apps: normalized.module.apps,
            default_app: normalized.module.default_app,
            leases: normalized.module.port_leases,
          };
        } catch (error) {
          contract = { ...contract, state: "invalid", issues: [error.message] };
        }
      }
      const packages = materialized ? await packageCensus(moduleRoot) : [];
      const proposedApps = packages
        .filter((item) => item.declaration !== "invalid-package-json")
        .map((item) => item.path);
      modules.push({
        ...record,
        materialized,
        contract,
        packages,
        proposal: {
          apps: proposedApps,
          default_app: proposedDefaultApp(proposedApps),
          needs_default_review: proposedApps.length > 0 && proposedDefaultApp(proposedApps) === null,
          port_candidates: [...new Set(packages.flatMap((item) => item.port_candidates))].sort((left, right) => left - right),
        },
      });
    }
  }
  const materialized = modules.filter((module) => module.materialized);
  return {
    schema_version: "lazurio.module_inventory.v1",
    root,
    summary: {
      declared_modules: modules.length,
      materialized_modules: materialized.length,
      missing_module_contracts: materialized.filter((module) => module.contract.state === "missing").length,
      legacy_contracts_missing_apps: materialized.filter((module) => module.contract.state === "legacy-missing-apps").length,
      explicit_contracts: materialized.filter((module) => module.contract.state === "explicit").length,
      modules_without_apps: materialized.filter((module) => module.proposal.apps.length === 0).length,
      legacy_app_packages: materialized.flatMap((module) => module.packages).filter((item) => item.declaration === "companyascode.app").length,
      runnable_undeclared_packages: materialized.flatMap((module) => module.packages).filter((item) => item.declaration === "runnable-undeclared").length,
      excluded_slots: excluded.length,
    },
    modules,
    excluded,
  };
}

async function main(argv) {
  const root = resolve(argumentValue(argv, "--root") ?? resolve(import.meta.dirname, ".."));
  const organization = argumentValue(argv, "--organization");
  if (!existsSync(join(root, "organizations"))) {
    console.error(`${root} není Lazurio Root: chybí organizations/`);
    process.exitCode = 2;
    return;
  }
  const inventory = await inventoryLazurioModules(root, { organization });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }
  const summary = inventory.summary;
  console.log(`Lazurio Module inventory: ${summary.materialized_modules}/${summary.declared_modules} materialized`);
  console.log(`contracts: ${summary.explicit_contracts} explicit, ${summary.legacy_contracts_missing_apps} legacy, ${summary.missing_module_contracts} missing`);
  console.log(`apps: ${summary.legacy_app_packages} legacy, ${summary.runnable_undeclared_packages} runnable undeclared, ${summary.modules_without_apps} modules with apps: [] proposal`);
  console.log(`excluded: ${summary.excluded_slots} non-Module slots`);
  for (const module of inventory.modules.filter((item) => item.materialized)) {
    const appState = module.proposal.apps.length === 0 ? "apps:[]" : `${module.proposal.apps.length} app(s)`;
    console.log(`${module.company}/${module.module}\t${module.contract.state}\t${appState}\t${module.path}`);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
