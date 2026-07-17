import { existsSync, readFileSync } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import { basename, join } from "path";
import { discoverLaunchpadApps, readJson } from "./discovery-lib.mjs";
import { UPDATE_CHANNELS, selectHighestStableTag } from "./update-lib.mjs";
import { buildGitApiResponse, compactGitSummaryForApp } from "./git-api-lib.mjs";
import { createRuntimeManager, resolveBunExecutable } from "./runtime-lib.mjs";
import { buildWorktreeIndex } from "./worktree-lib.mjs";
import {
  GIT_LOCAL_TIMEOUT_MS,
  resolveGitExecutableSync,
  safeGitCommandEnv,
} from "./git-lib.mjs";
import { agentSkillsEntrypointsDoctorCheck } from "./agent-skills-entrypoint-lib.mjs";
import {
  organizationSlotScope,
  organizationSlotWorkspace,
} from "./organization-slot-scope-lib.mjs";

const supportedPlatforms = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

const rootGitignoreProbePaths = [
  "launchpad/runtime/probe.json",
  "launchpad/logs/probe.log",
  "logs/probe.log",
];

const companyGitignoreProbePaths = [
  "company/colleagues/example/private/probe.txt",
  "company/colleagues/example/archive/probe.txt",
  "company/colleagues/example/archiv/probe.txt",
];

const worktreePackageLockfileNames = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const worktreeSupportedPackageManagers = new Set(["bun"]);

export async function buildLaunchpadAppsResponse({
  companiesRoot = join(import.meta.dirname, "..", ".."),
  launchpadRoot = join(import.meta.dirname, ".."),
  runtimeManager = createRuntimeManager({ companiesRoot, launchpadRoot }),
  gitStatusService = null,
  allowMissingOrganizations = false,
} = {}) {
  const discovery = await discoverLaunchpadApps(companiesRoot, { allowMissingOrganizations });
  const companiesConfig = await readCompaniesConfig(companiesRoot);
  const organizationSpaces = Array.isArray(discovery.organizations)
    ? await Promise.all(
        discovery.organizations.map(async (organization) => ({
          organization,
          spaces: await readOrganizationSpaces(companiesRoot, organization, discovery.local_config),
        })),
      )
    : [];
  const organizations = organizationSpaces.map(({ organization, spaces }) => {
    // module_declarations je interní resolver plumbing, ne API kontrakt.
    const { module_declarations, ...publicSpaces } = spaces;
    const publicOrganization = {
      slug: organization.slug,
      display_name: organization.display_name,
      path: organization.path,
      repository: organization.repository ?? null,
      git_url: organization.git_url ?? null,
      generation: organization.generation ?? null,
      migration_marker: organization.migration_marker ?? null,
      materialization: organization.materialization ?? null,
      // Kanonický klíč organization_type; workspace_type je deprecated GEN2 alias.
      organization_type: organization.organization_type ?? organization.workspace_type ?? null,
      // mounted (default) | planned — planned Organizace ještě nemá mount (decision 0024).
      status: organization.status ?? "mounted",
      discovery_source: organization.discovery_source ?? "registry",
      // GEN3 organization GEN3 model: workspaces (named module groups) and a
      // read-only productionspace boundary (externally-developed release/runtime
      // systems referenced here but governed by their own rules). Additive — the
      // UI groups apps by workspace and renders productionspace read-only.
      ...publicSpaces,
    };
    // Doctor potřebuje i vnořené deklarace, které nejsou UI dlaždice.
    // Non-enumerable vlastnost zůstane v interním read modelu pro Doctor, ale
    // neunikne do JSON /api/apps kontraktu.
    Object.defineProperty(publicOrganization, "module_declarations", {
      value: module_declarations,
      enumerable: false,
    });
    return publicOrganization;
  });
  const companies = organizations;
  // Module šablony jsou informační sken templates/<owner>/<template> (scan-first,
  // decision 0042) — ne registry a ne vynucený Git mount. Doctor je jen ukazuje;
  // nepřítomnost je prostě prázdný seznam, nikdy failure.
  const templates = (discovery.module_templates ?? []).map((template) => ({
    slug: template.slug,
    owner: template.owner ?? null,
    path: template.path,
    discovery_source: template.discovery_source ?? "filesystem",
  }));
  const companyNames = new Map(companies.map((company) => [company.slug, company.display_name]));
  // Decision 0041: deklarace v manifestu je autorita pro Workspace grouping;
  // odvozování z filesystem cesty se ruší.
  const workspaceResolvers = new Map(
    organizationSpaces.map(({ organization, spaces }) => [
      organization.path,
      workspaceResolverForOrganization({
        path: organization.path,
        module_declarations: spaces.module_declarations,
      }),
    ]),
  );
  const apps = await runtimeManager.appsWithRuntime(discovery.apps.map((app) => ({
    ...app,
    company_display_name: companyNames.get(app.company) ?? app.company,
    // Which workspace inside the organization this module belongs to — from the
    // manifest declaration (module_slots[].workspace / modules[].workspace);
    // missing declaration means the default "workspace" (decision 0041).
    workspace: workspaceForApp(workspaceResolvers, app),
    url: `http://${app.host}:${app.port}`,
    health_url: `http://${app.host}:${app.port}${app.health_path}`,
  })));
  const invalidApps = (discovery.invalid_apps ?? []).map((app) => ({
    ...app,
    company_display_name: companyNames.get(app.company) ?? app.company,
    workspace: workspaceForApp(workspaceResolvers, app),
    url: null,
    health_url: null,
    dependencies: {
      state: "invalid_manifest",
      message: `Manifest aplikace není validní: ${app.manifest_issues.join("; ")}`,
      can_start: false,
      can_install: false,
    },
    dependency_status: "invalid_manifest",
    runtime: {
      status: "stopped",
      message: "Aplikace s nevalidním manifestem se nespouští; oprav companyascode.app manifest.",
    },
    runtime_status: "stopped",
  }));
  const visibleApps = [...apps, ...invalidApps];
  const gitContext = await buildGitContext({ companiesRoot, gitStatusService });
  const appsWithGit = visibleApps.map((app) => ({
    ...app,
    git: compactGitSummaryForApp(gitContext.reposByKey.get(gitRepoKeyForApp(app))),
  }));
  // Template mounty (organization_kind=template) jsou validované, ale vyloučené z
  // runtime akcí, business přehledů i org počtů. Drží se v oddělených polích, aby
  // je žádný konzument organizations/apps nezapočítal; Doctor je jen označí.
  const templateMounts = (discovery.template_mounts ?? []).map((mount) => ({
    slug: mount.slug,
    display_name: mount.display_name ?? mount.slug,
    path: mount.path,
    organization_kind: "template",
    organization_type: mount.organization_type ?? "organization-template",
    // Status se musí zachovat: planned template slot (decision 0024) ještě nemá
    // mount a Git mount gate ho musí přeskočit stejně jako u planned Organizace.
    status: mount.status ?? "mounted",
    discovery_source: mount.discovery_source ?? "registry",
  }));
  const templateApps = discovery.template_apps ?? [];

  return {
    schema_version: "companiesascode.launchpad.apps.v1",
    generated_at: new Date().toISOString(),
    launchpad_root: workspaceSummary(companiesConfig),
    companies_workspace: workspaceSummary(companiesConfig),
    root: companiesRoot,
    ok: discovery.failures.length === 0,
    summary: {
      app_count: apps.length,
      invalid_app_count: invalidApps.length,
      organization_count: companies.length,
      company_count: companies.length,
      template_mount_count: templateMounts.length,
      template_app_count: templateApps.length,
      failure_count: discovery.failures.length,
      warning_count: discovery.warnings?.length ?? 0,
    },
    organizations,
    companies,
    templates,
    template_mounts: templateMounts,
    template_apps: templateApps,
    apps: appsWithGit,
    failures: discovery.failures,
    warnings: [...(discovery.warnings ?? []), ...gitContext.warnings],
  };
}

