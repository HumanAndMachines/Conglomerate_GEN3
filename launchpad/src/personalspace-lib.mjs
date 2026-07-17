// Personalspace discovery lane (CAC-0048, decision 0051).
//
// PRIVÁTNÍ HRANICE JE TVRDÁ. Tato lane je úplně oddělená od organizations/*
// auto-discovery (discovery-lib.mjs). Osobní prostor je privátní repo vlastníka
// mašiny (nebo AI kolegy) na jeho osobním GitHubu, mimo firemní GitHub
// organizace. Discovery skenuje výhradně personalspace/*/personal.gen3.json,
// nikdy organizations/*. Obsah osobních modulů a gbrain zápisů se NIKDY
// nepropisuje do org discovery, shared/doctor reportů ani templates — odsud
// vychází jen metadata (počty, validita, cesty), žádný obsah.
//
// Kontrakty (source of truth v HumanAndMachines, decision 0051):
//   - personal.gen3.json  → schemas/personal.gen3.schema.json (kopie identická)
//   - modules.manifest.json → identický module-slot kontrakt jako Organizace
//   - workspace/<modul>/ … → osobní aplikace přes companyascode.app manifesty
//
// Slot readiness (sdílené prostory!): available (mount existuje) / missing_access
// (deklarované repo bez lokálního checkoutu — typicky chybějící repo access) /
// planned_slot (slot bez repo deklarace). Stejná mechanika jako u Organizací
// (decision 0042), aby dva Kolegové mohli sdílet vybrané osobní moduly.

import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { dirname, join, relative, resolve, sep } from "path";
import { readJson, readLocalOverrideConfig, validateAppManifest } from "./discovery-lib.mjs";

const launchpadRoot = join(import.meta.dirname, "..");
const appSchemaPath = join(launchpadRoot, "schemas", "launchpad-app.schema.json");
const personalSchemaPath = join(launchpadRoot, "schemas", "personal.gen3.schema.json");
const buddyPresentationSchemaPath = join(launchpadRoot, "schemas", "personal-buddy-presentation.draft.schema.json");
const defaultPersonalspaceMountpoint = "personalspace";
const gitMarker = "_GEN3";
const ignoredSpaceDirs = new Set([".git", ".worktrees", "node_modules", "secrets"]);
// Osobní workspace moduly leží v ploché složce workspace/<modul>/, stejně jako
// org workspace. Uvnitř nechodíme do těchto adresářů kvůli aplikačním manifestům.
const ignoredWorkspaceDirs = new Set([".git", ".worktrees", "node_modules", "dist", "build", ".next", "coverage"]);

// Osobní aplikace dostávají vlastní id namespace, aby se v runtime/logách nikdy
// nemíchaly s org aplikacemi (a nemohly kolidovat na app id). Runtime manager
// personalspace lane používá tento prefix jako routovací klíč.
export const PERSONAL_APP_ID_PREFIX = "personal--";
export const PERSONAL_SCHEMA_VERSION = "humanandmachines.personal.gen3.v1";

export function isLegacyPersonalCustodyConfig(personal) {
  return personal?.schema_version === undefined
    && personal?.repository?.mount_strategy === undefined
    && personal?.gbrain?.repository === undefined
    && personal?.gbrain?.software === undefined;
}

export function personalAppRuntimeId(spaceDirName, appId) {
  return `${PERSONAL_APP_ID_PREFIX}${spaceDirName}--${appId}`;
}

