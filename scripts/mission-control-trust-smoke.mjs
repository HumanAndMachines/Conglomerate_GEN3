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

const GITHUB_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const FRICTION_RULE_TYPES = new Set([
  "pull_request",
  "required_status_checks",
  "required_signatures",
  "required_deployments",
  "workflows",
  "code_scanning",
  "update",
]);

function json(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

function evaluateClassicProtection(response) {
  if (response.kind === "unsupported") {
    return { kind: "unsupported", historyProtected: false, problems: [] };
  }
  if (response.kind === "blocked") {
    return {
      kind: "blocked",
      historyProtected: false,
      problems: [response.message || "GitHub branch protection nelze ověřit"],
    };
  }
  if (response.kind === "unconfigured") {
    return { kind: "unconfigured", historyProtected: false, problems: [] };
  }
  const protection = response.value ?? {};
  const problems = [];
  if (protection.required_pull_request_reviews != null) {
    problems.push("v3 nesmí pro běžnou datovou publikaci vyžadovat pull request");
  }
  if (protection.required_status_checks != null) {
    problems.push("v3 nesmí blokovat přímý writer povinným status checkem");
  }
  if (protection.restrictions != null) {
    problems.push("v3 nesmí nahrazovat GitHub repo granty druhým push rosterem");
  }
  if (protection.lock_branch?.enabled !== false) {
    problems.push("v3 nesmí být zamčená proti běžným Builder pushům");
  }
  if (protection.required_signatures?.enabled !== false) {
    problems.push("v3 nesmí vyžadovat podpis commitu mimo běžný writer kontrakt");
  }
  return {
    kind: "configured",
    historyProtected:
      protection.allow_force_pushes?.enabled === false &&
      protection.allow_deletions?.enabled === false &&
      protection.enforce_admins?.enabled === true,
    problems,
  };
}

export function evaluateEffectiveRules(response) {
  if (response.kind === "unsupported") {
    return { kind: "unsupported", historyProtected: false, problems: [] };
  }
  if (response.kind === "blocked") {
    return {
      kind: "blocked",
      historyProtected: false,
      problems: [response.message || "Efektivní GitHub rulesety nelze ověřit"],
    };
  }
  const rules = Array.isArray(response.value) ? response.value : [];
  const details = response.details ?? {};
  const problems = rules
    .filter((rule) => FRICTION_RULE_TYPES.has(rule?.type))
    .map(
      (rule) =>
        `Efektivní GitHub ruleset ${rule.type} blokuje frictionless validovaný fast-forward writer`,
    );
  const protectedTypes = new Set();
  for (const rule of rules) {
    if (!["deletion", "non_fast_forward"].includes(rule?.type)) continue;
    const detail = details[String(rule.ruleset_id)];
    if (
      detail?.enforcement === "active" &&
      Array.isArray(detail.bypass_actors) &&
      detail.bypass_actors.length === 0
    ) {
      protectedTypes.add(rule.type);
    }
  }
  return {
    kind: "configured",
    historyProtected:
      protectedTypes.has("deletion") && protectedTypes.has("non_fast_forward"),
    problems,
  };
}

export function evaluateProtection(
  classicResponse,
  effectiveRulesResponse = { kind: "unsupported" },
) {
  const classic = evaluateClassicProtection(classicResponse);
  const rules = evaluateEffectiveRules(effectiveRulesResponse);
  const problems = [...classic.problems, ...rules.problems];
  if (classic.kind === "blocked" || rules.kind === "blocked") {
    return { mode: "blocked", ok: false, problems };
  }
  if (classic.kind === "unsupported" && rules.kind === "unsupported") {
    return { mode: "trusted-process", ok: true, problems: [] };
  }
  const historyProtected = classic.historyProtected || rules.historyProtected;
  if (!historyProtected) {
    problems.push(
      "v3 nemá provider ochranu bez bypassu proti force pushi a smazání větve",
    );
  }
  return {
    mode: historyProtected ? "provider-enforced" : "capable-unprotected",
    ok: historyProtected && problems.length === 0,
    problems,
  };
}

export function evaluateTrustedProcessCircle({
  enforcementMode,
  writers,
  unconfirmedMemberships = [],
}) {
  if (enforcementMode !== "trusted-process") return [];
  const problems = [];
  const automationLogins = writers
    .filter((entry) => entry?.type !== "User")
    .map((entry) => entry?.login)
    .filter(Boolean);
  if (automationLogins.length > 0) {
    problems.push(
      `Trusted-process nesmí mít automatizovaného writera bez provider enforcement: ${automationLogins.join(", ")}`,
    );
  }
  for (const failure of unconfirmedMemberships) {
    problems.push(
      `Organization membership writera ${failure.login} není potvrzené: ${failure.message}`,
    );
  }
  return problems;
}

export function classifyRepositoryProbe(response) {
  if (response.status === 0) return { exists: true, error: null };
  const message = response.value?.message ?? response.stderr ?? "GitHub API selhalo";
  if (String(response.value?.status ?? "") === "404") {
    return { exists: false, error: null };
  }
  return { exists: null, error: message };
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
  const identity =
    ssh?.[1] ??
    https?.[1] ??
    (text.includes("/") && !text.includes(":") ? text : null);
  return identity && GITHUB_REPOSITORY_PATTERN.test(identity)
    ? identity
    : null;
}

function gh(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
  let value = null;
  try {
    value = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    value = null;
  }
  return {
    status: result.status ?? 1,
    value,
    stderr: String(result.stderr ?? result.error?.message ?? "").trim(),
  };
}

function ghPaginatedArray(endpoint) {
  const result = spawnSync(
    "gh",
    ["api", "--paginate", "--slurp", endpoint],
    { encoding: "utf8" },
  );
  let pages = null;
  try {
    pages = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    pages = null;
  }
  return {
    status: result.status ?? 1,
    value:
      Array.isArray(pages) && pages.every((page) => Array.isArray(page))
        ? pages.flat()
        : null,
    stderr: String(result.stderr ?? result.error?.message ?? "").trim(),
  };
}

function organizationMembership(githubOrg, login) {
  if (
    !GITHUB_LOGIN_PATTERN.test(String(githubOrg ?? "")) ||
    !GITHUB_LOGIN_PATTERN.test(String(login ?? ""))
  ) {
    return { kind: "unconfirmed", message: "neplatná GitHub identita" };
  }
  const response = gh(`orgs/${githubOrg}/members/${login}`);
  if (response.status === 0) return { kind: "member" };
  const message = response.value?.message ?? response.stderr;
  if (response.value?.status === "404" || /not found/i.test(message)) {
    return {
      kind: "unconfirmed",
      message:
        "GitHub vrátil 404: writer není Organization member nebo token nemá read:org scope",
    };
  }
  return { kind: "unconfirmed", message: message || "GitHub API selhalo" };
}

function branchProtection(repo) {
  const response = gh(`repos/${repo}/branches/v3/protection`);
  if (response.status === 0) return { kind: "configured", value: response.value };
  const message = response.value?.message ?? response.stderr;
  if (response.value?.status === "404" || message === "Branch not protected") {
    return { kind: "unconfigured", message };
  }
  if (
    /upgrade to github (?:pro|team)|enable this feature|only available for .*repositor/i.test(
      message,
    )
  ) {
    return { kind: "unsupported", message };
  }
  return { kind: "blocked", message };
}

function effectiveBranchRules(repo) {
  const response = gh(`repos/${repo}/rules/branches/v3`);
  if (response.status === 0 && Array.isArray(response.value)) {
    const details = {};
    const historyRules = response.value.filter((rule) =>
      ["deletion", "non_fast_forward"].includes(rule?.type),
    );
    for (const rule of historyRules) {
      const id = Number(rule?.ruleset_id);
      if (!Number.isSafeInteger(id) || details[String(id)]) continue;
      let endpoint = null;
      if (
        rule?.ruleset_source_type === "Repository" &&
        GITHUB_REPOSITORY_PATTERN.test(String(rule?.ruleset_source ?? ""))
      ) {
        endpoint = `repos/${rule.ruleset_source}/rulesets/${id}`;
      } else if (
        rule?.ruleset_source_type === "Organization" &&
        GITHUB_LOGIN_PATTERN.test(String(rule?.ruleset_source ?? ""))
      ) {
        endpoint = `orgs/${rule.ruleset_source}/rulesets/${id}`;
      }
      if (!endpoint) {
        return {
          kind: "blocked",
          message: `Nelze určit authority efektivního GitHub rulesetu ${id}`,
        };
      }
      const detail = gh(endpoint);
      if (detail.status !== 0) {
        return {
          kind: "blocked",
          message:
            detail.value?.message ??
            detail.stderr ??
            `Nelze přečíst efektivní GitHub ruleset ${id}`,
        };
      }
      details[String(id)] = detail.value;
    }
    return { kind: "configured", value: response.value, details };
  }
  const message = response.value?.message ?? response.stderr;
  if (
    /upgrade to github (?:pro|team)|enable this feature|only available for .*repositor/i.test(
      message,
    )
  ) {
    return { kind: "unsupported", message };
  }
  return { kind: "blocked", message };
}

function inspectOrganization(organizationRoot) {
  const company = json(join(organizationRoot, "company.gen3.json"));
  const manifestPath = join(organizationRoot, "modules.manifest.json");
  const manifest = existsSync(manifestPath) ? json(manifestPath) : { modules: [] };
  const slots = slotsOf(manifest);
  const dataSlot = slots.find((slot) => slot?.path === "mission-control/db");
  const githubOrg = company?.company?.github_org ?? company?.github_org;
  const dataRepo =
    parseRepo(dataSlot?.repository_db?.repo) ??
    parseRepo(dataSlot?.repository_db?.url) ??
    parseRepo(dataSlot?.git?.url) ??
    (githubOrg ? parseRepo(`${githubOrg}/mission-control-data`) : null);
  const dataRepoOwner = dataRepo?.split("/")[0] ?? null;
  const ownerMatches =
    typeof githubOrg === "string" &&
    typeof dataRepoOwner === "string" &&
    dataRepoOwner.toLowerCase() === githubOrg.toLowerCase();
  const repositoryResponse =
    dataRepo && ownerMatches
      ? gh(`repos/${dataRepo}`)
      : null;
  const repositoryProbe = repositoryResponse
    ? classifyRepositoryProbe(repositoryResponse)
    : { exists: false, error: null };
  const repositoryExists = repositoryProbe.exists === true;
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

  if (!dataRepo) {
    result.errors.push("Mission Control data slot nemá platnou GitHub repo identitu");
  } else if (!ownerMatches) {
    result.errors.push(
      `Mission Control data repo ${dataRepo} nepatří GitHub Organization ${githubOrg ?? "<missing>"}`,
    );
  }
  if (repositoryProbe.error) {
    result.errors.push(
      `Nelze ověřit existenci Mission Control data repa ${dataRepo}: ${repositoryProbe.error}`,
    );
  }

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
    const protection = evaluateProtection(
      branchProtection(dataRepo),
      effectiveBranchRules(dataRepo),
    );
    result.enforcement_mode = protection.mode;
    if (dataState === "active") {
      result.errors.push(...protection.problems);
    }
    const collaborators = ghPaginatedArray(
      `repos/${dataRepo}/collaborators?affiliation=all&per_page=100`,
    );
    if (collaborators.status !== 0 || !Array.isArray(collaborators.value)) {
      result.errors.push("Nelze ověřit živý GitHub write okruh data repa");
    } else {
      const writers = collaborators.value.filter(
        (entry) => entry?.permissions?.push || entry?.permissions?.maintain || entry?.permissions?.admin,
      );
      result.writers = writers.length;
      const unconfirmedMemberships = [];
      for (const writer of writers.filter((entry) => entry?.type === "User")) {
        const membership = organizationMembership(githubOrg, writer.login);
        if (membership.kind === "unconfirmed") {
          unconfirmedMemberships.push({
            login: writer.login,
            message: membership.message,
          });
        }
      }
      if (dataState === "active") {
        result.errors.push(
          ...evaluateTrustedProcessCircle({
            enforcementMode: protection.mode,
            writers,
            unconfirmedMemberships,
          }),
        );
      }
    }
  }
  return result;
}

