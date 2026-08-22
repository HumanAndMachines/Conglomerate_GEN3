import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { buildLazurioCliIdentity } from "./cli-install-lib.mjs";

const sourceRoot = resolve(import.meta.dir, "..");
const sourceCli = join(sourceRoot, "lazurio", "cli.mjs");
let sandbox;
let fixtureRoot;
let outsideCwd;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "lazurio-cli-install-žluťoučký-"));
  fixtureRoot = join(sandbox, "Lazurio source with spaces Ž");
  outsideCwd = join(sandbox, "outside cwd");
  mkdirSync(fixtureRoot, { recursive: true });
  mkdirSync(outsideCwd, { recursive: true });
  for (const path of ["lazurio", "launchpad"]) {
    cpSync(join(sourceRoot, path), join(fixtureRoot, path), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
  mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
  for (const path of [
    "package.json",
    "launchpad.gen3.json",
    "scripts/worktree-create-lib.mjs",
    "scripts/worktree-create-lock.mjs",
  ]) {
    const target = join(fixtureRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(sourceRoot, path), target, { preserveTimestamps: true });
  }
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

test("CLI default root patří entrypointu, ne aktuálnímu adresáři", () => {
  const result = runCli(sourceCli, ["cli", "identity", "--json"], {
    cwd: outsideCwd,
    environment: process.env,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(buildLazurioCliIdentity({ root: sourceRoot }));

  const explicit = runCli(sourceCli, ["cli", "identity", "--json", "--root", fixtureRoot], {
    cwd: outsideCwd,
    environment: process.env,
  });
  expect(explicit.status, explicit.stderr).toBe(0);
  expect(JSON.parse(explicit.stdout)).toEqual(buildLazurioCliIdentity({ root: fixtureRoot }));
});

test("help drží tři jednoduché CLI instalační akce", () => {
  const help = runCli(sourceCli, ["--help"], { cwd: outsideCwd, environment: process.env });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("lazurio cli install [--json] [--root <cesta>]");
  expect(help.stdout).toContain("lazurio cli status [--json] [--root <cesta>]");
  expect(help.stdout).toContain("lazurio cli uninstall [--json] [--root <cesta>]");
  expect(help.stdout).not.toContain("cli identity");
});

test("real Bun link projde install, direct status, idempotent reinstall a exact uninstall", () => {
  const isolated = isolatedBunEnvironment("golden");
  const install = runCli(sourceCli, ["cli", "install", "--json", "--root", fixtureRoot], {
    cwd: outsideCwd,
    environment: isolated.environment,
  });
  expect(install.status, install.stderr).toBe(0);
  const installed = JSON.parse(install.stdout);
  expect(installed).toMatchObject({
    schema_version: "lazurio.cli.installation.v1",
    action: "install",
    state: "current",
    changed: true,
    registration: { state: "owned" },
    bun: { global_bin_on_path: true },
  });
  expect(installed.command.path).toStartWith(isolated.globalBin);

  const status = runExecutable(installed.command.path, ["cli", "status", "--json"], {
    cwd: outsideCwd,
    environment: isolated.environment,
  });
  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    action: "status",
    state: "current",
    expected: buildLazurioCliIdentity({ root: fixtureRoot }),
  });

  const reinstall = runExecutable(installed.command.path, ["cli", "install", "--json"], {
    cwd: outsideCwd,
    environment: isolated.environment,
  });
  expect(reinstall.status, reinstall.stderr).toBe(0);
  expect(JSON.parse(reinstall.stdout)).toMatchObject({
    action: "install",
    state: "current",
    changed: false,
  });

  if (process.platform === "win32") {
    const cmd = runExecutable("cmd.exe", ["/d", "/s", "/c", "lazurio cli identity --json"], {
      cwd: outsideCwd,
      environment: isolated.environment,
    });
    expect(cmd.status, cmd.stderr).toBe(0);
    expect(JSON.parse(cmd.stdout)).toEqual(buildLazurioCliIdentity({ root: fixtureRoot }));
    const powershell = runExecutable(
      "powershell.exe",
      ["-NoProfile", "-Command", "& lazurio cli identity --json"],
      { cwd: outsideCwd, environment: isolated.environment },
    );
    expect(powershell.status, powershell.stderr).toBe(0);
    expect(JSON.parse(powershell.stdout)).toEqual(buildLazurioCliIdentity({ root: fixtureRoot }));
  }

  const uninstall = runExecutable(installed.command.path, ["cli", "uninstall", "--json"], {
    cwd: outsideCwd,
    environment: isolated.environment,
  });
  expect(uninstall.status, uninstall.stderr).toBe(0);
  expect(JSON.parse(uninstall.stdout)).toMatchObject({ action: "uninstall", changed: true });
  expect(existsSync(join(isolated.globalDirectory, "node_modules", "lazurio"))).toBe(false);

  const secondUninstall = runCli(
    sourceCli,
    ["cli", "uninstall", "--json", "--root", fixtureRoot],
    { cwd: outsideCwd, environment: isolated.environment },
  );
  expect(secondUninstall.status, secondUninstall.stderr).toBe(0);
  expect(JSON.parse(secondUninstall.stdout)).toMatchObject({
    action: "uninstall",
    changed: false,
    registration: { state: "absent" },
  });
});

test("foreign PATH command se nikdy nespustí ani nepřepíše", () => {
  const isolated = isolatedBunEnvironment("foreign-path");
  const foreignBin = join(isolated.root, "foreign first");
  mkdirSync(foreignBin, { recursive: true });
  const marker = join(isolated.root, "foreign-executed");
  if (process.platform === "win32") {
    writeFileSync(join(foreignBin, "lazurio.cmd"), `@echo foreign>"${marker}"\r\n`, "utf8");
  } else {
    const executable = join(foreignBin, "lazurio");
    writeFileSync(executable, `#!/bin/sh\nprintf foreign > '${marker}'\n`, "utf8");
    chmodSync(executable, 0o755);
  }
  const environment = {
    ...isolated.environment,
    PATH: `${foreignBin}${delimiter}${isolated.environment.PATH}`,
  };
  const result = runCli(sourceCli, ["cli", "install", "--root", fixtureRoot], {
    cwd: outsideCwd,
    environment,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("PATH už obsahuje jiný příkaz lazurio");
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(isolated.globalDirectory, "node_modules", "lazurio"))).toBe(false);
});

test("foreign Bun registrace se nepřepíše a neodinstaluje", () => {
  const isolated = isolatedBunEnvironment("foreign-registration");
  const foreignRoot = join(isolated.root, "foreign package");
  mkdirSync(foreignRoot, { recursive: true });
  writeFileSync(
    join(foreignRoot, "package.json"),
    `${JSON.stringify({ name: "lazurio", private: true, bin: { lazurio: "foreign.mjs" } }, null, 2)}\n`,
  );
  writeFileSync(join(foreignRoot, "foreign.mjs"), "#!/usr/bin/env bun\n", { mode: 0o755 });
  const link = runExecutable(process.execPath, ["link", "--cwd", foreignRoot], {
    cwd: foreignRoot,
    environment: isolated.environment,
  });
  expect(link.status, link.stderr).toBe(0);

  for (const action of ["install", "uninstall"]) {
    const result = runCli(sourceCli, ["cli", action, "--root", fixtureRoot], {
      cwd: outsideCwd,
      environment: isolated.environment,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("patří jinému rootu");
  }
  expect(existsSync(join(isolated.globalDirectory, "node_modules", "lazurio"))).toBe(true);
});

test("chybějící Bun global bin v PATH skončí před mutací", () => {
  const isolated = isolatedBunEnvironment("missing-path");
  const environment = {
    ...isolated.environment,
    PATH: process.env.PATH ?? "",
  };
  const result = runCli(sourceCli, ["cli", "install", "--root", fixtureRoot], {
    cwd: outsideCwd,
    environment,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Bun global bin není v PATH");
  expect(existsSync(join(isolated.globalDirectory, "node_modules", "lazurio"))).toBe(false);
});

test("linked task worktree se nestane permanentním PATH targetem", () => {
  const isolated = isolatedBunEnvironment("worktree");
  const linkedRoot = createLinkedWorktreeRoot();
  const result = runCli(sourceCli, ["cli", "install", "--root", linkedRoot], {
    cwd: outsideCwd,
    environment: isolated.environment,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("linked worktree");
  expect(existsSync(join(isolated.globalDirectory, "node_modules", "lazurio"))).toBe(false);
});

function isolatedBunEnvironment(label) {
  const root = join(sandbox, `bun ${label} Ž`);
  const installRoot = join(root, "install root");
  const globalDirectory = join(root, "global packages");
  const globalBin = join(root, "global bin");
  mkdirSync(root, { recursive: true });
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase() === "path") delete environment[name];
  }
  environment.PATH = `${globalBin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  return {
    root,
    installRoot,
    globalDirectory,
    globalBin,
    environment: {
      ...environment,
      BUN_INSTALL: installRoot,
      BUN_INSTALL_GLOBAL_DIR: globalDirectory,
      BUN_INSTALL_BIN: globalBin,
    },
  };
}

function createLinkedWorktreeRoot() {
  const repositoryRoot = join(sandbox, "standalone source repository");
  const linkedRoot = join(sandbox, "linked task worktree");
  cpSync(fixtureRoot, repositoryRoot, { recursive: true, preserveTimestamps: true });
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Lazurio Test"],
    ["config", "user.email", "lazurio-test@example.invalid"],
    ["add", "."],
    ["commit", "-m", "fixture"],
    ["worktree", "add", "-b", "agent/test", linkedRoot],
  ]) {
    const result = runExecutable("git", args, {
      cwd: repositoryRoot,
      environment: process.env,
    });
    if (result.status !== 0) {
      throw new Error(`Git fixture selhala: git ${args.join(" ")}\n${result.stderr}`);
    }
  }
  return linkedRoot;
}

function runCli(cliPath, args, options) {
  return runExecutable(process.execPath, [cliPath, ...args], options);
}

function runExecutable(command, args, { cwd, environment }) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}
