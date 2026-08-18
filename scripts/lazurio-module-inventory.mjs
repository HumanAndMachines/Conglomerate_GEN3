#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { normalizeModuleManifest } from "../lazurio/core/module-contract-lib.mjs";
import {
  normalizeOrganizationSlotPath,
  organizationSlotScope,
} from "../lazurio/core/organization-slot-scope-lib.mjs";
import { packagePathsBelow } from "./lazurio-runtime-migrate.mjs";

function posixRelative(parent, child) {
  return relative(parent, child).split(sep).join("/");
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function moduleExclusionReason(slot) {
  const path = normalizeOrganizationSlotPath(slot?.path) ?? "";
  const scope = organizationSlotScope(slot, path);
  if (scope === "productionspace") return "productionspace";
  if (scope !== "workspace" || !(path.startsWith("workspace/") || path.startsWith("modules/"))) {
    return "not-workspace-module";
  }
  const classification = String(slot?.classification ?? "").toLowerCase();
  const materialization = String(slot?.materialization ?? "").toLowerCase();
  const nestedPath = path.split("/").length > 2;
  if (
    nestedPath
    || classification.includes("repository-db-data")
    || classification.includes("repository_db_data")
    || materialization.startsWith("repository_db_mount")
  ) {
    return "nested-db";
  }
  if (slot?.status === "planned_slot" || !slotRepository(slot)) return "planned-slot";
  return null;
}

function slotRepository(slot) {
  for (const candidate of [slot?.git?.url, slot?.repo, slot?.repository]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

async function declaredModuleSlots(organizationRoot, companyManifest) {
  let manifestPath = null;
  for (const candidate of ["modules.manifest.json", "company/scripts/modules.manifest.json"]) {
    const path = join(organizationRoot, candidate);
    if (existsSync(path)) {
      manifestPath = path;
      break;
    }
  }

  const canonicalManifest = manifestPath ? await Bun.file(manifestPath).json() : null;
  const declarations = new Map();
  for (const slot of canonicalManifest?.module_slots ?? []) {
    const path = normalizeOrganizationSlotPath(slot?.path);
    if (!path) continue;
    declarations.set(path, {
      slot: { ...slot, path },
      declaration_source: posixRelative(organizationRoot, manifestPath),
    });
  }

  // Transitional compatibility only: canonical module_slots owns every path it
  // declares; company.gen3.json#modules may fill paths not migrated yet.
  for (const slot of companyManifest?.modules ?? []) {
    const path = normalizeOrganizationSlotPath(slot?.path);
    if (!path || declarations.has(path)) continue;
    declarations.set(path, {
      slot: { ...slot, path },
      declaration_source: "company.gen3.json#modules",
    });
  }
  return [...declarations.values()];
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
    for (const { slot, declaration_source } of await declaredModuleSlots(organizationRoot, companyManifest)) {
      const reason = moduleExclusionReason(slot);
      const record = {
        organization: entry.name,
        company,
        module: slot?.slug ?? basename(slot.path),
        path: slot?.path ?? null,
        repository: slotRepository(slot),
        classification: slot?.classification ?? null,
        materialization: slot?.materialization ?? null,
        declaration_source,
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