// Schema pro personal.gen3.json je const/enum-heavy; validujeme cíleně proti
// jeho tvaru (stejný styl jako org lane validace app manifestu). Vrací pole
// human-readable chyb v češtině.
export function validatePersonalConfig(personal, schema, label) {
  const failures = [];
  if (!personal || typeof personal !== "object" || Array.isArray(personal)) {
    failures.push(`${label}: personal.gen3.json musí být JSON object`);
    return failures;
  }
  const legacyCustody = isLegacyPersonalCustodyConfig(personal);
  for (const key of schema.required ?? []) {
    if (legacyCustody && key === "schema_version") continue;
    if (personal[key] === undefined) failures.push(`${label}: chybí povinné pole ${key}`);
  }
  const props = schema.properties ?? {};
  const checkConst = (obj, key, spec, path) => {
    if (spec?.const !== undefined && obj?.[key] !== undefined && obj[key] !== spec.const) {
      failures.push(`${label}: ${path} musí být ${JSON.stringify(spec.const)}`);
    }
  };
  const checkEnum = (obj, key, spec, path) => {
    if (Array.isArray(spec?.enum) && obj?.[key] !== undefined && !spec.enum.includes(obj[key])) {
      failures.push(`${label}: ${path} musí být jedno z ${spec.enum.join(", ")}`);
    }
  };
  const checkPattern = (obj, key, spec, path) => {
    if (spec?.pattern && typeof obj?.[key] === "string" && !new RegExp(spec.pattern).test(obj[key])) {
      failures.push(`${label}: ${path} neodpovídá patternu ${spec.pattern}`);
    }
  };
  const checkString = (obj, key, path, { required = false } = {}) => {
    const value = obj?.[key];
    if (value === undefined && !required) return;
    if (typeof value !== "string" || value.trim() === "") {
      failures.push(`${label}: ${path} musí být neprázdný text`);
    }
  };

  checkConst(personal, "schema_version", props.schema_version, "schema_version");
  checkConst(personal, "personal_generation", props.personal_generation, "personal_generation");
  checkConst(personal, "modules_manifest_path", props.modules_manifest_path, "modules_manifest_path");
  checkConst(personal, "workspace_path", props.workspace_path, "workspace_path");

  // owner
  const ownerSpec = props.owner ?? {};
  for (const key of ownerSpec.required ?? []) {
    if (personal.owner?.[key] === undefined) failures.push(`${label}: chybí owner.${key}`);
  }
  checkPattern(personal.owner, "github_username", ownerSpec.properties?.github_username, "owner.github_username");
  checkEnum(personal.owner, "type", ownerSpec.properties?.type, "owner.type");

  // Buddy je volitelný (decision 0079). Pokud binding existuje, validuje se
  // stejně přísně jako dřív; absence nevytváří placeholder ani chybu.
  if (personal.buddy !== undefined) {
    const buddySpec = props.buddy ?? {};
    if (!personal.buddy || typeof personal.buddy !== "object" || Array.isArray(personal.buddy)) {
      failures.push(`${label}: buddy musí být objekt`);
    } else {
      for (const key of buddySpec.required ?? []) {
        if (legacyCustody && ["path", "repository", "runtime", "hermes"].includes(key)) continue;
        if (personal.buddy[key] === undefined) failures.push(`${label}: chybí buddy.${key}`);
      }
      checkString(personal.buddy, "slug", "buddy.slug", { required: true });
      checkConst(personal.buddy, "gbrain_path", buddySpec.properties?.gbrain_path, "buddy.gbrain_path");
      if (!legacyCustody) {
        checkConst(personal.buddy, "path", buddySpec.properties?.path, "buddy.path");
        const buddyRepoSpec = buddySpec.properties?.repository ?? {};
        for (const key of buddyRepoSpec.required ?? []) {
          if (personal.buddy.repository?.[key] === undefined) {
            failures.push(`${label}: chybí buddy.repository.${key}`);
          }
        }
        checkPattern(
          personal.buddy.repository,
          "github_repo",
          buddyRepoSpec.properties?.github_repo,
          "buddy.repository.github_repo",
        );
        checkConst(
          personal.buddy.repository,
          "visibility",
          buddyRepoSpec.properties?.visibility,
          "buddy.repository.visibility",
        );
        checkConst(
          personal.buddy.repository,
          "mount_strategy",
          buddyRepoSpec.properties?.mount_strategy,
          "buddy.repository.mount_strategy",
        );
        const buddyRuntimeSpec = buddySpec.properties?.runtime ?? {};
        for (const key of buddyRuntimeSpec.required ?? []) {
          if (personal.buddy.runtime?.[key] === undefined) failures.push(`${label}: chybí buddy.runtime.${key}`);
        }
        checkConst(
          personal.buddy.runtime,
          "github_repo",
          buddyRuntimeSpec.properties?.github_repo,
          "buddy.runtime.github_repo",
        );
        checkConst(
          personal.buddy.runtime,
          "deployment_target",
          buddyRuntimeSpec.properties?.deployment_target,
          "buddy.runtime.deployment_target",
        );
        checkConst(
          personal.buddy.runtime,
          "local_execution",
          buddyRuntimeSpec.properties?.local_execution,
          "buddy.runtime.local_execution",
        );
        const hermesSpec = buddySpec.properties?.hermes ?? {};
        for (const key of hermesSpec.required ?? []) {
          if (personal.buddy.hermes?.[key] === undefined) failures.push(`${label}: chybí buddy.hermes.${key}`);
        }
        checkConst(
          personal.buddy.hermes,
          "software_repo",
          hermesSpec.properties?.software_repo,
          "buddy.hermes.software_repo",
        );
        checkConst(
          personal.buddy.hermes,
          "profile_format",
          hermesSpec.properties?.profile_format,
          "buddy.hermes.profile_format",
        );
        checkConst(
          personal.buddy.hermes,
          "profile_path",
          hermesSpec.properties?.profile_path,
          "buddy.hermes.profile_path",
        );
      }
    }
  }

  // repository
  const repoSpec = props.repository ?? {};
  for (const key of repoSpec.required ?? []) {
    if (legacyCustody && key === "mount_strategy") continue;
    if (personal.repository?.[key] === undefined) failures.push(`${label}: chybí repository.${key}`);
  }
  checkPattern(personal.repository, "github_repo", repoSpec.properties?.github_repo, "repository.github_repo");
  checkPattern(personal.repository, "mount_path", repoSpec.properties?.mount_path, "repository.mount_path");
  checkConst(personal.repository, "visibility", repoSpec.properties?.visibility, "repository.visibility");
  checkConst(personal.repository, "mount_strategy", repoSpec.properties?.mount_strategy, "repository.mount_strategy");

  // privacy — tvrdá hranice
  const privacySpec = props.privacy ?? {};
  for (const key of privacySpec.required ?? []) {
    if (personal.privacy?.[key] === undefined) failures.push(`${label}: chybí privacy.${key}`);
  }
  checkConst(personal.privacy, "default_share", privacySpec.properties?.default_share, "privacy.default_share");
  checkConst(personal.privacy, "agent_boundary", privacySpec.properties?.agent_boundary, "privacy.agent_boundary");
  checkConst(personal.privacy, "shared_outputs", privacySpec.properties?.shared_outputs, "privacy.shared_outputs");

  // gbrain
  const gbrainSpec = props.gbrain ?? {};
  for (const key of gbrainSpec.required ?? []) {
    if (legacyCustody && ["repository", "software"].includes(key)) continue;
    if (personal.gbrain?.[key] === undefined) failures.push(`${label}: chybí gbrain.${key}`);
  }
  checkConst(personal.gbrain, "path", gbrainSpec.properties?.path, "gbrain.path");
  if (!legacyCustody) {
    const gbrainRepoSpec = gbrainSpec.properties?.repository ?? {};
    for (const key of gbrainRepoSpec.required ?? []) {
      if (personal.gbrain?.repository?.[key] === undefined) failures.push(`${label}: chybí gbrain.repository.${key}`);
    }
    checkPattern(
      personal.gbrain?.repository,
      "github_repo",
      gbrainRepoSpec.properties?.github_repo,
      "gbrain.repository.github_repo",
    );
    checkConst(
      personal.gbrain?.repository,
      "visibility",
      gbrainRepoSpec.properties?.visibility,
      "gbrain.repository.visibility",
    );
    checkConst(
      personal.gbrain?.repository,
      "mount_strategy",
      gbrainRepoSpec.properties?.mount_strategy,
      "gbrain.repository.mount_strategy",
    );
    const gbrainSoftwareSpec = gbrainSpec.properties?.software ?? {};
    for (const key of gbrainSoftwareSpec.required ?? []) {
      if (personal.gbrain?.software?.[key] === undefined) failures.push(`${label}: chybí gbrain.software.${key}`);
    }
    checkConst(
      personal.gbrain?.software,
      "github_repo",
      gbrainSoftwareSpec.properties?.github_repo,
      "gbrain.software.github_repo",
    );
    checkConst(
      personal.gbrain?.software,
      "install_source",
      gbrainSoftwareSpec.properties?.install_source,
      "gbrain.software.install_source",
    );
  }
  checkConst(personal.gbrain, "default_shared", gbrainSpec.properties?.default_shared, "gbrain.default_shared");
  checkEnum(personal.gbrain, "human_editor", gbrainSpec.properties?.human_editor, "gbrain.human_editor");
  checkConst(personal.gbrain, "agent_access", gbrainSpec.properties?.agent_access, "gbrain.agent_access");

  // secrets
  const secretsSpec = props.secrets ?? {};
  for (const key of secretsSpec.required ?? []) {
    if (personal.secrets?.[key] === undefined) failures.push(`${label}: chybí secrets.${key}`);
  }
  checkConst(personal.secrets, "path", secretsSpec.properties?.path, "secrets.path");
  checkConst(personal.secrets, "git", secretsSpec.properties?.git, "secrets.git");

  return failures;
}

