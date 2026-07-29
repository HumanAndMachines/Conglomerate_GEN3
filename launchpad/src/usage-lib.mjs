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

// Historie počítadel přežije změnu velikosti písmen v app id.
//
// Konkrétní den, kvůli kterému to tady je: 2026-07-29 se dvacet app id
// (`AgentMint-*`, `Macano-Tech-*`) přejmenovalo na malá písmena, aby
// `launchpad.runtime.<id>` odpovídalo surfacu doctor reportu (decision 0118).
// usage.json je ale klíčovaný přesným řetězcem, takže by se devatenáct
// počítadel utrhlo od svých aplikací — nic by nespadlo, jen by panel
// „Nejčastější" tiše ukázal nulu. Že to není teorie, dokazuje tentýž soubor:
// po dřívějším přechodu Rozjedeme-ai v něm dodnes leží `Rozjedeme-ai-deals-v2`
// (count 5) vedle `rozjedeme-ai-deals-v2` a nikdo si toho nevšiml, protože
// osiřelý klíč se z panelu jen odfiltruje.
//
// Sčítáme proto záznamy, které se liší jen velikostí písmen, a párujeme je s
// discovery case-insensitive. Soubor se tím nepřepisuje — migrace se nevnucuje
// cizí mašině, jen se z ní přestane ztrácet historie.
function foldUsageByCaseInsensitiveId(usageApps) {
  const folded = new Map();
  for (const [appId, entry] of Object.entries(usageApps)) {
    const key = appId.toLowerCase();
    const previous = folded.get(key);
    const count = entry?.count ?? 0;
    const lastOpenedAt = entry?.last_opened_at ?? null;
    if (!previous) {
      folded.set(key, { count, last_opened_at: lastOpenedAt });
      continue;
    }
    previous.count += count;
    if (Date.parse(lastOpenedAt ?? 0) > Date.parse(previous.last_opened_at ?? 0)) {
      previous.last_opened_at = lastOpenedAt;
    }
  }
  return folded;
}

// Vrať nejčastěji otevírané aplikace, seřazené podle počtu (tie-break podle
// posledního otevření). Vrací jen ty, které jsou pořád v discovery (known ids).
export async function buildMostUsedApps({ launchpadRoot, apps = [], limit = DEFAULT_TOP_LIMIT } = {}) {
  const path = usageFilePath(launchpadRoot);
  const data = await readUsageFile(path);
  const knownIds = new Map(apps.map((app) => [app.id.toLowerCase(), app]));
  const usage = foldUsageByCaseInsensitiveId(data.apps);

  const ranked = [...usage.entries()]
    .filter(([appId]) => knownIds.has(appId))
    .map(([appId, entry]) => ({
      id: knownIds.get(appId)?.id ?? appId,
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
