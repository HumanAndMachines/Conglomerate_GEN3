#!/usr/bin/env bun

import { resolve } from "node:path";
import { runLazurioUpdate } from "./lazurio-update-lib.mjs";

const options = parseArgs(Bun.argv.slice(2));
const result = await runLazurioUpdate({
  rootPath: resolve(options.root),
  runtimeRoot: resolve(options.runtimeRoot),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--root", "--runtime-root"].includes(key) || !value) {
      throw new Error("lazurio update runtime requires --root and --runtime-root");
    }
    if (key === "--root") values.root = value;
    if (key === "--runtime-root") values.runtimeRoot = value;
  }
  if (!values.root || !values.runtimeRoot) throw new Error("lazurio update runtime arguments are incomplete");
  return values;
}
