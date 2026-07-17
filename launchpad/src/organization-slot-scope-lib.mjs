import { posix } from "path";

const organizationSlotScopes = new Set(["root", "workspace", "productionspace"]);
const organizationRootSlotPaths = new Set([
  "design-system",
  "infra",
  "mission-control",
  "mission-control/db",
]);

export function isOrganizationRootSlotPath(path) {
  const normalizedPath = normalizeOrganizationSlotPath(path);
  return normalizedPath !== null && organizationRootSlotPaths.has(normalizedPath);
}

export function organizationSlotScope(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  // Rezervované Organization root checkout boundaries nesmí nevalidní
  // deklarace přesunout do Teamu. Doctor současně nahlásí chybějící nebo
  // konfliktní explicitní `space: "root"`.
  if (isOrganizationRootSlotPath(path)) return "root";
  if (organizationSlotScopes.has(slot?.space)) return slot.space;
  if (path?.startsWith("productionspace/")) return "productionspace";
  return "workspace";
}

export function organizationSlotWorkspace(slot, normalizedPath = null) {
  const path = normalizeOrganizationSlotPath(normalizedPath ?? slot?.path);
  const space = organizationSlotScope(slot, path);
  if (space === "root") return null;
  if (space === "productionspace") return "productionspace";
  return slot?.workspace ?? "workspace";
}

export function normalizeOrganizationSlotPath(path) {
  if (typeof path !== "string") return null;
  const normalized = posix.normalize(path.replace(/\\/g, "/"));
  if (normalized === ".") return "";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
