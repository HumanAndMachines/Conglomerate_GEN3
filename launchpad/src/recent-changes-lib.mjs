// Panel „Poslední změny" (CAC-0044, step-006): per-modul poslední commity
// (datum, počet, rozklik detailu). Standalone, read-only, bounded git log —
// aby rebase na git read model z CAC-0042 bolel co nejmíň, tenhle
// soubor nezávisí na git-lib.mjs read modelu; má vlastní minimální runGit wrapper.
//
// Až bude git read model dostupný, tenhle lib se dá přepsat tak, aby stavěl nad jeho
// git-inventory-lib (enumerace repos) a git-lib (runGit) — kontrakt výstupu
// (recent_modules) zůstává stejný. Viz handoff.

import { existsSync } from "fs";
import { join } from "path";

const GIT_LOG_TIMEOUT_MS = 6_000;
const DEFAULT_MODULE_LIMIT = 8;
const DEFAULT_COMMIT_LIMIT = 15;
// Oddělovače pro git log --pretty: US (unit separator) mezi poli, RS (record
// separator) mezi commity. Oba jsou řídicí znaky, které se v commit metadatech
// nevyskytují, takže subject/body s libovolným obsahem parsování nerozbije.
// (NUL \x00 nejde — Bun.spawn odmítá argumenty s NUL byte.)
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

// Neinteraktivní git prostředí — nikdy nesmí čekat na heslo/askpass.
function nonInteractiveGitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GCM_INTERACTIVE: "never",
  };
}

async function runGit(args, cwd) {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: nonInteractiveGitEnv(),
    });
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, GIT_LOG_TIMEOUT_MS);
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    clearTimeout(timeout);
    return { ok: exitCode === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

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
    repo.absolute_path,
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

  const enriched = await Promise.all(
    repos.map(async (repo) => {
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
    }),
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
  try {
    const child = Bun.spawn(["git", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
      env: nonInteractiveGitEnv(),
    });
    const exitCode = await child.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