export function validateBuddyPresentation(buddy, schema, label) {
  const failures = [];
  const props = schema?.properties ?? {};
  const checkText = (obj, key, path, { required = false } = {}) => {
    const value = obj?.[key];
    if (value === undefined && !required) return;
    if (typeof value !== "string" || value.trim() === "") failures.push(`${label}: ${path} musí být neprázdný text`);
  };
  const checkPattern = (value, pattern, path) => {
    if (typeof value === "string" && pattern && !new RegExp(pattern).test(value)) {
      failures.push(`${label}: ${path} neodpovídá pattern ${pattern}`);
    }
  };

  checkText(buddy, "display_name", "buddy.display_name");
  checkText(buddy, "description", "buddy.description");
  checkText(buddy, "avatar_url", "buddy.avatar_url");
  if (typeof buddy?.avatar_url === "string" && !isValidAllowedUrl(buddy.avatar_url, new Set(["http:", "https:"]))) {
    failures.push(`${label}: buddy.avatar_url musí být validní odkaz s povoleným schématem`);
  }
  checkPattern(buddy?.avatar_url, props.avatar_url?.pattern, "buddy.avatar_url");

  if (buddy?.application !== undefined) {
    const application = buddy.application;
    const spec = props.application ?? {};
    if (!application || typeof application !== "object" || Array.isArray(application)) {
      failures.push(`${label}: buddy.application musí být objekt`);
    } else {
      for (const key of spec.required ?? []) checkText(application, key, `buddy.application.${key}`, { required: true });
      if (Array.isArray(spec.properties?.type?.enum) && !spec.properties.type.enum.includes(application.type)) {
        failures.push(`${label}: buddy.application.type musí být jedno z ${spec.properties.type.enum.join(", ")}`);
      }
      checkText(application, "url", "buddy.application.url");
      if (typeof application.url === "string" && !isValidAllowedUrl(application.url, new Set(["http:", "https:", "tg:", "sgnl:", "whatsapp:"]))) {
        failures.push(`${label}: buddy.application.url musí být validní odkaz s povoleným schématem`);
      }
      checkPattern(application.url, spec.properties?.url?.pattern, "buddy.application.url");
    }
  }

  if (buddy?.recurring_tasks !== undefined) {
    const tasks = buddy.recurring_tasks;
    const spec = props.recurring_tasks ?? {};
    const variants = Array.isArray(spec.anyOf) ? spec.anyOf : [];
    const mapSpec = variants.find((variant) => variant.type === "object") ?? {};
    const arraySpec = variants.find((variant) => variant.type === "array") ?? {};
    if (Array.isArray(tasks)) {
      const itemSpec = arraySpec.items ?? {};
      const seenIds = new Set();
      tasks.forEach((task, index) => {
        const path = `buddy.recurring_tasks[${index}]`;
        if (!task || typeof task !== "object" || Array.isArray(task)) {
          failures.push(`${label}: ${path} musí být objekt`);
          return;
        }
        for (const key of itemSpec.required ?? []) checkText(task, key, `${path}.${key}`, { required: true });
        const idPattern = itemSpec.properties?.id?.pattern;
        if (typeof task.id === "string" && idPattern && !new RegExp(idPattern).test(task.id)) {
          failures.push(`${label}: ${path}.id neodpovídá pattern ${idPattern}`);
        }
        if (typeof task.id === "string" && seenIds.has(task.id)) failures.push(`${label}: ${path}.id ${task.id} je duplicitní`);
        if (typeof task.id === "string") seenIds.add(task.id);
        checkText(task, "description", `${path}.description`);
        checkText(task, "delivery_channel", `${path}.delivery_channel`);
      });
    } else if (tasks && typeof tasks === "object") {
      const itemSpec = mapSpec.additionalProperties ?? {};
      for (const [taskId, task] of Object.entries(tasks)) {
        const idPattern = mapSpec.propertyNames?.pattern;
        if (idPattern && !new RegExp(idPattern).test(taskId)) {
          failures.push(`${label}: buddy.recurring_tasks.${taskId} neodpovídá pattern ${idPattern}`);
        }
        if (!task || typeof task !== "object" || Array.isArray(task)) {
          failures.push(`${label}: buddy.recurring_tasks.${taskId} musí být objekt`);
          continue;
        }
        for (const key of itemSpec.required ?? []) checkText(task, key, `buddy.recurring_tasks.${taskId}.${key}`, { required: true });
        checkText(task, "description", `buddy.recurring_tasks.${taskId}.description`);
        checkText(task, "delivery_channel", `buddy.recurring_tasks.${taskId}.delivery_channel`);
      }
    } else {
      failures.push(`${label}: buddy.recurring_tasks musí být mapa nebo přechodný seznam úkolů`);
    }
  }
  return failures;
}

