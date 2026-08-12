#!/usr/bin/env bun

import {
  installResidentArtifact,
  residentStatus,
  rollbackResidentArtifact,
} from "./updater-lib.mjs";

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  let result;
  if (command === "install" || command === "update") {
    result = await installResidentArtifact({
      archivePath: options.archive,
      checksumPath: options.checksum,
      installRoot: options.installRoot,
      expectedProfile: options.profile,
      expectedChannel: options.channel,
      mutableMountSources: options.mountSources,
    });
  } else if (command === "rollback") {
    result = await rollbackResidentArtifact({
      installRoot: options.installRoot,
      expectedProfile: options.profile,
      targetArtifactId: options.to,
    });
  } else if (command === "status") {
    result = await residentStatus({
      installRoot: options.installRoot,
      expectedProfile: options.profile,
    });
  } else {
    throw new Error(`unknown command ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(`resident updater failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log([
      "bun resident/updater.mjs install --archive FILE.tar --checksum FILE.tar.sha256 --install-root PATH --profile buddy [--channel candidate|stable] [--mount-source personalspace=/absolute/path]",
      "bun resident/updater.mjs update  --archive FILE.tar --checksum FILE.tar.sha256 --install-root PATH --profile buddy [--channel candidate|stable] [--mount-source personalspace=/absolute/path]",
      "bun resident/updater.mjs rollback --install-root PATH --profile buddy [--to ARTIFACT_ID]",
      "bun resident/updater.mjs status --install-root PATH [--profile buddy]",
    ].join("\n"));
    process.exit(0);
  }
  const command = argv[0];
  const options = { mountSources: {} };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    index += 1;
    if (argument === "--archive") options.archive = value;
    else if (argument === "--checksum") options.checksum = value;
    else if (argument === "--install-root") options.installRoot = value;
    else if (argument === "--profile") options.profile = value;
    else if (argument === "--channel") options.channel = value;
    else if (argument === "--to") options.to = value;
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
    }
    else throw new Error(`unknown option ${argument}`);
  }
  if (!["install", "update"].includes(command)
    && Object.keys(options.mountSources).length > 0) {
    throw new Error("--mount-source is valid only for install or update");
  }
  return { command, options };
}
