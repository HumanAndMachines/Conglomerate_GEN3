import { createHash } from "node:crypto";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  discoverLaunchpadApps,
  organizationRelativePathIssue,
  readJson,
} from "../launchpad/src/discovery-lib.mjs";
import {
  normalizeOrganizationSlotPath,
  organizationSlotTeams,
} from "../launchpad/src/organization-slot-scope-lib.mjs";
import { detectLazurioRoot } from "./lib.mjs";

export const LAZURIO_SEARCH_RESULT_SCHEMA_VERSION = "lazurio.search.results.v1";
export const LAZURIO_SEARCH_STATUS_SCHEMA_VERSION = "lazurio.search.status.v1";
export const LAZURIO_SEARCH_SCOPES_SCHEMA_VERSION = "lazurio.search.scopes.v1";
export const QMD_CONTRACT_VERSION = "lazurio.qmd.adapter.v1";
export const QMD_MIN_VERSION = "2.5.3";
const QMD_SOURCE_FINGERPRINT_ALGORITHM = "sha256-path-content-v1";

const searchScopesUrl = new URL("./search-scopes.v1.json", import.meta.url);
const githubUsernamePattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const portableIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const textExtensions = [
  "md",
  "mdx",
  "txt",
  "astro",
  "ts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "css",
  "json",
  "yaml",
  "yml",
  "toml",
];
const textExtensionSet = new Set(textExtensions);
const excludedGlobs = [
  "!**/.git/**",
  "!**/.worktrees/**",
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/out/**",
  "!**/.cache/**",
  "!**/coverage/**",
  "!**/private/**",
  "!**/secrets/**",
  "!**/.env",
  "!**/.env.*",
];
const qmdIgnorePatterns = [
  "**/.worktrees/**",
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/private/**",
  "**/secrets/**",
  "**/.env",
  "**/.env.*",
];
const excludedDirectoryNames = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "build",
  "out",
  ".cache",
  "coverage",
  "private",
  "secrets",
]);

let cachedSearchScopes;

export class LazurioSearchError extends Error {
  constructor(message, { code = "search_failed", exitCode = 2 } = {}) {
    super(message);
    this.name = "LazurioSearchError";
    this.code = code;
    this.lazurioExitCode = exitCode;
  }
}

export async function loadLazurioSearchScopes() {
  if (!cachedSearchScopes) {
    cachedSearchScopes = JSON.parse(await readFile(searchScopesUrl, "utf8"));
    validateSearchScopes(cachedSearchScopes);
  }
  return cachedSearchScopes;
}

