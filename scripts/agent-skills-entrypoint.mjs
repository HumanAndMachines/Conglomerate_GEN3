// Decision 0104: .claude/skills je Git-tracked byte-for-byte mirror kanonického
// .agents/skills. Tenhle skript je lokální doctor/repair lane Conglomerate
// rootu (adaptace referenční implementace z OrganizationTemplate_GEN3):
//   bun run doctor:agent-skills  — read-only parity check (drift => exit 1)
//   bun run repair:agent-skills  — deterministická regenerace mirroru
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 as pathWin32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_SKILLS_ENTRYPOINT_SCHEMA,
  CLAUDE_SKILLS_MATERIALIZATION,
  inspectAgentSkillsEntrypoint,
} from "../launchpad/src/agent-skills-entrypoint-lib.mjs";

export const CANONICAL_SKILLS_PATH = ".agents/skills";
export const CLAUDE_SKILLS_PATH = ".claude/skills";
// Gitignored OS junk z Finderu/Exploreru; v Git-tracked mirroru neexistuje,
// takže ho Repair ani nepočítá mezi neznámý obsah (viz lib komentář).
const IGNORED_MIRROR_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");
// Známé instalační prefixy Gitu. Discovery zůstává bez PATH lookupu (obrana
// proti podvrženému `git` v PATH), ale musí pokrýt i instalace bez admin práv:
// Git for Windows se u korporátního uživatele bez administrátora instaluje do
// %LOCALAPPDATA%\Programs\Git (cílová persona decision 0059), na macOS bývá
// vedle systémového shimu Homebrew.
export function trustedGitCandidates(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    return ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
  }
  if (platform === "linux") {
    return ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];
  }
  if (platform !== "win32") return [];
  const localAppData = env.LOCALAPPDATA;
  // Windows cesty se skládají výhradně přes path.win32 — isAbsolute i join
  // z node:path mají sémantiku hostitelské platformy, takže by tahle větev
  // na macOS/Linuxu (a v testech) tiše vypadla.
  return [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe",
    ...(typeof localAppData === "string" && pathWin32.isAbsolute(localAppData)
      ? [
        pathWin32.join(localAppData, "Programs", "Git", "cmd", "git.exe"),
        pathWin32.join(localAppData, "Programs", "Git", "bin", "git.exe"),
      ]
      : []),
  ];
}

