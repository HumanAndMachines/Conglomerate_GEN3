import { join, resolve } from "path";
import { buildLaunchpadDoctorReport } from "./diagnostics-lib.mjs";
import {
  installMacosLaunchpadApp,
  macosLaunchpadRepairIsIncomplete,
} from "./macos-launchpad-app-lib.mjs";

const options = parseArgs(Bun.argv.slice(2));
const companiesRoot = resolve(options.root ?? join(import.meta.dirname, "..", ".."));
const launchpadRoot = resolve(options.launchpadRoot ?? join(companiesRoot, "launchpad"));
let repairIncomplete = false;
if (options.repairLaunchpadDock) {
  const repairReport = await installMacosLaunchpadApp({ companiesRoot });
  console.log(JSON.stringify({ repair: "macos_launchpad_dock", ...repairReport }, null, 2));
  repairIncomplete = macosLaunchpadRepairIsIncomplete(repairReport);
}
const report = await buildLaunchpadDoctorReport({
  companiesRoot,
  launchpadRoot,
  allowMissingOrganizations: options.allowMissingOrganizations,
});

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHumanReport(report);
}

if (report.summary.fail > 0 || repairIncomplete) process.exit(1);

function printHumanReport(doctorReport) {
  console.log(`${doctorReport.summary.status} - ${doctorReport.scope.name}`);
  for (const check of doctorReport.checks) {
    console.log(`${check.status} - ${check.id}: ${check.message}`);
    if (check.status === "ok" || check.details.length === 0) continue;
    for (const detail of check.details) {
      console.log(`  - ${detail}`);
    }
  }
}

function parseArgs(args) {
  const parsed = {
    json: false,
    allowMissingOrganizations: false,
    repairLaunchpadDock: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--allow-missing-organizations") {
      parsed.allowMissingOrganizations = true;
      continue;
    }
    if (arg === "--repair-launchpad-dock") {
      parsed.repairLaunchpadDock = true;
      continue;
    }
    if (arg.startsWith("--root=")) {
      parsed.root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--root") {
      parsed.root = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--launchpad-root=")) {
      parsed.launchpadRoot = arg.slice("--launchpad-root=".length);
      continue;
    }
    if (arg === "--launchpad-root") {
      parsed.launchpadRoot = args[index + 1];
      index += 1;
    }
  }
  return parsed;
}
