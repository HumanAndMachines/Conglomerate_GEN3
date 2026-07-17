const organizationSlotScopes = new Set(["root", "workspace", "productionspace"]);

export function organizationSlotScope(slot, normalizedPath = null) {
  if (organizationSlotScopes.has(slot?.space)) return slot.space;
  const path = normalizedPath ?? normalizeSlotPath(slot?.path);
  if (path?.startsWith("productionspace/")) return "productionspace";
  return "workspace";
}

export function organizationSlotWorkspace(slot, normalizedPath = null) {
  const path = normalizedPath ?? normalizeSlotPath(slot?.path);
  const space = organizationSlotScope(slot, path);
  if (space === "root") return null;
  if (space === "productionspace") return "productionspace";
  return slot?.workspace ?? "workspace";
}

function normalizeSlotPath(path) {
  if (typeof path !== "string") return null;
  return path.replace(/\\/g, "/");
}
