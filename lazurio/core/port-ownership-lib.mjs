function ownerSortKey(owner) {
  return [
    owner.scope ?? "",
    owner.visibility ?? "",
    owner.package_path ?? "",
    owner.company ?? "",
    owner.app_id ?? "",
  ].join("\u0000");
}

export function buildPortOwner({ app, packagePath, company, scope = "organization", visibility = "shared" }) {
  return {
    port: Number.isInteger(app?.port) ? app.port : null,
    scope,
    visibility,
    app_id: typeof app?.id === "string" ? app.id : null,
    company: typeof app?.company === "string" ? app.company : company?.slug ?? null,
    module: typeof app?.module === "string" ? app.module : null,
    package_path: packagePath ?? null,
  };
}

export function buildPortOwnershipIndex(owners) {
  const normalizedOwners = owners
    .filter((owner) => Number.isInteger(owner.port))
    .sort((a, b) => ownerSortKey(a).localeCompare(ownerSortKey(b)));

  const byPort = new Map();
  const usedPorts = new Set();
  for (const owner of normalizedOwners) {
    usedPorts.add(owner.port);
    const existing = byPort.get(owner.port) ?? [];
    existing.push(owner);
    byPort.set(owner.port, existing);
  }

  const used_ports = [...usedPorts].sort((a, b) => a - b);
  const overlaps = [...byPort.entries()]
    .filter(([, portOwners]) => portOwners.length > 1)
    .sort(([left], [right]) => left - right)
    .map(([port, portOwners]) => ({
      port,
      owners: portOwners,
    }));

  return {
    owners: normalizedOwners,
    used_ports,
    by_port: byPort,
    overlaps,
  };
}

export function findPortOverlaps(indexOrOwners) {
  const index = Array.isArray(indexOrOwners) ? buildPortOwnershipIndex(indexOrOwners) : indexOrOwners;
  return index.overlaps ?? [];
}
