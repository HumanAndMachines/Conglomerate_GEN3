#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LEDGERS = [
  ["TODO.tasks.json", "todo-tasks-json", "tasks"],
  ["DONE.tasks.json", "done-tasks-json", "tasks"],
  ["ISSUES.open.json", "open-issues-json", "issues"],
];

const RETIRED_ROOT_FILES = [
  ".github/workflows/mission-control-parity.yml",
  ".github/workflows/mission-control-data-sync.yml",
  "scripts/mission-control-ci-checkout.mjs",
  "scripts/mission-control-ci-checkout.test.mjs",
  "scripts/mission-control-ledger-mirror.mjs",
];

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function slotsOf(manifest) {
  if (Array.isArray(manifest?.modules)) return manifest.modules;
  if (Array.isArray(manifest?.module_slots)) return manifest.module_slots;
  return [];
}

function normalizedSlotStatus(slot) {
  const explicit = String(slot?.status ?? "").toLowerCase();
  if (["planned", "planned_slot"].includes(explicit)) return "planned";
  if (explicit === "active") return "active";
  const materialization = String(slot?.materialization ?? "").toLowerCase();
  return materialization.includes("planned") ? "planned" : "active";
}

export function classifyDataState(slot, repositoryExists) {
  if (!slot) return repositoryExists ? "incomplete" : "missing-slot";
  const declared = normalizedSlotStatus(slot);
  if (declared === "active") return repositoryExists ? "active" : "incomplete";
  return repositoryExists ? "staged" : "planned";
}

export function evaluateProtection(response) {
  if (response.kind === "unsupported") {
    return { mode: "trusted-process", ok: true, problems: [] };
  }
  if (response.kind === "blocked") {
    return {
      mode: "blocked",
      ok: false,
      problems: [response.message || "GitHub branch protection nelze ověřit"],
    };
  }
  if (response.kind === "unconfigured") {
    return {
      mode: "capable-unprotected",
      ok: false,
      problems: ["Provider branch protection podporuje, ale v3 ji nemá aktivní"],
    };
  }
  const protection = response.value ?? {};
  const problems = [];
  if (protection.allow_force_pushes?.enabled !== false) {
    problems.push("v3 musí zakazovat force push");
  }
  if (protection.allow_deletions?.enabled !== false) {
    problems.push("v3 musí zakazovat smazání větve");
  }
  if (protection.enforce_admins?.enabled !== true) {
    problems.push("v3 ochrana musí platit i pro administrátory");
  }
  if (protection.required_pull_request_reviews != null) {
    problems.push("v3 nesmí pro běžnou datovou publikaci vyžadovat pull request");
  }
  if (protection.required_status_checks != null) {
    problems.push("v3 nesmí blokovat přímý writer povinným status checkem");
  }
  if (protection.restrictions != null) {
    problems.push("v3 nesmí nahrazovat GitHub repo granty druhým push rosterem");
  }
  return {
    mode: "provider-enforced",
    ok: problems.length === 0,
    problems,
  };
}

export function evaluateRootLedgers(organizationRoot, dataState, taskSources) {
  const problems = [];
  const active = dataState === "active";
  for (const [file, kind, collection] of LEDGERS) {
    const path = join(organizationRoot, file);
    if (!existsSync(path)) {
      if (active) problems.push(`Aktivní data slot vyžaduje root pointer ${file}`);
      continue;
    }
    const ledger = json(path);
    if (active) {
      const expected = `mission-control/db/data/mission-control/${file}`;
      if (ledger.authority !== "pointer" || ledger.status !== "read-only") {
        problems.push(`${file} musí být read-only pointer`);
      }
      if (ledger.superseded_by !== expected) {
        problems.push(`${file} musí odkazovat na ${expected}`);
      }
      if (
        typeof ledger.frozen_snapshot !== "string" ||
        !ledger.frozen_snapshot.startsWith("history/mission-control-root-snapshots/")
      ) {
        problems.push(`${file} musí odkazovat na frozen root snapshot`);
      }
      if (!Array.isArray(ledger[collection]) || ledger[collection].length !== 0) {
        problems.push(`${file}/${collection} musí být v pointeru prázdné pole`);
      }
    } else if (
      ledger.authority === "pointer" ||
      ledger.status === "read-only" ||
      Object.hasOwn(ledger, "superseded_by")
    ) {
      problems.push(`${dataState} slot nesmí předčasně používat root pointer ${file}`);
    }
    if (active) {
      const canonical = (Array.isArray(taskSources) ? taskSources : []).filter(
        (source) => source?.kind === kind && source?.authority === "source-of-truth",
      );
      const expected = `mission-control/db/data/mission-control/${file}`;
      if (canonical.length !== 1 || canonical[0]?.path !== expected) {
        problems.push(`task_sources musí mít jediný ${kind} source-of-truth na ${expected}`);
      }
    }
  }
  return problems;
}