export async function buildLaunchpadDoctorReport(options = {}) {
  const appsResponse = await buildLaunchpadAppsResponse(options);
  const environmentChecks = buildEnvironmentChecks({
    companiesRoot: appsResponse.root,
    companies: appsResponse.companies,
    // Module šablony (templates/*/*) jsou informační sken — žádná Git mount gate.
    // Marker template mounty (organization_kind=template) se nepočítají jako
    // Organizace, ale drží stejné strukturální Git mount gates (řádný Git checkout).
    templateMounts: appsResponse.template_mounts,
  });
  // Personalspace doctor check (CAC-0048) — METADATA ONLY (počty, validita,
  // gbrain mount stav). Nikdy nečte obsah osobních modulů ani gbrain zápisů a
  // osobní aplikace se NIKDY nemíchají do org appsResponse. Selhání personalspace
  // discovery nesmí shodit celý org doctor → izolované do skip/warn.
  const worktreeChecks = await buildWorktreeDoctorChecks({ companiesRoot: appsResponse.root });
  const personalspaceChecks = await buildPersonalspaceDoctorChecks({
    companiesRoot: appsResponse.root,
    launchpadRoot: options.launchpadRoot,
  });
  const agentSkillsChecks = [
    await agentSkillsEntrypointsDoctorCheck({
      companiesRoot: appsResponse.root,
      mounts: [
        ...(appsResponse.organizations ?? []),
        ...(appsResponse.template_mounts ?? []),
      ],
    }),
  ];
  return buildDoctorReportFromAppsResponse(appsResponse, {
    environmentChecks,
    extraChecks: [...worktreeChecks, ...personalspaceChecks, ...agentSkillsChecks],
  });
}

// Oddělený od org appsResponse: personalspace má vlastní lane. Dynamický import,
// aby se personalspace runtime moduly nenatahovaly, když se doctor volá jen na
// org kontrolu, a aby případná chyba lane zůstala izolovaná.
async function buildPersonalspaceDoctorChecks({ companiesRoot, launchpadRoot }) {
  try {
    const { buildPersonalspaceResponse, personalspaceDoctorCheck } = await import("./personalspace-runtime-lib.mjs");
    const personalspaceResponse = await buildPersonalspaceResponse({
      companiesRoot,
      launchpadRoot: launchpadRoot ?? join(companiesRoot, "launchpad"),
    });
    return [personalspaceDoctorCheck(personalspaceResponse)];
  } catch (error) {
    return [
      {
        id: "launchpad.personalspace",
        status: "skip",
        severity: "local-state",
        title: "Personalspace",
        message: `Personalspace kontrola se přeskočila (${error.message}).`,
        paths: ["personalspace"],
        links: [],
        details: [],
      },
    ];
  }
}

async function buildWorktreeDoctorChecks({ companiesRoot }) {
  try {
    const index = await buildWorktreeIndex({ companiesRoot });
    return [
      worktreeInventoryCheck(index),
      worktreeContractCheck(index),
      await worktreeDependencyCheck({ companiesRoot, index }),
    ];
  } catch (error) {
    return [
      {
        id: "git.worktrees.inventory",
        status: "warn",
        severity: "local-state",
        title: "Worktree inventory",
        message: `Worktree inventory nejde načíst (${error.message}).`,
        paths: ["organizations"],
        links: [],
        details: [error.stack ?? error.message],
      },
      skippedCheck({
        id: "git.worktrees.contract",
        title: "Worktree kontrakt",
        message: "Worktree contract checks se přeskočily, protože inventory nejde načíst.",
        paths: ["organizations"],
      }),
      skippedCheck({
        id: "git.worktrees.dependencies",
        title: "Worktree dependency readiness",
        message: "Worktree dependency checks se přeskočily, protože inventory nejde načíst.",
        paths: ["organizations"],
      }),
    ];
  }
}

function worktreeInventoryCheck(index) {
  const worktrees = index.worktrees ?? [];
  const ownershipCounts = countBy(worktrees.map((worktree) => worktree.ownership_status ?? "unknown"));
  const lifecycleCounts = countBy(worktrees.map((worktree) => worktree.status ?? "unknown"));
  const details = [
    `total: ${worktrees.length}`,
    `owned: ${ownershipCounts.owned ?? 0}`,
    `orphan_missing_plan: ${ownershipCounts.orphan_missing_plan ?? 0}`,
    `orphan_missing_file: ${ownershipCounts.orphan_missing_file ?? 0}`,
    `invalid: ${ownershipCounts.invalid ?? 0}`,
    `active: ${lifecycleCounts.active ?? 0}`,
    `stale: ${lifecycleCounts.stale ?? 0}`,
    `invalid_locations: ${(index.invalid_locations ?? []).length}`,
    "dependency_readiness: worktree runtime sources reuse Launchpad dependency checks when selected",
  ];
  return {
    id: "git.worktrees.inventory",
    status: "ok",
    severity: "local-state",
    title: "Worktree inventory",
    message: `Worktree inventory: ${worktrees.length} worktrees, ${(index.invalid_locations ?? []).length} invalid locations.`,
    paths: ["organizations/*/.worktrees"],
    links: [],
    details,
  };
}

function worktreeContractCheck(index) {
  const details = [];
  for (const location of index.invalid_locations ?? []) {
    details.push(`invalid_location: ${location.path} — ${location.message}`);
  }
  for (const worktree of index.worktrees ?? []) {
    if (worktree.ownership_status !== "owned") {
      details.push(`${worktree.ownership_status}: ${worktree.slug} (${worktree.path}) — ${worktree.message}`);
    }
    if (worktree.status === "stale") {
      details.push(`cleanup_candidate: ${worktree.slug} (${worktree.path}) — stale owned worktree without local draft/PR signal`);
    } else if (worktree.ownership_status === "owned" && worktree.status && !["active"].includes(worktree.status)) {
      details.push(`cleanup_candidate: ${worktree.slug} (${worktree.path}) — status ${worktree.status}`);
    }
  }
  for (const warning of index.warnings ?? []) {
    details.push(`warning: ${warning}`);
  }

  return {
    id: "git.worktrees.contract",
    status: details.length > 0 ? "warn" : "ok",
    severity: "local-state",
    title: "Worktree kontrakt",
    message:
      details.length > 0
        ? `Worktree kontrakt má ${formatCount(details.length, "varování", "varování", "varování")}: ownership/orphan/stale cleanup.`
        : "Worktree kontrakt je čistý: žádné orphany, invalid locations ani cleanup kandidáti.",
    paths: ["organizations/*/.worktrees", "organizations/*/.claude/worktrees", "organizations/*/.pr-worktrees"],
    links: [],
    details,
  };
}

