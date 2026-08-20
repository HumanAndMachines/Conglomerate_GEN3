#!/usr/bin/env bun

import { buildResidentArtifact } from "./build-lib.mjs";

const options = parseArgs(process.argv.slice(2));
try {
  const result = await buildResidentArtifact(options);
  console.log(JSON.stringify({
    status: "built",
    artifact_id: result.artifact_id,
    artifact_root: result.artifact_root,
    archive_path: result.archive_path,
    checksum_path: result.checksum_path,
    archive_sha256: result.archive_sha256,
  }, null, 2));
} catch (error) {
  console.error(`resident build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { forbiddenTerms: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log("bun distribution/build.mjs [--profile buddy|workspace] [--target linux-x64] [--version VERSION] [--channel candidate|stable] [--output PATH] [--forbid-term TEXT]");
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    index += 1;
    if (argument === "--profile") options.profile = value;
    else if (argument === "--target") options.target = value;
    else if (argument === "--version") options.artifactVersion = value;
    else if (argument === "--channel") options.channel = value;
    else if (argument === "--output") options.outputRoot = value;
    else if (argument === "--forbid-term") options.forbiddenTerms.push(value);
    else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}