function parseRepo(value) {
  const text = String(value ?? "").replace(/\.git$/, "");
  const ssh = text.match(/github\.com:([^/]+\/[^/]+)$/);
  const https = text.match(/github\.com\/([^/]+\/[^/]+)$/);
  return ssh?.[1] ?? https?.[1] ?? (text.includes("/") && !text.includes(":" ) ? text : null);
}

function gh(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
  let value = null;
  try {
    value = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    value = null;
  }
  return { status: result.status ?? 1, value, stderr: result.stderr.trim() };
}

function remoteText(repo, path, ref) {
  const response = gh(`repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (response.status !== 0 || typeof response.value?.content !== "string") return null;
  return Buffer.from(response.value.content.replace(/\n/g, ""), "base64").toString("utf8");
}

function branchProtection(repo) {
  const response = gh(`repos/${repo}/branches/v3/protection`);
  if (response.status === 0) return { kind: "configured", value: response.value };
  const message = response.value?.message ?? response.stderr;
  if (response.value?.status === "404" || message === "Branch not protected") {
    return { kind: "unconfigured", message };
  }
  if (/upgrade to github pro|enable this feature/i.test(message)) {
    return { kind: "unsupported", message };
  }
  return { kind: "blocked", message };
}

function dataConfigProblems(config, agentsText) {
  const problems = [];
  const policy = config?.publish_policy ?? {};
  if (policy.writer_mode !== "local-principal-v1") {
    problems.push("publish_policy.writer_mode musí být local-principal-v1");
  }
  for (const retired of ["approval_roles", "credential_authority", "local_principal"]) {
    if (Object.hasOwn(policy, retired)) problems.push(`publish_policy.${retired} je retired`);
  }
  if (!Array.isArray(policy.protected_paths) || policy.protected_paths.length === 0) {
    problems.push("publish_policy.protected_paths musí být neprázdné");
  }
  const admin = String(config?.organization_admin ?? "");
  if (!admin || /replace|pending|placeholder/i.test(admin)) {
    problems.push("organization_admin musí být konkrétní Admin owner růstového triggeru");
  }
  if (!agentsText) {
    problems.push("Data repo musí mít AGENTS.md s trust a enforcement kontraktem");
  } else {
    for (const phrase of ["GitHub je jediná autorita", "trusted-process", "provider-enforced"] ) {
      if (!agentsText.includes(phrase)) problems.push(`Data AGENTS.md musí obsahovat: ${phrase}`);
    }
  }
  return problems;
}

function appWriterProblems(appRepo) {
  if (!appRepo) return ["Aktivní app slot nemá čitelný GitHub repo identifikátor"];
  const capability = remoteText(
    appRepo,
    "app/v3/src/ui-app/repository-writer-capability.ts",
    "main",
  );
  if (!capability) return ["Nelze přečíst writer capability z app-code main"];
  const problems = [];
  if (!capability.includes("local-principal-v1")) {
    problems.push("App-code main nedeklaruje local-principal-v1 writer");
  }
  if (capability.includes("provider_access_audit_required")) {
    problems.push("App-code main stále vyžaduje retired provider access audit");
  }
  return problems;
}

function inspectOrganization(organizationRoot) {
  const company = json(join(organizationRoot, "company.gen3.json"));
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = existsSync(manifestPath) ? json(manifestPath) : { modules: [] };
  const slots = slotsOf(manifest);
  const appSlot = slots.find((slot) => slot?.path === "mission-control");
  const dataSlot = slots.find((slot) => slot?.path === "mission-control/db");
  const githubOrg = company?.company?.github_org ?? company?.github_org;
  const dataRepo =
    parseRepo(dataSlot?.repository_db?.repo) ??
    parseRepo(dataSlot?.repository_db?.url) ??
    parseRepo(dataSlot?.git?.url) ??
    (githubOrg ? `${githubOrg}/mission-control-data` : null);
  const repository = dataRepo ? gh(`repos/${dataRepo}`) : { status: 1, value: null };
  const repositoryExists = repository.status === 0;
  const dataState = classifyDataState(dataSlot, repositoryExists);
  const result = {
    organization: basename(organizationRoot),
    github_org: githubOrg ?? null,
    data_repo: dataRepo,
    data_state: dataState,
    enforcement_mode: null,
    writers: null,
    errors: [],
    notes: [],
  };

  if (["missing-slot", "incomplete"].includes(dataState)) {
    result.errors.push(`Mission Control data stav je ${dataState}`);
  }
  if (dataState === "staged") {
    result.notes.push("Data repo existuje, ale slot zůstává vědomě staged/planned; writer nesmí publikovat");
  }

  result.errors.push(
    ...evaluateRootLedgers(organizationRoot, dataState, company?.task_sources),
  );
  for (const retired of RETIRED_ROOT_FILES) {
    if (existsSync(join(organizationRoot, retired))) {
      result.errors.push(`Retired root mechanism zůstává aktivní: ${retired}`);
    }
  }

  if (repositoryExists) {
    const configText = remoteText(
      dataRepo,
      "data/mission-control/mission-control.config.json",
      "v3",
    );
    const agentsText = remoteText(dataRepo, "AGENTS.md", "v3");
    if (!configText) {
      result.errors.push("Nelze přečíst Mission Control data config z v3");
    } else {
      try {
        result.errors.push(...dataConfigProblems(JSON.parse(configText), agentsText));
      } catch {
        result.errors.push("Mission Control data config na v3 není validní JSON");
      }
    }
    const collaborators = gh(`repos/${dataRepo}/collaborators?affiliation=all&per_page=100`);
    if (collaborators.status !== 0 || !Array.isArray(collaborators.value)) {
      result.errors.push("Nelze ověřit živý GitHub write okruh data repa");
    } else {
      result.writers = collaborators.value.filter(
        (entry) => entry?.permissions?.push || entry?.permissions?.maintain || entry?.permissions?.admin,
      ).length;
    }
    const protection = evaluateProtection(branchProtection(dataRepo));
    result.enforcement_mode = protection.mode;
    if (dataState === "active") result.errors.push(...protection.problems);
  }

  if (appSlot && normalizedSlotStatus(appSlot) === "active") {
    const appRepo = parseRepo(appSlot?.git?.url) ?? parseRepo(appSlot?.doctor_managed_target?.repo);
    result.errors.push(...appWriterProblems(appRepo));
  }
  return result;
}

function parseArgs(argv) {
  const args = { json: false, workspaceRoot: fileURLToPath(new URL("../", import.meta.url)) };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--workspace-root") args.workspaceRoot = resolve(argv[++i]);
    else throw new Error(`Neznámý argument: ${argv[i]}`);
  }
  return args;
}

export function runSmoke(workspaceRoot) {
  const organizationsRoot = join(workspaceRoot, "organizations");
  return readdirSync(organizationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(organizationsRoot, entry.name))
    .filter((root) => existsSync(join(root, "company.gen3.json")))
    .sort()
    .map(inspectOrganization);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = runSmoke(args.workspaceRoot);
  const failed = results.filter((result) => result.errors.length > 0);
  if (args.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, organizations: results }, null, 2));
  } else {
    for (const result of results) {
      const status = result.errors.length > 0 ? "FAIL" : result.data_state === "staged" ? "STAGED" : "PASS";
      console.log(
        `${status} ${result.organization}: data=${result.data_state}, enforcement=${result.enforcement_mode ?? "n/a"}, writers=${result.writers ?? "n/a"}`,
      );
      for (const note of result.notes) console.log(`  note: ${note}`);
      for (const problem of result.errors) console.log(`  error: ${problem}`);
    }
    console.log(`Mission Control trust smoke: ${failed.length === 0 ? "PASS" : "FAIL"} (${results.length} Organizations)`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