function failedOrganizationResult(organizationRoot, error) {
  return {
    organization: basename(organizationRoot),
    github_org: null,
    data_repo: null,
    data_state: "invalid",
    enforcement_mode: null,
    writers: null,
    errors: [error instanceof Error ? error.message : String(error)],
    notes: [],
  };
}

export function defaultWorkspaceRoot() {
  const scriptRoot = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: scriptRoot,
    encoding: "utf8",
  });
  const primary = result.stdout
    ?.split("\0")
    .find((entry) => entry.startsWith("worktree "))
    ?.slice("worktree ".length);
  return result.status === 0 && primary ? resolve(primary) : resolve(scriptRoot);
}

function parseArgs(argv) {
  const args = { json: false, workspaceRoot: defaultWorkspaceRoot() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--workspace-root") args.workspaceRoot = resolve(argv[++i]);
    else throw new Error(`Neznámý argument: ${argv[i]}`);
  }
  return args;
}

export function runSmoke(workspaceRoot) {
  const organizationsRoot = join(workspaceRoot, "organizations");
  if (!existsSync(organizationsRoot)) {
    throw new Error(`Chybí Lazurio organizations mountpoint: ${organizationsRoot}`);
  }
  const candidates = readdirSync(organizationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(organizationsRoot, entry.name))
    .filter((root) => existsSync(join(root, "company.gen3.json")))
    .sort();
  const results = [];
  for (const root of candidates) {
    let company;
    try {
      company = json(join(root, "company.gen3.json"));
    } catch (error) {
      results.push(failedOrganizationResult(root, error));
      continue;
    }
    if (company?.organization_kind === "template") continue;
    // Discovery keeps legacy business mounts without organization_kind as
    // Organizations; only the explicit template marker excludes a mount.
    try {
      results.push(inspectOrganization(root));
    } catch (error) {
      results.push(failedOrganizationResult(root, error));
    }
  }
  if (results.length === 0) {
    throw new Error(
      `Mission Control trust smoke odmítá false-green běh bez Organizací: ${organizationsRoot}`,
    );
  }
  return results;
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `Mission Control trust smoke: FAIL (${error instanceof Error ? error.message : String(error)})`,
    );
    process.exitCode = 1;
  }
}