export async function discoverLazurioSearchScope({
  root = process.cwd(),
  scopeId = "lazurio",
  principalId,
  discover = discoverLaunchpadApps,
} = {}) {
  const detected = detectLazurioRoot(root);
  if (detected.kind !== "launchpad_root" || detected.manifestObservation !== "present") {
    throw new LazurioSearchError(
      "Search pilot vyžaduje kanonický Launchpad root.",
      { code: "launchpad_root_required" },
    );
  }

  const registry = await loadLazurioSearchScopes();
  const scope = registry.scopes.find((entry) => entry.id === scopeId);
  if (!scope) {
    throw new LazurioSearchError(
      `Neznámý search scope '${scopeId}'.`,
      { code: "unknown_search_scope" },
    );
  }

  const discovery = await discover(detected.absolutePath);
  const organization = discovery.organizations.find(
    (entry) => entry.slug === scope.organization_slug && entry.organization_kind === "organization",
  );
  if (!organization || organization.status !== "mounted") {
    throw new LazurioSearchError(
      `Organization ${scope.organization_slug} není kanonicky namountovaná.`,
      { code: "organization_not_mounted", exitCode: 3 },
    );
  }
  const scopedDiscoveryFailures = (discovery.failures ?? []).filter(
    (failure) => failure.startsWith(`${organization.path}:`),
  );
  if (scopedDiscoveryFailures.length > 0) {
    throw new LazurioSearchError(
      `Organization discovery není zelené: ${scopedDiscoveryFailures.join("; ")}`,
      { code: "organization_discovery_failed", exitCode: 3 },
    );
  }

  const observedPrincipal = normalizedPrincipal(
    principalId ?? discovery.local_config?.personalspace_owner,
  );
  if (!observedPrincipal) {
    throw new LazurioSearchError(
      "Search index nelze izolovat: launchpad.gen3.local.json nemá platného personalspace_owner.",
      { code: "principal_not_configured", exitCode: 3 },
    );
  }
  if (!scope.pilot_principals.includes(observedPrincipal)) {
    throw new LazurioSearchError(
      `Principál ${observedPrincipal} není deklarovaný pilot scope ${scope.id}.`,
      { code: "principal_outside_pilot", exitCode: 3 },
    );
  }

  const organizationRoot = join(detected.absolutePath, organization.path);
  const manifest = await readJson(join(organizationRoot, "modules.manifest.json"));
  if (manifest?.company !== scope.organization_slug) {
    throw new LazurioSearchError(
      "Search scope neodpovídá company identitě v modules.manifest.json.",
      { code: "organization_identity_mismatch", exitCode: 3 },
    );
  }
  const slots = new Map(
    (Array.isArray(manifest.module_slots) ? manifest.module_slots : [])
      .map((slot) => [normalizeOrganizationSlotPath(slot?.path), slot]),
  );

  const sources = scope.sources.map((source) => {
    const repositoryPath = normalizeOrganizationSlotPath(source.repository_path);
    const sourcePath = normalizeOrganizationSlotPath(source.path);
    const slot = slots.get(repositoryPath);
    if (!slot) {
      throw new LazurioSearchError(
        `Pilotní source ${source.id} odkazuje na nedeklarované repo ${source.repository_path}.`,
        { code: "search_source_not_declared", exitCode: 3 },
      );
    }
    if (!organizationSlotTeams(slot, repositoryPath).includes(scope.required_team)) {
      throw new LazurioSearchError(
        `Pilotní source ${source.id} není deklarovaný v Teamu ${scope.required_team}.`,
        { code: "search_source_team_mismatch", exitCode: 3 },
      );
    }
    if (!(sourcePath === repositoryPath || sourcePath.startsWith(`${repositoryPath}/`))) {
      throw new LazurioSearchError(
        `Pilotní source ${source.id} uniká mimo deklarované repo ${repositoryPath}.`,
        { code: "search_source_repository_escape", exitCode: 3 },
      );
    }
    for (const path of [repositoryPath, sourcePath]) {
      const issue = organizationRelativePathIssue({ organizationRoot, path });
      if (issue) {
        throw new LazurioSearchError(
          `Pilotní source ${source.id} má nebezpečnou cestu: ${issue}.`,
          { code: "search_source_path_rejected", exitCode: 3 },
        );
      }
    }

    const repositoryAbsolutePath = join(organizationRoot, repositoryPath);
    const absolutePath = join(organizationRoot, sourcePath);
    assertCanonicalDirectory(repositoryAbsolutePath, organizationRoot, `${source.id} repository`);
    assertCanonicalDirectory(absolutePath, organizationRoot, `${source.id} source`);
    if (!existsSync(join(repositoryAbsolutePath, ".git"))) {
      throw new LazurioSearchError(
        `Pilotní source ${source.id} nemá materializovaný Git repozitář.`,
        { code: "search_repository_not_materialized", exitCode: 3 },
      );
    }

    return {
      id: source.id,
      context: source.context,
      repository_path: repositoryPath,
      path: sourcePath,
      declared_teams: organizationSlotTeams(slot, repositoryPath),
      repository_absolute_path: repositoryAbsolutePath,
      absolute_path: absolutePath,
    };
  });

  return {
    id: scope.id,
    display_name: scope.display_name,
    organization: {
      slug: organization.slug,
      path: organization.path,
      kind: organization.organization_kind,
    },
    principal: {
      github_username: observedPrincipal,
      source: principalId ? "explicit_test_injection" : "launchpad.gen3.local.json",
    },
    team: scope.required_team,
    access: { ...scope.access },
    sources,
    root: detected.absolutePath,
  };
}

