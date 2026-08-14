#!/usr/bin/env bun

import {
  installBuddyBridgeService,
  preflightBuddyBridgeService,
  restorePreResidentBuddyService,
} from "./buddy-service-lib.mjs";

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  const shared = {
    installRoot: options.installRoot,
    unitDirectory: options.unitDirectory,
    environmentFile: options.environmentFile,
    queueRoot: options.queueRoot,
    hermesRoot: options.hermesRoot,
    bunPath: options.bunPath,
  };
  let result;
  if (command === "preflight") {
    const report = await preflightBuddyBridgeService(shared);
    result = {
      schema_version: report.schema_version,
      status: "pass",
      active_root: report.active_root,
      unit: report.unit_path,
      existing_unit: Boolean(report.current_unit),
      rollback_unit_preserved: Boolean(report.existing_backup),
      hermes_pin_verified: Boolean(report.hermes_runtime?.commit),
      hermes_context_cwd: report.active_root,
    };
  } else if (command === "install") {
    result = await installBuddyBridgeService(shared);
  } else if (command === "restore") {
    result = await restorePreResidentBuddyService({
      unitDirectory: options.unitDirectory,
      environmentFile: options.environmentFile,
      queueRoot: options.queueRoot,
    });
  } else {
    throw new Error(`unknown command ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(`Buddy resident service failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log([
      "bun resident/buddy-service.mjs preflight --install-root /opt/lazurio [options]",
      "bun resident/buddy-service.mjs install   --install-root /opt/lazurio [options]",
      "bun resident/buddy-service.mjs restore   [--unit-directory /etc/systemd/system]",
      "",
      "Options:",
      "  --unit-directory PATH   default /etc/systemd/system",
      "  --environment-file PATH default /run/buddy/buddy-bridge.env",
      "  --queue-root PATH        default /var/lib/buddy-bridge",
      "  --hermes-root PATH       default /opt/buddy-runtime/hermes",
      "  --bun PATH               default current Bun executable",
    ].join("\n"));
    process.exit(0);
  }
  const command = argv[0];
  const options = {
    unitDirectory: "/etc/systemd/system",
    environmentFile: "/run/buddy/buddy-bridge.env",
    queueRoot: "/var/lib/buddy-bridge",
    hermesRoot: "/opt/buddy-runtime/hermes",
    bunPath: process.execPath,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid or valueless argument ${argument}`);
    }
    index += 1;
    if (argument === "--install-root") options.installRoot = value;
    else if (argument === "--unit-directory") options.unitDirectory = value;
    else if (argument === "--environment-file") options.environmentFile = value;
    else if (argument === "--queue-root") options.queueRoot = value;
    else if (argument === "--hermes-root") options.hermesRoot = value;
    else if (argument === "--bun") options.bunPath = value;
    else throw new Error(`unknown option ${argument}`);
  }
  if (["preflight", "install"].includes(command) && !options.installRoot) {
    throw new Error(`${command} requires --install-root`);
  }
  return { command, options };
}
