import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildLazurioSearchStatus,
  discoverLazurioSearchScope,
  materializeQmdConfig,
  QMD_MIN_VERSION,
  qmdStorageLayout,
  searchLazurioExact,
  searchLazurioQmd,
  updateLazurioQmdIndex,
} from "./search-lib.mjs";

const tempRoots = [];
const cliPath = join(import.meta.dirname, "cli.mjs");

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("exact search vidí čerstvou českou změnu uvnitř parent-gitignored nested repa", async () => {
  const fixture = await searchFixture();
  await writeFile(join(fixture.website, "fresh.md"), "Příliš žluťoučký kůň je čerstvá změna.\n", "utf8");

  const result = await searchLazurioExact({
    root: fixture.root,
    query: "žluťoučký",
    principalId: "immakermatty",
  });

  expect(result.freshness).toEqual({ status: "live", reason: "ripgrep_reads_current_filesystem" });
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({
    path: "workspace/website-lazurio/fresh.md",
    repository_relative_path: "fresh.md",
    line: 1,
    provenance: {
      organization_slug: "HumanAndMachine-ai",
      principal_github_username: "immakermatty",
      team: "lazurio",
      source_id: "website",
      repository_path: "workspace/website-lazurio",
    },
  });
});

test("scope nepropustí jinou Organization, Personalspace, template, private ani worktree duplicity", async () => {
  const fixture = await searchFixture();
  const canary = "NEPROPUST_TENTO_CANARY";
  await writeFile(join(fixture.website, "public.md"), `${canary}\n`, "utf8");
  await mkdir(join(fixture.website, ".worktrees", "duplicate"), { recursive: true });
  await writeFile(join(fixture.website, ".worktrees", "duplicate", "copy.md"), `${canary}\n`, "utf8");
  await mkdir(join(fixture.website, "private", "secrets"), { recursive: true });
  await writeFile(join(fixture.website, "private", "secrets", "hidden.md"), `${canary}\n`, "utf8");
  await writeFile(join(fixture.otherOrganization, "outside.md"), `${canary}\n`, "utf8");
  await writeFile(join(fixture.personalspace, "private.md"), `${canary}\n`, "utf8");
  await writeFile(join(fixture.template, "template.md"), `${canary}\n`, "utf8");
  await writeFile(join(fixture.website, "binary.png"), `${canary}\n`, "utf8");
  await writeFile(join(fixture.website, "disguised-binary.md"), Buffer.from(`\0${canary}\0`));

  const result = await searchLazurioExact({
    root: fixture.root,
    query: canary,
    principalId: "immakermatty",
  });

  expect(result.results.map((entry) => entry.path)).toEqual([
    "workspace/website-lazurio/public.md",
  ]);
  expect(JSON.stringify(result)).not.toContain("OtherCo");
  expect(JSON.stringify(result)).not.toContain("personalspace");
  expect(JSON.stringify(result)).not.toContain("OrganizationTemplate");
});

test("zděděný ripgrep config nemůže následovat symlink mimo exact ani snapshot scope", async () => {
  const fixture = await searchFixture();
  const configPath = join(fixture.root, "poisoned-ripgrep.conf");
  const canary = "EXACT_LANE_EXTERNAL_CANARY";
  await writeFile(configPath, "--follow\n", "utf8");
  await writeFile(join(fixture.personalspace, "external.md"), `${canary}\n`, "utf8");

  const previousConfigPath = process.env.RIPGREP_CONFIG_PATH;
  process.env.RIPGREP_CONFIG_PATH = configPath;
  try {
    const before = await buildLazurioSearchStatus({
      root: fixture.root,
      principalId: "immakermatty",
    });
    await symlink(fixture.personalspace, join(fixture.website, "linked-personalspace"));

    const exact = await searchLazurioExact({
      root: fixture.root,
      query: canary,
      principalId: "immakermatty",
    });
    const after = await buildLazurioSearchStatus({
      root: fixture.root,
      principalId: "immakermatty",
    });

    expect(exact.results).toEqual([]);
    expect(after.exact.file_count).toBe(before.exact.file_count);
    expect(JSON.stringify(exact)).not.toContain("personalspace");
  } finally {
    if (previousConfigPath === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previousConfigPath;
  }
});

test("Organization containment odmítne symlinkovaný pilotní source", async () => {
  const fixture = await searchFixture({ withoutWebsite: true });
  const outside = await tempRoot("lazurio-search-outside-");
  await writeFile(join(outside, "escape.md"), "escape canary\n", "utf8");
  await symlink(outside, fixture.website);

  await expect(discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  })).rejects.toMatchObject({
    code: "organization_discovery_failed",
    lazurioExitCode: 3,
  });
});