export async function searchLazurioExact({
  root = process.cwd(),
  scopeId = "lazurio",
  principalId,
  query,
  limit = 50,
  spawn = spawnCommand,
  discover,
} = {}) {
  const normalizedQuery = normalizeQuery(query);
  const normalizedLimit = normalizeLimit(limit);
  const scope = await discoverLazurioSearchScope({ root, scopeId, principalId, discover });
  const matches = [];

  for (const source of scope.sources) {
    const result = spawn("rg", rgSearchArgs(normalizedQuery), {
      cwd: source.absolute_path,
      env: rgEnvironment(),
    });
    if (result.error) {
      throw new LazurioSearchError(
        `Exact search nelze spustit: ${safeCommandFailure(result.error.message)}.`,
        { code: "rg_unavailable", exitCode: 3 },
      );
    }
    if (![0, 1].includes(result.status)) {
      throw new LazurioSearchError(
        `Exact search selhal pro source ${source.id}: ${safeCommandFailure(result.stderr)}.`,
        { code: "rg_failed", exitCode: 3 },
      );
    }
    matches.push(...parseRipgrepMatches(result.stdout, { scope, source }));
  }

  matches.sort((left, right) =>
    left.provenance.source_id.localeCompare(right.provenance.source_id)
      || left.path.localeCompare(right.path)
      || left.line - right.line
      || left.column - right.column,
  );
  const selected = matches.slice(0, normalizedLimit);
  return {
    schema_version: LAZURIO_SEARCH_RESULT_SCHEMA_VERSION,
    mode: "exact",
    query: normalizedQuery,
    freshness: { status: "live", reason: "ripgrep_reads_current_filesystem" },
    scope: publicScope(scope),
    result_count: selected.length,
    truncated: matches.length > selected.length,
    results: selected,
  };
}

export async function buildLazurioSearchStatus({
  root = process.cwd(),
  scopeId = "lazurio",
  principalId,
  spawn = spawnCommand,
  discover,
} = {}) {
  const scope = await discoverLazurioSearchScope({ root, scopeId, principalId, discover });
  const snapshot = await buildSourceSnapshot(scope, { spawn });
  const layout = qmdStorageLayout(scope);
  const qmd = qmdRuntimeStatus({ layout, spawn });
  const state = await readLocalIndexState(layout.state_path);
  const freshness = qmd.index.state !== "present"
    ? { status: "absent", reason: "qmd_index_absent" }
    : snapshot.status !== "available" || !snapshot.fingerprint
      ? { status: "not_evaluated", reason: snapshot.reason }
    : !state
      ? { status: "not_evaluated", reason: "lazurio_update_state_absent" }
      : state.source_fingerprint_algorithm !== QMD_SOURCE_FINGERPRINT_ALGORITHM
        ? { status: "stale", reason: "source_fingerprint_algorithm_unsupported" }
        : state.source_fingerprint === snapshot.fingerprint
          ? { status: "fresh", reason: "source_snapshot_matches_last_update" }
          : { status: "stale", reason: "source_snapshot_changed_since_update" };

  return {
    schema_version: LAZURIO_SEARCH_STATUS_SCHEMA_VERSION,
    scope: publicScope(scope),
    exact: {
      status: snapshot.status,
      reason: snapshot.reason,
      file_count: snapshot.file_count,
      freshness: "live",
    },
    qmd: {
      ...qmd,
      freshness,
      last_successful_update: state?.updated_at ?? null,
      last_successful_embed: state?.embedded_at ?? null,
    },
  };
}

