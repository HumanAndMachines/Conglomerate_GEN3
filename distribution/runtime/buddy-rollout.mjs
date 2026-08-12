#!/usr/bin/env bun

import { rolloutBuddyArtifact } from "./buddy-rollout-lib.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await rolloutBuddyArtifact({
    archivePath: options.archive,
    checksumPath: options.checksum,
    installRoot: options.installRoot,
    channel: options.channel,
    mutableMountSources: options.mountSources,
    serviceOptions: {
      unitDirectory: options.unitDirectory,
      environmentFile: options.environmentFile,
      queueRoot: options.queueRoot,
      hermesRoot: options.hermesRoot,
      bunPath: options.bunPath,
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(`Buddy resident rollout failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log([
      "bun resident/buddy-rollout.mjs install|update --archive FILE.tar --checksum FILE.tar.sha256 --install-root /opt/lazurio --channel candidate|stable [options]",
      "",
      "Options:",
      "  --mount-source NAME=/absolute/path (repeatable)",
      "  --unit-directory PATH   default /etc/systemd/system",
      "  --environment-file PATH default /run/buddy/buddy-bridge.env",
      "  --queue-root PATH        default /var/lib/buddy-bridge",
      "  --hermes-root PATH       default /opt/buddy-runtime/hermes",
      "  --bun PATH               default the Bun executing this command",
    ].join("\n"));
    process.exit(0);
  }
  const operation = argv[0];
  if (!["install", "update"].includes(operation)) {
    throw new Error("first argument must be install or update");
  }
  const options = {
    operation,
    mountSources: {},
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
    if (argument === "--archive") options.archive = value;
    else if (argument === "--checksum") options.checksum = value;
    else if (argument === "--install-root") options.installRoot = value;
    else if (argument === "--channel") options.channel = value;
    else if (argument === "--unit-directory") options.unitDirectory = value;
    else if (argument === "--environment-file") options.environmentFile = value;
    else if (argument === "--queue-root") options.queueRoot = value;
    else if (argument === "--hermes-root") options.hermesRoot = value;
    else if (argument === "--bun") options.bunPath = value;
    else if (argument === "--mount-source") {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error("--mount-source must be NAME=/absolute/path");
      }
      const name = value.slice(0, separator);
      if (Object.hasOwn(options.mountSources, name)) {
        throw new Error(`duplicate --mount-source ${name}`);
      }
      options.mountSources[name] = value.slice(separator + 1);
    } else throw new Error(`unknown option ${argument}`);
  }
  for (const required of ["archive", "checksum", "installRoot", "channel"]) {
    if (!options[required]) throw new Error(`${operation} requires --${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return options;
}
