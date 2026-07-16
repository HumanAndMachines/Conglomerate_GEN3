import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tempRoots = [];
const scriptPath = new URL("./gen2-gen3-sync-inventory.mjs", import.meta.url).pathname;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("inventory is explicit-path based and labels shared-root extraction candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen2-gen3-inventory-"));
  tempRoots.push(root);
  const gen2 = join(root, "source-gen2");
  const gen3 = join(root, "target-gen3");
  await mkdir(join(gen2, "launchpad", "scripts"), { recursive: true });
  await mkdir(join(gen2, "guide", "app", "v1"), { recursive: true });
  await mkdir(join(gen2, "company", "scripts"), { recursive: true });
  await mkdir(join(gen2, "company", "team", "person"), { recursive: true });
  await mkdir(gen3, { recursive: true });

  await writeFile(join(gen2, "launchpad", "scripts", "buildDesktopApp.mjs"), "generic desktop packaging\n");
  await writeFile(join(gen2, "guide", "app", "v1", "package.json"), "{}\n");
  await writeFile(join(gen2, "company", "scripts", "workspace-search.py"), "print('tooling')\n");
  await writeFile(join(gen2, "company", "team", "person", "AGENTS.md"), "private overlay\n");
  await writeFile(join(gen2, "TODO.tasks.json"), "[]\n");

  const result = spawnSync(process.execPath, [
    scriptPath,
    "--gen2",
    gen2,
    "--gen3",
    gen3,
    "--label",
    "Example Organization",
    "--json",
    "--include-shared-surfaces",
  ], { encoding: "utf8" });

  expect(result.status).toBe(0);
  const data = JSON.parse(result.stdout);
  expect(data.results).toHaveLength(1);
  const entries = new Map(data.results[0].entries.map((entry) => [entry.path, entry]));

  expect(entries.get("launchpad/scripts/buildDesktopApp.mjs")).toMatchObject({
    kind: "port-candidate",
    owner_hint: "shared-root",
    extraction: "mechanism-only",
  });
  expect(entries.get("guide/app/v1/package.json")).toMatchObject({
    kind: "port-candidate",
    owner_hint: "shared-root",
    extraction: "mechanism-only",
  });
  expect(entries.get("company/scripts/workspace-search.py")).toMatchObject({
    kind: "port-candidate",
    owner_hint: "template-baseline",
    extraction: "anonymize-before-template",
  });
  expect(entries.get("TODO.tasks.json")).toMatchObject({
    kind: "port-candidate",
    owner_hint: "organization-local",
    extraction: "do-not-promote",
  });
  expect(entries.has("company/team/person/AGENTS.md")).toBe(false);
});

test("inventory refuses implicit built-in organization pairs", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--json"], { encoding: "utf8" });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Built-in organization pairs are intentionally not embedded");
});