export async function updateLazurioQmdIndex({
  root = process.cwd(),
  scopeId = "lazurio",
  principalId,
  embed = false,
  spawn = spawnCommand,
  discover,
} = {}) {
  const scope = await discoverLazurioSearchScope({ root, scopeId, principalId, discover });
  const layout = qmdStorageLayout(scope);
  const runtime = qmdRuntimeStatus({ layout, spawn, checkConfiguredRuntime: false });
  requireAvailableQmd(runtime);
  await materializeQmdConfig(scope, layout);
  const beforeSnapshot = await buildSourceSnapshot(scope, { spawn });
  if (beforeSnapshot.status !== "available" || !beforeSnapshot.fingerprint) {
    throw new LazurioSearchError(
      `QMD update nelze bezpečně spustit: source snapshot není dostupný (${beforeSnapshot.reason}).`,
      { code: "source_snapshot_unavailable", exitCode: 3 },
    );
  }

  const update = runQmd(layout, ["update"], spawn);
  if (update.status !== 0) {
    throw new LazurioSearchError(
      `QMD update selhal: ${safeCommandFailure(update.stderr)}.`,
      { code: "qmd_update_failed", exitCode: 3 },
    );
  }
  let embeddedAt = null;
  if (embed) {
    const embedding = runQmd(layout, ["embed", "--chunk-strategy", "auto"], spawn);
    if (embedding.status !== 0) {
      throw new LazurioSearchError(
        `QMD embed selhal: ${safeCommandFailure(embedding.stderr)}.`,
        { code: "qmd_embed_failed", exitCode: 3 },
      );
    }
    embeddedAt = new Date().toISOString();
  }
  const afterSnapshot = await buildSourceSnapshot(scope, { spawn });
  if (afterSnapshot.status !== "available" || !afterSnapshot.fingerprint) {
    throw new LazurioSearchError(
      `QMD index se aktualizoval, ale source freshness nelze bezpečně uložit (${afterSnapshot.reason}).`,
      { code: "source_snapshot_unavailable", exitCode: 3 },
    );
  }
  if (beforeSnapshot.fingerprint !== afterSnapshot.fingerprint) {
    throw new LazurioSearchError(
      "Source se během QMD update změnil; fresh state nebyl publikovaný. Spusť update znovu.",
      { code: "source_changed_during_qmd_update", exitCode: 3 },
    );
  }
  const state = {
    schema_version: "lazurio.qmd.local-state.v1",
    scope_id: scope.id,
    organization_slug: scope.organization.slug,
    principal_github_username: scope.principal.github_username,
    source_fingerprint_algorithm: QMD_SOURCE_FINGERPRINT_ALGORITHM,
    source_fingerprint: afterSnapshot.fingerprint,
    updated_at: new Date().toISOString(),
    embedded_at: embeddedAt,
  };
  await mkdir(dirname(layout.state_path), { recursive: true });
  await writeFile(layout.state_path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return buildLazurioSearchStatus({ root, scopeId, principalId, spawn, discover });
}

export async function searchLazurioQmd({
  root = process.cwd(),
  scopeId = "lazurio",
  principalId,
  query,
  mode = "lexical",
  limit = 20,
  spawn = spawnCommand,
  discover,
} = {}) {
  const normalizedQuery = normalizeQuery(query);
  const normalizedLimit = normalizeLimit(limit);
  if (!new Set(["lexical", "semantic", "hybrid"]).has(mode)) {
    throw new LazurioSearchError(`Neznámý QMD režim '${mode}'.`, { code: "unknown_search_mode" });
  }
  const scope = await discoverLazurioSearchScope({ root, scopeId, principalId, discover });
  const layout = qmdStorageLayout(scope);
  const runtime = qmdRuntimeStatus({ layout, spawn });
  requireAvailableQmd(runtime);
  if (runtime.index.state !== "present") {
    throw new LazurioSearchError(
      "QMD index ještě neexistuje; spusť `lazurio search --update`.",
      { code: "qmd_index_absent", exitCode: 3 },
    );
  }
  const command = mode === "lexical" ? "search" : mode === "semantic" ? "vsearch" : "query";
  const result = runQmd(layout, [command, normalizedQuery, "--json", "-n", String(normalizedLimit)], spawn);
  if (result.status !== 0) {
    throw new LazurioSearchError(
      `QMD ${mode} search selhal: ${safeCommandFailure(result.stderr)}.`,
      { code: "qmd_query_failed", exitCode: 3 },
    );
  }
  const parsed = parseQmdJson(result.stdout);
  const normalizedResults = parsed.map((entry) => normalizeQmdResult(entry, scope)).filter(Boolean);
  const state = await readLocalIndexState(layout.state_path);
  return {
    schema_version: LAZURIO_SEARCH_RESULT_SCHEMA_VERSION,
    mode,
    query: normalizedQuery,
    freshness: !state
      ? { status: "not_evaluated", reason: "lazurio_update_state_absent" }
      : state.source_fingerprint_algorithm !== QMD_SOURCE_FINGERPRINT_ALGORITHM
        ? { status: "not_evaluated", reason: "source_fingerprint_algorithm_unsupported" }
        : { status: "last_updated", reason: "qmd_local_state", updated_at: state.updated_at },
    scope: publicScope(scope),
    result_count: normalizedResults.length,
    truncated: normalizedResults.length >= normalizedLimit,
    results: normalizedResults,
  };
}

export function qmdStorageLayout(scope) {
  const organization = safeStorageSegment(scope.organization.slug, "organization slug");
  const principal = safeStorageSegment(scope.principal.github_username, "principal username");
  const indexName = `lazurio-${organization}-${principal}`.toLowerCase();
  const localRoot = join(scope.root, ".cache", "lazurio", "qmd");
  return {
    contract_version: QMD_CONTRACT_VERSION,
    index_name: indexName,
    config_dir: join(localRoot, "config"),
    cache_home: join(localRoot, "cache"),
    config_path: join(localRoot, "config", `${indexName}.yml`),
    database_path: join(localRoot, "cache", "qmd", `${indexName}.sqlite`),
    state_path: join(localRoot, "state", `${indexName}.json`),
    root: scope.root,
  };
}

export async function materializeQmdConfig(scope, layout = qmdStorageLayout(scope)) {
  assertLocalStorageLayout(layout);
  await assertQmdSourceTreesSafe(scope);
  await mkdir(layout.config_dir, { recursive: true });
  await mkdir(layout.cache_home, { recursive: true });
  const config = {
    global_context: `${scope.display_name} search pilot v1. Organization a Principal scope jsou fyzicky izolované Lazurio adapterem.`,
    collections: Object.fromEntries(scope.sources.map((source) => [source.id, {
      path: source.absolute_path,
      pattern: `**/*.{${textExtensions.join(",")}}`,
      ignore: qmdIgnorePatterns,
      includeByDefault: true,
      context: { "/": source.context },
    }])),
  };
  await writeFile(layout.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { config, path: layout.config_path };
}

async function assertQmdSourceTreesSafe(scope) {
  for (const source of scope.sources) {
    await walk(source.absolute_path, realpathSync(source.absolute_path));
  }

  async function walk(directory, canonicalSourceRoot) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new LazurioSearchError("QMD source tree nelze bezpečně přečíst.", {
        code: "qmd_source_unreadable",
        exitCode: 3,
      });
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let canonicalTarget;
        try {
          canonicalTarget = realpathSync(entryPath);
        } catch {
          throw new LazurioSearchError("QMD source tree obsahuje rozbitý symlink; indexace je fail-closed.", {
            code: "qmd_source_symlink",
            exitCode: 3,
          });
        }
        if (!isPathInside(canonicalSourceRoot, canonicalTarget)) {
          throw new LazurioSearchError("QMD source tree obsahuje symlink mimo deklarovaný source; indexace je fail-closed.", {
            code: "qmd_source_symlink",
            exitCode: 3,
          });
        }
        // QMD's standard filesystem scan uses followSymbolicLinks: false.
        // Keep safe in-source links out of this preflight too, so they cannot
        // duplicate canonical content already reachable beneath the source.
        continue;
      }
      if (entry.isDirectory() && !excludedDirectoryNames.has(entry.name)) {
        await walk(entryPath, canonicalSourceRoot);
      }
      if (entry.isFile() && textExtensionSet.has(extname(entry.name).slice(1).toLowerCase())) {
        await assertTextFile(entryPath);
      }
    }
  }

  async function assertTextFile(path) {
    let handle;
    try {
      handle = await open(path, "r");
      const sample = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      if (sample.subarray(0, bytesRead).includes(0)) {
        throw new LazurioSearchError("QMD source tree obsahuje binární obsah s textovou příponou.", {
          code: "qmd_source_binary",
          exitCode: 3,
        });
      }
    } catch (error) {
      if (error instanceof LazurioSearchError) throw error;
      throw new LazurioSearchError("QMD textový source nelze bezpečně přečíst.", {
        code: "qmd_source_unreadable",
        exitCode: 3,
      });
    } finally {
      await handle?.close();
    }
  }
}

