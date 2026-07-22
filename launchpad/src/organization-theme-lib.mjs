import { constants } from "fs";
import { lstat, open, realpath } from "fs/promises";
import { isAbsolute, relative, resolve } from "path";

const maxThemeBytes = 256 * 1024;
const designSystemThemeCandidate = "design-system/launchpad.tokens.css";
const designSystemConfigCandidate = "design-system/design-system.config.json";

// Explicitní adaptér v design systému je cílový kontrakt. Starší Organization
// mounty už nesou GEN2 Launchpad skin odvozený ze stejného design systému, takže
// funguje jako kompatibilní fallback bez hardcodování názvů firem.
export const organizationThemeCandidates = [
  designSystemThemeCandidate,
  "launchpad/app/v1/web/style.css",
];

export const launchpadThemeTokenNames = new Set([
  "--bg",
  "--bg-elevated",
  "--bg-subtle",
  "--bg-muted",
  "--surface",
  "--surface-console",
  "--text",
  "--text-muted",
  "--text-subtle",
  "--line",
  "--line-strong",
  "--accent",
  "--on-accent",
  "--accent-soft",
  "--accent-ring",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--shadow-hover",
  "--r-sm",
  "--r-md",
  "--r-lg",
  "--r-pill",
  "--font-body",
  "--font-heading",
  "--font-mono",
  "--c-accent-200",
  "--c-accent-400",
  "--c-accent-500",
  "--c-accent-700",
  "--c-accent-800",
  "--c-accent-900",
  "--launchpad-body-background",
]);

const requiredThemeTokens = ["--bg", "--surface", "--text", "--accent", "--font-body"];
const requiredDarkThemeTokens = ["--bg", "--surface", "--text", "--accent"];

export async function readOrganizationLaunchpadTheme({ companiesRoot, organization }) {
  if (!organization?.path || organization.status === "planned") return null;

  const organizationRoot = resolve(companiesRoot, organization.path);
  let realOrganizationRoot;
  try {
    realOrganizationRoot = await realpath(organizationRoot);
  } catch {
    return null;
  }

  for (const candidate of organizationThemeCandidates) {
    const isDesignSystemAdapter = candidate === designSystemThemeCandidate;
    if (
      isDesignSystemAdapter
      && !await isApprovedOrganizationDesignSystem({
        organizationRoot,
        realOrganizationRoot,
        organizationSlug: organization.slug,
      })
    ) {
      continue;
    }

    try {
      const themeBytes = await readSafeOrganizationFile({
        organizationRoot,
        realOrganizationRoot,
        candidate,
      });
      if (!themeBytes) continue;
      const css = themeBytes.toString("utf8");
      const theme = extractLaunchpadTheme(css, { requireOnAccent: isDesignSystemAdapter });
      if (theme) return { source: candidate, ...theme };
    } catch {
      // Chybějící, nečitelný nebo nekompatibilní kandidát není blokátor.
    }
  }
  return null;
}

async function isApprovedOrganizationDesignSystem({
  organizationRoot,
  realOrganizationRoot,
  organizationSlug,
}) {
  if (typeof organizationSlug !== "string" || !organizationSlug) return false;
  try {
    const configBytes = await readSafeOrganizationFile({
      organizationRoot,
      realOrganizationRoot,
      candidate: designSystemConfigCandidate,
    });
    if (!configBytes) return false;
    const config = JSON.parse(configBytes.toString("utf8"));
    return (
      config?.mode === "organization"
      && config?.content_status === "approved"
      && config?.organization?.slug === organizationSlug
    );
  } catch {
    return false;
  }
}

