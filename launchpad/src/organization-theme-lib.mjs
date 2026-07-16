import { constants } from "fs";
import { lstat, open, realpath } from "fs/promises";
import { isAbsolute, relative, resolve } from "path";

const maxThemeBytes = 256 * 1024;

// Explicitní adaptér v design systému je cílový kontrakt. Starší Organization
// mounty už nesou GEN2 Launchpad skin odvozený ze stejného design systému, takže
// funguje jako kompatibilní fallback bez hardcodování názvů firem.
export const organizationThemeCandidates = [
  "design-system/launchpad.tokens.css",
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
    const candidatePath = resolve(organizationRoot, candidate);
    let themeFile;
    try {
      const stats = await lstat(candidatePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxThemeBytes) continue;
      const realCandidatePath = await realpath(candidatePath);
      const relativePath = relative(realOrganizationRoot, realCandidatePath);
      if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
      themeFile = await open(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const openedStats = await themeFile.stat();
      if (!openedStats.isFile() || openedStats.size > maxThemeBytes) continue;
      const themeBytes = await themeFile.readFile();
      if (themeBytes.byteLength > maxThemeBytes) continue;
      const css = themeBytes.toString("utf8");
      const theme = extractLaunchpadTheme(css);
      if (theme) return { source: candidate, ...theme };
    } catch {
      // Chybějící, nečitelný nebo nekompatibilní kandidát není blokátor.
    } finally {
      await themeFile?.close();
    }
  }
  return null;
}

export function extractLaunchpadTheme(css) {
  const withoutComments = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const rootBlock = extractCssBlock(withoutComments, /:root\s*\{/g);
  if (!rootBlock) return null;

  const lightSource = parseCustomProperties(rootBlock);
  const darkBlock = extractCssBlock(withoutComments, /\[data-theme\s*=\s*["']dark["']\]\s*\{/g);
  const darkSource = darkBlock ? parseCustomProperties(darkBlock) : new Map();
  const light = resolvedAllowedTokens(lightSource);
  if (!requiredThemeTokens.every((token) => light[token])) return null;

  const dark = resolvedAllowedTokens(new Map([...lightSource, ...darkSource]), new Set(darkSource.keys()));
  if (!requiredDarkThemeTokens.every((token) => dark[token])) return null;
  addAccentAliases({ light, dark, lightSource, darkSource });
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
  return isSafeColor(value);
}

function isSafeColor(value) {
  return /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.%,\s+-]+\)|transparent|white|black)$/.test(value);
}

function isSafeShadow(value) {
  if (!/^[a-zA-Z0-9#.,%()\s+-]+$/.test(value)) return false;
  const functions = [...value.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*\(/g)].map((match) => match[1]);
  if (functions.some((name) => !["rgb", "rgba", "hsl", "hsla"].includes(name))) return false;
  return /(?:^|\s)-?\d/.test(value) && /(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\()/.test(value);
}

function addAccentAliases({ light, dark, lightSource, darkSource }) {
  const lightAccentReference = referencedToken(lightSource.get("--accent"));
  const darkCombined = new Map([...lightSource, ...darkSource]);
  for (const weight of [200, 400, 500, 700, 800, 900]) {
    const sourceToken = lightAccentReference?.replace(/-(?:50|100|200|400|500|600|700|800|900)$/, `-${weight}`);
    const sourceValue = sourceToken ? resolveCustomProperty(sourceToken, lightSource) : null;
    if (isSafeThemeValue(`--c-accent-${weight}`, sourceValue)) light[`--c-accent-${weight}`] = sourceValue;
  }
  light["--c-accent-500"] ??= light["--accent"];
  light["--c-accent-400"] ??= light["--accent"];
  light["--c-accent-700"] ??= light["--accent"];

  const darkAccentReference = referencedToken(darkSource.get("--accent"));
  const darkAccent = darkAccentReference
    ? resolveCustomProperty(darkAccentReference, darkCombined)
    : dark["--accent"];
  if (isSafeThemeValue("--c-accent-400", darkAccent)) dark["--c-accent-400"] = darkAccent;
}

function referencedToken(value) {
  return value?.match(/var\(\s*(--[a-zA-Z0-9_-]+)/)?.[1] ?? null;
}
