import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

// Decision 0104: .claude/skills je Git-tracked byte-for-byte mirror kanonického
// .agents/skills (žádné symlinky/junctiony — na Windows nejsou spolehlivé).
// Tento check běží i nad cizími checkouty (Organization mounty), proto je
// fail (blocked) vyhrazen jen stavům, které nejde bezpečně opravit lokální
// repair lane; legacy symlink model a drift jsou repair_needed (warn).
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
      .filter((slug) => typeof slug === "string" && slug.length > 0);
    if (slugs.length > 0) return [...new Set(slugs)].sort();
  } catch {
    // Manifest chybí nebo nejde přečíst → fallback na adresářový sken.
  }
  const slugs = [];
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillStat = await lstatOrNull(join(canonicalRoot, entry.name, "SKILL.md"));
    if (skillStat?.isFile()) slugs.push(entry.name);
  }
  return slugs.sort();
}

async function mirrorDrift(root, slugs) {
  const unsafe = [];
  const drift = [];
  const mirrorRoot = join(root, compatibilityRelativePath);
  const expectedSlugs = new Set(slugs);

  for (const entry of await readdir(mirrorRoot, { withFileTypes: true })) {
    const entryPath = join(mirrorRoot, entry.name);
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
      continue;
    }
    for (const child of await readdir(entryPath, { withFileTypes: true })) {
      if (child.isSymbolicLink()) {
        unsafe.push(
          `${compatibilityRelativePath}/${entry.name}/${child.name} je symlink; mirror musí být obyčejné soubory.`,
        );
      } else if (!child.isFile() || child.name !== "SKILL.md") {
        drift.push(`${compatibilityRelativePath}/${entry.name}/${child.name} nepatří do mirroru.`);
      }
    }
  }

  for (const slug of slugs) {
    const mirrorFile = join(mirrorRoot, slug, "SKILL.md");
    const mirrorStat = await lstatOrNull(mirrorFile);
    if (!mirrorStat) {
      drift.push(`${compatibilityRelativePath}/${slug}/SKILL.md chybí.`);
      continue;
    }
    if (!mirrorStat.isFile() || mirrorStat.isSymbolicLink()) continue;
    const [canonicalBytes, mirrorBytes] = await Promise.all([
      readFile(join(root, canonicalRelativePath, slug, "SKILL.md")),
      readFile(mirrorFile),
    ]);
    if (!canonicalBytes.equals(mirrorBytes)) {
      drift.push(`${compatibilityRelativePath}/${slug}/SKILL.md není byte-for-byte shodný s kanonickým katalogem.`);
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
  const status = blocked.length > 0
    ? "fail"
    : repairNeeded.length > 0
      ? "warn"
      : applicable.length > 0
        ? "ok"
        : "skip";

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
  };
}