async function readSafeOrganizationFile({
  organizationRoot,
  realOrganizationRoot,
  candidate,
}) {
  const candidatePath = resolve(organizationRoot, candidate);
  let file;
  try {
    const stats = await lstat(candidatePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxThemeBytes) return null;
    const realCandidatePath = await realpath(candidatePath);
    const relativePath = relative(realOrganizationRoot, realCandidatePath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
    file = await open(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await file.stat();
    if (!openedStats.isFile() || openedStats.size > maxThemeBytes) return null;
    const bytes = await file.readFile();
    return bytes.byteLength <= maxThemeBytes ? bytes : null;
  } finally {
    await file?.close();
  }
}

export function extractLaunchpadTheme(css, { requireOnAccent = false } = {}) {
  const withoutComments = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const rootBlock = extractCssBlock(withoutComments, /:root\s*\{/g);
  if (!rootBlock) return null;

  const lightSource = parseCustomProperties(rootBlock);
  const darkBlock = extractCssBlock(withoutComments, /\[data-theme\s*=\s*["']dark["']\]\s*\{/g);
  const darkSource = darkBlock ? parseCustomProperties(darkBlock) : new Map();
  const light = resolvedAllowedTokens(lightSource);
  const requiredLightTokens = requireOnAccent
    ? [...requiredThemeTokens, "--on-accent"]
    : requiredThemeTokens;
  if (!requiredLightTokens.every((token) => light[token])) return null;

  const dark = resolvedAllowedTokens(new Map([...lightSource, ...darkSource]), new Set(darkSource.keys()));
  const requiredDarkTokens = requireOnAccent
    ? [...requiredDarkThemeTokens, "--on-accent"]
    : requiredDarkThemeTokens;
  if (!requiredDarkTokens.every((token) => dark[token])) return null;
  addAccentAliases({
    light,
    dark,
    lightSource,
    alignDarkAccentRamp: requireOnAccent,
  });
  light["--font-heading"] ??= light["--font-body"];
  light["--launchpad-body-background"] = "linear-gradient(180deg, var(--bg-muted) 0%, var(--bg) 42%)";
  dark["--launchpad-body-background"] = "linear-gradient(180deg, var(--bg-muted) 0%, var(--bg) 42%)";

  return { light, dark };
}

function extractCssBlock(css, selectorPattern) {
  selectorPattern.lastIndex = 0;
  const match = selectorPattern.exec(css);
  if (!match) return null;
  const openingBrace = css.indexOf("{", match.index);
  let depth = 0;
  let quote = null;
  for (let index = openingBrace; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (character === quote && css[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(openingBrace + 1, index);
    }
  }
  return null;
}

function parseCustomProperties(block) {
  const properties = new Map();
  const pattern = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+);?/g;
  for (const match of block.matchAll(pattern)) {
    properties.set(match[1], match[2].trim());
  }
  return properties;
}

function resolvedAllowedTokens(source, only = null) {
  const result = {};
  for (const token of launchpadThemeTokenNames) {
    if (only && !only.has(token)) continue;
    const value = resolveCustomProperty(token, source);
    if (isSafeThemeValue(token, value)) result[token] = value;
  }
  return result;
}

function resolveCustomProperty(token, source, stack = new Set()) {
  if (stack.has(token)) return null;
  const original = source.get(token);
  if (!original) return null;
  const nextStack = new Set(stack).add(token);
  let valid = true;
  const resolved = original.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+))?\)/g, (_match, reference, fallback) => {
    const value = resolveCustomProperty(reference, source, nextStack) ?? fallback?.trim();
    if (!value) valid = false;
    return value ?? "";
  });
  return valid ? resolved.trim() : null;
}

function isSafeThemeValue(token, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || /[\\{};<>:@]/.test(value)) {
    return false;
  }
  if (token.startsWith("--font-")) return /^[a-zA-Z0-9 ,"'_-]+$/.test(value);
  if (token.startsWith("--r-")) return /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/.test(value);
  if (token.startsWith("--shadow-")) return isSafeShadow(value);
  if (token === "--launchpad-body-background") {
    return value === "linear-gradient(180deg, var(--bg-muted) 0%, var(--bg) 42%)";
  }
  if (token === "--on-accent") return isSafeOpaqueColor(value);
  return isSafeColor(value);
}

function isSafeColor(value) {
  return /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.%,\s+-]+\)|transparent|white|black)$/.test(value);
}

function isSafeOpaqueColor(value) {
  if (value === "white" || value === "black") return true;
  const hex = value.match(/^#([0-9a-fA-F]+)$/)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 6) return true;
    if (hex.length === 4) return hex.endsWith("f") || hex.endsWith("F");
    if (hex.length === 8) return hex.endsWith("ff") || hex.endsWith("FF");
    return false;
  }
  const colorFunction = value.match(/^(rgb|rgba|hsl|hsla)\(([\d.%,\s+/-]+)\)$/);
  if (!colorFunction) return false;
  const serializedComponents = colorFunction[2].trim();
  let components;
  let alpha;
  if (serializedComponents.includes("/")) {
    if (serializedComponents.includes(",")) return false;
    const slashParts = serializedComponents.split("/");
    if (slashParts.length !== 2) return false;
    components = slashParts[0].trim().split(/\s+/);
    alpha = slashParts[1].trim();
  } else if (serializedComponents.includes(",")) {
    components = serializedComponents.split(",").map((component) => component.trim());
    alpha = components.length === 4 ? components.pop() : undefined;
  } else {
    components = serializedComponents.split(/\s+/);
  }
  if (components.length !== 3 || !alpha && serializedComponents.includes("/")) return false;
  const [first, second, third] = components;
  const validComponents = colorFunction[1].startsWith("rgb")
    ? [first, second, third].every(isCssNumberOrPercentage)
    : isCssNumber(first) && isCssPercentage(second) && isCssPercentage(third);
  if (!validComponents) return false;
  return alpha === undefined || /^(?:1(?:\.0+)?|100(?:\.0+)?%)$/.test(alpha);
}

function isCssNumber(value) {
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value);
}

function isCssPercentage(value) {
  return value.endsWith("%") && isCssNumber(value.slice(0, -1));
}

function isCssNumberOrPercentage(value) {
  return isCssNumber(value) || isCssPercentage(value);
}

function isSafeShadow(value) {
  if (!/^[a-zA-Z0-9#.,%()\s+-]+$/.test(value)) return false;
  const functions = [...value.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*\(/g)].map((match) => match[1]);
  if (functions.some((name) => !["rgb", "rgba", "hsl", "hsla"].includes(name))) return false;
  return /(?:^|\s)-?\d/.test(value) && /(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\()/.test(value);
}

function addAccentAliases({
  light,
  dark,
  lightSource,
  alignDarkAccentRamp,
}) {
  const lightAccentReference = referencedToken(lightSource.get("--accent"));
  for (const weight of [200, 400, 500, 700, 800, 900]) {
    const sourceToken = lightAccentReference?.replace(/-(?:50|100|200|400|500|600|700|800|900)$/, `-${weight}`);
    const sourceValue = sourceToken ? resolveCustomProperty(sourceToken, lightSource) : null;
    if (isSafeThemeValue(`--c-accent-${weight}`, sourceValue)) light[`--c-accent-${weight}`] = sourceValue;
  }
  light["--c-accent-500"] ??= light["--accent"];
  light["--c-accent-400"] ??= light["--accent"];
  light["--c-accent-700"] ??= light["--accent"];

  const darkAccent = dark["--accent"];
  if (isSafeThemeValue("--c-accent-400", darkAccent)) {
    dark["--c-accent-400"] = darkAccent;
    if (alignDarkAccentRamp) dark["--c-accent-500"] = darkAccent;
  }
}

function referencedToken(value) {
  return value?.match(/var\(\s*(--[a-zA-Z0-9_-]+)/)?.[1] ?? null;
}
