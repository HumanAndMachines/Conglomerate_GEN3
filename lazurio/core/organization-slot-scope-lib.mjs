import { posix } from "node:path";

const organizationSlotScopes = new Set(["root", "workspace", "productionspace"]);
const protectedOrganizationSlotAccessModes = new Set([
  "private",
  "restricted",
  "role_based",
]);
const organizationRootSlotPaths = new Set([
  "design-system",
  "infra",
  "mission-control",
  "mission-control/db",
]);
const organizationDiagnosticsOnlySlotPaths = new Set([
  "mission-control/db",
]);
const organizationSlotUiExposures = new Set(["module", "diagnostics-only"]);

export function isOrganizationRootSlotPath(path) {
  const normalizedPath = normalizeOrganizationSlotPath(path);
  return normalizedPath !== null && organizationRootSlotPaths.has(normalizedPath);
}

export function isOrganizationRootSlotDescendantPath(path) {
  const normalizedPath = normalizeOrganizationSlotPath(path);
  if (normalizedPath === null || organizationRootSlotPaths.has(normalizedPath)) return false;
  return [...organizationRootSlotPaths].some((rootPath) =>
    normalizedPath.startsWith(`${rootPath}/`),
  );
}

export function isOrganizationSlotContainerPath(path) {
  const normalizedPath = normalizeOrganizationSlotPath(path);
  return (
    normalizedPath === "workspace"
    || normalizedPath === "modules"
    || normalizedPath === "productionspace"
  );
}

export function isCanonicalOrganizationRepositorySlotPath(path) {
  if (
    typeof path !== "string"
    || path.includes("\\")
    || path.includes("\0")
  ) {
    return false;
  }
  const normalizedPath = normalizeOrganizationSlotPath(path);
  if (normalizedPath === null || path !== normalizedPath) return false;
  return (
    organizationRootSlotPaths.has(normalizedPath)
    // Fyzický basename mountu přesně zachovává jméno repozitáře včetně
    // case, `_` a `.`; oddělené stabilní ID vrací helper níže (decision 0125).
    || /^(workspace|modules|productionspace)\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(normalizedPath)
  );
}

export function organizationSlotRepositoryId(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  if (!path || !isCanonicalOrganizationRepositorySlotPath(path)) return null;
  const declared = slot?.slug;
  const candidate = declared === undefined ? posix.basename(path) : declared;
  if (typeof candidate !== "string" || candidate.trim() !== candidate) return null;
  // `root` už vlastní implicitní Organization root záznam v Git inventáři.
  if (candidate === "root") return null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) ? candidate : null;
}