test("QMD storage je fyzicky oddělený podle Organization a Principála", async () => {
  const fixture = await searchFixture();
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });
  const first = qmdStorageLayout(scope);
  const second = qmdStorageLayout({
    ...scope,
    principal: { ...scope.principal, github_username: "another-principal" },
  });
  const third = qmdStorageLayout({
    ...scope,
    organization: { ...scope.organization, slug: "AnotherOrg" },
  });

  expect(first.database_path).not.toBe(second.database_path);
  expect(first.database_path).not.toBe(third.database_path);
  expect(first.config_path).not.toBe(second.config_path);
  expect(first.index_name).toContain("humanandmachine-ai-immakermatty");
});

test("QMD child environment vždy odstraní zděděný INDEX_PATH", async () => {
  const fixture = await searchFixture();
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });
  const layout = qmdStorageLayout(scope);
  await materializeQmdConfig(scope, layout);
  await mkdir(dirname(layout.database_path), { recursive: true });
  await writeFile(layout.database_path, "fixture index", "utf8");
  const qmdCalls = [];
  const spawn = qmdStub({ calls: qmdCalls });

  const previousIndexPath = process.env.INDEX_PATH;
  process.env.INDEX_PATH = join(fixture.personalspace, "external-qmd.sqlite");
  try {
    await buildLazurioSearchStatus({
      root: fixture.root,
      principalId: "immakermatty",
      spawn,
    });
    await searchLazurioQmd({
      root: fixture.root,
      principalId: "immakermatty",
      query: "izolace",
      mode: "lexical",
      spawn,
    });
    await updateLazurioQmdIndex({
      root: fixture.root,
      principalId: "immakermatty",
      embed: true,
      spawn,
    });
  } finally {
    if (previousIndexPath === undefined) delete process.env.INDEX_PATH;
    else process.env.INDEX_PATH = previousIndexPath;
  }

  for (const operation of ["--version", "status", "search", "update", "embed"]) {
    expect(qmdCalls.some(({ args }) => args.includes(operation))).toBe(true);
  }
  for (const { options } of qmdCalls) {
    expect(options.env.INDEX_PATH).toBeUndefined();
    expect(options.env.QMD_CONFIG_DIR).toBe(layout.config_dir);
    expect(options.env.XDG_CACHE_HOME).toBe(layout.cache_home);
  }
});

test("QMD config materializuje jen tři explicitní textové collections s boundary excludes", async () => {
  const fixture = await searchFixture();
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });
  const layout = qmdStorageLayout(scope);
  const { config } = await materializeQmdConfig(scope, layout);

  expect(Object.keys(config.collections)).toEqual(["website", "design-system", "knowledge"]);
  expect(config.collections.knowledge.path).toBe(fixture.knowledge);
  expect(config.collections.website.pattern).toContain("md");
  expect(config.collections.website.pattern).not.toContain("png");
  expect(config.collections.website.ignore).toContain("**/.worktrees/**");
  expect(config.collections.website.ignore).toContain("**/private/**");
  expect(config.collections.website.ignore).toContain("**/secrets/**");
  expect(existsSync(layout.config_path)).toBe(true);
});

test("QMD config fail-closed odmítne nested symlink uvnitř povoleného source", async () => {
  const fixture = await searchFixture();
  const outside = await tempRoot("lazurio-qmd-symlink-outside-");
  await writeFile(join(outside, "escape.md"), "secret outside scope\n", "utf8");
  await symlink(join(outside, "escape.md"), join(fixture.website, "escape.md"));
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });

  await expect(materializeQmdConfig(scope)).rejects.toMatchObject({
    code: "qmd_source_symlink",
    lazurioExitCode: 3,
  });
});

test("QMD config bezpečně přeskočí interní symlink bez duplikace kanonického obsahu", async () => {
  const fixture = await searchFixture();
  const canonical = join(fixture.designSystem, "content");
  await mkdir(canonical, { recursive: true });
  await writeFile(join(canonical, "canonical.md"), "kanonický obsah\n", "utf8");
  await mkdir(join(fixture.designSystem, "app", "public"), { recursive: true });
  await symlink(canonical, join(fixture.designSystem, "app", "public", "content"));
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });

  await expect(materializeQmdConfig(scope)).resolves.toMatchObject({
    config: {
      collections: {
        "design-system": {
          path: fixture.designSystem,
        },
      },
    },
  });
});