async function worktreeDependencyCheck({ companiesRoot, index }) {
  const ownedWorktrees = (index.worktrees ?? []).filter((worktree) => worktree.ownership_status === "owned");
  const records = [];
  for (const worktree of ownedWorktrees) {
    const packageRoots = await worktreePackageRoots(join(companiesRoot, worktree.path));
    if (packageRoots.length === 0) {
      records.push({
        state: "no_package",
        worktree,
        detail: `no_package: ${worktree.slug} (${worktree.path})`,
      });
      continue;
    }
    for (const packageRoot of packageRoots) {
      records.push(await worktreePackageReadiness({ worktree, packageRoot }));
    }
  }

  const counts = countBy(records.map((record) => record.state));
  const packageRecords = records.filter((record) => record.state !== "no_package");
  const warningStates = new Set(["needs_install", "stale_lockfile", "unknown_package_manager", "invalid_package_json"]);
  const warnings = records.filter((record) => warningStates.has(record.state));
  const details = [
    `checked_worktrees: ${ownedWorktrees.length}`,
    `checked_packages: ${packageRecords.length}`,
    `ready: ${counts.ready ?? 0}`,
    `needs_install: ${counts.needs_install ?? 0}`,
    `stale_lockfile: ${counts.stale_lockfile ?? 0}`,
    `unknown_package_manager: ${counts.unknown_package_manager ?? 0}`,
    `invalid_package_json: ${counts.invalid_package_json ?? 0}`,
    `no_package: ${counts.no_package ?? 0}`,
    ...warnings.map((record) => record.detail),
  ];

  return {
    id: "git.worktrees.dependencies",
    status: warnings.length > 0 ? "warn" : "ok",
    severity: "local-state",
    title: "Worktree dependency readiness",
    message:
      warnings.length > 0
        ? `Worktree dependency readiness má ${formatCount(warnings.length, "varování", "varování", "varování")}.`
        : `Worktree dependency readiness je čistá pro ${formatCount(packageRecords.length, "package", "packages", "packages")}.`,
    paths: ["organizations/*/.worktrees/*/*/*/package.json", "organizations/*/.worktrees/*/*/*/app/*/package.json"],
    links: [],
    details,
  };
}

async function worktreePackageRoots(absoluteWorktreePath) {
  const roots = [];
  if (existsSync(join(absoluteWorktreePath, "package.json"))) {
    roots.push({ absolute_dir: absoluteWorktreePath, relative_dir: "." });
  }
  const appRoot = join(absoluteWorktreePath, "app");
  if (existsSync(join(appRoot, "package.json"))) {
    roots.push({ absolute_dir: appRoot, relative_dir: "app" });
  }
  if (existsSync(appRoot)) {
    for (const entry of await safeReadDir(appRoot)) {
      if (!entry.isDirectory()) continue;
      const absoluteDir = join(appRoot, entry.name);
      if (existsSync(join(absoluteDir, "package.json"))) {
        roots.push({ absolute_dir: absoluteDir, relative_dir: `app/${entry.name}` });
      }
    }
  }
  return roots;
}

async function worktreePackageReadiness({ worktree, packageRoot }) {
  const packagePath = join(packageRoot.absolute_dir, "package.json");
  const packageRelativePath = packageRoot.relative_dir === "." ? "package.json" : `${packageRoot.relative_dir}/package.json`;
  const label = packageRoot.relative_dir === "." ? worktree.slug : `${worktree.slug}/${packageRoot.relative_dir}`;
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    return {
      state: "invalid_package_json",
      worktree,
      package_path: packageRelativePath,
      detail: `invalid_package_json: ${label} (${worktree.path}/${packageRelativePath}) — ${error.message}`,
    };
  }

  const lockfile = await firstExistingWorktreeLockfile(packageRoot.absolute_dir);
  const manager = detectWorktreePackageManager({ packageJson, lockfile });
  const declaredDependencyCount = countWorktreeDeclaredDependencies(packageJson);
  const packageNeedsInstall = declaredDependencyCount > 0 || Boolean(lockfile);
  const nodeModulesPresent = existsSync(join(packageRoot.absolute_dir, "node_modules"));
  let state = "ready";
  let action = "ready";
  if (!manager.supported) {
    state = "unknown_package_manager";
    action = `unsupported package manager ${manager.name ?? "unknown"}`;
  } else if (packageNeedsInstall && !nodeModulesPresent) {
    state = "needs_install";
    action = manager.install_command.join(" ");
  } else if (lockfile && nodeModulesPresent && await packageJsonNewerThanLockfile(packagePath, lockfile.absolute_path)) {
    state = "stale_lockfile";
    action = manager.install_command.join(" ");
  }

  return {
    state,
    worktree,
    package_path: packageRelativePath,
    detail: `${state}: ${label} (${worktree.path}/${packageRelativePath}) — ${action}`,
  };
}

async function firstExistingWorktreeLockfile(packageRoot) {
  for (const name of worktreePackageLockfileNames) {
    const absolutePath = join(packageRoot, name);
    if (!existsSync(absolutePath)) continue;
    return {
      path: name,
      absolute_path: absolutePath,
      package_manager: worktreePackageManagerForLockfile(name),
    };
  }
  return null;
}

function detectWorktreePackageManager({ packageJson, lockfile }) {
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager.trim() : "";
  if (declared) {
    const name = worktreePackageManagerName(declared);
    return {
      name,
      source: "packageManager",
      supported: worktreeSupportedPackageManagers.has(name),
      install_command: worktreeSupportedPackageManagers.has(name) ? [name, "install"] : null,
    };
  }
  if (lockfile) {
    return {
      name: lockfile.package_manager,
      source: `lockfile:${lockfile.path}`,
      supported: worktreeSupportedPackageManagers.has(lockfile.package_manager),
      install_command: worktreeSupportedPackageManagers.has(lockfile.package_manager) ? [lockfile.package_manager, "install"] : null,
    };
  }
  return {
    name: "bun",
    source: "default",
    supported: true,
    install_command: ["bun", "install"],
  };
}

function worktreePackageManagerName(value) {
  if (!value) return null;
  if (value.startsWith("@")) {
    const parts = value.split("@").filter(Boolean);
    return parts.length >= 2 ? `@${parts[0]}` : value;
  }
  return value.split("@")[0];
}

function worktreePackageManagerForLockfile(name) {
  return (
    {
      "bun.lock": "bun",
      "bun.lockb": "bun",
      "package-lock.json": "npm",
      "pnpm-lock.yaml": "pnpm",
      "yarn.lock": "yarn",
    }[name] ?? "unknown"
  );
}

function countWorktreeDeclaredDependencies(packageJson) {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .map((key) => packageJson[key])
    .filter((value) => value && typeof value === "object" && !Array.isArray(value))
    .reduce((count, value) => count + Object.keys(value).length, 0);
}

async function packageJsonNewerThanLockfile(packagePath, lockfilePath) {
  try {
    const [packageStat, lockStat] = await Promise.all([stat(packagePath), stat(lockfilePath)]);
    return packageStat.mtimeMs > lockStat.mtimeMs + 1_000;
  } catch {
    return false;
  }
}

async function safeReadDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function buildGitContext({ companiesRoot, gitStatusService = null }) {
  try {
    const gitResponse = await buildGitApiResponse({
      companiesRoot,
      statusService: gitStatusService,
      // /api/apps is the cheap discovery/runtime lane. Only the focused browser
      // asks /api/git/repos to schedule a network refresh.
      allowRemoteRefresh: false,
    });
    return {
      reposByKey: new Map(gitResponse.repos.map((repo) => [repo.key, repo])),
      warnings: gitResponse.warnings.map((warning) => `git: ${warning}`),
    };
  } catch (error) {
    return {
      reposByKey: new Map(),
      warnings: [`git: stav repozitářů nejde načíst (${error.message})`],
    };
  }
}

function gitRepoKeyForApp(app) {
  if (!app?.company || !app?.module) return null;
  return `${app.company}::${app.module}`;
}

