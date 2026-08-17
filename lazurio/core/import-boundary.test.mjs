import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

const coreRoot = import.meta.dirname;
const repositoryRoot = resolve(coreRoot, "..", "..");
const transpilers = new Map();
const standardLibrarySpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "bun",
  "bun:test",
]);

test("Core imports only platform libraries and other Core modules", async () => {
  const findings = [];
  for (const path of (await moduleFiles(coreRoot)).filter((entry) => !entry.includes(".test."))) {
    const source = await readFile(path, "utf8");
    for (const { path: specifier } of scanImports(source, path)) {
      if (!specifier.startsWith(".")) {
        if (!standardLibrarySpecifiers.has(specifier) && !specifier.startsWith("bun:")) {
          findings.push(`${relative(coreRoot, path)} imports non-platform package ${specifier}`);
        }
        continue;
      }
      const target = resolve(dirname(path), specifier);
      if (!isInside(coreRoot, target)) {
        findings.push(`${relative(coreRoot, path)} imports ${specifier} outside Core`);
      }
    }
  }
  expect(findings).toEqual([]);
});

test("slot classification has one physical owner shared by CLI and Launchpad", async () => {
  const moduleName = "organization-slot-scope-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", moduleName))).toBe(false);

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer);

  expect(consumers.some((importer) => importer.startsWith("lazurio/"))).toBe(true);
  expect(consumers.some((importer) => importer.startsWith("launchpad/src/"))).toBe(true);
});

test("canonical path containment has one physical Core owner", async () => {
  const moduleName = "path-boundary-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", moduleName))).toBe(false);

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer)
    .sort();

  expect(consumers).toEqual([
    "launchpad/src/git-inventory-lib.mjs",
    "launchpad/src/git-materialization-lib.mjs",
    "launchpad/src/mission-control-plan-lib.mjs",
    "launchpad/src/worktree-actions-lib.mjs",
    "launchpad/src/worktree-lib.mjs",
  ]);
});

test("runtime declaration validation has one physical Core owner", async () => {
  const moduleName = "runtime-contract-lib.mjs";
  expect(existsSync(join(coreRoot, moduleName))).toBe(true);
  expect(existsSync(join(repositoryRoot, "launchpad", "src", moduleName))).toBe(false);

  const imports = await repositoryImports([
    join(repositoryRoot, "lazurio"),
    join(repositoryRoot, "launchpad", "src"),
    join(repositoryRoot, "scripts"),
  ]);
  const consumers = imports
    .filter(({ target }) => target === join(coreRoot, moduleName))
    .map(({ importer }) => importer)
    .sort();

  expect(consumers).toEqual([
    "launchpad/src/discovery-lib.mjs",
    "launchpad/src/personalspace-lib.mjs",
    "launchpad/src/runtime-lib.mjs",
    "scripts/lazurio-runtime-migrate.mjs",
  ]);
});

async function repositoryImports(roots) {
  const imports = [];
  for (const root of roots) {
    for (const path of (await moduleFiles(root)).filter((entry) => !entry.includes(".test."))) {
      const source = await readFile(path, "utf8");
      for (const { path: specifier } of scanImports(source, path)) {
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

function scanImports(source, path) {
  const loader = /\.(?:ts|mts|cts)$/.test(path)
    ? "ts"
    : path.endsWith(".tsx")
      ? "tsx"
      : path.endsWith(".jsx")
        ? "jsx"
        : "js";
  if (!transpilers.has(loader)) transpilers.set(loader, new Bun.Transpiler({ loader }));
  return transpilers.get(loader).scanImports(source.replace(/^#![^\n]*(?:\n|$)/, ""));
}

async function moduleFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await moduleFiles(path));
    else if (entry.isFile() && /\.(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}
