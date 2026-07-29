// Společný surface doctorů (decision 0118) — VENDOROVANÁ KOPIE.
//
// Zdroj pravdy: `Rozjedeme-ai/HumanAndMachines` → `scripts/doctor-surface-lib.mjs`
// a `schemas/doctor-report.schema.json`. Sem se kopíruje stejnou cestou jako
// `schemas/personal.gen3.schema.json`: Conglomerate je samostatné repo bez
// build-time závislosti na HumanAndMachines a mount `organizations/` je
// gitignored, takže import přes mount by z rootu udělal repo, které nejde
// naklonovat samo o sobě. Změna surfacu se dělá NEJDŘÍV v HumanAndMachines a
// teprve pak se sem překopíruje.
//
// Doctor není jeden program. Root doctor v kořeni Conglomerate orchestruje a nese
// standardizované kontroly; každé namountované repo — organization, personalspace —
// si nese vlastní nezávislý doctor, který root najde a zavolá. Personalspace doctor
// musí umět běžet i SAMOSTATNĚ: na Buddy VPS žádný root nad ním neexistuje.
//
// Tenhle soubor je jediná kopie surfacu v tomhle repu: slovník stavů, odvození
// souhrnu, exit kódy, validace reportu a invokace + agregace podřízených doctorů.
// Root-side lane, která ho používá, je `doctor-children-lib.mjs`.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { validateAgainstSchema } from "./json-schema-mini.mjs";

export const DOCTOR_REPORT_SCHEMA_VERSION_V1 = "companiesascode.doctor.report.v1";
export const DOCTOR_REPORT_SCHEMA_VERSION_V2 = "companiesascode.doctor.report.v2";
export const DOCTOR_REPORT_SCHEMA_VERSION_V3 = "companiesascode.doctor.report.v3";

export const DOCTOR_DECLARATION_SCHEMA_VERSION = "humanandmachines.doctor.declaration.v1";

/** Stavy jednotlivé kontroly ve v3. `skip` je legacy a čte se jako `blocked`. */
export const CHECK_STATUSES = Object.freeze(["ok", "warn", "fail", "not_applicable", "blocked"]);
export const LEGACY_CHECK_STATUS = "skip";
export const NOT_APPLICABLE_REASONS = Object.freeze([
  "owned_by_root",
  "no_such_mount",
  "not_declared",
]);
export const SUMMARY_STATUSES = Object.freeze(["ok", "warn", "fail", "incomplete"]);
export const CHILD_OUTCOMES = Object.freeze([
  "report",
  "no_report",
  "unparseable",
  "schema_invalid",
  "timeout",
  "spawn_failed",
  "scope_mismatch",
]);

/**
 * Exit kódy invokačního kontraktu. Rozlišení 2 od 1 je to, co rodiči dovolí odlišit
 * „dítě řeklo ne" od „dítě neumělo říct".
 */
export const DOCTOR_EXIT_CODES = Object.freeze({
  ok: 0,
  warn: 0,
  fail: 1,
  incomplete: 2,
  no_report: 3,
});

export const DEFAULT_CHILD_TIMEOUT_MS = 120_000;

/** `skip` z v1/v2 se čte jako `blocked` — fail-closed směrem. */
export function normalizeCheckStatus(status) {
  return status === LEGACY_CHECK_STATUS ? "blocked" : status;
}

export function countChecks(checks) {
  const counts = { ok: 0, warn: 0, fail: 0, not_applicable: 0, blocked: 0 };
  for (const check of checks ?? []) {
    const status = normalizeCheckStatus(check?.status);
    if (status in counts) counts[status] += 1;
  }
  return counts;
}

/**
 * Jediná funkce, která odvozuje souhrn. Pořadí je nosné:
 * fail>0 → fail; jinak blocked>0 → incomplete; jinak warn>0 → warn; jinak ok.
 * `not_applicable` se v odvození NEOBJEVUJE — je to fakt, ne nález.
 */