export function buildDoctorReportFromAppsResponse(appsResponse, { environmentChecks = [], extraChecks = [] } = {}) {
  const checks = [
    ...environmentChecks,
    discoveryCheck(appsResponse),
    workspaceDeclarationCheck(appsResponse),
    ...runtimeChecks(appsResponse),
    // Additivní checks (např. personalspace, CAC-0048) — nikdy nemění org
    // appsResponse, jen se přidají do reportu.
    ...extraChecks,
  ];
  return {
    schema_version: "companiesascode.doctor.report.v1",
    scope: {
      type: "launchpad_root",
      path: ".",
      name: appsResponse.launchpad_root.display_name,
      absolute_path: appsResponse.root,
    },
    summary: summarizeChecks(checks),
    checks,
  };
}

export function buildEnvironmentChecks({ companiesRoot, companies = [], templateMounts = [] }) {
  const toolChecks = platformChecks(companiesRoot);
  const gitAvailable = toolChecks.some((check) => check.id === "platform.git" && check.status === "ok");
  if (!gitAvailable) {
    return [
      ...toolChecks,
      skippedCheck({
        id: "git.root",
        title: "Git root",
        message: "Git kontroly jsou přeskočené, protože Git není dostupný.",
        paths: ["."],
      }),
      skippedCheck({
        id: "gitignore.protection",
        title: ".gitignore ochrana",
        message: ".gitignore kontroly jsou přeskočené, protože Git není dostupný.",
        paths: [".gitignore"],
      }),
    ];
  }

  const repoMounts = uniqueRepoMounts({ companies, templateMounts });
  return [
    ...toolChecks,
    gitRootCheck(companiesRoot),
    gitWorktreeCheck(companiesRoot),
    updateChannelCheck(companiesRoot),
    gitSubmodulesCheck(companiesRoot),
    gitRepoMountsCheck(companiesRoot, repoMounts),
    gitignoreProtectionCheck(companiesRoot, repoMounts),
  ];
}

async function readCompaniesConfig(companiesRoot) {
  const configPath = join(companiesRoot, "launchpad.gen3.json");
  if (!existsSync(configPath)) return null;
  return readJson(configPath);
}

// Reads an organization's company.gen3.json to expose its Workspace boundaries
// and Productionspace systems. Productionspace systems are NOT lifecycle apps —
// they are externally-developed repos referenced with their own rules, surfaced
// read-only. Returns empty/null gracefully for planned or config-less orgs.
async function readOrganizationSpaces(companiesRoot, organization, localConfig = null) {
  const empty = { workspaces: [], productionspace: null, module_declarations: [] };
  if (organization.status === "planned" || !organization.path) return empty;
  const configPath = join(companiesRoot, organization.path, "company.gen3.json");
  if (!existsSync(configPath)) return empty;
  let config;
  try {
    config = await readJson(configPath);
  } catch {
    return empty;
  }

  const organizationRoot = join(companiesRoot, organization.path);
  const principalRoles = localConfig?.organization_roles?.[organization.slug];
  const declared = Array.isArray(config?.workspaces) ? config.workspaces : [];
  const productionspaceConfig = config?.productionspace ?? null;
  const productionBoundary = declared.find(
    (workspace) => workspace.slug === "productionspace" || workspace.path === "productionspace",
  );
  const manifest = await readOrganizationModuleManifest(companiesRoot, organization);
  const moduleSlots = (Array.isArray(manifest?.module_slots) ? manifest.module_slots.map(normalizeModuleSlot).filter(Boolean) : [])
    .map((slot) => moduleSlotWithReadiness(organizationRoot, slot, principalRoles));
  // Decision 0041: deklarace modules[].workspace v company.gen3.json je druhý
  // deklarativní povrch; manifest module_slots[] má přednost při konfliktu.
  // Config-only sloty (bez manifest protějšku) se počítají do tiles i
  // readiness stejně jako manifest sloty.
  const manifestPaths = new Set(moduleSlots.map((slot) => slot.path));
  const configOnlyModules = (Array.isArray(config?.modules) ? config.modules.map(normalizeModuleSlot).filter(Boolean) : [])
    .filter((slot) => !manifestPaths.has(slot.path))
    .map((slot) => moduleSlotWithReadiness(organizationRoot, slot, principalRoles));
  const moduleDeclarations = [...moduleSlots, ...configOnlyModules];
  // Vnořený child slot (např. mission-control/db — repository-db data
  // checkout uvnitř app mountu) je technický mount pro Doctor/search/publish
  // flow, ne samostatná Launchpad module dlaždice. Pro resolver
  // (module_declarations) zůstává, z tiles a productionspace systems se
  // vynechává.
  const declarationPaths = moduleDeclarations.map((slot) => slot.path);
  const isNestedChildSlot = (slot) =>
    declarationPaths.some((path) => path !== slot.path && slot.path.startsWith(`${path}/`));
  const tileModules = moduleDeclarations.filter((slot) => !isNestedChildSlot(slot));
  const workspaceModules = tileModules.filter(
    (slot) => slot.space === "workspace" && slot.workspace,
  );
  const workspaceSlugs = new Set([
    ...declared.filter((workspace) => workspace !== productionBoundary).map((workspace) => workspace.slug).filter(Boolean),
    ...workspaceModules.map((slot) => slot.workspace),
  ]);
  if (workspaceSlugs.size === 0 && workspaceModules.length > 0) workspaceSlugs.add("workspace");

  const declaredBySlug = new Map(declared.map((workspace) => [workspace.slug, workspace]));
  const workspaces = [...workspaceSlugs].map((slug) => {
    const workspace = declaredBySlug.get(slug) ?? { slug };
    return {
      slug,
      display_name: workspace.display_name ?? humanizeSlug(slug),
      path: workspace.path ?? slug,
      default: workspace.default === true || slug === "workspace",
      modules: workspaceModules.filter((slot) => slot.workspace === slug),
    };
  });

  const productionSystems = productionspaceSystems({
    moduleSlots: tileModules,
    productionspaceConfig,
  }).map((slot) => slot.readiness
    ? slot
    : moduleSlotWithReadiness(organizationRoot, slot, principalRoles));
  const productionspace =
    productionBoundary || productionspaceConfig || productionSystems.length > 0
      ? {
          slug: productionBoundary?.slug ?? "productionspace",
          display_name: productionBoundary?.display_name ?? "Productionspace",
          status: productionspaceConfig?.status ?? "candidate-boundary",
          systems: productionSystems,
        }
      : null;

  return {
    workspaces,
    productionspace,
    module_declarations: moduleDeclarations,
    space_readiness: {
      blocking_slots: moduleDeclarations
        .filter((slot) => slot.readiness?.severity === "blocking")
        .map((slot) => ({ path: slot.path, message: slot.readiness.message, reason: slot.readiness.reason })),
    },
    workspace_conformance_issues: workspaceConformanceIssues({
      declared,
      productionBoundary,
      manifest,
      config,
    }),
  };
}

