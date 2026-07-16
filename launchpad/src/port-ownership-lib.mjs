export const APP_PORT_MIN = 1024;
export const APP_PORT_MAX = 65535;

function normalizePort(port, { minPort = APP_PORT_MIN, maxPort = APP_PORT_MAX } = {}) {
  return Number.isInteger(port) && port >= minPort && port <= maxPort ? port : null;
}

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

export function suggestNextFreePort(
  usedPorts,
  { afterPort = null, minPort = APP_PORT_MIN, maxPort = APP_PORT_MAX } = {},
) {
  const used = new Set(
    [...usedPorts]
      .map((port) => normalizePort(port, { minPort, maxPort }))
      .filter((port) => port !== null),
  );
  if (used.size >= maxPort - minPort + 1) return null;

  const rawStart = Number.isInteger(afterPort) ? afterPort + 1 : minPort;
  const start = rawStart >= minPort && rawStart <= maxPort ? rawStart : minPort;

  for (let port = start; port <= maxPort; port += 1) {
    if (!used.has(port)) return port;
  }
  for (let port = minPort; port < start; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

export function buildPortOwnershipIndex(
  owners,
  { minPort = APP_PORT_MIN, maxPort = APP_PORT_MAX } = {},
) {
  const normalizedOwners = owners
    .map((owner) => ({ ...owner, port: normalizePort(owner.port, { minPort, maxPort }) }))
    .filter((owner) => owner.port !== null)
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
  const collisions = [...byPort.entries()]
    .filter(([, portOwners]) => portOwners.length > 1)
    .map(([port, portOwners]) => ({
      port,
      owners: portOwners,
      suggested_free_port: suggestNextFreePort(used_ports, { afterPort: port, minPort, maxPort }),
    }));

  return {
    owners: normalizedOwners,
    used_ports,
    by_port: byPort,
    collisions,
  };
}

export function findPortCollisions(indexOrOwners, options = {}) {
  const index = Array.isArray(indexOrOwners) ? buildPortOwnershipIndex(indexOrOwners, options) : indexOrOwners;
  return index.collisions ?? [];
}

export function portOwnerLabel(owner) {
  if (!owner || typeof owner !== "object") return "unknown app";
  if (owner.visibility === "private") return "private_local_port_collision";
  return owner.package_path ?? owner.app_id ?? owner.company ?? "unknown app";
}

export function formatPortCollisionFailure({ owner, existingOwner, usedPorts }) {
  const suggestedFreePort = suggestNextFreePort(usedPorts, { afterPort: owner.port });
  const suggestion = suggestedFreePort === null ? "null" : String(suggestedFreePort);
  return `${portOwnerLabel(owner)}: port ${owner.port} koliduje s ${portOwnerLabel(existingOwner)}; suggested_free_port=${suggestion}`;
}
