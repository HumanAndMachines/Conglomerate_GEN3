// Panel „Poslední změny" (CAC-0044, step-006): per-modul poslední commity
// (datum, počet, rozklik detailu). Standalone, read-only, bounded git log —
// Git procesy sdílejí jeden bounded/cross-platform runner s ostatními Launchpad
// pohledy, aby Windows nepouštěl POSIX askpass helper a stderr se vždy drainoval.

import { existsSync } from "fs";
import { join } from "path";
import {
  GIT_COMMAND_CONCURRENCY,
  GIT_LOCAL_TIMEOUT_MS,
  mapWithConcurrency,
  resolveGitExecutable,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";

const DEFAULT_MODULE_LIMIT = 8;
const DEFAULT_COMMIT_LIMIT = 15;
// Oddělovače pro git log --pretty: US (unit separator) mezi poli, RS (record
// separator) mezi commity. Oba jsou řídicí znaky, které se v commit metadatech
// nevyskytují, takže subject/body s libovolným obsahem parsování nerozbije.
// (NUL \x00 nejde — Bun.spawn odmítá argumenty s NUL byte.)
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

// Modul = jeden git repo. Discovery apps nesou cwd/module/organization; jeden
// modul může mít víc app variant (v1/v2) v různých app podsložkách —
// deduplikujeme podle identity Organizace + modulu, ne podle cwd varianty.
function moduleReposFromApps(apps, companiesRoot) {
  const byModule = new Map();
  for (const app of apps) {
    const cwd = app.cwd;
    if (!cwd) continue;
    const absolute = join(companiesRoot, cwd);
    const moduleId = app.module ? `${app.company}::${app.module}` : app.id;
    if (byModule.has(moduleId)) continue;
    byModule.set(moduleId, {
      id: moduleId,
      name: moduleDisplayName(app),
      company: app.company,
      company_display_name: app.company_display_name ?? app.company,
      module: app.module ?? null,
      icon: app.icon ?? null,
      tags: Array.isArray(app.tags) ? app.tags : [],
      absolute_path: absolute,
      relative_path: cwd,
    });
  }
  return [...byModule.values()];
}

function moduleDisplayName(app) {
  if (app.module) {
    return app.module
      .split("-")
      .map((word, index) => (index === 0 ? capitalize(word) : word))
      .join(" ");
  }
  return app.title ?? app.id;
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

// git log jednoho repa → seznam commitů (bounded). Používá US (\x1f) a RS (\x1e)
// separátory, aby subject/body s libovolnými znaky nerozbily parsování.
async function readRepoCommits(repo, { commitLimit }) {
  if (!existsSync(repo.absolute_path)) return null;
  const format = ["%H", "%h", "%an", "%aI", "%s", "%b"].join(FIELD_SEP);
  const result = await runGit(
    ["log", `-${commitLimit}`, `--pretty=format:${format}${RECORD_SEP}`, "--no-color"],
    {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      env: safeGitRemoteEnv(),
    },
  );
  if (!result.ok || result.stdout.trim() === "") return null;

  const commits = result.stdout
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, author, committedAt, subject, ...bodyParts] = record.split(FIELD_SEP);
      return {
        hash,
        short_hash: shortHash,
        author,
        committed_at: committedAt,
        committed_at_unix: committedAt ? Math.floor(Date.parse(committedAt) / 1000) : 0,
        subject: subject ?? "",
        body: (bodyParts.join(FIELD_SEP) ?? "").trim(),
      };
    })
    .filter((commit) => commit.hash);

  if (commits.length === 0) return null;
  return commits;
}

export async function buildRecentModuleChanges({
  companiesRoot,
  apps,
  moduleLimit = DEFAULT_MODULE_LIMIT,
  commitLimit = DEFAULT_COMMIT_LIMIT,
} = {}) {
  const repos = moduleReposFromApps(apps ?? [], companiesRoot);
  const gitAvailable = await isGitAvailable();
  if (!gitAvailable) {
    return {
      schema_version: "companiesascode.launchpad.recent_changes.v1",
      generated_at: new Date().toISOString(),
      git_available: false,
      recent_modules: [],
    };
  }

  const enriched = await mapWithConcurrency(
    repos,
    GIT_COMMAND_CONCURRENCY,
    async (repo) => {
      const commits = await readRepoCommits(repo, { commitLimit });
      if (!commits) return null;
      return {
        id: repo.id,
        name: repo.name,
        company: repo.company,
        company_display_name: repo.company_display_name,
        module: repo.module,
        icon: repo.icon,
        tags: repo.tags,
        relative_path: repo.relative_path,
        last_commit_at: commits[0].committed_at,
        commit_count: commits.length,
        commits,
      };
    },
  );

  const recentModules = enriched
    .filter(Boolean)
    .sort((a, b) => (b.commits[0]?.committed_at_unix ?? 0) - (a.commits[0]?.committed_at_unix ?? 0))
    .slice(0, moduleLimit);

  return {
    schema_version: "companiesascode.launchpad.recent_changes.v1",
    generated_at: new Date().toISOString(),
    git_available: true,
    recent_modules: recentModules,
  };
}

async function isGitAvailable() {
  return Boolean(await resolveGitExecutable());
}