function sanitizedGitEnvironment() {
  const environment = {};
  for (const key of ["TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  environment.LC_ALL = "C";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "cat";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_COUNT = "0";
  return environment;
}

function trustedGitExecutable(platform = process.platform) {
  for (const candidate of trustedGitCandidates(platform)) {
    try {
      const canonicalPath = realpathSync.native(candidate);
      if (isAbsolute(canonicalPath) && statSync(canonicalPath).isFile()) {
        return canonicalPath;
      }
    } catch {
      // Zkus další system-owned kandidát; caller-controlled discovery není povolená.
    }
  }
  return null;
}

function git(root, args) {
  const executable = trustedGitExecutable();
  if (!executable) {
    return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() };
  }
  return Bun.spawnSync({
    cmd: [executable, ...args],
    cwd: root,
    env: sanitizedGitEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result) {
  return new TextDecoder().decode(result.stdout).trim();
}

function comparablePath(path, platform = process.platform) {
  const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function publicState({ status, code, problems = [], message }) {
  return {
    schema_version: AGENT_SKILLS_ENTRYPOINT_SCHEMA,
    status,
    code,
    canonical_path: CANONICAL_SKILLS_PATH,
    compatibility_path: CLAUDE_SKILLS_PATH,
    materialization: CLAUDE_SKILLS_MATERIALIZATION,
    problems,
    message,
  };
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function readActiveSkillSlugs(root = defaultRoot) {
  const manifestPath = join(resolve(root), CANONICAL_SKILLS_PATH, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const slugs = [];
  for (const skill of manifest.skills ?? []) {
    if (typeof skill.slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.slug)) {
      // Slug je součást filesystem cest mirroru; cokoliv mimo kebab-case
      // (tečky, lomítka, "..") by dovolilo traversal mimo kanonický katalog.
      throw new Error(
        `Manifest skill ${typeof skill.slug === "string" ? skill.slug : "<bez slugu>"} musí mít kebab-case slug bez cest.`,
      );
    }
    const expectedPath = `${CANONICAL_SKILLS_PATH}/${skill.slug}/SKILL.md`;
    if (skill.path !== expectedPath) {
      throw new Error(
        `Manifest skill ${skill.slug} musí mít path ${expectedPath}.`,
      );
    }
    slugs.push(skill.slug);
  }
  return [...new Set(slugs)].sort();
}

export function expectedMirrorPaths(slugs) {
  return slugs.map((slug) => `${CLAUDE_SKILLS_PATH}/${slug}/SKILL.md`);
}

// Git kontrakt: mirror nesmí být gitignored a tracked obsah .claude/skills smí
// být jen odvozený mirror aktivních skillů.
export function validateGitContract(root, expectedPaths) {
  const problems = [];
  const topLevel = git(root, ["rev-parse", "--show-toplevel"]);
  if (topLevel.exitCode !== 0) {
    problems.push("Agent-skills mirror lze spravovat jen uvnitř Git checkoutu.");
    return problems;
  }
  try {
    // Bez téhle vazby by check i repair pracovaly s indexem nadřazeného
    // repozitáře, kdyby root nebyl vlastní Git checkout.
    if (
      comparablePath(realpathSync.native(output(topLevel))) !==
      comparablePath(realpathSync.native(root))
    ) {
      problems.push("Agent-skills mirror nesmí převzít Git index nadřazeného repozitáře.");
      return problems;
    }
  } catch {
    problems.push("Nelze bezpečně svázat agent-skills mirror s Git rootem repozitáře.");
    return problems;
  }

  const ignored = git(root, ["check-ignore", "--no-index", "-q", "--", CLAUDE_SKILLS_PATH]);
  if (ignored.exitCode === 0) {
    problems.push(`${CLAUDE_SKILLS_PATH} je Git-tracked odvozený mirror a nesmí být v .gitignore.`);
  }

  const tracked = git(root, ["ls-files", "--cached", "--", CLAUDE_SKILLS_PATH]);
  if (tracked.exitCode !== 0) {
    problems.push(`Nelze bezpečně načíst Git index pro ${CLAUDE_SKILLS_PATH}.`);
    return problems;
  }
  const expected = new Set(expectedPaths);
  for (const path of output(tracked).split("\n").filter(Boolean)) {
    if (!expected.has(path)) {
      problems.push(`Trackovaný ${path} nepatří do odvozeného mirroru aktivních skillů.`);
    }
  }
  return problems;
}

export async function checkAgentSkillsMirror(root = defaultRoot, options = {}) {
  const repoRoot = resolve(root);
  const inspection = await inspectAgentSkillsEntrypoint(repoRoot, options);
  if (inspection.status === "blocked" || inspection.status === "not_applicable") {
    return inspection;
  }
  let slugs;
  try {
    slugs = await readActiveSkillSlugs(repoRoot);
  } catch (error) {
    return publicState({
      status: "blocked",
      code: "manifest_invalid",
      problems: [error instanceof Error ? error.message : String(error)],
      message: "Manifest aktivních skillů nelze bezpečně přečíst.",
    });
  }
  const gitProblems = validateGitContract(repoRoot, expectedMirrorPaths(slugs));
  if (gitProblems.length > 0) {
    return publicState({
      status: "blocked",
      code: "entrypoint_contract_invalid",
      problems: gitProblems,
      message: "Claude skills mirror porušuje Git kontrakt.",
    });
  }
  if (inspection.status === "ok") {
    // Obsahová parita nestačí: mirror soubor mimo Git index by tiše chyběl
    // v commitu i čerstvém checkoutu, i když doctor vidí shodné bajty.
    const tracked = git(repoRoot, ["ls-files", "--cached", "--", CLAUDE_SKILLS_PATH]);
    if (tracked.exitCode === 0) {
      const trackedSet = new Set(output(tracked).split("\n").filter(Boolean));
      const untracked = expectedMirrorPaths(slugs).filter((path) => !trackedSet.has(path));
      if (untracked.length > 0) {
        return publicState({
          status: "repair_needed",
          code: "mirror_untracked",
          problems: untracked.map((path) => `${path} není v Git indexu.`),
          message: `${CLAUDE_SKILLS_PATH} mirror není celý v Git indexu; spusť bun run repair:agent-skills a commitni.`,
        });
      }
    }
  }
  return inspection;
}

async function removeLegacyLink(path) {
  try {
    await unlink(path);
  } catch {
    // Windows junction se odstraňuje jako adresářový záznam; cíl zůstává nedotčený.
    await rm(path, { recursive: false, force: false });
  }
}

export async function repairAgentSkillsMirror(root = defaultRoot, options = {}) {
  const repoRoot = resolve(root);
  const before = await checkAgentSkillsMirror(repoRoot, options);
  if (before.status === "ok" || before.status === "blocked" || before.status === "not_applicable") {
    return before;
  }

  const compatibilityPath = join(repoRoot, CLAUDE_SKILLS_PATH);
  if (before.code === "mirror_legacy_link" || before.code === "entrypoint_wrong_link") {
    await removeLegacyLink(compatibilityPath);
  } else if (before.code === "mirror_legacy_placeholder") {
    await unlink(compatibilityPath);
  }

  const slugs = await readActiveSkillSlugs(repoRoot);
  const expectedSlugs = new Set(slugs);
  await mkdir(compatibilityPath, { recursive: true });

  for (const entry of await readdir(compatibilityPath, { withFileTypes: true })) {
    const entryPath = join(compatibilityPath, entry.name);
    if (IGNORED_MIRROR_ENTRIES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) {
      // Stray soubor přímo v mirroru: inspect ho hlásí jako drift, ale mazat
      // neznámý obsah Repair nesmí — bez tohohle gate by parita nikdy nesešla.
      return publicState({
        status: "blocked",
        code: "mirror_unknown_content",
        problems: [
          `${CLAUDE_SKILLS_PATH}/${entry.name} nepatří do mirroru; Repair ho nesmaže, porovnej a odstraň ručně.`,
        ],
        message: "Claude skills mirror nelze bezpečně regenerovat automaticky.",
      });
    }
    const children = await readdir(entryPath, { withFileTypes: true });
    const onlyMirrorShape = children.every(
      (child) =>
        IGNORED_MIRROR_ENTRIES.has(child.name) ||
        (child.isFile() && !child.isSymbolicLink() && child.name === "SKILL.md"),
    );
    if (!onlyMirrorShape) {
      // Platí i pro aktivní skill adresář: extra obsah vedle SKILL.md by jinak
      // přežil repair a drift by se nikdy nesrovnal (Greptile nález na PR #45).
      return publicState({
        status: "blocked",
        code: "mirror_unknown_content",
        problems: [
          `${CLAUDE_SKILLS_PATH}/${entry.name} obsahuje neznámý obsah; Repair ho nesmaže, porovnej a odstraň ručně.`,
        ],
        message: "Claude skills mirror nelze bezpečně regenerovat automaticky.",
      });
    }
    if (expectedSlugs.has(entry.name)) continue;
    await rm(entryPath, { recursive: true, force: false });
  }

  for (const slug of slugs) {
    const canonicalDirectory = join(repoRoot, CANONICAL_SKILLS_PATH, slug);
    const canonicalFile = join(canonicalDirectory, "SKILL.md");
    // Symlink na kanonické straně by protáhl do trackovaného mirroru bajty
    // zvenčí katalogu (disclosure) — kopíruje se jen obyčejný soubor
    // v obyčejném adresáři.
    const [canonicalDirStat, canonicalStat] = await Promise.all([
      lstatOrNull(canonicalDirectory),
      lstatOrNull(canonicalFile),
    ]);
    if (
      !canonicalDirStat?.isDirectory() || canonicalDirStat.isSymbolicLink() ||
      !canonicalStat?.isFile() || canonicalStat.isSymbolicLink()
    ) {
      return publicState({
        status: "blocked",
        code: "canonical_unsafe_content",
        problems: [
          `${CANONICAL_SKILLS_PATH}/${slug} musí být skutečný adresář s obyčejným SKILL.md (žádné symlinky).`,
        ],
        message: "Kanonický katalog obsahuje nebezpečný obsah; oprav ho ručně.",
      });
    }
    const mirrorDirectory = join(compatibilityPath, slug);
    const mirrorFile = join(mirrorDirectory, "SKILL.md");
    await mkdir(mirrorDirectory, { recursive: true });
    const mirrorStat = await lstatOrNull(mirrorFile);
    if (mirrorStat && (!mirrorStat.isFile() || mirrorStat.isSymbolicLink())) {
      return publicState({
        status: "blocked",
        code: "mirror_unsafe_content",
        problems: [`${CLAUDE_SKILLS_PATH}/${slug}/SKILL.md není obyčejný soubor; oprav ho ručně.`],
        message: "Claude skills mirror nelze bezpečně regenerovat automaticky.",
      });
    }
    await writeFile(mirrorFile, await readFile(canonicalFile));
  }

  const staged = git(repoRoot, ["add", "-A", "--", CLAUDE_SKILLS_PATH]);
  if (staged.exitCode !== 0) {
    return publicState({
      status: "blocked",
      code: "mirror_stage_failed",
      problems: [`git add pro ${CLAUDE_SKILLS_PATH} selhal.`],
      message: "Mirror se nepodařilo přidat do Git indexu.",
    });
  }

  return checkAgentSkillsMirror(repoRoot, options);
}

function printState(state, json) {
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  const label = state.status === "ok" ? "ok" : state.status === "repair_needed" ? "repair" : "fail";
  console.log(`${label} - agent-skills-entrypoint: ${state.message}`);
  for (const problem of state.problems ?? []) console.log(`  - ${problem}`);
}

async function main() {
  const [command = "check", ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  if (!["check", "repair"].includes(command)) {
    throw new Error("Použití: agent-skills-entrypoint.mjs <check|repair> [--json].");
  }
  const state = command === "repair"
    ? await repairAgentSkillsMirror(defaultRoot)
    : await checkAgentSkillsMirror(defaultRoot);
  printState(state, json);
  if (state.status !== "ok") process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const state = publicState({
      status: "blocked",
      code: "entrypoint_operation_failed",
      problems: [error instanceof Error ? error.message : String(error)],
      message: "Kontrola nebo oprava agent-skills mirroru selhala.",
    });
    printState(state, process.argv.includes("--json"));
    process.exitCode = 1;
  }
}