function validateSearchScopes(registry) {
  if (registry?.schema_version !== LAZURIO_SEARCH_SCOPES_SCHEMA_VERSION || !Array.isArray(registry.scopes)) {
    throw new Error("lazurio/search-scopes.v1.json nemá podporovaný schema kontrakt.");
  }
  const scopeIds = new Set();
  for (const scope of registry.scopes) {
    if (!portableIdPattern.test(scope?.id ?? "") || scopeIds.has(scope.id)) {
      throw new Error("Search scope potřebuje unikátní portable id.");
    }
    scopeIds.add(scope.id);
    if (!Array.isArray(scope.pilot_principals) || scope.pilot_principals.some((id) => !normalizedPrincipal(id))) {
      throw new Error(`Search scope ${scope.id} má neplatný seznam pilot_principals.`);
    }
    if (!Array.isArray(scope.sources) || scope.sources.length === 0) {
      throw new Error(`Search scope ${scope.id} nemá explicitní sources.`);
    }
    const sourceIds = new Set();
    for (const source of scope.sources) {
      if (!portableIdPattern.test(source?.id ?? "") || sourceIds.has(source.id)) {
        throw new Error(`Search scope ${scope.id} má neplatné nebo duplicitní source id.`);
      }
      sourceIds.add(source.id);
      for (const path of [source.repository_path, source.path]) {
        if (typeof path !== "string" || path.trim() !== path || isAbsolute(path) || path.split("/").some((part) => ["", ".", ".."].includes(part))) {
          throw new Error(`Search source ${source.id} má nebezpečnou deklarovanou cestu.`);
        }
      }
    }
  }
}