export function buddyPresentationProjection(buddy) {
  const projection = {};
  for (const key of ["display_name", "description", "avatar_url", "application", "recurring_tasks"]) {
    if (buddy?.[key] !== undefined) projection[key] = buddy[key];
  }
  return projection;
}

// Identity invariant (decision 0051): owner.github_username ↔ mount
// personalspace/<username>_GEN3 ↔ repo <username>/<username>_GEN3 musí souhlasit,
// aby nevznikla nejasná custody hranice. Fail-closed: nesouhlas = prostor se
// nematerializuje (žádné osobní appky, žádný gbrain), jen se nahlásí chyba.
export function identityInvariantIssues(personal, dirName) {
  const issues = [];
  const owner = personal?.owner?.github_username;
  if (!owner) return ["owner.github_username chybí, nelze ověřit identity invariant"];
  const expectedDir = `${owner}${gitMarker}`;
  if (dirName !== expectedDir) {
    issues.push(`mount adresář ${dirName} neodpovídá owner.github_username (${owner}); očekáváno personalspace/${expectedDir}`);
  }
  const expectedMount = `${defaultPersonalspaceMountpoint}/${expectedDir}`;
  if (personal?.repository?.mount_path !== expectedMount) {
    issues.push(`repository.mount_path (${personal?.repository?.mount_path ?? "chybí"}) musí být ${expectedMount}`);
  }
  const expectedRepo = `${owner}/${owner}${gitMarker}`;
  if (personal?.repository?.github_repo !== expectedRepo) {
    issues.push(`repository.github_repo (${personal?.repository?.github_repo ?? "chybí"}) musí být ${expectedRepo}`);
  }
  if (!isLegacyPersonalCustodyConfig(personal)) {
    const gbrainRepo = personal?.gbrain?.repository?.github_repo;
    const gbrainRepoOwner = personal?.gbrain?.repository?.github_repo?.split("/")?.[0];
    if (typeof gbrainRepoOwner !== "string" || gbrainRepoOwner.toLowerCase() !== owner.toLowerCase()) {
      issues.push("gbrain.repository.github_repo musí patřit stejnému GitHub účtu jako Personalspace");
    }
    if (gbrainRepo?.toLowerCase() === expectedRepo.toLowerCase()) {
      issues.push("gbrain.repository.github_repo musí být jiné repo než Personalspace owner repo");
    }
    if (personal?.buddy !== undefined) {
      const buddyRepo = personal?.buddy?.repository?.github_repo;
      const [buddyRepoOwner, buddyRepoName] = typeof buddyRepo === "string"
        ? buddyRepo.split("/")
        : [];
      if (typeof buddyRepoOwner !== "string" || buddyRepoOwner.toLowerCase() !== owner.toLowerCase()) {
        issues.push("buddy.repository.github_repo musí patřit stejnému GitHub účtu jako Personalspace");
      }
      if (
        buddyRepo?.toLowerCase() === expectedRepo.toLowerCase()
        || buddyRepo?.toLowerCase() === gbrainRepo?.toLowerCase()
      ) {
        issues.push("buddy.repository.github_repo musí být jiné repo než Personalspace owner a gbrain repo");
      }
      if (
        typeof buddyRepoName !== "string"
        || personal?.buddy?.slug !== buddyRepoName.toLowerCase()
      ) {
        issues.push("buddy.slug musí odpovídat lower-case názvu Buddy profile repa");
      }
    }
  }
  return issues;
}

