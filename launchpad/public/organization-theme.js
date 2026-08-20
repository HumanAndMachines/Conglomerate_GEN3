export function safeOpaqueOrganizationThemeColor(value) {
  if (typeof value !== "string" || value.length > 100 || value === "transparent") return false;
  if (value === "white" || value === "black") return true;
  const hex = value.match(/^#([0-9a-fA-F]+)$/)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 6) return true;
    if (hex.length === 4) return hex.endsWith("f") || hex.endsWith("F");
    if (hex.length === 8) return hex.endsWith("ff") || hex.endsWith("FF");
    return false;
  }
  const colorFunction = parseOrganizationThemeColorFunction(value);
  return colorFunction !== null && (
    colorFunction.alpha === undefined
    || /^(?:1(?:\.0+)?|100(?:\.0+)?%)$/.test(colorFunction.alpha)
  );
}

function parseOrganizationThemeColorFunction(value) {
  const match = value.match(/^(rgb|rgba|hsl|hsla)\(([\d.%,\s+/-]+)\)$/);
  if (!match) return null;
  const serializedComponents = match[2].trim();
  let components;
  let alpha;
  if (serializedComponents.includes("/")) {
    if (serializedComponents.includes(",")) return null;
    const slashParts = serializedComponents.split("/");
    if (slashParts.length !== 2) return null;
    components = slashParts[0].trim().split(/\s+/);
    alpha = slashParts[1].trim();
  } else if (serializedComponents.includes(",")) {
    components = serializedComponents.split(",").map((component) => component.trim());
    alpha = components.length === 4 ? components.pop() : undefined;
  } else {
    components = serializedComponents.split(/\s+/);
  }
  if (components.length !== 3 || alpha !== undefined && !cssNumberOrPercentage(alpha)) return null;
  const [first, second, third] = components;
  const validComponents = match[1].startsWith("rgb")
    ? [first, second, third].every(cssNumberOrPercentage)
    : cssNumber(first) && cssPercentage(second) && cssPercentage(third);
  return validComponents ? { alpha } : null;
}

function cssNumber(value) {
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value);
}

function cssPercentage(value) {
  return value.endsWith("%") && cssNumber(value.slice(0, -1));
}

function cssNumberOrPercentage(value) {
  return cssNumber(value) || cssPercentage(value);
}
