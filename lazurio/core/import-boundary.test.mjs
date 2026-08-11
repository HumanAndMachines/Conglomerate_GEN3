import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

const coreRoot = import.meta.dirname;
const repositoryRoot = resolve(coreRoot, "..", "..");
const standardLibrarySpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "bun",
  "bun:test",
]);
const movedModules = [
  "discovery-lib.mjs",
  "git-inventory-lib.mjs",
  "git-lib.mjs",
  "git-materialization-lib.mjs",
  "git-status-lib.mjs",
  "organization-slot-scope-lib.mjs",
  "path-boundary-lib.mjs",
  "port-ownership-lib.mjs",
  "update-lib.mjs",
];

test("Core importuje jen standardní knihovny a jiné Core moduly", async () => {
  const findings = [];
  for (const path of (await moduleFiles(coreRoot)).filter((entry) => !entry.endsWith(".test.mjs"))) {
    const source = await readFile(path, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        if (!standardLibrarySpecifiers.has(specifier) && !specifier.startsWith("bun:")) {
          findings.push(`${relative(coreRoot, path)} importuje nestandardní balíček ${specifier}`);
        }
        continue;
      }
      const target = resolve(dirname(path), specifier);
      if (!isInside(coreRoot, target)) {
        findings.push(`${relative(coreRoot, path)} importuje ${specifier} mimo Core`);
      }
    }
  }
  expect(findings).toEqual([]);
});

test("boundary parser vidí binding, side-effect, re-export i dynamic import", () => {
  expect(importSpecifiers(`
import value from "node:path";
import "third-party-package";
export { value as renamed } from "./local.mjs";
const lazy = import("../../launchpad/src/server.mjs");
`)).toEqual([
    "node:path",
    "third-party-package",
    "./local.mjs",
    "../../launchpad/src/server.mjs",
  ]);
});

test("přesunuté moduly mají jediný fyzický domov a surfaces importují Core", async () => {
  for (const name of movedModules) {
    expect(existsSync(join(coreRoot, name))).toBe(true);
    expect(existsSync(join(repositoryRoot, "launchpad", "src", name))).toBe(false);
  }

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const coreConsumers = imports.filter(({ target }) => isInside(coreRoot, target));

  expect(coreConsumers.some(({ importer }) => importer.startsWith("lazurio/"))).toBe(true);
  expect(coreConsumers.some(({ importer }) => importer.startsWith("launchpad/src/"))).toBe(true);
  expect(imports.filter(({ target }) => target.includes(`${sep}launchpad${sep}src${sep}`))
    .some(({ target }) => movedModules.includes(target.split(sep).at(-1)))).toBe(false);
});

async function repositoryImports(roots) {
  const imports = [];
  for (const root of roots) {
    for (const path of (await moduleFiles(root)).filter((entry) => !entry.endsWith(".test.mjs"))) {
      const source = await readFile(path, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith(".")) continue;
        imports.push({
          importer: relative(repositoryRoot, path).split(sep).join("/"),
          target: resolve(dirname(path), specifier),
        });
      }
    }
  }
  return imports;
}

async function moduleFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await moduleFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(path);
  }
  return files;
}

function importSpecifiers(source) {
  const staticSpecifiers = [...source.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(?:(?:[^"';]|\n)*?\s+from\s+)?["']([^"']+)["']/g,
  )].map((match) => match[1]);
  const dynamicSpecifiers = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
  return [...staticSpecifiers, ...dynamicSpecifiers];
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}
