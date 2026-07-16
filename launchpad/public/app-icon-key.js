const DEFAULT_ICON_KEYS = new Set([
  "control",
  "book",
  "pen",
  "palette",
  "deal",
  "warehouse",
  "product",
  "datasheet",
  "pricebook",
  "invoice",
  "installation",
  "dashboard",
  "profitability",
  "marketing",
  "website",
  "examples",
  "database",
  "system",
  "app",
]);

function knownIcon(knownIconKeys, key) {
  if (knownIconKeys instanceof Set) return knownIconKeys.has(key);
  return Boolean(knownIconKeys && Object.prototype.hasOwnProperty.call(knownIconKeys, key));
}

function semanticTokens(app) {
  return new Set(
    [app?.module, app?.id, ...(Array.isArray(app?.tags) ? app.tags : [])]
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

function hasAny(tokens, values) {
  return values.some((value) => tokens.has(value));
}

// Ikona vyjadřuje funkci modulu. Manifest zůstává autorita; tato taxonomie je
// pouze org-agnostic fallback pro appky, které vlastní klíč ikony ještě nemají.
export function semanticAppIconKey(app, knownIconKeys = DEFAULT_ICON_KEYS) {
  if (typeof app?.icon === "string" && knownIcon(knownIconKeys, app.icon)) return app.icon;

  const tokens = semanticTokens(app);
  if (hasAny(tokens, ["datasheet", "datasheets", "spreadsheet", "spreadsheets"])) return "datasheet";
  if (hasAny(tokens, ["warehouse", "inventory", "stock"])) return "warehouse";
  if (hasAny(tokens, ["product", "products", "catalog", "catalogue"])) return "product";
  if (hasAny(tokens, ["pricebook", "pricing", "prices"])) return "pricebook";
  if (hasAny(tokens, ["invoice", "invoices", "billing"])) return "invoice";
  if (hasAny(tokens, ["installation", "installations", "maintenance", "repair", "service"])) return "installation";
  if (hasAny(tokens, ["dashboard", "analytics", "metrics", "reporting"])) return "dashboard";
  if (hasAny(tokens, ["profitability", "profit", "margin", "forecast"])) return "profitability";
  if (hasAny(tokens, ["deal", "deals", "sales", "crm", "quote", "quotes", "offer", "offers"])) return "deal";
  if (hasAny(tokens, ["mission", "control", "admin", "automation", "automations"])) return "control";
  if (hasAny(tokens, ["knowledge", "knowledgebase", "guide", "doc", "docs", "document", "documents", "documentation", "wiki", "manual"])) return "book";
  if (hasAny(tokens, ["content", "editor", "blog", "news", "copy"])) return "pen";
  if (hasAny(tokens, ["marketing", "campaign", "campaigns", "promotion", "promotions"])) return "marketing";
  if (hasAny(tokens, ["website", "websites", "web", "portal", "site"])) return "website";
  if (hasAny(tokens, ["example", "examples", "sample", "samples", "demo", "demos"])) return "examples";
  if (hasAny(tokens, ["design", "brand", "theme", "palette"])) return "palette";
  if (hasAny(tokens, ["database", "db", "repository", "storage", "ledger", "mint"])) return "database";
  if (hasAny(tokens, ["system", "server", "infrastructure", "infra"])) return "system";
  return "app";
}
