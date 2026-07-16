import { discoverLaunchpadApps } from "./discovery-lib.mjs";

const allowMissingOrganizations = Bun.argv.includes("--allow-missing-organizations");
const rootArg = Bun.argv.slice(2).find((arg) => !arg.startsWith("--"));
const { apps, failures } = await discoverLaunchpadApps(rootArg, { allowMissingOrganizations });

if (failures.length > 0) {
  console.error("Launchpad discovery failures");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (apps.length === 0) {
  console.log("Žádné Launchpad aplikace nebyly nalezené.");
} else {
  console.log("Launchpad aplikace");
  for (const app of apps) {
    console.log(`[${app.company}] ${app.title} (${app.id})`);
    console.log(`  ${app.host}:${app.port}${app.health_path}`);
    console.log(`  package: ${app.package_path}`);
    console.log(`  script: ${app.dev_script}`);
  }
}