export function summarizeStatus(checks) {
  const counts = countChecks(checks);
  if (counts.fail > 0) return "fail";
  if (counts.blocked > 0) return "incomplete";
  if (counts.warn > 0) return "warn";
  return "ok";
}

export function buildSummary(checks) {
  const counts = countChecks(checks);
  return { status: summarizeStatus(checks), ...counts };
}

/** `incomplete` nikdy nesplní bránu — proto nemá vlastní „úspěšný" exit kód. */
export function exitCodeForSummaryStatus(status) {
  if (status === "ok" || status === "warn") return DOCTOR_EXIT_CODES.ok;
  if (status === "fail") return DOCTOR_EXIT_CODES.fail;
  if (status === "incomplete") return DOCTOR_EXIT_CODES.incomplete;
  return DOCTOR_EXIT_CODES.no_report;
}

/** True jen pro stavy, které smí splnit bránu. `incomplete` mezi ně nepatří. */
export function satisfiesGate(status) {
  return status === "ok" || status === "warn";
}

export function loadDoctorReportSchema(root) {
  const schemaPath = join(root, "schemas", "doctor-report.schema.json");
  if (!existsSync(schemaPath)) {
    throw new Error(`Chybí schemas/doctor-report.schema.json: ${schemaPath}`);
  }
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

/**
 * Validace reportu proti schématu PLUS křížová pravidla, která se do JSON Schema
 * nevejdou: souhrn musí souhlasit s checks, pole vázaná na stav nesmí viset u
 * jiného stavu a vnořené reporty dětí se validují rekurzivně stejnými pravidly.
 */
export function validateDoctorReport(report, { schema, label = "report" } = {}) {
  const failures = validateAgainstSchema(report, schema, label);
  if (!report || typeof report !== "object" || Array.isArray(report)) return failures;

  const checks = Array.isArray(report.checks) ? report.checks : [];
  // Souhrn se počítá z vlastních checks A ze všech vnořených checks dětí. U listu
  // (žádné children) je to totéž; u rootu je to celý smysl agregace.
  const allChecks = flattenChecks(report);
  const summary = report.summary;
  const isV3 = report.schema_version === DOCTOR_REPORT_SCHEMA_VERSION_V3;

  if (summary && typeof summary === "object") {
    const counted = countChecks(allChecks);
    const expectedKeys = isV3
      ? ["ok", "warn", "fail", "not_applicable", "blocked"]
      : ["ok", "warn", "fail"];
    for (const key of expectedKeys) {
      if (summary[key] !== counted[key]) {
        failures.push(
          `${label}: summary.${key}=${summary[key]} neodpovídá počtu checks (${counted[key]})`,
        );
      }
    }
    if (!isV3) {
      const legacySkips = checks.filter(
        (check) => check?.status === LEGACY_CHECK_STATUS,
      ).length;
      if (summary.skip !== legacySkips) {
        failures.push(
          `${label}: summary.skip=${summary.skip} neodpovídá počtu checks (${legacySkips})`,
        );
      }
    }
    // v1/v2 se posuzuje starým pravidlem: `skip` tam souhrn nekazil, takže starý
    // report zůstává ČITELNÝ. Fail-closed překlad skip→blocked se uplatní až tam,
    // kde se z něj počítá — v agregaci rodiče.
    const derived = isV3
      ? summarizeStatus(allChecks)
      : summarizeStatus(allChecks.filter((check) => check?.status !== LEGACY_CHECK_STATUS));
    if (summary.status !== derived) {
      failures.push(
        `${label}: summary.status=${summary.status} neodpovídá odvozenému stavu ${derived}`,
      );
    }
  }

  checks.forEach((check, index) => {
    const at = `${label}.checks[${index}]`;
    const status = check?.status;
    for (const field of ["not_applicable_reason", "owner"]) {
      if (field in (check ?? {}) && status !== "not_applicable") {
        failures.push(`${at}: pole '${field}' patří jen k status=not_applicable, ne k '${status}'`);
      }
    }
    for (const field of ["blocked_reason", "remedy"]) {
      if (field in (check ?? {}) && status !== "blocked") {
        failures.push(`${at}: pole '${field}' patří jen k status=blocked, ne k '${status}'`);
      }
    }
  });

  const children = Array.isArray(report.children) ? report.children : [];
  children.forEach((child, index) => {
    const at = `${label}.children[${index}]`;
    if (child?.outcome !== "report" && (child?.failures ?? []).length === 0) {
      failures.push(
        `${at}: outcome='${child?.outcome}' bez jediného záznamu ve 'failures' — rozbitý potomek musí být hlasitý`,
      );
    }
    if (child?.outcome === "report" && (child?.failures ?? []).length > 0) {
      failures.push(`${at}: outcome='report' nesmí nést 'failures'`);
    }
    if (child?.report && child?.outcome !== "report") {
      failures.push(
        `${at}: 'report' smí nést jen outcome='report'; nevalidovaný payload patří do 'stdout_tail'`,
      );
    }
    if (child?.report) {
      failures.push(...validateDoctorReport(child.report, { schema, label: `${at}.report` }));
    }
  });

  return failures;
}

/**
 * Deklarace podřízeného doctora v manifestu (personal.gen3.json / company.gen3.json).
 * Discovery je deklarací, ne hádáním cesty: konvenční `scripts/doctor.mjs` by
 * nefungovala pro mount, který není Node projekt.
 */
export function readDoctorDeclaration(manifest) {
  const declaration = manifest?.doctor;
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) return null;
  return declaration;
}