function normalizePersonalModuleSlot(slot) {
  if (!slot || typeof slot !== "object" || typeof slot.path !== "string" || slot.path.trim() === "") {
    return null;
  }
  const path = slot.path.replace(/\\/g, "/");
  return {
    slug: path.split("/").filter(Boolean).at(-1) ?? path,
    path,
    category: slot.category ?? null,
    default_access: slot.default_access ?? null,
    required_roles: Array.isArray(slot.required_roles) ? slot.required_roles : [],
    source_of_truth: slot.source_of_truth ?? null,
    repo: slot.repo ?? slot.git?.url ?? null,
    branch: slot.branch ?? slot.git?.branch ?? null,
    notes: typeof slot.notes === "string" ? slot.notes : null,
  };
}

// Readiness stavu osobního modulu — stejná mechanika jako org (decision 0042).
function personalModuleStatus(spaceRoot, slot) {
  if (existsSync(join(spaceRoot, slot.path))) return "available";
  return slot.repo ? "missing_access" : "planned_slot";
}

async function readPersonalManifest(spaceRoot) {
  const manifestPath = join(spaceRoot, "modules.manifest.json");
  if (!existsSync(manifestPath)) return { manifest: null, error: null };
  try {
    return { manifest: await readJson(manifestPath), error: null };
  } catch (error) {
    return { manifest: null, error: error.message };
  }
}

// Projde workspace/<modul>/**/package.json a najde companyascode.app manifesty.
// Vrací syrové {packagePath, app, packageJson} — validace probíhá výš, aby
// nevalidní osobní appka izolovala jen sebe (stejně jako org lane, decision 0043).
async function walkPersonalPackageJson(spaceRoot, current, output) {
  if (!existsSync(current)) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (ignoredWorkspaceDirs.has(entry.name)) continue;
      await walkPersonalPackageJson(spaceRoot, absolutePath, output);
      continue;
    }
    if (entry.isFile() && entry.name === "package.json") {
      output.push(absolutePath);
    }
  }
}

// Bezpečné odvození gbrain zdrojové cesty pro daný prostor.
// - canonical mount je vždy <space>/gbrain (schema const), preferovaný cílový stav;
// - transitional_source_path (additivní pole, decision 0051 přechod) povoluje
//   PŘECHODNĚ ukázat na živý vault MIMO prostor, ale POUZE uvnitř personalspace
//   mountpointu (např. ../examplebuddy-gbrain), dokud fyzická migrace neproběhne.
//   Bounding na personalspace/ (ne na celý root) je tvrdá privátní hranice:
//   přechodný zdroj nikdy nesmí ukázat na organizations/ ani na root — jinak by
//   gbrain browser mohl číst nepersonální obsah. Cesta se resolvuje relativně
//   k prostoru a musí existovat.
export function resolveGbrainSource({ companiesRoot, spaceRoot, personal, personalspaceRoot }) {
  const canonical = join(spaceRoot, "gbrain");
  // Kořen povolené oblasti pro přechodný zdroj = personalspace mountpoint.
  // (Fallback na parent prostoru, kdyby personalspaceRoot nebyl předaný.)
  const boundaryRoot = resolve(personalspaceRoot ?? join(spaceRoot, ".."));
  const transitional = personal?.gbrain?.transitional_source_path;
  if (typeof transitional === "string" && transitional.trim() !== "") {
    const candidate = resolve(spaceRoot, transitional);
    const insideBoundary = candidate === boundaryRoot || candidate.startsWith(`${boundaryRoot}${sep}`);
    if (!insideBoundary) {
      return {
        path: canonical,
        rel: relative(companiesRoot, canonical).split("\\").join("/"),
        mode: "canonical",
        exists: existsSync(canonical),
        transitional_rejected: `gbrain.transitional_source_path (${transitional}) míří mimo personalspace mountpoint; ignorováno`,
      };
    }
    if (existsSync(candidate)) {
      return {
        path: candidate,
        rel: relative(companiesRoot, candidate).split("\\").join("/"),
        mode: "transitional",
        exists: true,
        canonical_rel: relative(companiesRoot, canonical).split("\\").join("/"),
      };
    }
    // Deklarovaný přechodný zdroj neexistuje → spadneme na canonical, ale
    // řekneme to (metadata, žádný obsah).
    return {
      path: canonical,
      rel: relative(companiesRoot, canonical).split("\\").join("/"),
      mode: "canonical",
      exists: existsSync(canonical),
      transitional_missing: transitional,
    };
  }
  return {
    path: canonical,
    rel: relative(companiesRoot, canonical).split("\\").join("/"),
    mode: "canonical",
    exists: existsSync(canonical),
  };
}

function normalizeOwner(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizedText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizeBuddyApplication(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = normalizedText(value.name);
  const type = normalizedText(value.type);
  if (!name || !type) return null;
  return {
    name,
    type,
    url: normalizedText(value.url),
  };
}

function isValidAllowedUrl(value, allowedProtocols) {
  if (
    value !== value.trim()
    || /[\u0000-\u001f\u007f\\]/.test(value)
    || /%(?![0-9a-f]{2})/i.test(value)
  ) return false;
  try {
    const parsed = new URL(value);
    if (!allowedProtocols.has(parsed.protocol)) return false;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return isValidHttpHostname(parsed.hostname) && !isLoopbackHostname(parsed.hostname);
    }
    return Boolean(parsed.protocol);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname) {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized === "0.0.0.0"
    || normalized.startsWith("::ffff:127.")
  ) return true;
  const ipv4 = normalized.split(".");
  return ipv4.length === 4
    && ipv4.every((part) => /^\d{1,3}$/.test(part))
    && Number(ipv4[0]) === 127;
}