test("QMD config fail-closed odmítne binární obsah s textovou příponou", async () => {
  const fixture = await searchFixture();
  await writeFile(join(fixture.knowledge, "disguised.md"), Buffer.from("text\0binary"));
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });

  await expect(materializeQmdConfig(scope)).rejects.toMatchObject({
    code: "qmd_source_binary",
    lazurioExitCode: 3,
  });
});

test("QMD status hlásí nepodporovanou 2.1.0 bez rozbití exact lane", async () => {
  const fixture = await searchFixture();
  const spawn = qmdStub({ version: "2.1.0" });
  const status = await buildLazurioSearchStatus({
    root: fixture.root,
    principalId: "immakermatty",
    spawn,
  });
  const exact = await searchLazurioExact({
    root: fixture.root,
    principalId: "immakermatty",
    query: "Lazurio",
  });

  expect(status.qmd).toMatchObject({
    status: "unavailable",
    reason: "unsupported_qmd_version",
    version: "2.1.0",
    minimum_version: "2.5.3",
  });
  expect(status.exact.status).toBe("available");
  expect(exact.result_count).toBeGreaterThan(0);
});

test("QMD ABI failure je diagnostikovaný bez zveřejnění backend stack trace", async () => {
  const fixture = await searchFixture();
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });
  await materializeQmdConfig(scope);
  const status = await buildLazurioSearchStatus({
    root: fixture.root,
    principalId: "immakermatty",
    spawn: qmdStub({
      version: QMD_MIN_VERSION,
      statusCode: 1,
      statusError: "better_sqlite3.node was compiled against NODE_MODULE_VERSION 141",
    }),
  });

  expect(status.qmd.status).toBe("unavailable");
  expect(status.qmd.reason).toBe("qmd_native_abi_mismatch");
  expect(JSON.stringify(status)).not.toContain("better_sqlite3.node");
});

test("QMD update uloží source fingerprint a status rozliší fresh od stale", async () => {
  const fixture = await searchFixture();
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });
  const layout = qmdStorageLayout(scope);
  await mkdir(dirname(layout.database_path), { recursive: true });
  await writeFile(layout.database_path, "fixture index", "utf8");
  const spawn = qmdStub({ version: QMD_MIN_VERSION });

  const fresh = await updateLazurioQmdIndex({
    root: fixture.root,
    principalId: "immakermatty",
    spawn,
  });
  expect(fresh.qmd).toMatchObject({
    status: "available",
    freshness: { status: "fresh", reason: "source_snapshot_matches_last_update" },
  });
  expect(fresh.qmd.last_successful_update).toBeString();

  await writeFile(join(fixture.knowledge, "after-update.md"), "nová neindexovaná změna\n", "utf8");
  const stale = await buildLazurioSearchStatus({
    root: fixture.root,
    principalId: "immakermatty",
    spawn,
  });
  expect(stale.qmd.freshness).toEqual({
    status: "stale",
    reason: "source_snapshot_changed_since_update",
  });

  const unknown = await buildLazurioSearchStatus({
    root: fixture.root,
    principalId: "immakermatty",
    spawn: qmdStub({ version: QMD_MIN_VERSION, rgUnavailable: true }),
  });
  expect(unknown.exact.status).toBe("not_evaluated");
  expect(unknown.qmd.freshness).toEqual({ status: "not_evaluated", reason: "rg_unavailable" });
});

test("QMD update bez source snapshotu nikdy nezapíše falešný fresh state", async () => {
  const fixture = await searchFixture();
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });
  const layout = qmdStorageLayout(scope);
  await mkdir(dirname(layout.database_path), { recursive: true });
  await writeFile(layout.database_path, "fixture index", "utf8");

  await expect(updateLazurioQmdIndex({
    root: fixture.root,
    principalId: "immakermatty",
    spawn: qmdStub({ version: QMD_MIN_VERSION, rgUnavailable: true }),
  })).rejects.toMatchObject({
    code: "source_snapshot_unavailable",
    lazurioExitCode: 3,
  });
  expect(existsSync(layout.state_path)).toBe(false);
});