function assertCanonicalDirectory(path, organizationRoot, label) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    throw new LazurioSearchError(`${label} není materializovaný adresář.`, {
      code: "search_source_absent",
      exitCode: 3,
    });
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new LazurioSearchError(`${label} musí být kanonický adresář, ne symlink.`, {
      code: "search_source_non_canonical",
      exitCode: 3,
    });
  }
  const canonicalRoot = realpathSync(organizationRoot);
  const canonicalPath = realpathSync(path);
  if (!isPathInside(canonicalRoot, canonicalPath)) {
    throw new LazurioSearchError(`${label} uniká mimo Organization root.`, {
      code: "search_source_escape",
      exitCode: 3,
    });
  }
}

function rgSearchArgs(query) {
  return [
    "--no-config",
    "--json",
    "--fixed-strings",
    "--smart-case",
    "--no-ignore-parent",
    "--no-messages",
    ...textExtensions.flatMap((extension) => ["--glob", `*.${extension}`]),
    ...excludedGlobs.flatMap((glob) => ["--glob", glob]),
    "--",
    query,
    ".",
  ];
}

function rgFilesArgs() {
  return [
    "--no-config",
    "--files",
    "--no-ignore-parent",
    "--no-messages",
    ...textExtensions.flatMap((extension) => ["--glob", `*.${extension}`]),
    ...excludedGlobs.flatMap((glob) => ["--glob", glob]),
    ".",
  ];
}

function rgEnvironment() {
  const environment = { ...process.env };
  delete environment.RIPGREP_CONFIG_PATH;
  return environment;
}

function parseRipgrepMatches(stdout, { scope, source }) {
  const matches = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new LazurioSearchError("rg vrátil neplatný JSON stream.", { code: "rg_invalid_output" });
    }
    if (event.type !== "match") continue;
    const relativePath = normalizeRgPath(event.data?.path?.text);
    const absolutePath = resolve(source.absolute_path, relativePath);
    if (!isPathInside(source.absolute_path, absolutePath)) {
      throw new LazurioSearchError("rg vrátil výsledek mimo deklarovaný source.", {
        code: "rg_result_escape",
        exitCode: 3,
      });
    }
    const submatches = Array.isArray(event.data?.submatches) && event.data.submatches.length > 0
      ? event.data.submatches
      : [{ start: 0, end: 0 }];
    for (const submatch of submatches) {
      matches.push({
        path: joinPosix(source.path, relativePath),
        repository_relative_path: joinPosix(relative(source.repository_absolute_path, absolutePath)),
        line: event.data?.line_number ?? 1,
        column: Number.isInteger(submatch.start) ? submatch.start + 1 : 1,
        text: String(event.data?.lines?.text ?? "").replace(/\r?\n$/, ""),
        provenance: resultProvenance(scope, source),
      });
    }
  }
  return matches;
}

function normalizeRgPath(path) {
  const normalized = String(path ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => ["", ".", ".."].includes(part))) {
    throw new LazurioSearchError("rg vrátil nebezpečnou relativní cestu.", {
      code: "rg_invalid_path",
      exitCode: 3,
    });
  }
  return normalized;
}

async function buildSourceSnapshot(scope, { spawn }) {
  const rows = [];
  for (const source of scope.sources) {
    const result = spawn("rg", rgFilesArgs(), { cwd: source.absolute_path, env: rgEnvironment() });
    if (result.error || ![0, 1].includes(result.status)) {
      return {
        status: "not_evaluated",
        reason: result.error ? "rg_unavailable" : "rg_files_failed",
        file_count: 0,
        fingerprint: null,
      };
    }
    const files = String(result.stdout ?? "").split("\n").filter(Boolean).map(normalizeRgPath).sort();
    for (const file of files) {
      const filePath = resolve(source.absolute_path, file);
      if (!isPathInside(source.absolute_path, filePath)) continue;
      const metadata = await stat(filePath);
      if (!metadata.isFile()) continue;
      const contentFingerprint = createHash("sha256")
        .update(await readFile(filePath))
        .digest("hex");
      rows.push(`${source.id}\0${file}\0${contentFingerprint}`);
    }
  }
  return {
    status: "available",
    reason: "manifest_scoped_text_files_observed",
    file_count: rows.length,
    fingerprint: createHash("sha256").update(rows.join("\n")).digest("hex"),
  };
}

