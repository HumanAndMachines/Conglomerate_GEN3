#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  installMacosLaunchpadApp,
  macosLaunchpadRepairIsIncomplete,
} from "../launchpad/src/macos-launchpad-app-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const report = await installMacosLaunchpadApp({ companiesRoot: root });
console.log(JSON.stringify(report, null, 2));
if (report.dock_status === "manual_required") {
  console.log("\nFinder je otevřený na ikoně Launchpadu. Přetáhni ji do Docku a potom spusť bun run doctor.");
}
if (report.dock_status === "pin_pending") {
  console.log("\ndockutil připnutí přijal, ale Dock preferences ho ještě nepotvrdily. Chvíli počkej a spusť bun run doctor znovu.");
}
if (macosLaunchpadRepairIsIncomplete(report)) process.exitCode = 1;