// Konflikt deklarace vs. realita hlásí doctor (decision 0041 bod 4); jde o
// transition warningy, ne hard failures.
function workspaceConformanceIssues({ declared, productionBoundary, manifest, config }) {
  const issues = [];
  if (productionBoundary) {
    issues.push(
      "company.gen3.json: workspaces[] obsahuje productionspace — rezervovaný slug nesmí být Workspace (decision 0041 bod 6)",
    );
  }
  const defaults = declared.filter((workspace) => workspace !== productionBoundary && workspace.default === true);
  if (defaults.length > 1) {
    issues.push("company.gen3.json: workspaces[] deklaruje víc než jeden default Workspace");
  }
  const rawSlots = [
    ...(Array.isArray(manifest?.module_slots) ? manifest.module_slots : []).map((slot) => ({
      source: "modules.manifest.json",
      slot,
    })),
    ...(Array.isArray(config?.modules) ? config.modules : []).map((slot) => ({
      source: "company.gen3.json",
      slot,
    })),
  ];
  for (const { source, slot } of rawSlots) {
    if (!slot || typeof slot.path !== "string") continue;
    const path = slot.path.replace(/\\/g, "/");
    if (slot.workspace === "productionspace") {
      issues.push(
        path.startsWith("productionspace/")
          ? `${source}: slot ${path} deklaruje workspace "productionspace" — rezervovaný slug nesmí být hodnota workspace; productionspace slot určuje cesta (decision 0041 bod 6)`
          : `${source}: slot ${path} deklaruje workspace "productionspace" mimo productionspace/ — productionspace není Workspace (decision 0041 bod 6)`,
      );
    }
    if (slot.workspace && slot.workspace !== "productionspace" && path.startsWith("productionspace/")) {
      issues.push(
        `${source}: slot ${path} leží v productionspace/, ale deklaruje workspace "${slot.workspace}" (decision 0041 bod 6)`,
      );
    }
  }
  return issues;
}

// Readiness stavu module slotu (decision 0042): available = mount existuje,
// missing_access = deklarované repo bez lokálního checkoutu (typicky chybějící
// GitHub přístup nebo zatím nespuštěný doctor sync), planned_slot = slot bez
// repo deklarace.
function moduleSlotStatus(organizationRoot, slot) {
  if (existsSync(join(organizationRoot, slot.path))) return "available";
  return slot.repo ? "missing_access" : "planned_slot";
}

function moduleSlotWithReadiness(organizationRoot, slot, principalRoles = null) {
  const status = moduleSlotStatus(organizationRoot, slot);
  return {
    ...slot,
    status,
    readiness: classifyModuleSlotReadiness(slot, status, principalRoles),
  };
}

// Status popisuje fyzickou materializaci, readiness její dopad pro aktuální
// prostor. Dokud Doctor nemá autoritativní principal-scoped ACL důkaz, je
// role-based chybějící checkout fail-closed. UI umí přijmout kanonicky
// doloženou neutral severity, ale lokální odhad z GitHub tokenu ji nevyrábí.
function classifyModuleSlotReadiness(slot, status, principalRoles = null) {
  if (status === "available") {
    return { severity: "ok", reason: "available", message: "Checkout modulu je dostupný." };
  }
  if (status === "planned_slot") {
    return { severity: "neutral", reason: "planned", message: "Slot je plánovaný a zatím nemá repozitář." };
  }
  if (status === "missing_access") {
    const accessRestricted = ["role_based", "restricted", "private"].includes(slot.default_access);
    const requiredRoles = Array.isArray(slot.required_roles) ? slot.required_roles : [];
    const hasPrincipalRoleEvidence = Array.isArray(principalRoles);
    const principalIsEntitled = requiredRoles.includes("*")
      || (hasPrincipalRoleEvidence && requiredRoles.some((role) => principalRoles.includes(role)));
    if (accessRestricted && hasPrincipalRoleEvidence && requiredRoles.length > 0 && !principalIsEntitled) {
      return {
        severity: "neutral",
        reason: "role_not_entitled",
        message: "Checkout podle lokálně deklarovaných rolí tohoto Principála není očekávaný.",
      };
    }
    return {
      severity: "blocking",
      reason: accessRestricted
        ? "access_entitlement_unknown"
        : "unexpected_missing_access",
      message: slot.default_access === "expected"
        ? "Modul má být dostupný každému kolegovi, ale checkout chybí."
        : "Checkout chybí a access kontrola nedoložila očekávané omezení role nebo ACL.",
    };
  }
  return { severity: "blocking", reason: "unknown_status", message: `Neznámý stav slotu: ${status}.` };
}

// Decision 0041: aplikace patří do Workspace svého modulu podle manifest
// deklarace; chybějící deklarace znamená default slug "workspace". Filesystem
// cesta se pro grouping nepoužívá.
function workspaceResolverForOrganization(company) {
  const declarations = Array.isArray(company.module_declarations) ? company.module_declarations : [];
  return (app) => {
    // path.relative na Windows vrací backslashe; deklarace jsou POSIX.
    const packagePath = String(app.package_path ?? "").replace(/\\/g, "/");
    const prefix = `${company.path}/`;
    if (!packagePath.startsWith(prefix)) return "workspace";
    const organizationRelativePath = packagePath.slice(prefix.length);
    let match = null;
    for (const declaration of declarations) {
      if (
        organizationRelativePath === declaration.path ||
        organizationRelativePath.startsWith(`${declaration.path}/`)
      ) {
        if (!match || declaration.path.length > match.path.length) match = declaration;
      }
    }
    return match?.space === "root" ? null : match?.workspace ?? "workspace";
  };
}

function workspaceForApp(workspaceResolvers, app) {
  const resolver = workspaceResolvers.get(app.organization_path);
  return resolver ? resolver(app) : "workspace";
}