test("QMD update nezapíše fresh state, když se source změní během indexace", async () => {
  const fixture = await searchFixture();
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });
  const layout = qmdStorageLayout(scope);
  await mkdir(dirname(layout.database_path), { recursive: true });
  await writeFile(layout.database_path, "fixture index", "utf8");
  const baseSpawn = qmdStub({ version: QMD_MIN_VERSION });
  await updateLazurioQmdIndex({
    root: fixture.root,
    principalId: "immakermatty",
    spawn: baseSpawn,
  });
  const previousState = await readFile(layout.state_path, "utf8");
  let changedDuringUpdate = false;
  const spawn = (command, args, options) => {
    const result = baseSpawn(command, args, options);
    if (command === "qmd" && args.includes("update") && !changedDuringUpdate) {
      writeFileSync(join(fixture.knowledge, "during-update.md"), "změna po načtení QMD\n", "utf8");
      changedDuringUpdate = true;
    }
    return result;
  };

  await expect(updateLazurioQmdIndex({
    root: fixture.root,
    principalId: "immakermatty",
    spawn,
  })).rejects.toMatchObject({
    code: "source_changed_during_qmd_update",
    lazurioExitCode: 3,
  });
  expect(changedDuringUpdate).toBe(true);
  expect(await readFile(layout.state_path, "utf8")).toBe(previousState);
  const status = await buildLazurioSearchStatus({
    root: fixture.root,
    principalId: "immakermatty",
    spawn: baseSpawn,
  });
  expect(status.qmd.freshness).toEqual({
    status: "stale",
    reason: "source_snapshot_changed_since_update",
  });
});

test("QMD lexical adapter normalizuje výsledek do stejné scoped provenance", async () => {
  const fixture = await searchFixture();
  const scope = await discoverLazurioSearchScope({
    root: fixture.root,
    principalId: "immakermatty",
  });
  const layout = qmdStorageLayout(scope);
  await materializeQmdConfig(scope, layout);
  await mkdir(dirname(layout.database_path), { recursive: true });
  await writeFile(layout.database_path, "fixture", "utf8");
  const spawn = qmdStub({
    version: QMD_MIN_VERSION,
    queryOutput: JSON.stringify([{
      file: "qmd://knowledge/index.md?index=lazurio-humanandmachine-ai-immakermatty",
      line: 7,
      score: 0.91,
      snippet: "Český význam Lazuria",
    }]),
  });

  const result = await searchLazurioQmd({
    root: fixture.root,
    principalId: "immakermatty",
    query: "český význam",
    mode: "lexical",
    spawn,
  });

  expect(result.results).toEqual([expect.objectContaining({
    path: "workspace/knowledgebase/data/v2/lazurio-ai/index.md",
    repository_relative_path: "data/v2/lazurio-ai/index.md",
    line: 7,
    score: 0.91,
    provenance: expect.objectContaining({
      source_id: "knowledge",
      organization_slug: "HumanAndMachine-ai",
      principal_github_username: "immakermatty",
    }),
  })]);
});

test("CLI exact search vrací strojově čitelný scoped výsledek", async () => {
  const fixture = await searchFixture();
  await writeFile(join(fixture.knowledge, "cli.md"), "Česká CLI zkouška.\n", "utf8");
  const result = Bun.spawnSync([
    process.execPath,
    cliPath,
    "search",
    "Česká",
    "--json",
    "--root",
    fixture.root,
  ], { stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    schema_version: "lazurio.search.results.v1",
    mode: "exact",
    result_count: 1,
  });
  expect(stdout).not.toContain(fixture.root);
});

test("CLI hledá jednoslovné exact dotazy status a update místo spuštění akcí", async () => {
  const fixture = await searchFixture();
  await writeFile(join(fixture.knowledge, "action-words.md"), "status update\n", "utf8");

  for (const query of ["status", "update"]) {
    const result = Bun.spawnSync([
      process.execPath,
      cliPath,
      "search",
      query,
      "--json",
      "--root",
      fixture.root,
    ], { stdout: "pipe", stderr: "pipe" });
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout));

    expect(result.exitCode).toBe(0);
    expect(parsed).toMatchObject({ mode: "exact", query, result_count: 1 });
  }
});

test("CLI fail-closed odmítne search-only flag u contextu i query-only flag u statusu", async () => {
  const fixture = await searchFixture();
  const context = Bun.spawnSync([
    process.execPath,
    cliPath,
    "context",
    "--json",
    "--mode",
    "exact",
    "--root",
    fixture.root,
  ], { stdout: "pipe", stderr: "pipe" });
  const status = Bun.spawnSync([
    process.execPath,
    cliPath,
    "search",
    "--status",
    "--limit",
    "5",
    "--root",
    fixture.root,
  ], { stdout: "pipe", stderr: "pipe" });

  expect(context.exitCode).toBe(2);
  expect(new TextDecoder().decode(context.stderr)).toContain("pouze s příkazem search");
  expect(status.exitCode).toBe(2);
  expect(new TextDecoder().decode(status.stderr)).toContain("pouze se search dotazem");
});

