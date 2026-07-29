import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { buildMostUsedApps, recordAppOpen } from "./usage-lib.mjs";

const tempRoots = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeLaunchpadRoot() {
  const root = await mkdtemp(join(tmpdir(), "launchpad-usage-"));
  tempRoots.push(root);
  return root;
}

const apps = [
  { id: "alpha", title: "Alpha", company: "acme", company_display_name: "Acme", icon: "control" },
  { id: "beta", title: "Beta", company: "acme", company_display_name: "Acme", icon: null },
  { id: "gamma", title: "Gamma", company: "acme", company_display_name: "Acme", icon: null },
];

test("usage tracking je cold start, dokud se nic neotevře", async () => {
  const launchpadRoot = await makeLaunchpadRoot();
  const result = await buildMostUsedApps({ launchpadRoot, apps });
  expect(result.cold_start).toBe(true);
  expect(result.most_used).toEqual([]);
});

test("usage tracking řadí podle skutečného počtu otevření", async () => {
  const launchpadRoot = await makeLaunchpadRoot();
  await recordAppOpen({ launchpadRoot, appId: "beta" });
  await recordAppOpen({ launchpadRoot, appId: "beta" });
  await recordAppOpen({ launchpadRoot, appId: "beta" });
  await recordAppOpen({ launchpadRoot, appId: "alpha" });

  const result = await buildMostUsedApps({ launchpadRoot, apps });
  expect(result.cold_start).toBe(false);
  expect(result.most_used.map((entry) => entry.id)).toEqual(["beta", "alpha"]);
  expect(result.most_used[0].count).toBe(3);
  expect(result.most_used[0].name).toBe("Beta");
});

test("usage tracking ignoruje appky mimo aktuální discovery", async () => {
  const launchpadRoot = await makeLaunchpadRoot();
  await recordAppOpen({ launchpadRoot, appId: "removed-app" });
  await recordAppOpen({ launchpadRoot, appId: "alpha" });

  const result = await buildMostUsedApps({ launchpadRoot, apps });
  expect(result.most_used.map((entry) => entry.id)).toEqual(["alpha"]);
});

test("usage tracking nezapisuje žádnou PII, jen id + agregát", async () => {
  const launchpadRoot = await makeLaunchpadRoot();
  await recordAppOpen({ launchpadRoot, appId: "alpha", now: new Date("2026-07-03T10:00:00Z") });
  const raw = await Bun.file(join(launchpadRoot, "runtime", "usage.json")).json();
  expect(Object.keys(raw.apps)).toEqual(["alpha"]);
  expect(Object.keys(raw.apps.alpha).sort()).toEqual(["count", "last_opened_at"]);
});

test("usage tracking drží globální limit odpovědi", async () => {
  const launchpadRoot = await makeLaunchpadRoot();
  const multiCompanyApps = [
    ...apps,
    { id: "delta", title: "Delta", company: "beta", company_display_name: "Beta", icon: null },
    { id: "epsilon", title: "Epsilon", company: "beta", company_display_name: "Beta", icon: null },
  ];
  for (const appId of ["alpha", "beta", "delta", "epsilon"]) {
    await recordAppOpen({ launchpadRoot, appId });
  }

  const result = await buildMostUsedApps({ launchpadRoot, apps: multiCompanyApps, limit: 1 });
  expect(result.most_used).toHaveLength(1);
});

// Regrese k přejmenování app id na malá písmena (decision 0118, founder ruling
// 2026-07-29). Bez foldu se počítadlo utrhne od aplikace a panel ukáže nulu —
// přesně to, co se stalo při dřívějším přechodu Rozjedeme-ai a čeho si nikdo
// nevšiml, protože osiřelý klíč se jen tiše odfiltruje.
test("usage přežije změnu velikosti písmen v app id", async () => {
  const launchpadRoot = await makeLaunchpadRoot();
  await recordAppOpen({ launchpadRoot, appId: "Macano-Tech-cenik-v2", now: new Date("2026-07-16T10:07:12Z") });

  const renamed = [{ id: "macano-tech-cenik-v2", title: "Ceník", company: "Macano-Tech", icon: null }];
  const result = await buildMostUsedApps({ launchpadRoot, apps: renamed });

  expect(result.cold_start).toBe(false);
  expect(result.most_used).toHaveLength(1);
  expect(result.most_used[0].id).toBe("macano-tech-cenik-v2");
  expect(result.most_used[0].count).toBe(1);
});

test("usage sečte staré a nové psaní téhož app id a vezme pozdější otevření", async () => {
  const launchpadRoot = await makeLaunchpadRoot();
  // Reálný tvar z usage.json po přechodu Rozjedeme-ai: obě psaní vedle sebe.
  await recordAppOpen({ launchpadRoot, appId: "Rozjedeme-ai-deals-v2", now: new Date("2026-07-16T10:07:12Z") });
  await recordAppOpen({ launchpadRoot, appId: "Rozjedeme-ai-deals-v2", now: new Date("2026-07-16T11:00:00Z") });
  await recordAppOpen({ launchpadRoot, appId: "rozjedeme-ai-deals-v2", now: new Date("2026-07-29T21:48:03Z") });

  const renamed = [{ id: "rozjedeme-ai-deals-v2", title: "Deals", company: "Rozjedeme-ai", icon: null }];
  const result = await buildMostUsedApps({ launchpadRoot, apps: renamed });

  expect(result.most_used).toHaveLength(1);
  expect(result.most_used[0].count).toBe(3);
  expect(result.most_used[0].last_opened_at).toBe("2026-07-29T21:48:03.000Z");
});

test("usage nesloučí dvě různá app id, která se neliší jen velikostí písmen", async () => {
  const launchpadRoot = await makeLaunchpadRoot();
  await recordAppOpen({ launchpadRoot, appId: "personal--immakermatty_GEN3--personal-todo-v1" });
  await recordAppOpen({ launchpadRoot, appId: "alpha" });

  const mixed = [
    { id: "personal--immakermatty_GEN3--personal-todo-v1", title: "Todo", company: "personal", icon: null },
    ...apps,
  ];
  const result = await buildMostUsedApps({ launchpadRoot, apps: mixed });

  // Kompozitní klíč personalspace lane nese velké písmeno legitimně (je v něm
  // název mountu) a nesmí se přepsat na malá písmena ani sloučit s ničím jiným.
  expect(result.most_used.map((entry) => entry.id).sort()).toEqual([
    "alpha",
    "personal--immakermatty_GEN3--personal-todo-v1",
  ]);
});
