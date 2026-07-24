import { join, resolve } from "path";
import {
  UPDATE_CLI_USAGE,
  formatUpdateLaneReport,
  parseUpdateCliArgs,
  runUpdateLane,
} from "./update-cli-lib.mjs";

const parsed = parseUpdateCliArgs(Bun.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  console.error(UPDATE_CLI_USAGE);
  process.exit(1);
}
if (parsed.options.help) {
  console.log(UPDATE_CLI_USAGE);
  process.exit(0);
}

const rootPath = resolve(parsed.options.root ?? join(import.meta.dirname, "..", ".."));
const result = await runUpdateLane({ rootPath, options: parsed.options });

if (parsed.options.json) console.log(JSON.stringify(result, null, 2));
else console.log(formatUpdateLaneReport(result));

if (!result.ok) process.exit(1);