async function searchFixture({ withoutWebsite = false } = {}) {
  const root = await tempRoot("lazurio-search-");
  for (const directory of ["launchpad", "guide", "manual", "organizations", "personalspace"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeJson(join(root, "launchpad.gen3.json"), {
    launchpad_root: { slug: "fixture-root", display_name: "Fixture root", root_role: "companies-root" },
  });
  await writeJson(join(root, "launchpad.gen3.local.json"), {
    personalspace_owner: "immakermatty",
  });
  await writeFile(join(root, ".gitignore"), "organizations/**\npersonalspace/**\n", "utf8");

  const organizationRoot = join(root, "organizations", "HumanAndMachine-ai_GEN3");
  await createOrganization(organizationRoot, {
    slug: "HumanAndMachine-ai",
    kind: "organization",
    slots: [
      slot("workspace/website-lazurio", ["lazurio"]),
      slot("workspace/design-system-lazurio", ["lazurio"]),
      slot("workspace/knowledgebase", ["rozjedeme-ai", "lazurio"]),
    ],
  });
  const website = join(organizationRoot, "workspace", "website-lazurio");
  const designSystem = join(organizationRoot, "workspace", "design-system-lazurio");
  const knowledgeRepository = join(organizationRoot, "workspace", "knowledgebase");
  const knowledge = join(knowledgeRepository, "data", "v2", "lazurio-ai");
  if (!withoutWebsite) await createRepository(website);
  await createRepository(designSystem);
  await createRepository(knowledgeRepository);
  await mkdir(knowledge, { recursive: true });
  await writeFile(join(website, "README.md"), "Lazurio website\n", "utf8").catch(() => {});
  await writeFile(join(designSystem, "README.md"), "Lazurio design system\n", "utf8");
  await writeFile(join(knowledge, "index.md"), "Lazurio znalosti\n", "utf8");

  const otherOrganization = join(root, "organizations", "OtherCo_GEN3");
  await createOrganization(otherOrganization, {
    slug: "OtherCo",
    kind: "organization",
    slots: [slot("workspace/outside", ["workspace"])],
    teams: ["workspace"],
  });
  await createRepository(join(otherOrganization, "workspace", "outside"));

  const template = join(root, "organizations", "OrganizationTemplate_GEN3");
  await createOrganization(template, {
    slug: "template-organization",
    kind: "template",
    slots: [],
    teams: ["workspace"],
  });
  const personalspace = join(root, "personalspace", "immakermatty_GEN3");
  await mkdir(personalspace, { recursive: true });

  return {
    root,
    organizationRoot,
    website,
    designSystem,
    knowledgeRepository,
    knowledge,
    otherOrganization: join(otherOrganization, "workspace", "outside"),
    personalspace,
    template,
  };
}

async function createOrganization(root, {
  slug,
  kind,
  slots,
  teams = ["rozjedeme-ai", "lazurio"],
}) {
  for (const directory of ["manual", "company/colleagues", "workspace"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeJson(join(root, "company.gen3.json"), {
    organization_generation: "gen3",
    organization_kind: kind,
    company: {
      slug,
      display_name: slug,
      github_org: slug,
      repository: `git@github.com:${slug}/${slug}_GEN3.git`,
    },
    teams: teams.map((team) => ({ slug: team, display_name: team })),
  });
  await writeJson(join(root, "modules.manifest.json"), {
    schema_version: "companiesascode.modules.v1",
    company: slug,
    github_org: slug,
    module_slots: slots,
  });
}

function slot(path, teams) {
  const repository = path.split("/").at(-1);
  return {
    path,
    slug: repository,
    teams,
    status: "active",
    category: "knowledge",
    source_of_truth: "git-native",
    git: { url: `git@github.com:HumanAndMachine-ai/${repository}.git`, branch: "main" },
  };
}

async function createRepository(path) {
  await mkdir(join(path, ".git"), { recursive: true });
}

function qmdStub({
  version = QMD_MIN_VERSION,
  statusCode = 0,
  statusError = "",
  queryOutput = "[]",
  rgUnavailable = false,
  calls,
} = {}) {
  return (command, args, options) => {
    if (command === "rg" && rgUnavailable) {
      return { status: null, stdout: "", stderr: "", error: new Error("spawn rg ENOENT") };
    }
    if (command !== "qmd") return realSpawn(command, args, options);
    calls?.push({ args: [...args], options: { cwd: options.cwd, env: { ...options.env } } });
    if (args.includes("--version")) return commandResult(0, `qmd ${version}\n`);
    if (args.includes("status")) return commandResult(statusCode, "", statusError);
    if (args.some((arg) => ["search", "vsearch", "query"].includes(arg))) {
      return commandResult(0, queryOutput);
    }
    return commandResult(0, "ok\n");
  };
}

function realSpawn(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

function commandResult(status, stdout = "", stderr = "") {
  return { status, stdout, stderr, error: null };
}

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
