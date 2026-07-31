import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

// Decision 0104 (+ CAC-0085): .claude/skills je Git-tracked byte-for-byte
// mirror kanonického .agents/skills — celých adresářů aktivních skillů včetně
// references/, templates/ a scripts/, ne jen SKILL.md (žádné symlinky/junctiony
// — na Windows nejsou spolehlivé). Tento check běží i nad cizími checkouty
// (Organization mounty), proto je fail (blocked) vyhrazen jen stavům, které
// nejde bezpečně opravit lokální repair lane; legacy symlink model, starší
// SKILL.md-only mirror a drift jsou repair_needed (warn).
export const AGENT_SKILLS_ENTRYPOINT_SCHEMA = "companiesascode.agent_skills_entrypoint.v2";
export const CLAUDE_SKILLS_MATERIALIZATION = "tracked-derived-mirror";
export const AGENT_CAPABILITY_MODES = Object.freeze({
  CODEX_ONLY: "codex-only",
  CLAUDE_COMPATIBLE: "claude-compatible",
});
const canonicalRelativePath = ".agents/skills";
const compatibilityRelativePath = ".claude/skills";
const producerRelativePath = "scripts/agent-skills-entrypoint.mjs";
const legacyPlaceholder = "../.agents/skills";
// OS junk, které vytváří Finder/Explorer a které je v každém GEN3 repu
// gitignored. Do Git-tracked mirroru se nikdy nedostane, takže ho nesmí
// hlásit jako drift — jinak stačí otevřít .claude/skills ve Finderu a
// bun run check zůstane trvale červený bez automatického remedy.
const ignoredMirrorEntries = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function state({ status, code, message }) {
  return {
    schema_version: AGENT_SKILLS_ENTRYPOINT_SCHEMA,
    status,
    code,
    canonical_path: canonicalRelativePath,
    compatibility_path: compatibilityRelativePath,
    materialization: CLAUDE_SKILLS_MATERIALIZATION,
    message,
  };
}

function comparablePath(path, platform = process.platform) {
  const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsInside(root, target, platform = process.platform) {
  const relativePath = relative(root, target);
  if (relativePath === "") return true;
  if (/^\.\.(?:[\\/]|$)/.test(relativePath)) {
    return false;
  }
  return comparablePath(target, platform).startsWith(`${comparablePath(root, platform)}/`);
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Aktivní skilly čte z manifestu (slug + path kontrakt). Cizí checkout nemusí
// manifest mít nebo nést starší tvar — pak je autoritou adresářový sken
// kanonického katalogu; read-only doctor kvůli tomu nesmí failovat.
async function readActiveSkillSlugs(root) {
  const canonicalRoot = join(root, canonicalRelativePath);
  try {
    const manifest = JSON.parse(
      await readFile(join(canonicalRoot, "manifest.json"), "utf8"),
    );
    const slugs = (manifest.skills ?? [])
      .map((skill) => skill?.slug)
      // Slug tvoří filesystem cesty; mimo kebab-case (tečky, lomítka, "..")
      // hrozí traversal — read-only doctor takové položky ignoruje.
      .filter((slug) => typeof slug === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug));
    if (slugs.length > 0) return [...new Set(slugs)].sort();
  } catch {
    // Manifest chybí nebo nejde přečíst → fallback na adresářový sken.
  }
  const slugs = [];
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    // Stačí, že SKILL.md existuje v jakékoli podobě — jestli je to obyčejný
    // soubor, rozhoduje až drift scan, aby symlink skončil zavřeně místo aby
    // slug tiše vypadl ze seznamu aktivních skillů.
    const skillStat = await lstatOrNull(join(canonicalRoot, entry.name, "SKILL.md"));
    if (skillStat) slugs.push(entry.name);
  }
  return slugs.sort();
}

