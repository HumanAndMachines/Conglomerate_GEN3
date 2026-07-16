// Panel „Nejčastější" (CAC-0044, step-007): lokální tracking otevření aplikací.
// GEN2 mělo fixní QUICK_APP_IDS hardcode jedné firmy; sdílený Launchpad musí
// být org-agnostic, takže tady měříme skutečné použití na dané mašině.
//
// Invarianty:
//  - Data žijí v launchpad/runtime/usage.json — mimo Git (runtime/ je
//    gitignored), per mašina, žádná PII (jen app id, počet, čas posledního
//    otevření).
//  - Cold start (nic ještě neotevřeno) vrací prázdný seznam; UI má fallback na
//    „připravené" aplikace.

import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

const USAGE_SCHEMA = "companiesascode.launchpad.usage.v1";
const DEFAULT_TOP_LIMIT = 6;

function usageFilePath(launchpadRoot) {
  return join(launchpadRoot, "runtime", "usage.json");
}

async function readUsageFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.apps !== "object") {
      return { schema_version: USAGE_SCHEMA, apps: {} };
    }
    return { schema_version: USAGE_SCHEMA, apps: parsed.apps };
  } catch {
    // Chybějící/nevalidní soubor = cold start, ne chyba.
    return { schema_version: USAGE_SCHEMA, apps: {} };
  }
}

async function writeUsageFile(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// Zaznamenej otevření aplikace. Idempotentní vůči souboru: přečti, inkrementuj,
// zapiš. appId je jediné, co ukládáme + agregát (count, last_opened_at).
export async function recordAppOpen({ launchpadRoot, appId, now = new Date() } = {}) {
  if (!appId) return null;
  const path = usageFilePath(launchpadRoot);
  const data = await readUsageFile(path);
  const entry = data.apps[appId] ?? { count: 0, last_opened_at: null };
  entry.count += 1;
  entry.last_opened_at = now.toISOString();
  data.apps[appId] = entry;
  await writeUsageFile(path, data);
  return { app_id: appId, ...entry };
}

// Vrať nejčastěji otevírané aplikace, seřazené podle počtu (tie-break podle
// posledního otevření). Vrací jen ty, které jsou pořád v discovery (known ids).
export async function buildMostUsedApps({ launchpadRoot, apps = [], limit = DEFAULT_TOP_LIMIT } = {}) {
  const path = usageFilePath(launchpadRoot);
  const data = await readUsageFile(path);
  const knownIds = new Map(apps.map((app) => [app.id, app]));

  const ranked = Object.entries(data.apps)
    .filter(([appId]) => knownIds.has(appId))
    .map(([appId, entry]) => ({
      id: appId,
      name: knownIds.get(appId)?.title ?? appId,
      company: knownIds.get(appId)?.company ?? null,
      company_display_name: knownIds.get(appId)?.company_display_name ?? null,
      icon: knownIds.get(appId)?.icon ?? null,
      count: entry.count ?? 0,
      last_opened_at: entry.last_opened_at ?? null,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return Date.parse(b.last_opened_at ?? 0) - Date.parse(a.last_opened_at ?? 0);
    })
    .slice(0, limit);

  return {
    schema_version: "companiesascode.launchpad.most_used.v1",
    generated_at: new Date().toISOString(),
    // Cold start = žádná otevření zatím zaznamenaná; UI má fallback.
    cold_start: ranked.length === 0,
    most_used: ranked,
  };
}
