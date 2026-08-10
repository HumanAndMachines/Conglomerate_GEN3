#!/usr/bin/env bun

import { resolve } from "node:path";

import { renderHumanDoctorReport } from "../launchpad/src/doctor-output-lib.mjs";
import { DOCTOR_EXIT_CODES } from "../launchpad/src/doctor-surface-lib.mjs";
import { buildLazurioContext, buildLazurioDoctorReport } from "./lib.mjs";
import {
  buildLazurioSearchStatus,
  searchLazurioExact,
  searchLazurioQmd,
  updateLazurioQmdIndex,
} from "./search-lib.mjs";

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

  if (options.command === "search") {
    if (options.searchAction === "status") {
      const status = await buildLazurioSearchStatus({
        root: options.root,
        scopeId: options.scope,
      });
      console.log(options.json ? JSON.stringify(status, null, 2) : renderSearchStatus(status));
      return 0;
    }
    if (options.searchAction === "update") {
      const status = await updateLazurioQmdIndex({
        root: options.root,
        scopeId: options.scope,
        embed: options.embed,
      });
      console.log(options.json ? JSON.stringify(status, null, 2) : renderSearchStatus(status));
      return 0;
    }

    const result = options.mode === "exact"
      ? await searchLazurioExact({
          root: options.root,
          scopeId: options.scope,
          query: options.query,
          limit: options.limit,
        })
      : await searchLazurioQmd({
          root: options.root,
          scopeId: options.scope,
          query: options.query,
          mode: options.mode,
          limit: options.limit,
        });
    console.log(options.json ? JSON.stringify(result, null, 2) : renderSearchResults(result));
    return 0;
  }

  throw new Error(`Neznámý příkaz '${options.command ?? ""}'.\n${usage()}`);
}

function parseArgs(argv) {
  const parsed = {
    command: null,
    root: process.cwd(),
    json: false,
    help: false,
    scope: "lazurio",
    mode: "exact",
    limit: 50,
    embed: false,
    status: false,
    update: false,
    operands: [],
    searchFlags: new Set(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!parsed.command && !arg.startsWith("-")) {
      parsed.command = arg;
      continue;
    }
    if (parsed.command === "search" && !arg.startsWith("-")) {
      parsed.operands.push(arg);
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
    if (arg === "--embed") {
      parsed.embed = true;
      parsed.searchFlags.add("--embed");
      continue;
    }
    if (arg === "--status" || arg === "--update") {
      parsed[arg.slice(2)] = true;
      parsed.searchFlags.add(arg);
      continue;
    }
    if (arg === "--scope" || arg === "--mode" || arg === "--limit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${arg} vyžaduje hodnotu.`);
      if (arg === "--scope") parsed.scope = value;
      if (arg === "--mode") parsed.mode = value;
      if (arg === "--limit") parsed.limit = Number(value);
      parsed.searchFlags.add(arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      parsed.scope = requiredInlineValue(arg, "--scope");
      parsed.searchFlags.add("--scope");
      continue;
    }
    if (arg.startsWith("--mode=")) {
      parsed.mode = requiredInlineValue(arg, "--mode");
      parsed.searchFlags.add("--mode");
      continue;
    }
    if (arg.startsWith("--limit=")) {
      parsed.limit = Number(requiredInlineValue(arg, "--limit"));
      parsed.searchFlags.add("--limit");
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
  if (parsed.command === "search") {
    if (parsed.status && parsed.update) {
      throw new Error("--status a --update se vzájemně vylučují.");
    }
    parsed.searchAction = parsed.status ? "status" : parsed.update ? "update" : "query";
    parsed.query = parsed.searchAction === "query" ? parsed.operands.join(" ") : null;
    if (!new Set(["exact", "lexical", "semantic", "hybrid"]).has(parsed.mode)) {
      throw new Error(`--mode musí být exact, lexical, semantic nebo hybrid.`);
    }
    if (parsed.searchAction === "query" && !parsed.query) {
      throw new Error("search vyžaduje dotaz, --status nebo --update.");
    }
    if (parsed.searchAction !== "query" && parsed.operands.length > 0) {
      throw new Error("--status a --update nepřijímají search dotaz.");
    }
    if (parsed.embed && parsed.searchAction !== "update") {
      throw new Error("--embed lze použít pouze s `lazurio search --update`.");
    }
    if (parsed.searchAction !== "query" && ["--mode", "--limit"].some((flag) => parsed.searchFlags.has(flag))) {
      throw new Error("--mode a --limit lze použít pouze se search dotazem.");
    }
  } else if (parsed.searchFlags.size > 0) {
    throw new Error(`${[...parsed.searchFlags].join(", ")} lze použít pouze s příkazem search.`);
  }
  return parsed;
}

function requiredInlineValue(arg, name) {
  const value = arg.slice(name.length + 1);
  if (!value) throw new Error(`${name} vyžaduje hodnotu.`);
  return value;
}

function usage() {
  return [
    "Lazurio CLI v0 (unstable, read-only)",
    "",
    "Použití:",
    "  lazurio context --json [--root <cesta>]",
    "  lazurio doctor [--json] [--root <cesta>]",
    "  lazurio search <dotaz> [--mode exact|lexical|semantic|hybrid] [--scope lazurio] [--limit N] [--json] [--root <cesta>]",
    "  lazurio search --status [--scope lazurio] [--json] [--root <cesta>]",
    "  lazurio search --update [--embed] [--scope lazurio] [--json] [--root <cesta>]",
  ].join("\n");
}

function renderSearchResults(result) {
  const lines = [
    `${result.scope.display_name} · ${result.mode} · ${result.result_count} výsledků`,
  ];
  for (const item of result.results) {
    lines.push(`${item.path}:${item.line}:${item.column}: ${item.text}`);
  }
  return lines.join("\n");
}

function renderSearchStatus(status) {
  return [
    `${status.scope.display_name} search`,
    `Exact: ${status.exact.status} · ${status.exact.file_count} textových souborů · live`,
    `QMD: ${status.qmd.status} (${status.qmd.reason}) · verze ${status.qmd.version ?? "nezjištěna"}`,
    `Index: ${status.qmd.index.state} · freshness ${status.qmd.freshness.status}`,
  ].join("\n");
}
