#!/usr/bin/env bun

import { resolve } from "node:path";

import { renderHumanDoctorReport } from "../launchpad/src/doctor-output-lib.mjs";
import { DOCTOR_EXIT_CODES } from "../launchpad/src/doctor-surface-lib.mjs";
import { buildLazurioContext, buildLazurioDoctorReport } from "./lib.mjs";

if (import.meta.main) {
  try {
    process.exitCode = await run(Bun.argv.slice(2));
  } catch (error) {
    console.error(`lazurio: ${error.message}`);
    process.exitCode = error.lazurioExitCode ?? 2;
  }
}

async function run(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (options.command === "context") {
    if (!options.json) throw new Error("context v0 podporuje pouze výstup --json.");
    const context = await buildLazurioContext({ root: options.root });
    console.log(JSON.stringify(context, null, 2));
    return 0;
  }

  if (options.command === "doctor") {
    try {
      const result = await buildLazurioDoctorReport({ root: options.root });
      console.log(options.json
        ? JSON.stringify(result.report, null, 2)
        : renderHumanDoctorReport(result.report));
      return result.exit_code;
    } catch (error) {
      error.lazurioExitCode ??= DOCTOR_EXIT_CODES.no_report;
      throw error;
    }
  }

  throw new Error(`Neznámý příkaz '${options.command ?? ""}'.\n${usage()}`);
}

function parseArgs(argv) {
  const parsed = {
    command: null,
    root: process.cwd(),
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!parsed.command && !arg.startsWith("-")) {
      parsed.command = arg;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--root vyžaduje cestu.");
      parsed.root = resolve(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      const value = arg.slice("--root=".length);
      if (!value) throw new Error("--root vyžaduje cestu.");
      parsed.root = resolve(value);
      continue;
    }
    throw new Error(`Neznámý argument '${arg}'.`);
  }
  return parsed;
}

function usage() {
  return [
    "Lazurio CLI v0 (unstable, read-only)",
    "",
    "Použití:",
    "  lazurio context --json [--root <cesta>]",
    "  lazurio doctor [--json] [--root <cesta>]",
  ].join("\n");
}
