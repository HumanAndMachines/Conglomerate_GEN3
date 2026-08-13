import { discoverLaunchpadApps } from "./discovery-lib.mjs";
import { discoveryContractFailures } from "./check-launchpad-discovery-lib.mjs";

const allowMissingOrganizations = Bun.argv.includes("--allow-missing-organizations");
const rootArg = Bun.argv.slice(2).find((arg) => !arg.startsWith("--"));
const {
  apps,
  failures,
  warnings = [],
  organizations = [],
  port_overlaps: portOverlaps = [],
  module_listener_drifts: moduleListenerDrifts = [],
} = await discoverLaunchpadApps(rootArg, { allowMissingOrganizations });

const contractFailures = discoveryContractFailures({
  portOverlaps,
  moduleListenerDrifts,
});
const hardFailures = [...failures, ...contractFailures];

if (hardFailures.length > 0) {
  console.error("Launchpad discovery není validní");
  for (const failure of hardFailures) console.error(`- ${failure}`);
  process.exit(1);
}

for (const warning of warnings) console.warn(`Launchpad discovery warning: ${warning}`);
console.log(`Launchpad discovery v pořádku: ${apps.length} aplikací / ${organizations.length} organizací`);
