import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const AGENT_SKILLS_ENTRYPOINT_SCHEMA = "companiesascode.agent_skills_entrypoint.v1";
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
      message: "Organizace ještě nedeklaruje sdílený agent-skills entrypoint.",
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
      message: `${canonicalRelativePath} se dostává mimo root Organizace.`,
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
      message: ".claude musí být skutečný adresář uvnitř rootu Organizace.",
    });
  }
  if (compatibilityParentStat) {
    const compatibilityParentRealPath = await realpath(compatibilityParent);
    if (!pathIsInside(rootRealPath, compatibilityParentRealPath, platform)) {
      return state({
        status: "blocked",
        code: "compatibility_parent_escape",
        message: ".claude se dostává mimo root Organizace.",
      });
    }
  }

  if (!compatibilityStat) {
    if (platform === "win32" && agentCapabilityMode === AGENT_CAPABILITY_MODES.CODEX_ONLY) {
      return state({
        status: "ok",
        code: "codex_entrypoint_ready",
        message: `${canonicalRelativePath} je připravené pro Codex; ${compatibilityRelativePath} je na Windows volitelná Claude kompatibilita.`,
      });
    }
    return state({
      status: "repair_needed",
      code: "entrypoint_missing",
      message: `${compatibilityRelativePath} chybí; spusť explicitní Organization Repair.`,
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
          status: "ok",
          code: "entrypoint_ready",
          message: `${compatibilityRelativePath} odkazuje na ${canonicalRelativePath}.`,
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return state({
      status: "repair_needed",
      code: "entrypoint_wrong_link",
      message: `${compatibilityRelativePath} nemíří na ${canonicalRelativePath}.`,
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
        code: "entrypoint_legacy_placeholder",
        message: `${compatibilityRelativePath} je textový placeholder z Windows checkoutu.`,
      });
    }
    return state({
      status: "blocked",
      code: "entrypoint_unexpected_file",
      message: `${compatibilityRelativePath} je neznámý soubor; Doctor ho nesmaže.`,
    });
  }

  return state({
    status: "blocked",
    code: compatibilityStat.isDirectory()
      ? "entrypoint_duplicate_directory"
      : "entrypoint_unknown_type",
    message: compatibilityStat.isDirectory()
      ? `${compatibilityRelativePath} je samostatný adresář a druhý source of truth.`
      : `${compatibilityRelativePath} má nepodporovaný filesystem typ.`,
  });
}

export async function agentSkillsEntrypointsDoctorCheck({
  companiesRoot,
  mounts = [],
  platform = process.platform,
  agentCapabilityMode = AGENT_CAPABILITY_MODES.CLAUDE_COMPATIBLE,
}) {
  const inspected = await Promise.all(
    mounts
      .filter((mount) => mount?.path && mount.status !== "planned")
      .map(async (mount) => {
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
          ? `${repairNeeded.length} agent-skills entrypointů potřebuje explicitní Repair.`
          : status === "ok"
            ? `${applicable.length} agent-skills entrypointů míří na kanonickou knihovnu.`
            : "Žádná připojená Organizace ještě agent-skills entrypoint nedeklaruje.",
    paths: ["organizations/*/.agents/skills", "organizations/*/.claude/skills"],
    links: [],
    details: applicable.map(({ mount, state: entrypointState }) =>
      `${mount.path}: ${entrypointState.status}/${entrypointState.code} — ${entrypointState.message}`),
  };
}
