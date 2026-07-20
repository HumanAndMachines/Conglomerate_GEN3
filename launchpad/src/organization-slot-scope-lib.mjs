import { posix } from "path";

const organizationSlotScopes = new Set(["root", "workspace", "productionspace"]);
const organizationRootSlotPaths = new Set([
  "design-system",
  "infra",
  "mission-control",
  "mission-control/db",
]);
const organizationDiagnosticsOnlySlotPaths = new Set([
  "mission-control/db",
]);

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
    || /^(workspace|modules|productionspace)\/[a-z0-9][a-z0-9-]*$/.test(normalizedPath)
  );
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
  return slot?.workspace ?? "workspace";
}

export function organizationSlotUiExposure(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  const sourceOfTruth = typeof slot?.source_of_truth === "string"
    ? slot.source_of_truth.trim().toLowerCase()
    : "";
  if (
    organizationDiagnosticsOnlySlotPaths.has(path)
    || sourceOfTruth === "repository-db"
    || sourceOfTruth.startsWith("repository-db:")
  ) {
    return "diagnostics-only";
  }
  return "module";
}

export function normalizeOrganizationSlotPath(path) {
  if (typeof path !== "string") return null;
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  if (normalized === ".") return "";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
