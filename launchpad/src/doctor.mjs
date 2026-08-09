import { join, resolve } from "path";
import { buildLaunchpadDoctorReport } from "./diagnostics-lib.mjs";
import { renderHumanDoctorReport } from "./doctor-output-lib.mjs";
import { exitCodeForSummaryStatus } from "./doctor-surface-lib.mjs";

const options = parseArgs(Bun.argv.slice(2));
const companiesRoot = resolve(options.root ?? join(import.meta.dirname, "..", ".."));
const launchpadRoot = resolve(options.launchpadRoot ?? join(companiesRoot, "launchpad"));
const report = await buildLaunchpadDoctorReport({
  companiesRoot,
  launchpadRoot,
  allowMissingOrganizations: options.allowMissingOrganizations,
  runChildDoctors: !options.skipChildren,
});

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderHumanDoctorReport(report));
}

// Invokační kontrakt společného surfacu (decision 0118): 0 = ok|warn, 1 = fail,
// 2 = incomplete, 3 = report vůbec nevznikl. `incomplete` NIKDY nesplní bránu.
//
// Schválně `process.exitCode` místo `process.exit()`: `process.exit()` ukončí
// proces dřív, než se stihne dopsat celý stdout, a rodič, který by tenhle doctor
// zavolal jako podřízeného, by useknutý JSON klasifikoval jako `unparseable`.
process.exitCode = exitCodeForSummaryStatus(report.summary.status);

function parseArgs(args) {
  const parsed = {
    json: false,
    allowMissingOrganizations: false,
    skipChildren: false,
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
    // Ladicí přepínač, ne tichý vypínač: bez potomků se `doctor.children`
    // ohlásí jako `blocked` a souhrn skončí `incomplete`, který bránu nesplní.
    if (arg === "--skip-children") {
      parsed.skipChildren = true;
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