async function readOrganizationModuleManifest(companiesRoot, organization) {
  for (const relativePath of ["modules.manifest.json", "company/scripts/modules.manifest.json"]) {
    const manifestPath = join(companiesRoot, organization.path, relativePath);
    if (!existsSync(manifestPath)) continue;
    try {
      return await readJson(manifestPath);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeModuleSlot(slot) {
  if (!slot || typeof slot !== "object" || typeof slot.path !== "string" || slot.path.trim() === "") {
    return null;
  }
  const path = slot.path.replace(/\\/g, "/");
  const space = organizationSlotScope(slot, path);
  const workspace = organizationSlotWorkspace(slot, path);
  if (space !== "root" && !workspace) return null;
  // Vnořený slot (mission-control/db) potřebuje jméno z celé org-relativní
  // cesty, ne jen z basename ("Db").
  const nestedSegments = path.split("/").filter((segment) => !["workspace", "productionspace", "modules"].includes(segment));
  return {
    slug: basename(path),
    name: humanizeSlug(nestedSegments.join("-")),
    path,
    space,
    workspace,
    category: slot.category ?? null,
    default_access: slot.default_access ?? null,
    required_roles: Array.isArray(slot.required_roles) ? slot.required_roles : [],
    classification: slot.classification ?? null,
    launchpad_port: slot.launchpad_port ?? null,
    repo: slot.repo ?? slot.git?.url ?? null,
    branch: slot.branch ?? slot.git?.branch ?? null,
  };
}

function productionspaceSystems({ moduleSlots, productionspaceConfig }) {
  const productionSlots = moduleSlots.filter((slot) => slot.space === "productionspace");
  const byPath = new Map(productionSlots.map((slot) => [slot.path, slot]));
  const orderedPaths = Array.isArray(productionspaceConfig?.candidate_modules)
    ? productionspaceConfig.candidate_modules.map((path) => path.replace(/\\/g, "/"))
    : [];
  const ordered = orderedPaths.map((path) => byPath.get(path) ?? normalizeModuleSlot({ path, workspace: "productionspace" })).filter(Boolean);
  for (const slot of productionSlots) {
    if (!ordered.some((item) => item.path === slot.path)) ordered.push(slot);
  }
  return ordered;
}

function humanizeSlug(slug) {
  if (!slug) return "";
  return String(slug)
    .split(/[-_]/)
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function platformChecks(companiesRoot) {
  const platformName = supportedPlatforms[process.platform];
  const bunExecutable = resolveBunExecutable();
  const gitExecutable = resolveGitExecutableSync();
  return [
    {
      id: "platform.os",
      status: platformName ? "ok" : "fail",
      severity: "required",
      title: "Operační systém",
      message: platformName
        ? `${platformName} je podporovaný Launchpad GEN3 root OS.`
        : `Nepodporovaný OS ${process.platform}.`,
      paths: [],
      links: [],
      details: [`platform: ${process.platform}`, `arch: ${process.arch}`],
    },
    commandCheck({
      id: "platform.bun",
      title: "Bun runtime",
      command: bunExecutable,
      args: ["--version"],
      cwd: companiesRoot,
      okMessage: (result) => `Bun ${result.stdout} je dostupný jako ${bunExecutable}.`,
      failMessage: "Bun nebyl nalezen ani neprošel validací executable kandidáta.",
    }),
    commandCheck({
      id: "platform.git",
      title: "Git",
      command: gitExecutable,
      args: ["--version"],
      cwd: companiesRoot,
      okMessage: (result) => result.stdout,
      failMessage: "Git nebyl nalezen ani neprošel validací executable kandidáta.",
      env: safeGitCommandEnv(),
    }),
  ];
}

function commandCheck({ id, title, command, args, cwd, okMessage, failMessage, env }) {
  const result = command
    ? runCommand(command, args, { cwd, env })
    : {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "Executable resolver nevrátil žádného validního kandidáta.",
      };
  return {
    id,
    status: result.ok ? "ok" : "fail",
    severity: "required",
    title,
    message: result.ok ? okMessage(result) : failMessage,
    paths: [],
    links: [],
    details: result.ok
      ? [`command: ${command} ${args.join(" ")}`]
      : [`command: ${command ?? "<missing>"} ${args.join(" ")}`, result.stderr || result.error || "Příkaz selhal."],
  };
}

function gitRootCheck(companiesRoot) {
  const result = runGit(["rev-parse", "--show-toplevel"], companiesRoot);
  return {
    id: "git.root",
    status: result.ok ? "ok" : "fail",
    severity: "required",
    title: "Git root",
    message: result.ok ? `Git root: ${result.stdout}` : "Launchpad GEN3 root není použitelný Git repo.",
    paths: ["."],
    links: [],
    details: result.ok ? [] : [result.stderr || result.error || "git rev-parse selhal"],
  };
}

function gitWorktreeCheck(companiesRoot) {
  const result = runGit(["status", "--porcelain=v1"], companiesRoot);
  if (!result.ok) {
    return {
      id: "git.worktree",
      status: "fail",
      severity: "required",
      title: "Git worktree",
      message: "Git worktree stav nejde přečíst.",
      paths: ["."],
      links: [],
      details: [result.stderr || result.error || "git status selhal"],
    };
  }

  const dirtyLines = result.stdout.split("\n").filter(Boolean);
  return {
    id: "git.worktree",
    status: dirtyLines.length > 0 ? "warn" : "ok",
    severity: "local-state",
    title: "Git worktree",
    message: dirtyLines.length > 0
      ? `Working tree má ${formatCount(dirtyLines.length, "změnu", "změny", "změn")}.`
      : "Working tree je čistý.",
    paths: ["."],
    links: [],
    details: dirtyLines.slice(0, 20),
  };
}

// Anti-stuck check update kanálu (decision 0059, draft 0080). Read-only:
// čte jen lokální refs a config, NIKDY nefetchuje ani nemutuje — mutační
// update je samostatný guarded tool (/api/update), ne Doctor check.
export function updateChannelCheck(companiesRoot) {
  const base = {
    id: "update.channel",
    severity: "local-state",
    title: "Update kanál",
    paths: ["launchpad.gen3.local.json"],
    links: [],
  };

  let channel = "stable";
  let configState = "defaulted";
  const configPath = join(companiesRoot, "launchpad.gen3.local.json");
  if (existsSync(configPath)) {
    try {
      const configured = JSON.parse(readFileSync(configPath, "utf8"))?.update_channel;
      if (configured !== undefined && configured !== null && configured !== "") {
        if (UPDATE_CHANNELS.includes(configured)) {
          channel = configured;
          configState = "configured";
        } else {
          return {
            ...base,
            status: "warn",
            message: `Neplatný update_channel ${JSON.stringify(configured)}; platí stable. Povolené hodnoty: ${UPDATE_CHANNELS.join(", ")}.`,
            details: [],
          };
        }
      }
    } catch {
      return {
        ...base,
        status: "warn",
        message: "launchpad.gen3.local.json nejde přečíst jako JSON; update kanál platí stable.",
        details: [],
      };
    }
  }

  const branch = runGit(["branch", "--show-current"], companiesRoot);
  if (!branch.ok || branch.stdout !== "main") {
    return {
      ...base,
      status: "warn",
      message: branch.ok && branch.stdout
        ? `Root checkout je na branchi ${branch.stdout}, ne na main — update kanálu je zablokovaný.`
        : "Root checkout není na branchi main (detached HEAD nebo nečitelný stav) — update kanálu je zablokovaný.",
      details: ["Kontrakt: primární checkout zůstává na main; práce patří do worktrees (AGENTS.md)."],
    };
  }

  let targetSha = null;
  let targetLabel = null;
  if (channel === "nightly") {
    const originMain = runGit(["rev-parse", "--verify", "origin/main^{commit}"], companiesRoot);
    if (originMain.ok) {
      targetSha = originMain.stdout;
      targetLabel = "origin/main";
    }
  } else {
    const tags = runGit(["tag", "--list"], companiesRoot);
    const tag = tags.ok ? selectHighestStableTag(tags.stdout.split("\n").filter(Boolean)) : null;
    if (!tag) {
      return {
        ...base,
        status: "warn",
        message: "Stable kanál zatím nemá žádný release tag vMAJOR.MINOR.PATCH — update nemá cíl.",
        details: ["Kanál lze dočasně přepnout na nightly v launchpad.gen3.local.json."],
      };
    }
    const tagSha = runGit(["rev-parse", "--verify", `${tag}^{commit}`], companiesRoot);
    if (tagSha.ok) {
      targetSha = tagSha.stdout;
      targetLabel = tag;
    }
  }

  if (!targetSha) {
    return {
      ...base,
      status: "warn",
      message: `Cíl kanálu ${channel} nejde lokálně přečíst (poslední známý stav chybí).`,
      details: ["Doctor nefetchuje; stav se zpřesní po akci Aktualizovat nebo git fetch."],
    };
  }

  const relation = runGit(["rev-list", "--left-right", "--count", `HEAD...${targetSha}`], companiesRoot);
  if (!relation.ok) {
    return {
      ...base,
      status: "warn",
      message: `Vztah HEAD a cíle kanálu ${channel} (${targetLabel}) nejde ověřit.`,
      details: [relation.stderr || relation.error || "git rev-list selhal"],
    };
  }
  const [ahead, behind] = relation.stdout.split(/\s+/).map((value) => Number(value));
  if (ahead > 0 && behind > 0) {
    return {
      ...base,
      status: "warn",
      message: `Root se rozešel s cílem kanálu ${channel} (${targetLabel}): ${ahead} vlastních commitů, ${behind} chybějících.`,
      details: ["Fail-closed stav — vyřeš s Agentem; žádný reset --hard."],
    };
  }
  if (behind > 0) {
    return {
      ...base,
      status: "warn",
      message: `Kanál ${channel} má novější verzi (${targetLabel}); root je ${behind} commitů pozadu — spusť Aktualizovat.`,
      details: [],
    };
  }
  return {
    ...base,
    status: "ok",
    message: ahead > 0
      ? `Kanál ${channel} (${configState === "defaulted" ? "default" : "nastaveno"}): root je ${ahead} commitů před posledním známým cílem (${targetLabel}) — žádný downgrade se neprovádí.`
      : `Kanál ${channel} (${configState === "defaulted" ? "default" : "nastaveno"}): root odpovídá poslednímu známému cíli (${targetLabel}).`,
    details: [],
  };
}

function gitSubmodulesCheck(companiesRoot) {
  const paths = gitmodulePaths(companiesRoot);
  if (paths.length === 0) {
    return {
      id: "git.submodules",
      status: "ok",
      severity: "required",
      title: "Git submoduly",
      message: "Workspace nemá deklarované submoduly.",
      paths: [".gitmodules"],
      links: [],
      details: [],
    };
  }

  const failures = [];
  const warnings = [];
  for (const path of paths) {
    const absolutePath = join(companiesRoot, path);
    if (!existsSync(absolutePath)) {
      failures.push(`${path}: chybí mountpoint`);
      continue;
    }
    const repoCheck = runGit(["rev-parse", "--is-inside-work-tree"], absolutePath);
    if (!repoCheck.ok || repoCheck.stdout !== "true") {
      failures.push(`${path}: není použitelný Git checkout`);
      continue;
    }
    const status = runGit(["status", "--porcelain=v1"], absolutePath);
    if (!status.ok) {
      failures.push(`${path}: nejde přečíst git status`);
      continue;
    }
    const dirtyLines = status.stdout.split("\n").filter(Boolean);
    if (dirtyLines.length > 0) {
      warnings.push(`${path}: ${formatCount(dirtyLines.length, "změna", "změny", "změn")}`);
    }
  }

  return {
    id: "git.submodules",
    status: failures.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "ok",
    severity: "required",
    title: "Git submoduly",
    message:
      failures.length > 0
        ? "Některé deklarované submoduly nejsou použitelné."
        : warnings.length > 0
          ? "Některé deklarované submoduly mají lokální změny."
          : `Submoduly jsou použitelné: ${paths.length}`,
    paths: [".gitmodules", ...paths],
    links: [],
    details: [...failures, ...warnings],
  };
}

function gitRepoMountsCheck(companiesRoot, repoMounts) {
  if (repoMounts.length === 0) {
    return {
      id: "git.mounts",
      status: "ok",
      severity: "required",
      title: "Organization Git mountpointy",
      message: "V launchpad.gen3.json nejsou deklarované žádné organization mountpointy.",
      paths: ["launchpad.gen3.json"],
      links: [],
      details: [],
    };
  }

  const failures = [];
  for (const mount of repoMounts) {
    const absolutePath = join(companiesRoot, mount.path);
    if (!existsSync(absolutePath)) {
      failures.push(`${mount.path}: chybí ${mount.kind}`);
      continue;
    }
    const result = runGit(["rev-parse", "--is-inside-work-tree"], absolutePath);
    if (!result.ok || result.stdout !== "true") {
      failures.push(`${mount.path}: ${mount.kind} není Git checkout`);
    }
  }

  return {
    id: "git.mounts",
    status: failures.length > 0 ? "fail" : "ok",
    severity: "required",
    title: "Organization Git mountpointy",
    message: failures.length > 0
      ? "Některé organization mountpointy nejsou Git checkouty."
      : `Organization mountpointy jsou Git checkouty: ${repoMounts.length}`,
    paths: ["launchpad.gen3.json", ...repoMounts.map((mount) => mount.path)],
    links: [],
    details: failures,
  };
}

function gitignoreProtectionCheck(companiesRoot, repoMounts) {
  const failures = [];
  for (const path of rootGitignoreProbePaths) {
    if (!isIgnored(companiesRoot, path)) {
      failures.push(`root: ${path} není chráněné .gitignore`);
    }
  }

  for (const mount of repoMounts) {
    if (mount.kind !== "organization") continue;
    const absolutePath = join(companiesRoot, mount.path);
    if (!existsSync(absolutePath)) continue;
    for (const path of companyGitignoreProbePaths) {
      if (!isIgnored(absolutePath, path)) {
        failures.push(`${mount.path}: ${path} není chráněné .gitignore`);
      }
    }
  }

  return {
    id: "gitignore.protection",
    status: failures.length > 0 ? "fail" : "ok",
    severity: "required",
    title: ".gitignore ochrana",
    message: failures.length > 0
      ? "Některé runtime, log, private nebo archive cesty nejsou chráněné."
      : ".gitignore chrání runtime, log, private a archive cesty.",
    paths: [".gitignore", ...repoMounts.map((mount) => `${mount.path}/.gitignore`)],
    links: [],
    details: failures,
  };
}

function uniqueRepoMounts({ companies, templateMounts = [] }) {
  const mounts = [];
  const seen = new Set();
  for (const company of companies) {
    // Planned Organizace (decision 0024) ještě nemá mount; Git kontroly ji přeskakují.
    if (company.status === "planned") continue;
    addMount(mounts, seen, {
      kind: "organization",
      path: company.path,
    });
  }
  // Module šablony (templates/*/*) se do Git mount gate úmyslně NEpřidávají — jsou
  // informační (scan-first, decision 0042), ne vynucené required-for-first-client
  // mounty. Marker template mounty (organization_kind=template) naopak drží stejné
  // Git mount gates jako firma — musí být řádný Git checkout — ale nepočítají se jako org.
  for (const mount of templateMounts) {
    if (mount.status === "planned") continue;
    addMount(mounts, seen, {
      kind: "organization template",
      template_type: "organization",
      path: mount.path,
    });
  }
  return mounts;
}

function addMount(mounts, seen, mount) {
  if (!mount.path || seen.has(mount.path)) return;
  seen.add(mount.path);
  mounts.push(mount);
}

function gitmodulePaths(cwd) {
  if (!existsSync(join(cwd, ".gitmodules"))) return [];
  const result = runGit(["config", "--file", ".gitmodules", "--get-regexp", "path"], cwd);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).at(-1))
    .filter(Boolean);
}

function isIgnored(cwd, path) {
  return runGit(["check-ignore", "-q", "--", path], cwd).ok;
}

function runGit(args, cwd) {
  const executable = resolveGitExecutableSync();
  if (!executable) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "Git executable was not found or failed validation.",
    };
  }
  return runCommand(executable, args, { cwd, env: safeGitCommandEnv() });
}

