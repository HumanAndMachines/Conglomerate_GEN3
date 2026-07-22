const ROOT_HASH = "#/";
const PERSONALSPACE_HASH = "#/personalspace";

export function organizationHash(organizationSlug) {
  const slug = validRouteSegment(organizationSlug);
  if (!slug) throw new TypeError("Organization slug is required for a Launchpad deep-link.");
  return `#/org/${encodeURIComponent(slug)}`;
}

export function personalspaceHash() {
  return PERSONALSPACE_HASH;
}

export function parseLaunchpadHash(hash) {
  const serialized = String(hash ?? "").trim();
  if (serialized === "" || serialized === "#" || serialized === ROOT_HASH) {
    return { kind: "root" };
  }

  const path = serialized.startsWith("#") ? serialized.slice(1) : serialized;
  const segments = path.replace(/^\//, "").split("/");
  if (segments.length === 1 && segments[0] === "personalspace") {
    return { kind: "personalspace" };
  }
  if (segments.length === 2 && segments[0] === "org") {
    const organization = decodeRouteSegment(segments[1]);
    if (organization) return { kind: "organization", organization };
  }
  return { kind: "invalid" };
}

export function resolveLaunchpadHash(hash, {
  companies = [],
  personalspaceAvailable = false,
} = {}) {
  const route = parseLaunchpadHash(hash);
  if (route.kind === "root") return { status: "none", route };
  if (route.kind === "invalid") return { status: "invalid", route };
  if (route.kind === "personalspace") {
    return personalspaceAvailable
      ? { status: "matched", route, scope: "personal", company: "all" }
      : { status: "unavailable", route };
  }

  const organization = companies.find((company) => company?.slug === route.organization);
  return organization
    ? { status: "matched", route, scope: "org", company: organization.slug }
    : { status: "not_found", route };
}

function decodeRouteSegment(value) {
  try {
    return validRouteSegment(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function validRouteSegment(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized === ""
    || normalized.length > 160
    || normalized === "."
    || normalized === ".."
    || normalized.includes("/")
    || normalized.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) return null;
  return normalized;
}
