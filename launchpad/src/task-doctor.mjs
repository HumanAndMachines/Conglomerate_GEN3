import { join, resolve } from "path";
import { taskPreflightGitCheck } from "./task-preflight-lib.mjs";

const options = parseArgs(Bun.argv.slice(2));
const companiesRoot = resolve(options.root ?? join(import.meta.dirname, "..", ".."));
const check = await taskPreflightGitCheck(companiesRoot);
const report = {
  schema_version: "companiesascode.doctor.task-preflight.v1",
  scope: { type: "launchpad_root", path: ".", absolute_path: companiesRoot },
  summary: {
    status: check.status,
    ok: check.status === "ok" ? 1 : 0,
    warn: 0,
    fail: check.status === "fail" ? 1 : 0,
    skip: 0,
  },
  checks: [check],
};

if (options.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${check.status} - ${check.id}: ${check.message}`);
  for (const detail of check.details) console.log(`  - ${detail}`);
}
if (check.status === "fail") process.exit(1);

function parseArgs(args) {
  const parsed = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--root") {
      parsed.root = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--root=")) parsed.root = arg.slice("--root=".length);
  }
  return parsed;
}