function tail(text, limit = 2000) {
  const value = String(text ?? "");
  return value.length > limit ? value.slice(value.length - limit) : value;
}

/**
 * Porovnání cest se dělá na ROZLOŽENÉ cestě. Řetězcové porovnání není kontrola:
 * `/var/folders/...` a `/private/var/folders/...` jsou na macOS táž složka a
 * doctor spuštěný přes symlinkovaný mount by jinak hlásil scope_mismatch, který
 * se nikdy nestal (AGENTS.md, invariant o resolved path).
 */
function samePath(left, right) {
  const canonical = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  return canonical(left) === canonical(right);
}

function toRelative(root, target) {
  const relativePath = relative(root, target).split(sep).join("/");
  return relativePath === "" ? "." : relativePath;
}

/**
 * Deklarované `cwd` nesmí vylézt z mountu. Kontroluje se na ROZLOŽENÉ cestě, ne
 * řetězcově — jinak by `cwd: "../../.."` v manifestu jedné Organizace pustil root
 * doctor mimo její access hranici, a symlinkovaný mount by hlásil únik, který se
 * nikdy nestal.
 */
function isInsideMount(mountPath, cwd) {
  const canonical = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  const mount = canonical(mountPath);
  const target = canonical(cwd);
  if (mount === target) return true;
  const relativePath = relative(mount, target);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/**
 * Spustí jeden podřízený doctor a klasifikuje, CO rodič skutečně dostal.
 * Rodič nikdy nevěří tomu, co dítě řeklo o sobě: report se znovu validuje,
 * scope se aserceuje proti mountu, který rodič spustil, a exit kód se porovná
 * s tím, co z reportu vychází.
 */
export function runChildDoctor({
  root,
  declarationPath,
  mountPath,
  declaration,
  schema,
  spawn = spawnSync,
  now = () => Date.now(),
}) {
  const command = Array.isArray(declaration?.command) ? declaration.command : [];
  const cwd = declaration?.cwd
    ? resolve(mountPath, declaration.cwd)
    : mountPath;
  const timeoutMs = Number.isInteger(declaration?.timeout_ms)
    ? declaration.timeout_ms
    : DEFAULT_CHILD_TIMEOUT_MS;

  const entry = {
    declaration_path: toRelative(root, isAbsolute(declarationPath) ? declarationPath : join(root, declarationPath)),
    mount_path: toRelative(root, cwd),
    invoked_command: command.length > 0 ? [...command] : ["<nedeklarováno>"],
    outcome: "spawn_failed",
    failures: [],
  };

  if (command.length === 0) {
    entry.failures.push("Deklarace doctora nemá 'command' — root nemá co spustit.");
    return entry;
  }
  if (!existsSync(cwd)) {
    entry.failures.push(`Pracovní adresář podřízeného doctora neexistuje: ${entry.mount_path}`);
    return entry;
  }
  if (!isInsideMount(mountPath, cwd)) {
    entry.failures.push(
      `Deklarované 'cwd' ukazuje mimo mount: '${declaration.cwd}' se rozkládá na `
      + `${entry.mount_path}. Podřízený doctor běží jen uvnitř svého repa.`,
    );
    return entry;
  }

  const startedAt = now();
  const result = spawn(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  entry.duration_ms = Math.max(0, now() - startedAt);
  entry.stderr_tail = tail(result?.stderr);
  if (Number.isInteger(result?.status)) entry.exit_code = result.status;

  const timedOut = result?.error?.code === "ETIMEDOUT"
    || (result?.signal === "SIGTERM" && !Number.isInteger(result?.status));
  if (timedOut) {
    entry.outcome = "timeout";
    entry.failures.push(
      `Podřízený doctor nedoběhl do ${timeoutMs} ms a byl ukončen. Nepozorovali jsme nic — to není zelená.`,
    );
    return entry;
  }
  if (result?.error) {
    entry.outcome = "spawn_failed";
    entry.failures.push(`Podřízený doctor nešel spustit: ${result.error.message}`);
    return entry;
  }

  const stdout = String(result?.stdout ?? "").trim();
  if (stdout === "") {
    entry.outcome = "no_report";
    entry.failures.push(
      "Podřízený doctor nevypsal na stdout žádný report (očekávaný exit kód 3).",
    );
    return entry;
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    entry.outcome = "unparseable";
    entry.failures.push(`Stdout podřízeného doctora není JSON: ${error.message}`);
    return entry;
  }

  // Payload, který neprojde, se ukládá jako TEXT do stdout_tail, nikdy jako
  // `report`. Nevalidovaný report by se v agregaci počítal jako data — a přesně
  // tím by se z rozbitého potomka stala tichá zelená.
  const schemaFailures = validateDoctorReport(parsed, { schema, label: "child" });
  if (schemaFailures.length > 0) {
    entry.outcome = "schema_invalid";
    entry.stdout_tail = tail(stdout);
    entry.failures.push(...schemaFailures);
    return entry;
  }

  const reportedPath = parsed?.scope?.absolute_path;
  if (typeof reportedPath === "string" && reportedPath !== "" && !samePath(reportedPath, cwd)) {
    entry.outcome = "scope_mismatch";
    entry.stdout_tail = tail(stdout);
    entry.failures.push(
      `Podřízený doctor hlásí scope.absolute_path '${reportedPath}', ale root ho spustil v '${cwd}'.`,
    );
    return entry;
  }
  if (
    typeof declaration?.scope_type === "string"
    && parsed?.scope?.type !== declaration.scope_type
  ) {
    entry.outcome = "scope_mismatch";
    entry.stdout_tail = tail(stdout);
    entry.failures.push(
      `Manifest deklaruje scope.type '${declaration.scope_type}', report hlásí '${parsed?.scope?.type}'.`,
    );
    return entry;
  }

  // Invokační kontrakt se vymáhá jen na v3 producentech. Starší dítě exit kód
  // podle `blocked` znát nemohlo — čte se fail-closed (viz níž), ale nesoudí se
  // podle pravidla, které v době jeho vzniku neexistovalo.
  if (parsed?.schema_version === DOCTOR_REPORT_SCHEMA_VERSION_V3) {
    const expectedExit = exitCodeForSummaryStatus(summarizeStatus(parsed.checks));
    if (Number.isInteger(entry.exit_code) && entry.exit_code !== expectedExit) {
      entry.exit_code_mismatch = expectedExit;
    }
  }

  entry.outcome = "report";
  entry.report = parsed;
  return entry;
}

/**
 * Ploché checks z reportu i všech vnořených dětí. Root počítá souhrn odsud —
 * nikdy z toho, co dítě napsalo do vlastního summary.
 */
export function flattenChecks(report) {
  const own = Array.isArray(report?.checks) ? [...report.checks] : [];
  for (const child of report?.children ?? []) {
    if (child?.report) own.push(...flattenChecks(child.report));
  }
  return own;
}

/**
 * Postaví aggregate check za rozbitého potomka. Tohle je místo, kde se „chybějící
 * doctor" mění z ticha na fail — bez něj by root prostě neměl co počítat a vyšel by
 * zeleně.
 */
export function childDefectCheck(child, index) {
  const messages = {
    no_report: "nevrátil žádný report",
    unparseable: "vrátil něco, co není JSON",
    schema_invalid: "vrátil report, který neodpovídá kontraktu",
    timeout: "nedoběhl v limitu",
    spawn_failed: "nešel vůbec spustit",
    scope_mismatch: "vrátil report o jiném scope, než v jakém byl spuštěn",
  };
  return {
    id: `doctor.child.${index}`,
    status: "fail",
    severity: "required",
    title: "Podřízený doctor",
    message: `Podřízený doctor deklarovaný v ${child.declaration_path} ${messages[child.outcome] ?? "selhal"}`,
    paths: [child.mount_path ?? child.declaration_path],
    details: [
      ...child.failures,
      ...(child.stderr_tail ? [`stderr: ${tail(child.stderr_tail, 400)}`] : []),
    ],
  };
}

/**
 * Sestaví v3 report rodiče. `checks` jsou vlastní kontroly rodiče, `children`
 * výstupy `runChildDoctor`. Souhrn se počítá z vlastních checks, syntetizovaných
 * checks za rozbité potomky a ze VŠECH vnořených checks.
 */
export function buildAggregateReport({ scope, checks = [], children = [], generatedAt } = {}) {
  const ownChecks = [...checks];
  children.forEach((child, index) => {
    if (child.outcome !== "report") {
      ownChecks.push(childDefectCheck(child, index));
      return;
    }
    if (child.report?.schema_version !== DOCTOR_REPORT_SCHEMA_VERSION_V3) {
      // Starý producent se přečte, ale zamlčet se nesmí: jeho `skip` se do
      // agregace započítá jako `blocked` a rodič k tomu přiloží warn, aby bylo
      // vidět, že se tu čte fail-closed překlad, ne původní tvrzení.
      ownChecks.push({
        id: `doctor.child.${index}.legacy_schema`,
        status: "warn",
        severity: "recommended",
        title: "Podřízený doctor na starším kontraktu",
        message:
          `Podřízený doctor z ${child.declaration_path} vrací `
          + `${child.report?.schema_version} — 'skip' se čte jako 'blocked'`,
        paths: [child.mount_path ?? child.declaration_path],
        details: [],
      });
    }
    if (Number.isInteger(child.exit_code_mismatch)) {
      ownChecks.push({
        id: `doctor.child.${index}.exit_code`,
        status: "fail",
        severity: "required",
        title: "Exit kód podřízeného doctora",
        message:
          `Podřízený doctor z ${child.declaration_path} skončil kódem ${child.exit_code}, `
          + `ale z jeho vlastního reportu vychází ${child.exit_code_mismatch}`,
        paths: [child.mount_path ?? child.declaration_path],
        details: [],
      });
    }
  });

  const report = {
    schema_version: DOCTOR_REPORT_SCHEMA_VERSION_V3,
    scope,
    summary: buildSummary([
      ...ownChecks,
      ...children.flatMap((child) => (child.report ? flattenChecks(child.report) : [])),
    ]),
    checks: ownChecks,
  };
  if (generatedAt) report.generated_at = generatedAt;
  if (children.length > 0) report.children = [...children];
  return report;
}
