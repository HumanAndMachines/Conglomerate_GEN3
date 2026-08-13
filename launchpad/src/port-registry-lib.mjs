const REGISTRY_KEYS = new Set(["schema_version", "allocation_strategy", "organization_blocks"]);
const BLOCK_KEYS = new Set(["company", "start", "end"]);
const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function normalizePortRegistry(registry, {
  source = "lazurio.port-registry.json",
} = {}) {
  const issues = [];
  const label = `${source}: lazurio port registry`;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return { registry: null, issues: [`${label} musí být object`] };
  }
  for (const key of Object.keys(registry)) {
    if (!REGISTRY_KEYS.has(key)) issues.push(`${label}.${key} není povolené pole`);
  }
  if (registry.schema_version !== "lazurio.port_registry.v1") {
    issues.push(`${label}.schema_version musí být lazurio.port_registry.v1`);
  }
  if (registry.allocation_strategy !== "organization-blocks") {
    issues.push(`${label}.allocation_strategy musí být organization-blocks`);
  }
  if (!Array.isArray(registry.organization_blocks) || registry.organization_blocks.length === 0) {
    issues.push(`${label}.organization_blocks musí být neprázdné pole`);
    return { registry: null, issues };
  }
  const companies = new Set();
  const blocks = [];
  for (const [index, block] of registry.organization_blocks.entries()) {
    const blockLabel = `${label}.organization_blocks[${index}]`;
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      issues.push(`${blockLabel} musí být object`);
      continue;
    }
    for (const key of Object.keys(block)) {
      if (!BLOCK_KEYS.has(key)) issues.push(`${blockLabel}.${key} není povolené pole`);
    }
    if (typeof block.company !== "string" || !COMPANY_ID.test(block.company)) {
      issues.push(`${blockLabel}.company není validní`);
    } else if (companies.has(block.company)) {
      issues.push(`${blockLabel}.company ${block.company} je duplicitní`);
    } else {
      companies.add(block.company);
    }
    for (const key of ["start", "end"]) {
      if (!Number.isInteger(block[key]) || block[key] < 1024 || block[key] > 65_535) {
        issues.push(`${blockLabel}.${key} musí být číslo 1024-65535`);
      }
    }
    if (Number.isInteger(block.start) && Number.isInteger(block.end) && block.start > block.end) {
      issues.push(`${blockLabel}.start nesmí být větší než end`);
    }
    blocks.push({ company: block.company, start: block.start, end: block.end });
  }
  const sorted = [...blocks].sort((left, right) => left.start - right.start || left.end - right.end);
  let widest = sorted[0] ?? null;
  for (let index = 1; index < sorted.length; index += 1) {
    if (widest && sorted[index].start <= widest.end) {
      issues.push(`${label}: bloky ${widest.company} a ${sorted[index].company} se překrývají`);
    }
    if (!widest || sorted[index].end > widest.end) widest = sorted[index];
  }
  return {
    registry: issues.length === 0
      ? {
          schema_version: registry.schema_version,
          allocation_strategy: registry.allocation_strategy,
          organization_blocks: blocks,
        }
      : null,
    issues,
  };
}

export function portRegistryBlock(registry, company) {
  return registry?.organization_blocks?.find((block) => block.company === company) ?? null;
}

export function validateModuleLeasesAgainstRegistry({ modules, registry }) {
  const issues = [];
  const owners = new Map();
  const moduleSources = new Map();
  for (const module of modules) {
    const moduleKey = `${module.company}/${module.id}`;
    const priorSource = moduleSources.get(moduleKey);
    if (priorSource && priorSource !== module.module_path) {
      issues.push(
        `${moduleKey} má více module-root manifestů: ${priorSource} a ${module.module_path}`,
      );
      continue;
    }
    moduleSources.set(moduleKey, module.module_path);
    const block = portRegistryBlock(registry, module.company);
    if (!block) {
      issues.push(`${module.module_path}: company ${module.company} nemá centrálně přidělený port block`);
      continue;
    }
    for (const lease of module.port_leases ?? []) {
      if (lease.port < block.start || lease.port > block.end) {
        issues.push(`${module.module_path}: lease ${lease.id} port ${lease.port} leží mimo block ${block.start}-${block.end}`);
      }
      const owner = owners.get(lease.port);
      if (
        owner &&
        (
          owner.company !== module.company ||
          owner.module !== module.id ||
          owner.source !== module.module_path ||
          owner.lease !== lease.id
        )
      ) {
        issues.push(`port ${lease.port} vlastní dva moduly: ${owner.company}/${owner.module} a ${module.company}/${module.id}`);
      } else {
        owners.set(lease.port, {
          company: module.company,
          module: module.id,
          lease: lease.id,
          source: module.module_path,
        });
      }
    }
  }
  return issues;
}

export function nextFreeModulePort({ registry, company, modules }) {
  const block = portRegistryBlock(registry, company);
  if (!block) throw new Error(`Company ${company} nemá centrální port block`);
  const used = new Set(
    modules
      .filter((module) => module.company === company)
      .flatMap((module) => module.port_leases ?? [])
      .map((lease) => lease.port),
  );
  // x00 is reserved as the human-readable Organization block identifier;
  // module leases start at x01 by contract.
  for (let port = block.start + 1; port <= block.end; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error(`Port block ${block.start}-${block.end} pro ${company} je vyčerpaný`);
}