function isValidHttpHostname(hostname) {
  if (!hostname || hostname === "." || hostname.startsWith(".") || hostname.endsWith(".")) return false;
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return hostname.split(".").every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9-]+$/i.test(label)
    && !label.startsWith("-")
    && !label.endsWith("-")
  );
}

function normalizeRecurringTasks(value) {
  if (!value || typeof value !== "object") return [];
  const entries = Array.isArray(value)
    ? value.map((task) => [task?.id, task])
    : Object.entries(value);
  return entries
    .filter(([, task]) => task && typeof task === "object" && !Array.isArray(task))
    .map(([id, task]) => ({
      id: normalizedText(id),
      title: normalizedText(task.title),
      schedule_label: normalizedText(task.schedule_label),
      description: normalizedText(task.description),
      delivery_channel: normalizedText(task.delivery_channel),
    }))
    .filter((task) => task.id && task.title && task.schedule_label);
}

// Skenuje personalspace/*/personal.gen3.json a vrací unikátní github_username
// vlastníky (jen metadata, žádný obsah). Autorita je soubor na disku, ne registry.
async function scanPersonalspaceOwners(personalspaceRoot) {
  if (!existsSync(personalspaceRoot)) return [];
  let entries;
  try {
    entries = await readdir(personalspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const owners = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || ignoredSpaceDirs.has(entry.name)) continue;
    const personalPath = join(personalspaceRoot, entry.name, "personal.gen3.json");
    if (!existsSync(personalPath)) continue;
    let personal;
    try {
      personal = await readJson(personalPath);
    } catch {
      continue;
    }
    const owner = normalizeOwner(personal?.owner?.github_username);
    if (owner && !owners.includes(owner)) owners.push(owner);
  }
  return owners;
}

// Který prostor je primární prostor vlastníka mašiny (zobrazí se první, bez owner
// badge). Ostatní jsou nasdílené prostory (owner badge). Scan-first (decision
// 0042): vlastníka určuje VÝHRADNĚ explicitní per-machine override — sken
// personalspace/* vlastníka nikdy neodvozuje, protože nasdílený cizí prostor se
// mountuje identicky jako vlastní a primární prostor odemyká privacy hranice
// (gbrain vault). Fail-closed: bez override žádný prostor není primární.
//   1. options.primaryOwner (explicitní runtime/test override),
//   2. launchpad.gen3.local.json → personalspace_owner (per-machine override),
//   3. jinak žádný primární prostor; sken slouží jen jako nápověda kandidátů
//      ve warningu (žádný prostor = žádný warning).
// Sdílený launchpad.gen3.json vlastníka NEnese (osobní data v shared repu);
// legacy personalspace_owner se ignoruje s jedním deprecation warningem.
async function resolvePrimaryOwner({ companiesRoot, companiesConfig, personalspaceRoot, options, warnings }) {
  if (
    normalizeOwner(companiesConfig?.personalspace_owner) ||
    normalizeOwner(companiesConfig?.personalspace?.owner_github_username)
  ) {
    warnings.push(
      "launchpad.gen3.json: personalspace_owner je zastaralé pole; ve scan-first modelu (decision 0042) se ignoruje (osobní data nepatří do sdíleného configu). Vlastník mašiny se určuje per-machine v launchpad.gen3.local.json.",
    );
  }
  const fromOption = normalizeOwner(options.primaryOwner);
  if (fromOption) return fromOption;
  const fromLocal = normalizeOwner((await readLocalOverrideConfig(companiesRoot, warnings))?.personalspace_owner);
  if (fromLocal) return fromLocal;
  const owners = await scanPersonalspaceOwners(personalspaceRoot);
  if (owners.length > 0) {
    warnings.push(
      `personalspace: primární vlastník mašiny není určen — nastav personalspace_owner v launchpad.gen3.local.json (fail-closed privacy hranice: sken nerozliší vlastní prostor od nasdíleného; kandidáti ze skenu: ${owners.join(", ")}). Zatím není žádný prostor označený jako primární.`,
    );
  }
  return null;
}