function qmdRuntimeStatus({ layout, spawn, checkConfiguredRuntime = true }) {
  const versionResult = spawn("qmd", ["--version"], { cwd: layout.root, env: qmdEnvironment(layout) });
  if (versionResult.error) {
    return qmdStatusDocument(layout, {
      status: "unavailable",
      reason: "qmd_not_found",
      version: null,
    });
  }
  const version = parseQmdVersion(versionResult.stdout || versionResult.stderr);
  if (versionResult.status !== 0 || !version) {
    return qmdStatusDocument(layout, {
      status: "unavailable",
      reason: "qmd_version_unreadable",
      version: null,
    });
  }
  if (!supportedQmdVersion(version)) {
    return qmdStatusDocument(layout, {
      status: "unavailable",
      reason: "unsupported_qmd_version",
      version,
    });
  }
  if (!checkConfiguredRuntime || !existsSync(layout.config_path)) {
    return qmdStatusDocument(layout, {
      status: "available",
      reason: existsSync(layout.config_path) ? "qmd_version_supported" : "qmd_index_not_configured",
      version,
    });
  }
  const statusResult = runQmd(layout, ["status"], spawn);
  if (statusResult.status !== 0) {
    const combined = `${statusResult.stderr ?? ""}\n${statusResult.stdout ?? ""}`;
    return qmdStatusDocument(layout, {
      status: "unavailable",
      reason: combined.includes("NODE_MODULE_VERSION") || combined.includes("better_sqlite3.node")
        ? "qmd_native_abi_mismatch"
        : "qmd_runtime_error",
      version,
    });
  }
  return qmdStatusDocument(layout, { status: "available", reason: "qmd_status_ok", version });
}

function qmdStatusDocument(layout, { status, reason, version }) {
  return {
    contract_version: QMD_CONTRACT_VERSION,
    minimum_version: QMD_MIN_VERSION,
    status,
    reason,
    version,
    index: {
      name: layout.index_name,
      state: existsSync(layout.database_path) ? "present" : "absent",
      config_state: existsSync(layout.config_path) ? "present" : "absent",
    },
  };
}

function requireAvailableQmd(runtime) {
  if (runtime.status === "available") return;
  throw new LazurioSearchError(
    `QMD není použitelné (${runtime.reason}); exact režim zůstává dostupný.`,
    { code: runtime.reason, exitCode: 3 },
  );
}

function runQmd(layout, args, spawn) {
  return spawn("qmd", ["--index", layout.index_name, ...args], {
    cwd: layout.root,
    env: qmdEnvironment(layout),
  });
}

function qmdEnvironment(layout) {
  const environment = { ...process.env };
  delete environment.INDEX_PATH;
  return {
    ...environment,
    NO_COLOR: "1",
    QMD_CONFIG_DIR: layout.config_dir,
    XDG_CACHE_HOME: layout.cache_home,
  };
}

function parseQmdVersion(output) {
  const match = String(output ?? "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function supportedQmdVersion(version) {
  const parsed = version.split(".").map(Number);
  const minimum = QMD_MIN_VERSION.split(".").map(Number);
  if (parsed[0] !== 2) return false;
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] > minimum[index]) return true;
    if (parsed[index] < minimum[index]) return false;
  }
  return true;
}

function parseQmdJson(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? ""));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.results)) return parsed.results;
  } catch {
    // Fall through to a typed error without exposing raw backend output.
  }
  throw new LazurioSearchError("QMD vrátil neplatný JSON výstup.", { code: "qmd_invalid_output" });
}