export function githubRepositoryCoordinate(remote) {
  if (typeof remote !== "string" || remote.trim() !== remote || remote === "") return null;
  const prefixed = remote.match(
    /^(?:git@github\.com:|ssh:\/\/(?:git@)?github\.com\/|https?:\/\/github\.com\/|git:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/i,
  );
  const shorthand = remote.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  const match = prefixed ?? shorthand;
  if (!match) return null;
  const repository = match[2].endsWith(".git") ? match[2].slice(0, -4) : match[2];
  if (repository === "") return null;
  return {
    owner: match[1],
    repository,
    ownerRepo: `${match[1]}/${repository}`,
  };
}

export function organizationSlotRepositoryMountIssue(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  if (!path || isOrganizationRootSlotPath(path)) return null;
  // Stejné pořadí jako normalizeModuleSlot: validujeme přesně remote, který
  // následně vstoupí do Git action surface.
  const remote = slot?.repo ?? slot?.git?.url ?? slot?.repository;
  const coordinate = githubRepositoryCoordinate(remote);
  if (!coordinate) return null;
  const mountBasename = posix.basename(path);
  if (mountBasename === coordinate.repository) return null;
  return `repository mount basename ${JSON.stringify(mountBasename)} neodpovídá přesnému názvu GitHub repozitáře ${JSON.stringify(coordinate.repository)}`;
}

// Jedna Organization nesmí dvě fyzické repo boundary promítnout do stejného
// logického ID ani deklarovat dvě cesty, které se na case-insensitive hostu
// sloučí. Kontrola je záměrně jen nad jedním deklarativním seznamem; manifest a
// company config smějí stejný slot paralelně popisovat během migrace.
export function organizationRepositorySlotCollectionIssues(
  slots,
  { allowEquivalentDuplicates = false } = {},
) {
  const issues = [];
  const paths = new Map();
  const ids = new Map();
  for (const slot of Array.isArray(slots) ? slots : []) {
    if (!slot || typeof slot.path !== "string") continue;
    const path = normalizeOrganizationSlotPath(slot.path);
    if (!path || !isCanonicalOrganizationRepositorySlotPath(slot.path)) continue;
    const foldedPath = path.toLowerCase();
    const id = organizationSlotRepositoryId(slot, path);
    const previousPath = paths.get(foldedPath);
    if (previousPath) {
      const equivalent = previousPath.path === path && previousPath.id === id;
      if (!(allowEquivalentDuplicates && equivalent)) {
        issues.push(
          previousPath.path === path
            ? previousPath.id === id
              ? `repo cesta ${JSON.stringify(path)} je deklarovaná vícekrát`
              : `repo cesta ${JSON.stringify(path)} nese rozdílné repository slugs ${JSON.stringify(previousPath.id)} a ${JSON.stringify(id)}`
            : `repo cesty ${JSON.stringify(previousPath.path)} a ${JSON.stringify(path)} se liší jen velikostí písmen`,
        );
      }
    } else {
      paths.set(foldedPath, { path, id });
    }

    if (id === null) continue;
    const previousIdPath = ids.get(id);
    if (previousIdPath) {
      if (!(allowEquivalentDuplicates && previousIdPath === path)) {
        issues.push(
          `repository slug ${JSON.stringify(id)} používají zároveň ${JSON.stringify(previousIdPath)} a ${JSON.stringify(path)}`,
        );
      }
    } else {
      ids.set(id, path);
    }
  }
  return issues;
}

export function organizationSlotPathScope(path) {
  const normalizedPath = normalizeOrganizationSlotPath(path);
  if (
    isOrganizationRootSlotPath(normalizedPath)
    || isOrganizationRootSlotDescendantPath(normalizedPath)
  ) {
    return "root";
  }
  if (
    normalizedPath === "productionspace" ||
    normalizedPath?.startsWith("productionspace/")
  ) {
    return "productionspace";
  }
  if (
    isOrganizationSlotContainerPath(normalizedPath) ||
    normalizedPath?.startsWith("workspace/") ||
    normalizedPath?.startsWith("modules/")
  ) {
    return "workspace";
  }
  return null;
}

export function organizationSlotScope(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  // Fyzická path boundary má přednost před konfliktním deklarovaným `space`.
  // Doctor konflikt současně hlásí jako blokátor, ale read model nesmí ani
  // mezitím zpřístupnit productionspace/root repo jako akční Team modul.
  const pathScope = organizationSlotPathScope(path);
  if (pathScope) return pathScope;
  if (organizationSlotScopes.has(slot?.space)) return slot.space;
  return "workspace";
}

export function organizationSlotWorkspace(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  const space = organizationSlotScope(slot, path);
  if (space === "root") return null;
  if (space === "productionspace") return "productionspace";
  return organizationSlotTeams(slot, path)[0] ?? "workspace";
}

export function organizationSlotTeams(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  if (organizationSlotScope(slot, path) !== "workspace") return [];
  const declared = Array.isArray(slot?.teams)
    ? slot.teams
    : Array.isArray(slot?.workspaces)
      ? slot.workspaces
      : [slot?.workspace];
  const normalized = declared
    .filter((team) => typeof team === "string" && team.trim() !== "")
    .map((team) => team.trim())
    .filter((team) => team !== "productionspace");
  return normalized.length > 0 ? [...new Set(normalized)] : ["workspace"];
}

export function organizationSlotUiExposure(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  const declaredExposure = typeof slot?.ui_exposure === "string"
    ? slot.ui_exposure.trim().toLowerCase()
    : "";
  if (organizationSlotUiExposures.has(declaredExposure)) {
    return declaredExposure;
  }
  const sourceOfTruth = typeof slot?.source_of_truth === "string"
    ? slot.source_of_truth.trim().toLowerCase()
    : "";
  const repositoryDb = sourceOfTruth === "repository-db"
    || sourceOfTruth.startsWith("repository-db:");
  if (
    organizationDiagnosticsOnlySlotPaths.has(path)
    || (repositoryDb && organizationSlotScope(slot, path) === "root")
  ) {
    return "diagnostics-only";
  }
  return "module";
}

export function organizationSlotCatalogPresentation(slot, normalizedPath = null) {
  const description = typeof slot?.description === "string"
    ? slot.description.trim()
    : "";
  return {
    description: description === "" ? null : description,
    ui_exposure: organizationSlotUiExposure(slot, normalizedPath),
  };
}

// Manifest deklaruje inventory a sync intent, nikoli oprávnění aktuálního
// Principála. Chráněný slot se do každodenního Launchpad API promítne až když
// na této mašině existuje jeho checkout (poslední známý offline stav bez TTL).
// `required_roles: ["*"]` je explicitní veřejná deklarace a zůstává viditelná
// i před materializací.
export function organizationSlotProjectsToLocalMachine(
  slot,
  { materialized = slot?.status === "available" } = {},
) {
  if (materialized) return true;
  if (slot?.required_roles?.includes("*")) return true;
  return !protectedOrganizationSlotAccessModes.has(slot?.default_access);
}

export function normalizeOrganizationSlotPath(path) {
  if (typeof path !== "string") return null;
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  if (normalized === ".") return "";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