export async function discoverPersonalspace(
  companiesRoot = join(import.meta.dirname, "..", ".."),
  options = {},
) {
  const failures = [];
  const warnings = [];
  const presentationWarnings = [];
  const spaces = [];
  const apps = [];
  const invalidApps = [];

  const companiesConfigPath = join(companiesRoot, "launchpad.gen3.json");
  const companiesConfig = existsSync(companiesConfigPath) ? await readJson(companiesConfigPath) : {};
  const mountpoint = companiesConfig?.personalspace_mountpoint ?? defaultPersonalspaceMountpoint;
  const personalspaceRoot = join(companiesRoot, mountpoint);
  const primaryOwner = await resolvePrimaryOwner({
    companiesRoot,
    companiesConfig,
    personalspaceRoot,
    options,
    warnings,
  });

  if (!existsSync(personalspaceRoot)) {
    return { spaces, apps, invalid_apps: invalidApps, failures, warnings, presentation_warnings: presentationWarnings, mountpoint, primary_owner: primaryOwner ?? null };
  }

  const personalSchema = existsSync(personalSchemaPath) ? await readJson(personalSchemaPath) : null;
  const buddyPresentationSchema = existsSync(buddyPresentationSchemaPath) ? await readJson(buddyPresentationSchemaPath) : null;
  const appSchema = existsSync(appSchemaPath) ? await readJson(appSchemaPath) : null;
  if (!personalSchema) failures.push(`Chybí ${relative(companiesRoot, personalSchemaPath)} pro personalspace validaci`);

  let entries;
  try {
    entries = await readdir(personalspaceRoot, { withFileTypes: true });
  } catch (error) {
    failures.push(`${mountpoint}: nejde přečíst personalspace mountpoint: ${error.message}`);
    return { spaces, apps, invalid_apps: invalidApps, failures, warnings, presentation_warnings: presentationWarnings, mountpoint, primary_owner: primaryOwner ?? null };
  }

  const appIds = new Set();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || ignoredSpaceDirs.has(entry.name)) continue;
    const dirName = entry.name;
    const mountPath = `${mountpoint}/${dirName}`;
    const spaceRoot = join(companiesRoot, mountPath);
    const personalPath = join(spaceRoot, "personal.gen3.json");
    // Bez personal.gen3.json to není deklarovaný osobní prostor (může to být jen
    // živý gbrain checkout apod.) — přeskočíme bez failure.
    if (!existsSync(personalPath)) continue;

    let personal;
    try {
      personal = await readJson(personalPath);
    } catch (error) {
      failures.push(`${mountPath}: personal.gen3.json nejde přečíst: ${error.message}`);
      continue;
    }

    const schemaIssues = personalSchema ? validatePersonalConfig(personal, personalSchema, mountPath) : [];
    const identityIssues = identityInvariantIssues(personal, dirName);
    const configIssues = [...schemaIssues, ...identityIssues];
    // Fail-closed: nevalidní config nebo porušený identity invariant → prostor se
    // NEMATERIALIZUJE (žádné osobní appky, žádný gbrain). Jen metadata + failures.
    if (configIssues.length > 0) {
      failures.push(...configIssues.map((issue) => `${mountPath}: ${issue}`));
      spaces.push({
        owner: personal?.owner?.github_username ?? null,
        display_name: personal?.owner?.display_name ?? dirName,
        owner_type: personal?.owner?.type ?? null,
        dir_name: dirName,
        mount_path: mountPath,
        github_repo: personal?.repository?.github_repo ?? null,
        is_owner_primary: false,
        identity_ok: false,
        config_valid: false,
        config_issues: configIssues,
        buddy: null,
        gbrain: null,
        modules: [],
        module_summary: { available: 0, missing_access: 0, planned_slot: 0 },
        app_ids: [],
      });
      continue;
    }
    const legacyCustody = isLegacyPersonalCustodyConfig(personal);
    if (legacyCustody) {
      warnings.push(
        `${mountPath}: legacy neversionovaný Personalspace zůstává dočasně čitelný; `
        + "přejdi na humanandmachines.personal.gen3.v1 podle manual/migrate-personalspace-custody-v1.md",
      );
    }

    const owner = personal.owner.github_username;
    const isPrimary = primaryOwner ? owner === primaryOwner : false;
    // Buddy prezentace je privátní obsah primárního vlastníka. U nasdílených
    // prostorů ji bez explicitní field-level sharing policy ani nevalidujeme,
    // ani nematerializujeme do /api/personalspace.
    const buddyPresentation = isPrimary && personal.buddy
      ? buddyPresentationProjection(personal.buddy)
      : {};
    const presentationIssues = !isPrimary || !personal.buddy
      ? []
      : buddyPresentationSchema
        ? validateBuddyPresentation(buddyPresentation, buddyPresentationSchema, mountPath)
        : ["chybí Launchpad-local Buddy presentation schema"];
    if (personal.buddy && presentationIssues.length > 0) {
      presentationWarnings.push(`${mountPath}: Buddy prezentační metadata se ignorují: ${presentationIssues.join("; ")}`);
    }
    const presentationValid = Boolean(personal.buddy) && isPrimary && presentationIssues.length === 0;

    // modules.manifest.json — identický kontrakt jako org.
    const { manifest, error: manifestError } = await readPersonalManifest(spaceRoot);
    if (manifestError) {
      warnings.push(`${mountPath}: modules.manifest.json nejde přečíst: ${manifestError}`);
    }
    const rawSlots = Array.isArray(manifest?.module_slots) ? manifest.module_slots : [];
    const modules = rawSlots
      .map(normalizePersonalModuleSlot)
      .filter(Boolean)
      .map((slot) => ({ ...slot, status: personalModuleStatus(spaceRoot, slot) }));
    const moduleSummary = modules.reduce(
      (acc, slot) => {
        acc[slot.status] = (acc[slot.status] ?? 0) + 1;
        return acc;
      },
      { available: 0, missing_access: 0, planned_slot: 0 },
    );

    // gbrain zdroj (metadata only — obsah se nikdy nečte tady).
    const gbrainSource = resolveGbrainSource({ companiesRoot, spaceRoot, personal, personalspaceRoot });
    if (gbrainSource.transitional_rejected) warnings.push(`${mountPath}: ${gbrainSource.transitional_rejected}`);

    // Osobní aplikace: sken workspace/<modul>/**/package.json.
    const workspaceRoot = join(spaceRoot, personal.workspace_path ?? "workspace");
    const packagePaths = [];
    await walkPersonalPackageJson(spaceRoot, workspaceRoot, packagePaths);
    const spaceAppIds = [];
    for (const absolutePackagePath of packagePaths.sort((a, b) => a.localeCompare(b))) {
      let packageJson;
      try {
        packageJson = await readJson(absolutePackagePath);
      } catch (error) {
        warnings.push(`${relative(companiesRoot, absolutePackagePath)}: package.json nejde přečíst: ${error.message}`);
        continue;
      }
      const app = packageJson.companyascode?.app;
      if (!app) continue;
      const packagePath = relative(companiesRoot, absolutePackagePath).split("\\").join("/");
      const manifestIssues = [];
      if (appSchema) {
        validateAppManifest({ app, packageJson, packagePath, schema: appSchema, failures: manifestIssues });
      }
      // Osobní aplikace deklaruje company = owner (osobní GitHub účet).
      if (typeof app.company === "string" && app.company !== owner) {
        manifestIssues.push(`${packagePath}: companyascode.app.company musí být ${owner} (osobní prostor ${dirName})`);
      }
      const runtimeId = personalAppRuntimeId(dirName, typeof app.id === "string" ? app.id : `invalid:${packagePath}`);
      const base = {
        id: runtimeId,
        app_id: typeof app.id === "string" ? app.id : null,
        title: typeof app.title === "string" && app.title.trim() !== "" ? app.title : packagePath,
        company: owner,
        company_display_name: personal.owner.display_name ?? owner,
        module: typeof app.module === "string" ? app.module : null,
        surface: typeof app.surface === "string" ? app.surface : null,
        port: Number.isInteger(app.port) ? app.port : null,
        host: typeof app.host === "string" ? app.host : null,
        health_path: typeof app.health_path === "string" ? app.health_path : null,
        dev_script: typeof app.dev_script === "string" ? app.dev_script : null,
        package_path: packagePath,
        cwd: dirname(packagePath),
        tags: Array.isArray(app.tags) ? app.tags.filter((tag) => typeof tag === "string") : [],
        // Privátní surface příznaky — použité pro filtrování z každého
        // org-scoped / shared výstupu a pro Private badge v UI.
        personal: true,
        surface_scope: "private",
        space: dirName,
        space_mount_path: mountPath,
        space_owner: owner,
      };
      // App id kolize (i napříč prostory) → izolace jako invalid (decision 0043).
      if (base.app_id && appIds.has(runtimeId)) {
        manifestIssues.push(`${packagePath}: personalspace app id ${base.app_id} koliduje v runtime namespace`);
      }
      if (manifestIssues.length > 0) {
        warnings.push(...manifestIssues.map((issue) => `${issue} (invalid personal app manifest)`));
        invalidApps.push({
          ...base,
          manifest_state: "invalid_manifest",
          manifest_issues: manifestIssues,
        });
        continue;
      }
      appIds.add(runtimeId);
      spaceAppIds.push(runtimeId);
      apps.push(base);
    }

    spaces.push({
      owner,
      display_name: personal.owner.display_name ?? owner,
      owner_type: personal.owner.type ?? null,
      dir_name: dirName,
      mount_path: mountPath,
      github_repo: personal.repository.github_repo,
      personal_schema_version: personal.schema_version ?? "legacy-gen3-unversioned",
      is_owner_primary: isPrimary,
      identity_ok: true,
      config_valid: true,
      config_issues: [],
      buddy: personal.buddy
        ? {
            slug: personal.buddy.slug,
            display_name: presentationValid ? normalizedText(buddyPresentation.display_name) : null,
            description: presentationValid ? normalizedText(buddyPresentation.description) : null,
            avatar_url: presentationValid ? normalizedText(buddyPresentation.avatar_url) : null,
            application: presentationValid ? normalizeBuddyApplication(buddyPresentation.application) : null,
            recurring_tasks: presentationValid ? normalizeRecurringTasks(buddyPresentation.recurring_tasks) : [],
            gbrain_path: personal.buddy.gbrain_path,
          }
        : null,
      gbrain: {
        // Kanonický mount vždy <space>/gbrain; source je aktuální (možná přechodný) vault.
        canonical_rel: relative(companiesRoot, join(spaceRoot, "gbrain")).split("\\").join("/"),
        source_rel: gbrainSource.rel,
        mode: gbrainSource.mode,
        exists: gbrainSource.exists,
        default_shared: personal.gbrain.default_shared,
        human_editor: personal.gbrain.human_editor,
        agent_access: personal.gbrain.agent_access,
        repository: personal.gbrain.repository
          ? {
              github_repo: personal.gbrain.repository.github_repo,
              visibility: personal.gbrain.repository.visibility,
              mount_strategy: personal.gbrain.repository.mount_strategy,
            }
          : null,
        software: personal.gbrain.software
          ? {
              github_repo: personal.gbrain.software.github_repo,
              install_source: personal.gbrain.software.install_source,
            }
          : null,
        transitional_source_path: personal.gbrain.transitional_source_path ?? null,
        transitional_missing: gbrainSource.transitional_missing ?? null,
      },
      modules,
      module_summary: moduleSummary,
      app_ids: spaceAppIds,
    });
  }

  // Řazení prostorů: primární prostor vlastníka mašiny první, pak nasdílené
  // prostory abecedně. Nevalidní prostory (identity fail) až nakonec.
  spaces.sort((a, b) => {
    if (a.is_owner_primary !== b.is_owner_primary) return a.is_owner_primary ? -1 : 1;
    if (a.config_valid !== b.config_valid) return a.config_valid ? -1 : 1;
    return String(a.dir_name).localeCompare(String(b.dir_name));
  });

  return {
    spaces,
    apps,
    invalid_apps: invalidApps,
    failures,
    warnings,
    presentation_warnings: presentationWarnings,
    mountpoint,
    primary_owner: primaryOwner ?? null,
  };
}