function normalizeQmdResult(entry, scope) {
  const file = typeof entry?.file === "string" ? entry.file : typeof entry?.path === "string" ? entry.path : null;
  let documentUri;
  try {
    documentUri = new URL(file);
  } catch {
    return null;
  }
  if (documentUri.protocol !== "qmd:" || documentUri.username || documentUri.password || documentUri.port) {
    return null;
  }
  const source = scope.sources.find((candidate) => candidate.id === documentUri.hostname);
  if (!source) return null;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(documentUri.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
  const relativePath = normalizeRgPath(decodedPath);
  const absolutePath = resolveCurrentQmdResultFile(source, relativePath);
  if (!absolutePath) return null;
  return {
    path: joinPosix(source.path, relativePath),
    repository_relative_path: joinPosix(relative(source.repository_absolute_path, absolutePath)),
    line: Number.isInteger(entry.line) ? entry.line : 1,
    column: 1,
    score: typeof entry.score === "number" ? entry.score : null,
    text: typeof entry.snippet === "string" ? entry.snippet : typeof entry.text === "string" ? entry.text : "",
    provenance: resultProvenance(scope, source),
  };
}

function resolveCurrentQmdResultFile(source, relativePath) {
  const pathParts = relativePath.split("/");
  const basename = pathParts.at(-1);
  if (
    pathParts.some((part) => excludedDirectoryNames.has(part))
    || basename === ".env"
    || basename.startsWith(".env.")
    || !textExtensionSet.has(extname(basename).slice(1).toLowerCase())
  ) {
    return null;
  }

  let candidate = source.absolute_path;
  try {
    for (const [index, part] of pathParts.entries()) {
      candidate = join(candidate, part);
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink()) return null;
      if (index < pathParts.length - 1 && !metadata.isDirectory()) return null;
      if (index === pathParts.length - 1 && !metadata.isFile()) return null;
    }
    const canonicalSourceRoot = realpathSync(source.absolute_path);
    const canonicalCandidate = realpathSync(candidate);
    if (!isPathInside(canonicalSourceRoot, canonicalCandidate)) return null;

    const sample = Buffer.alloc(8192);
    let descriptor;
    try {
      descriptor = openSync(candidate, "r");
      const bytesRead = readSync(descriptor, sample, 0, sample.length, 0);
      if (sample.subarray(0, bytesRead).includes(0)) return null;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    return candidate;
  } catch {
    return null;
  }
}

function resultProvenance(scope, source) {
  return {
    organization_slug: scope.organization.slug,
    principal_github_username: scope.principal.github_username,
    provider_access_status: scope.access.status,
    provider_access_reason: scope.access.reason,
    team: scope.team,
    scope_id: scope.id,
    source_id: source.id,
    repository_path: source.repository_path,
    source_path: source.path,
    declared_teams: source.declared_teams,
  };
}

function publicScope(scope) {
  return {
    id: scope.id,
    display_name: scope.display_name,
    organization: scope.organization,
    principal: scope.principal,
    team: scope.team,
    access: scope.access,
    sources: scope.sources.map(({
      absolute_path: _absolutePath,
      repository_absolute_path: _repositoryAbsolutePath,
      ...source
    }) => source),
  };
}

async function readLocalIndexState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed?.schema_version === "lazurio.qmd.local-state.v1" ? parsed : null;
  } catch {
    return null;
  }
}

function assertLocalStorageLayout(layout) {
  const root = resolve(layout.root);
  for (const path of [layout.config_dir, layout.cache_home, layout.config_path, layout.database_path, layout.state_path]) {
    if (!isPathInside(root, resolve(path))) {
      throw new LazurioSearchError("QMD local storage uniká mimo Launchpad root.", {
        code: "qmd_storage_escape",
        exitCode: 3,
      });
    }
  }
}

function normalizeQuery(query) {
  const value = typeof query === "string" ? query.trim() : "";
  if (!value) throw new LazurioSearchError("Search dotaz nesmí být prázdný.", { code: "empty_query" });
  if (value.length > 500) throw new LazurioSearchError("Search dotaz je příliš dlouhý.", { code: "query_too_long" });
  return value;
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new LazurioSearchError("--limit musí být celé číslo 1 až 200.", { code: "invalid_limit" });
  }
  return value;
}

function normalizedPrincipal(value) {
  return typeof value === "string" && githubUsernamePattern.test(value.trim()) ? value.trim() : null;
}

function safeStorageSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new LazurioSearchError(`Neplatný ${label} pro QMD storage.`, { code: "invalid_storage_identity" });
  }
  return value;
}

function safeCommandFailure(value) {
  const text = String(value ?? "unknown error").replaceAll(/\s+/g, " ").trim();
  return text.slice(0, 240) || "unknown error";
}

function spawnCommand(command, args, options) {
  const result = nodeSpawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

function isPathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function joinPosix(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replaceAll("\\", "/")
    .replaceAll(/\/{2,}/g, "/")
    .replace(/^\.\//, "");
}
