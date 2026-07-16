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