function runCommand(command, args, { cwd, env } = {}) {
  try {
    const result = Bun.spawnSync([command, ...args], {
      cwd,
      ...(env ? { env } : {}),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      timeout: GIT_LOCAL_TIMEOUT_MS,
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: decodeOutput(result.stdout).trim(),
      stderr: decodeOutput(result.stderr).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: error.message,
    };
  }
}

function decodeOutput(output) {
  if (!output) return "";
  return new TextDecoder().decode(output);
}

function skippedCheck({ id, title, message, paths }) {
  return {
    id,
    status: "skip",
    severity: "required",
    title,
    message,
    paths,
    links: [],
    details: [],
  };
}

function workspaceSummary(companiesConfig) {
  const workspace = companiesConfig?.launchpad_root ?? companiesConfig?.companies_workspace ?? {};
  return {
    slug: workspace.slug ?? "unknown",
    display_name: workspace.display_name ?? "Launchpad GEN3 root",
    root_role: workspace.root_role ?? "launchpad-root",
  };
}

function discoveryCheck(appsResponse) {
  const warningCount = appsResponse.warnings?.length ?? 0;
  const status = appsResponse.failures.length > 0 ? "fail" : warningCount > 0 ? "warn" : "ok";
  // Template mounty jsou validované, ale mimo runtime/business/counts. V Doctor
  // reportu je jen označíme jako template, ať je jasné, že mount existuje a prošel
  // gates, ale záměrně se nespouští a nepočítá se do org přehledů.
  const templateMounts = appsResponse.template_mounts ?? [];
  const templateDetails = templateMounts.map(
    (mount) => `template mount ${mount.path ?? mount.slug} (organization_kind=template): validovaný, mimo runtime/business/counts`,
  );
  return {
    id: "launchpad.discovery",
    status,
    severity: "required",
    title: "Launchpad discovery",
    message:
      status === "ok"
        ? `Launchpad discovery našel ${formatCount(appsResponse.apps.length, "aplikaci", "aplikace", "aplikací")}`
        : status === "warn"
          ? `Launchpad discovery našel ${formatCount(appsResponse.apps.length, "aplikaci", "aplikace", "aplikací")} s ${formatCount(warningCount, "varováním", "varováními", "varováními")}`
          : "Launchpad discovery kontroly selhaly",
    paths: ["launchpad.gen3.json", "launchpad", "organizations"],
    links: [],
    details: [...appsResponse.failures, ...(appsResponse.warnings ?? []), ...templateDetails],
  };
}

// Doctor kontrola manifest-declared Workspace groupingu (decision 0041): hlásí
// konflikty deklarace vs. realita a shrnuje readiness stavy module slotů
// (available / missing_access / planned_slot, decision 0042).
function workspaceDeclarationCheck(appsResponse) {
  const details = [];
  const statusCounts = { available: 0, missing_access: 0, planned_slot: 0 };
  let conformanceIssueCount = 0;
  let blockingSlotCount = 0;
  for (const organization of appsResponse.organizations ?? []) {
    for (const issue of organization.workspace_conformance_issues ?? []) {
      details.push(`${organization.path}: ${issue}`);
      conformanceIssueCount += 1;
    }
    const slots = Array.isArray(organization.module_declarations)
      ? organization.module_declarations
      : [
          ...(organization.workspaces ?? []).flatMap((workspace) => workspace.modules ?? []),
          ...(organization.productionspace?.systems ?? []),
        ];
    for (const slot of slots) {
      if (slot.status && statusCounts[slot.status] !== undefined) statusCounts[slot.status] += 1;
      if (slot.readiness?.severity === "blocking") {
        blockingSlotCount += 1;
        details.push(`${organization.path}/${slot.path}: ${slot.readiness.message}`);
      }
    }
  }
  details.push(
    `module slots: available ${statusCounts.available}, missing_access ${statusCounts.missing_access}, planned_slot ${statusCounts.planned_slot}`,
  );
  return {
    id: "launchpad.workspace_declarations",
    status: blockingSlotCount > 0 ? "fail" : conformanceIssueCount > 0 ? "warn" : "ok",
    severity: "required",
    title: "Workspace deklarace",
    message:
      blockingSlotCount > 0
        ? `Manifestované sloty mají ${formatCount(blockingSlotCount, "blokátor", "blokátory", "blokátorů")}.`
        : conformanceIssueCount > 0
        ? `Manifest deklarace mají ${formatCount(conformanceIssueCount, "konflikt", "konflikty", "konfliktů")} s decision 0041.`
        : "Workspace grouping jede z manifest deklarací (decision 0041).",
    paths: ["organizations"],
    links: [],
    details,
  };
}

function runtimeChecks(appsResponse) {
  if (appsResponse.failures.length > 0) {
    return [
      {
        id: "launchpad.runtime",
        status: "skip",
        severity: "runtime",
        title: "Launchpad runtime",
        message: "Runtime diagnostika se přeskočila, protože discovery není validní.",
        paths: ["launchpad"],
        links: [],
        details: [],
      },
    ];
  }

  return [
    runtimeSummaryCheck(appsResponse.apps),
    ...appsResponse.apps.map(runtimeAppCheck),
  ];
}

function runtimeSummaryCheck(apps) {
  const counts = countBy(apps.map((app) => app.runtime_status ?? "unknown"));
  const status = apps.some((app) => runtimeAppStatus(app) === "fail")
    ? "fail"
    : apps.some((app) => runtimeAppStatus(app) === "warn")
      ? "warn"
      : "ok";
  return {
    id: "launchpad.runtime",
    status,
    severity: "runtime",
    title: "Launchpad runtime",
    message: `Runtime: ${runtimeCountMessage(counts)}`,
    paths: ["launchpad/runtime", "launchpad/logs"],
    links: [],
    details: [],
  };
}

function runtimeAppCheck(app) {
  const runtime = app.runtime ?? {};
  const dependencies = app.dependencies ?? runtime.dependencies ?? {};
  return {
    id: `launchpad.runtime.${app.id}`,
    status: runtimeAppStatus(app),
    severity: "runtime",
    title: app.title,
    message: dependencies.state && dependencies.state !== "ready"
      ? dependencies.message
      : (runtime.message ?? runtimeLabel(runtime.status)),
    paths: [app.package_path, runtime.log_path].filter(Boolean),
    links: [],
    details: [
      `status: ${runtime.status ?? "unknown"}`,
      `dependency: ${dependencies.state ?? "unknown"}`,
      `install: ${dependencies.install_command_display ?? "-"}`,
      `owner: ${runtime.owner ?? "unknown"}`,
      `pid: ${runtime.pid ?? "-"}`,
      `port: ${app.port ?? "-"}`,
      `health: ${app.health_url ?? "-"}`,
    ],
  };
}

export function runtimeAppStatus(app) {
  const runtime = app.runtime ?? {};
  const dependencyState = app.dependencies?.state ?? runtime.dependencies?.state;
  // Port ownership is a safety boundary and must outrank dependency warnings.
  // Otherwise a foreign checkout with local needs_install/stale_lockfile state
  // would be downgraded from a hard failure to a warning.
  if (runtime.owner === "unknown-port" || runtime.owner === "foreign-port") return "fail";
  // Nevalidní manifest je scoped attention stav (decision 0043), ne root fail.
  if (dependencyState === "invalid_manifest") return "warn";
  if (dependencyState === "missing_package" || dependencyState === "unknown_package_manager") return "fail";
  if (dependencyState === "needs_install" || dependencyState === "stale_lockfile") return "warn";
  if (runtime.status === "unhealthy") return "warn";
  if (runtime.status === "starting" || runtime.status === "unknown") return "warn";
  return "ok";
}

function summarizeChecks(checks) {
  const summary = { status: "ok", ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) {
    summary[check.status] = (summary[check.status] ?? 0) + 1;
  }
  if (summary.fail > 0) summary.status = "fail";
  else if (summary.warn > 0) summary.status = "warn";
  else summary.status = "ok";
  return summary;
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function runtimeCountMessage(counts) {
  const order = ["healthy", "starting", "stopped", "unhealthy", "unknown"];
  return order
    .filter((status) => counts[status] > 0)
    .map((status) => `${status}: ${counts[status]}`)
    .join(", ") || "žádné aplikace";
}

function runtimeLabel(status) {
  return (
    {
      healthy: "Aplikace odpovídá.",
      starting: "Aplikace startuje.",
      stopped: "Aplikace neběží.",
      unhealthy: "Aplikace je v runtime problému.",
      unknown: "Runtime stav není známý.",
    }[status] ?? "Runtime stav není známý."
  );
}

function formatCount(count, one, few, many) {
  if (count === 1) return `${count} ${one}`;
  if (count >= 2 && count <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}