// Rekurzivní sken obyčejných souborů jednoho skill adresáře. Vrací mapu
// relativní cesta (posix "/") → absolutní cesta; symlink nebo nepodporovaný
// filesystem typ kdekoli uvnitř jde do `unsafe` (mirror i kanonický katalog
// musí být jen obyčejné soubory a adresáře).
export async function listSkillFiles(baseDir, displayPrefix) {
  const files = new Map();
  const unsafe = [];
  const stack = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop();
    const currentDir = relativeDir === "" ? baseDir : join(baseDir, relativeDir);
    for (const entry of await readdir(currentDir, { withFileTypes: true })) {
      if (ignoredMirrorEntries.has(entry.name)) continue;
      const childRelative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        unsafe.push(`${displayPrefix}/${childRelative} je symlink; mirror musí být obyčejné soubory.`);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(childRelative);
        continue;
      }
      if (entry.isFile()) {
        files.set(childRelative, join(currentDir, entry.name));
        continue;
      }
      unsafe.push(`${displayPrefix}/${childRelative} má nepodporovaný filesystem typ.`);
    }
  }
  return { files, unsafe };
}

async function mirrorDrift(root, slugs) {
  const unsafe = [];
  const drift = [];
  const mirrorRoot = join(root, compatibilityRelativePath);
  const expectedSlugs = new Set(slugs);

  for (const entry of await readdir(mirrorRoot, { withFileTypes: true })) {
    if (ignoredMirrorEntries.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      unsafe.push(`${compatibilityRelativePath}/${entry.name} je symlink; mirror musí být obyčejné soubory.`);
      continue;
    }
    if (!entry.isDirectory()) {
      drift.push(`${compatibilityRelativePath}/${entry.name} nepatří do mirroru.`);
      continue;
    }
    if (!expectedSlugs.has(entry.name)) {
      drift.push(`${compatibilityRelativePath}/${entry.name} není aktivní skill.`);
    }
  }

  for (const slug of slugs) {
    const canonicalDirectory = join(root, canonicalRelativePath, slug);
    const canonicalFile = join(canonicalDirectory, "SKILL.md");
    // Symlink na kanonické straně nesmí projít jako "shodné bajty": mirror by
    // tak nesl obsah zvenčí katalogu. Doctor to musí hlásit stejně zavřeně
    // jako repair lane, jinak si obě lane protiřečí.
    const [canonicalDirStat, canonicalStat] = await Promise.all([
      lstatOrNull(canonicalDirectory),
      lstatOrNull(canonicalFile),
    ]);
    if (
      !canonicalDirStat?.isDirectory() || canonicalDirStat.isSymbolicLink() ||
      !canonicalStat?.isFile() || canonicalStat.isSymbolicLink()
    ) {
      unsafe.push(
        `${canonicalRelativePath}/${slug} musí být skutečný adresář s obyčejným SKILL.md (žádné symlinky).`,
      );
      continue;
    }
    const canonicalScan = await listSkillFiles(canonicalDirectory, `${canonicalRelativePath}/${slug}`);
    unsafe.push(...canonicalScan.unsafe);
    const mirrorDirectory = join(mirrorRoot, slug);
    const mirrorDirStat = await lstatOrNull(mirrorDirectory);
    if (!mirrorDirStat) {
      drift.push(`${compatibilityRelativePath}/${slug} chybí.`);
      continue;
    }
    // Symlink/ne-adresář na slug úrovni už ohlásil sken mirrorRoot výš.
    if (mirrorDirStat.isSymbolicLink() || !mirrorDirStat.isDirectory()) continue;
    const mirrorScan = await listSkillFiles(mirrorDirectory, `${compatibilityRelativePath}/${slug}`);
    unsafe.push(...mirrorScan.unsafe);
    for (const [relativeFile, canonicalPath] of canonicalScan.files) {
      const mirrorPath = mirrorScan.files.get(relativeFile);
      if (!mirrorPath) {
        drift.push(`${compatibilityRelativePath}/${slug}/${relativeFile} chybí.`);
        continue;
      }
      const [canonicalBytes, mirrorBytes] = await Promise.all([
        readFile(canonicalPath),
        readFile(mirrorPath),
      ]);
      if (!canonicalBytes.equals(mirrorBytes)) {
        drift.push(
          `${compatibilityRelativePath}/${slug}/${relativeFile} není byte-for-byte shodný s kanonickým katalogem.`,
        );
      }
    }
    for (const relativeFile of mirrorScan.files.keys()) {
      if (!canonicalScan.files.has(relativeFile)) {
        drift.push(`${compatibilityRelativePath}/${slug}/${relativeFile} nepatří do mirroru.`);
      }
    }
  }

  return { unsafe, drift };
}

