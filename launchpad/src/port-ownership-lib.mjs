function ownerSortKey(owner) {
  return [
    String(owner.port ?? ""),
    owner.host ?? "",
    owner.scope ?? "",
    owner.visibility ?? "",
    owner.package_path ?? "",
    owner.company ?? "",
    owner.app_id ?? "",
    owner.listener_id ?? "",
  ].join("\u0000");
}

export function buildPortOwner({
  app,
  listener = app?.entrypoint_listener,
  packagePath,
  company,
  scope = "organization",
  visibility = "shared",
}) {
  const claim = listener?.claim ?? { mode: "exclusive" };
  return {
    port: listener?.allocation === "static" && Number.isInteger(listener?.port) ? listener.port : null,
    host: canonicalListenerHost(listener?.host ?? app?.host),
    scope,
    visibility,
    app_id: typeof app?.id === "string" ? app.id : null,
    company: typeof app?.company === "string" ? app.company : company?.slug ?? null,
    module: typeof app?.module === "string" ? app.module : null,
    package_path: packagePath ?? null,
    listener_id: typeof listener?.id === "string" ? listener.id : null,
    lease_id: typeof listener?.lease === "string" ? listener.lease : null,
    listener_role: typeof listener?.role === "string" ? listener.role : null,
    allocation: listener?.allocation ?? null,
    protocol: listener?.protocol ?? null,
    claim_mode: claim.mode ?? "exclusive",
    claim_group: typeof claim.group === "string" ? claim.group : null,
    runtime_schema_version: app?.runtime_contract?.schema_version ?? null,
    legacy: app?.runtime_contract?.legacy === true,
  };
}

export function buildPortOwnershipIndex(owners) {
  const normalizedOwners = owners
    .filter((owner) => Number.isInteger(owner.port))
    .sort((a, b) => ownerSortKey(a).localeCompare(ownerSortKey(b)));

  const byEndpoint = new Map();
  const usedPorts = new Set();
  for (const owner of normalizedOwners) {
    usedPorts.add(owner.port);
    const endpoint = listenerEndpointKey(owner);
    const existing = byEndpoint.get(endpoint) ?? [];
    existing.push(owner);
    byEndpoint.set(endpoint, existing);
  }

  const used_ports = [...usedPorts].sort((a, b) => a - b);
  const byPort = new Map();
  for (const owner of normalizedOwners) {
    const existing = byPort.get(owner.port) ?? [];
    existing.push(owner);
    byPort.set(owner.port, existing);
  }

  // VPN and module ownership are keyed by the port number, not by one local
  // bind spelling. 127.0.0.1:24001 and ::1:24001 therefore still collide.
  const overlaps = [...byPort.entries()]
    .filter(([, portOwners]) => portOwners.length > 1)
    .map(([port, portOwners]) => classifyListenerOverlap({ endpoint: `*:${port}`, owners: portOwners }))
    .sort((left, right) => left.port - right.port);
  const module_listener_drifts = findModuleListenerDrifts(normalizedOwners);

  return {
    owners: normalizedOwners,
    used_ports,
    by_port: byPort,
    by_endpoint: byEndpoint,
    overlaps,
    module_listener_drifts,
  };
}

export function findPortOverlaps(indexOrOwners) {
  const index = Array.isArray(indexOrOwners) ? buildPortOwnershipIndex(indexOrOwners) : indexOrOwners;
  return index.overlaps ?? [];
}

export function classifyListenerOverlap({ endpoint, owners }) {
  const leaseKeys = new Set(owners.map(moduleListenerLeaseKey).filter(Boolean));
  const companies = new Set(owners.map((owner) => owner.company).filter(Boolean));
  const legacy = owners.some((owner) => owner.legacy === true);
  const sameModuleLease = !legacy
    && owners.length > 1
    && leaseKeys.size === 1
    && owners.every((owner) => moduleListenerLeaseKey(owner));
  const crossOrganizationLease = !legacy
    && owners.length > 1
    && companies.size > 1
    && owners.every((owner) => moduleListenerLeaseKey(owner));
  const intentional = sameModuleLease || crossOrganizationLease;
  const separator = endpoint.lastIndexOf(":");
  const host = endpoint.slice(0, separator).replace(/^\[(.*)\]$/, "$1");
  const rawPort = endpoint.slice(separator + 1);
  return {
    endpoint,
    host,
    port: Number(rawPort),
    classification: intentional
      ? sameModuleLease
        ? "module-version-lease"
        : "cross-organization-lease"
      : legacy
        ? "legacy-overlap"
        : "declared-conflict",
    intentional,
    conflict: !intentional,
    claim_group: null,
    module_lease: sameModuleLease ? [...leaseKeys][0] : null,
    owners,
  };
}

export function findModuleListenerDrifts(owners) {
  const groups = new Map();
  for (const owner of owners) {
    const key = moduleListenerLeaseKey(owner);
    if (!key) continue;
    const existing = groups.get(key) ?? [];
    existing.push(owner);
    groups.set(key, existing);
  }

  return [...groups.entries()].flatMap(([moduleLease, leaseOwners]) => {
    const declarations = new Map();
    for (const owner of leaseOwners) {
      const signature = `${canonicalListenerHost(owner.host) ?? "127.0.0.1"}:${owner.port}/${owner.protocol ?? "tcp"}`;
      const existing = declarations.get(signature) ?? [];
      existing.push(owner);
      declarations.set(signature, existing);
    }
    if (declarations.size <= 1) return [];
    return [{
      module_lease: moduleLease,
      classification: "module-listener-drift",
      conflict: true,
      declarations: [...declarations.entries()].map(([endpoint, declarationOwners]) => ({
        endpoint,
        owners: declarationOwners,
      })),
      owners: leaseOwners,
    }];
  }).sort((left, right) => left.module_lease.localeCompare(right.module_lease));
}

export function canonicalListenerHost(host) {
  return host === "localhost" ? "127.0.0.1" : host;
}

function listenerEndpointKey(owner) {
  return `${canonicalListenerHost(owner.host) ?? "127.0.0.1"}:${owner.port}`;
}

function moduleListenerLeaseKey(owner) {
  if (!owner?.company || !owner?.module) return null;
  return owner.lease_id ? `${owner.company}/${owner.module}#${owner.lease_id}` : null;
}
