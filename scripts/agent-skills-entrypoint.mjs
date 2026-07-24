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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_SKILLS_ENTRYPOINT_SCHEMA,
  CLAUDE_SKILLS_MATERIALIZATION,
  inspectAgentSkillsEntrypoint,
} from "../launchpad/src/agent-skills-entrypoint-lib.mjs";

export const CANONICAL_SKILLS_PATH = ".agents/skills";
export const CLAUDE_SKILLS_PATH = ".claude/skills";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");
const TRUSTED_GIT_EXECUTABLES = {
  darwin: ["/usr/bin/git"],
  linux: ["/usr/bin/git", "/bin/git"],
  win32: [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe",
  ],
};

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
  for (const candidate of TRUSTED_GIT_EXECUTABLES[platform] ?? []) {
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
    const expectedPath = `${CANONICAL_SKILLS_PATH}/${skill.slug}/SKILL.md`;
    if (typeof skill.slug !== "string" || skill.path !== expectedPath) {
      throw new Error(
        `Manifest skill ${skill.slug ?? "<bez slugu>"} musí mít path ${expectedPath}.`,
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
      (child) => child.isFile() && !child.isSymbolicLink() && child.name === "SKILL.md",
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
    const canonicalFile = join(repoRoot, CANONICAL_SKILLS_PATH, slug, "SKILL.md");
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