export async function inspectAgentSkillsEntrypoint(organizationRoot, {
  platform = process.platform,
  agentCapabilityMode = AGENT_CAPABILITY_MODES.CLAUDE_COMPATIBLE,
} = {}) {
  if (!Object.values(AGENT_CAPABILITY_MODES).includes(agentCapabilityMode)) {
    throw new Error(`Unsupported agent capability mode: ${agentCapabilityMode}`);
  }
  const root = resolve(organizationRoot);
  const canonicalPath = join(root, canonicalRelativePath);
  const compatibilityPath = join(root, compatibilityRelativePath);
  const compatibilityParent = dirname(compatibilityPath);
  const [producerStat, canonicalStat, compatibilityStat] = await Promise.all([
    lstatOrNull(join(root, producerRelativePath)),
    lstatOrNull(canonicalPath),
    lstatOrNull(compatibilityPath),
  ]);
  const contractPresent = Boolean(producerStat || canonicalStat || compatibilityStat);

  if (!contractPresent) {
    return state({
      status: "not_applicable",
      code: "contract_not_adopted",
      message: "Repozitář ještě nedeklaruje sdílený agent-skills entrypoint.",
    });
  }

  if (!canonicalStat?.isDirectory() || canonicalStat.isSymbolicLink()) {
    return state({
      status: "blocked",
      code: canonicalStat ? "canonical_not_directory" : "canonical_missing",
      message: `${canonicalRelativePath} musí být skutečný kanonický adresář.`,
    });
  }

  const [rootRealPath, canonicalRealPath] = await Promise.all([
    realpath(root),
    realpath(canonicalPath),
  ]);
  if (!pathIsInside(rootRealPath, canonicalRealPath, platform)) {
    return state({
      status: "blocked",
      code: "canonical_path_escape",
      message: `${canonicalRelativePath} se dostává mimo root repozitáře.`,
    });
  }

  const compatibilityParentStat = await lstatOrNull(compatibilityParent);
  if (
    compatibilityParentStat &&
    (!compatibilityParentStat.isDirectory() || compatibilityParentStat.isSymbolicLink())
  ) {
    return state({
      status: "blocked",
      code: "compatibility_parent_not_directory",
      message: ".claude musí být skutečný adresář uvnitř rootu repozitáře.",
    });
  }
  if (compatibilityParentStat) {
    const compatibilityParentRealPath = await realpath(compatibilityParent);
    if (!pathIsInside(rootRealPath, compatibilityParentRealPath, platform)) {
      return state({
        status: "blocked",
        code: "compatibility_parent_escape",
        message: ".claude se dostává mimo root repozitáře.",
      });
    }
  }

  if (!compatibilityStat) {
    if (platform === "win32" && agentCapabilityMode === AGENT_CAPABILITY_MODES.CODEX_ONLY) {
      return state({
        status: "ok",
        code: "codex_entrypoint_ready",
        message: `${canonicalRelativePath} je připravené pro Codex; ${compatibilityRelativePath} mirror je na Windows volitelná Claude kompatibilita.`,
      });
    }
    return state({
      status: "repair_needed",
      code: "mirror_missing",
      message: `${compatibilityRelativePath} mirror chybí; spusť bun run repair:agent-skills a mirror commitni.`,
    });
  }

  if (compatibilityStat.isSymbolicLink()) {
    try {
      const compatibilityRealPath = await realpath(compatibilityPath);
      if (
        comparablePath(compatibilityRealPath, platform) ===
        comparablePath(canonicalRealPath, platform)
      ) {
        return state({
          status: "repair_needed",
          code: "mirror_legacy_link",
          message: `${compatibilityRelativePath} je legacy symlink/junction; repair lane ho nahradí trackovaným mirrorem (decision 0104).`,
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return state({
      status: "repair_needed",
      code: "entrypoint_wrong_link",
      message: `${compatibilityRelativePath} je symlink mimo kanonický katalog; repair lane ho nahradí trackovaným mirrorem.`,
    });
  }

  if (compatibilityStat.isFile()) {
    const contents = (await readFile(compatibilityPath, "utf8"))
      .replace(/^\uFEFF/, "")
      .trim();
    if (contents === legacyPlaceholder) {
      if (platform === "win32" && agentCapabilityMode === AGENT_CAPABILITY_MODES.CODEX_ONLY) {
        return state({
          status: "ok",
          code: "codex_entrypoint_ready",
          message: `${canonicalRelativePath} je připravené pro Codex; textový ${compatibilityRelativePath} placeholder se na Windows nepoužívá.`,
        });
      }
      return state({
        status: "repair_needed",
        code: "mirror_legacy_placeholder",
        message: `${compatibilityRelativePath} je textový placeholder z Windows checkoutu; repair lane ho nahradí mirrorem.`,
      });
    }
    return state({
      status: "blocked",
      code: "entrypoint_unexpected_file",
      message: `${compatibilityRelativePath} je neznámý soubor; Doctor ho nesmaže.`,
    });
  }

  if (!compatibilityStat.isDirectory()) {
    return state({
      status: "blocked",
      code: "entrypoint_unknown_type",
      message: `${compatibilityRelativePath} má nepodporovaný filesystem typ.`,
    });
  }

  const slugs = await readActiveSkillSlugs(root);
  const { unsafe, drift } = await mirrorDrift(root, slugs);
  if (unsafe.length > 0) {
    return state({
      status: "blocked",
      code: "mirror_unsafe_content",
      message: unsafe.join(" "),
    });
  }
  if (drift.length > 0) {
    return state({
      status: "repair_needed",
      code: "mirror_drift",
      message: `${compatibilityRelativePath} není byte-for-byte mirror: ${drift.join(" ")}`,
    });
  }
  return state({
    status: "ok",
    code: "mirror_ready",
    message: `${compatibilityRelativePath} je byte-for-byte mirror aktivních skillů z ${canonicalRelativePath}.`,
  });
}

export async function agentSkillsEntrypointsDoctorCheck({
  companiesRoot,
  mounts = [],
  includeRoot = true,
  platform = process.platform,
  agentCapabilityMode = AGENT_CAPABILITY_MODES.CLAUDE_COMPATIBLE,
}) {
  const targets = [
    // Conglomerate root má vlastní skills katalog a mirror (decision 0104).
    ...(includeRoot ? [{ path: ".", label: "root" }] : []),
    ...mounts.filter((mount) => mount?.path && mount.status !== "planned"),
  ];
  const inspected = await Promise.all(
    targets.map(async (mount) => {
      try {
        return {
          mount,
          state: await inspectAgentSkillsEntrypoint(join(companiesRoot, mount.path), {
            platform,
            agentCapabilityMode,
          }),
        };
      } catch (error) {
        return {
          mount,
          state: state({
            status: "blocked",
            code: "inspection_failed",
            message: `Filesystem kontrola selhala: ${error.message}`,
          }),
        };
      }
    }),
  );
  const applicable = inspected.filter((item) => item.state.status !== "not_applicable");
  const blocked = applicable.filter((item) => item.state.status === "blocked");
  const repairNeeded = applicable.filter((item) => item.state.status === "repair_needed");
  // „Žádný checkout entrypoint nedeklaruje" je FAKT o mountech, ne nezměřená
  // kontrola — proto `not_applicable` a ne `blocked` (společný surface doctorů,
  // decision 0118). Vlastníkem je mount, ne root: entrypoint deklaruje checkout.
  const status = blocked.length > 0
    ? "fail"
    : repairNeeded.length > 0
      ? "warn"
      : applicable.length > 0
        ? "ok"
        : "not_applicable";

  return {
    id: "launchpad.agent_skills_entrypoints",
    status,
    severity: "local-state",
    title: "Agent skills entrypointy",
    message:
      status === "fail"
        ? `${blocked.length} agent-skills entrypointů je blokovaných.`
        : status === "warn"
          ? `${repairNeeded.length} agent-skills entrypointů čeká na repair lane (tracked mirror, decision 0104).`
          : status === "ok"
            ? `${applicable.length} agent-skills entrypointů drží tracked byte-for-byte mirror.`
            : "Žádný checkout ještě agent-skills entrypoint nedeklaruje.",
    paths: [
      ".agents/skills",
      ".claude/skills",
      "organizations/*/.agents/skills",
      "organizations/*/.claude/skills",
    ],
    links: [],
    details: applicable.map(({ mount, state: entrypointState }) =>
      `${mount.label ?? mount.path}: ${entrypointState.status}/${entrypointState.code} — ${entrypointState.message}`),
    ...(status === "not_applicable"
      ? {
        not_applicable_reason: "not_declared",
        owner: "namountované checkouty (entrypoint deklaruje mount, ne sdílený root)",
      }
      : {}),
  };
}
