import { constants, existsSync, lstatSync, realpathSync } from "fs";
import { open, readFile } from "fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "path";
import { buildDoctorReportFromAppsResponse, buildLaunchpadAppsResponse } from "./diagnostics-lib.mjs";
import {
  GitApiError,
  buildGitApiResponse,
  buildPlansResponse,
  buildPullAllResponse,
  buildRepoAutostashPullResponse,
  buildRepoChangesResponse,
  buildRepoPullResponse,
  buildRepoResponse,
  buildWorktreesResponse,
} from "./git-api-lib.mjs";
import { RuntimeActionError, createRuntimeManager } from "./runtime-lib.mjs";
import { createGitStatusService } from "./git-status-lib.mjs";
import { performRootUpdate, readRootUpdateStatus } from "./update-lib.mjs";
import { WorktreeActionError, createWorktreeFromPlan, publishWorktreeDraft } from "./worktree-actions-lib.mjs";
import { buildRecentModuleChanges } from "./recent-changes-lib.mjs";
import { buildMostUsedApps } from "./usage-lib.mjs";
import {
  buildPersonalspaceResponse,
  createPersonalspaceRuntimeManager,
  personalspaceDoctorCheck,
  resolveSpaceGbrainVault,
} from "./personalspace-runtime-lib.mjs";
import { GbrainAccessError, gbrainFile, gbrainSearch, gbrainTree } from "./gbrain-lib.mjs";
import { readOrganizationLaunchpadTheme } from "./organization-theme-lib.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 4174;
const allowedHosts = new Set(["127.0.0.1", "localhost"]);
const safeApiMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const launchpadRoot = join(import.meta.dirname, "..");
const publicRoot = join(launchpadRoot, "public");
const options = parseArgs(Bun.argv.slice(2));
const companiesRoot = resolve(options.root ?? join(launchpadRoot, ".."));
const host = options.host ?? defaultHost;
const port = Number(options.port ?? process.env.PORT ?? defaultPort);
const principalEmail = resolvePrincipalEmail();
const runtimeManager = createRuntimeManager({ companiesRoot, launchpadRoot });
const gitStatusService = createGitStatusService();
const organizationLogoCandidates = [
  "launchpad/app/v1/web/launchpad-icon.png",
  "launchpad/app/v1/web/logo-square.png",
  "launchpad/app/v1/web/favicon.svg",
  "launchpad/app/v1/web/favicon.png",
];
const maxOrganizationLogoBytes = 2 * 1024 * 1024;
let organizationLogoPaths = new Map();
// Personalspace lane (CAC-0048): úplně oddělený runtime manager pro osobní
// aplikace. Local-only (server běží jen na 127.0.0.1). Osobní data se nikdy
// nepropisují do org /api/apps ani /api/doctor shared výstupu.
const personalspaceRuntimeManager = createPersonalspaceRuntimeManager({ companiesRoot, launchpadRoot });

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error(`Neplatný port: ${options.port ?? process.env.PORT}`);
  process.exit(1);
}

if (!allowedHosts.has(host)) {
  console.error(`Neplatný host: ${host}. Launchpad v1 smí běžet jen na 127.0.0.1 nebo localhost.`);
  process.exit(1);
}

const server = startServer(port);

const serverUrl = `http://${host}:${server.port}`;
console.log(`Launchpad GEN3 běží na ${serverUrl}`);
console.log(`Launchpad GEN3 root: ${companiesRoot}`);

if (options.open) {
  openBrowser(serverUrl);
}

setInterval(() => {}, 2_147_483_647);

async function buildAppsResponse() {
  const response = await buildLaunchpadAppsResponse({
    companiesRoot,
    launchpadRoot,
    runtimeManager,
    gitStatusService,
  });
  const nextLogoPaths = new Map();
  await Promise.all((response.organizations ?? []).map(async (organization) => {
    const [logoPath, theme] = await Promise.all([
      Promise.resolve(resolveOrganizationLogoPath(organization)),
      readOrganizationLaunchpadTheme({ companiesRoot, organization }),
    ]);
    if (logoPath) {
      organization.logo_url = `/api/organizations/${encodeURIComponent(organization.slug)}/logo`;
      nextLogoPaths.set(organization.slug, logoPath);
    }
    if (theme) organization.theme = theme;
  }));
  organizationLogoPaths = nextLogoPaths;
  return response;
}

function resolveOrganizationLogoPath(organization) {
  if (!organization?.path) return null;
  const organizationRoot = resolve(companiesRoot, organization.path);
  let realOrganizationRoot;
  try {
    realOrganizationRoot = realpathSync(organizationRoot);
  } catch {
    return null;
  }
  for (const candidate of organizationLogoCandidates) {
    const logoPath = resolve(organizationRoot, candidate);
    try {
      const logoStats = lstatSync(logoPath);
      if (!logoStats.isFile() || logoStats.isSymbolicLink() || logoStats.size > maxOrganizationLogoBytes) continue;
      const realLogoPath = realpathSync(logoPath);
      const relativePath = relative(realOrganizationRoot, realLogoPath);
      if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
        return realLogoPath;
      }
    } catch {
      // Chybějící nebo nečitelný asset není blokátor; zkus další kandidát.
    }
  }
  return null;
}

async function serveOrganizationLogo(request, url, slug) {
  if (!isTrustedLocalRequest(request, url)) {
    return jsonResponse({ error: "cross_origin_logo_request_forbidden" }, 403);
  }
  const logoPath = organizationLogoPaths.get(slug);
  if (!logoPath) return notFound();
  let logoFile;
  try {
    const logoStats = lstatSync(logoPath);
    if (!logoStats.isFile() || logoStats.isSymbolicLink()) return notFound();
    logoFile = await open(logoPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await logoFile.stat();
    if (!openedStats.isFile() || openedStats.size > maxOrganizationLogoBytes) return notFound();
    const logoBytes = await logoFile.readFile();
    return new Response(logoBytes, {
      headers: {
        "content-type": contentType(logoPath),
        "cache-control": "no-store",
        "content-security-policy": "sandbox",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return notFound();
  } finally {
    await logoFile?.close();
  }
}

function isTrustedLocalRequest(request, url) {
  if (!allowedHosts.has(url.hostname)) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  if (origin && origin !== url.origin) return false;
  return true;
}

function isMutatingApiRequest(request, url) {
  return url.pathname.startsWith("/api/") && !safeApiMethods.has(request.method);
}

async function buildDoctorReport() {
  // Personalspace doctor check je metadata-only a osobní aplikace se nikdy
  // nemíchají do org appsResponse (CAC-0048).
  const [appsResponse, personalspaceResponse] = await Promise.all([
    buildAppsResponse(),
    buildPersonalspace(),
  ]);
  return buildDoctorReportFromAppsResponse(appsResponse, {
    extraChecks: [personalspaceDoctorCheck(personalspaceResponse)],
  });
}

async function buildPersonalspace() {
  return buildPersonalspaceResponse({
    companiesRoot,
    launchpadRoot,
    runtimeManager: personalspaceRuntimeManager,
    profileEmail: principalEmail,
  });
}

function resolvePrincipalEmail() {
  try {
    const result = Bun.spawnSync(["git", "config", "user.email"], {
      cwd: companiesRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
    });
    if (result.exitCode !== 0) return null;
    const email = new TextDecoder().decode(result.stdout).trim();
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

// Panel „Poslední změny" (CAC-0044, step-006): per-modul poslední commity.
// Read-only, bounded git log; staví nad discovery apps z /api/apps.
async function buildRecentChangesResponse(company = null) {
  const appsResponse = await buildAppsResponse();
  const apps = company ? appsResponse.apps.filter((app) => app.company === company) : appsResponse.apps;
  return buildRecentModuleChanges({ companiesRoot, apps });
}

// Panel „Nejčastější" (CAC-0044, step-007): lokální usage tracking mimo Git.
async function buildMostUsedResponse(company = null) {
  const appsResponse = await buildAppsResponse();
  const apps = company ? appsResponse.apps.filter((app) => app.company === company) : appsResponse.apps;
  return buildMostUsedApps({ launchpadRoot, apps });
}

async function serveStatic(pathname) {
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const absolutePath = resolve(publicRoot, requestedPath);
  const relativePath = relative(publicRoot, absolutePath);
  if (relativePath.startsWith("..") || relativePath === "" || normalize(relativePath).startsWith("..")) {
    return notFound();
  }

  if (!existsSync(absolutePath)) return notFound();
  return new Response(await readFile(absolutePath), {
    headers: {
      "content-type": contentType(absolutePath),
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound() {
  return jsonResponse({ error: "not_found" }, 404);
}

function runtimeErrorResponse(error) {
  if (error instanceof RuntimeActionError) {
    return jsonResponse(
      {
        error: error.code,
        message: error.message,
        details: error.details,
        ...error.metadata,
      },
      error.status,
    );
  }
  return jsonResponse({ error: "launchpad_error", message: error.message }, 500);
}

function apiErrorResponse(error) {
  if (error instanceof WorktreeActionError) {
    return jsonResponse({ error: error.code, message: error.message, details: error.details ?? [] }, error.status);
  }
  if (error instanceof GitApiError) {
    return jsonResponse({ error: error.code, message: error.message }, error.status);
  }
  return jsonResponse({ error: "launchpad_error", message: error.message }, 500);
}

function contentType(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--open") {
      parsed.open = true;
      continue;
    }
    if (arg.startsWith("--port=")) {
      parsed.port = arg.slice("--port=".length);
      continue;
    }
    if (arg === "--port") {
      parsed.port = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      parsed.host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--host") {
      parsed.host = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      parsed.root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--root") {
      parsed.root = args[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function openBrowser(url) {
  const commands = {
    darwin: ["open", url],
    win32: ["cmd", "/c", "start", "", url],
    linux: ["xdg-open", url],
  };
  const command = commands[process.platform];
  if (!command) return;
  Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
  });
}

function appRuntimeRoute(pathname) {
  const match = pathname.match(/^\/api\/apps\/([^/]+)\/(health|install|repair|start|open|stop|restart|logs)$/);
  if (!match) return null;
  return {
    appId: decodeURIComponent(match[1]),
    action: match[2],
  };
}

// Personalspace runtime akce (CAC-0048) — stejné akce jako org, ale přes
// oddělený personalspace runtime manager. Osobní app id má prefix personal--.
function personalAppRuntimeRoute(pathname) {
  const match = pathname.match(/^\/api\/personalspace\/apps\/([^/]+)\/(health|install|repair|start|stop|restart|logs|open)$/);
  if (!match) return null;
  return {
    appId: decodeURIComponent(match[1]),
    action: match[2],
  };
}

// Gbrain read-only browser API (CAC-0048) — BOUNDED na vault daného prostoru.
// Local-only (server běží jen na 127.0.0.1). Žádný obsah do logů.
function gbrainRoute(pathname) {
  const match = pathname.match(/^\/api\/personalspace\/([^/]+)\/gbrain\/(tree|note|search)$/);
  if (!match) return null;
  return {
    space: decodeURIComponent(match[1]),
    resource: match[2],
  };
}

function gbrainErrorResponse(error) {
  if (error instanceof GbrainAccessError) {
    return jsonResponse({ error: error.code, message: error.message }, error.status);
  }
  return jsonResponse({ error: "gbrain_error", message: error.message }, 500);
}

async function handleGbrainRoute(request, url, route) {
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
  try {
    const vault = await resolveSpaceGbrainVault({ companiesRoot, spaceDirName: route.space });
    if (route.resource === "tree") {
      return jsonResponse({ space: route.space, source_rel: vault.source_rel, mode: vault.mode, ...(await gbrainTree(vault.vaultRoot)) });
    }
    if (route.resource === "note") {
      const path = url.searchParams.get("path");
      if (!path) return jsonResponse({ error: "missing_path", message: "Chybí parametr path." }, 400);
      return jsonResponse({ space: route.space, ...(await gbrainFile(vault.vaultRoot, path)) });
    }
    if (route.resource === "search") {
      const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      return jsonResponse({ space: route.space, ...(await gbrainSearch(vault.vaultRoot, query)) });
    }
    return notFound();
  } catch (error) {
    return gbrainErrorResponse(error);
  }
}

async function handlePersonalRuntimeRoute(request, route) {
  try {
    if (route.action === "health" && (request.method === "GET" || request.method === "POST")) {
      return jsonResponse(await personalspaceRuntimeManager.health(route.appId));
    }
    if (route.action === "logs" && request.method === "GET") {
      return jsonResponse(await personalspaceRuntimeManager.logs(route.appId));
    }
    if ((route.action === "install" || route.action === "repair") && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.install(route.appId, { action: route.action }));
    }
    if (route.action === "start" && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.start(route.appId));
    }
    // One-click open chain (ensure install → ensure start → wait healthy → URL)
    // v oddělené personalspace lane — GEN2-minimal dlaždice ho volá klikem na
    // celou kartu (stejný kontrakt jako firemní /api/apps/<id>/open).
    if (route.action === "open" && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.open(route.appId));
    }
    if (route.action === "stop" && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.stop(route.appId));
    }
    if (route.action === "restart" && request.method === "POST") {
      return jsonResponse(await personalspaceRuntimeManager.restart(route.appId));
    }
    return jsonResponse({ error: "method_not_allowed" }, 405);
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}

function gitApiRoute(pathname) {
  if (pathname === "/api/git/repos") return { kind: "repos" };
  if (pathname === "/api/git/pull-all") return { kind: "pull_all" };
  if (pathname === "/api/git/worktrees") return { kind: "worktrees" };
  if (pathname === "/api/mission-control/plans") return { kind: "plans" };
  const createWorktreeMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/worktrees\/create$/);
  if (createWorktreeMatch) return { kind: "create_worktree", repoKey: decodeURIComponent(createWorktreeMatch[1]) };
  const publishWorktreeMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/worktrees\/([^/]+)\/publish$/);
  if (publishWorktreeMatch) {
    return {
      kind: "publish_worktree",
      repoKey: decodeURIComponent(publishWorktreeMatch[1]),
      slug: decodeURIComponent(publishWorktreeMatch[2]),
    };
  }
  const changesMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/changes$/);
  if (changesMatch) return { kind: "repo_changes", repoKey: decodeURIComponent(changesMatch[1]) };
  const autostashPullMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/pull-autostash$/);
  if (autostashPullMatch) return { kind: "repo_autostash_pull", repoKey: decodeURIComponent(autostashPullMatch[1]) };
  const pullMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)\/pull$/);
  if (pullMatch) return { kind: "repo_pull", repoKey: decodeURIComponent(pullMatch[1]) };
  const repoMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)$/);
  if (repoMatch) return { kind: "repo", repoKey: decodeURIComponent(repoMatch[1]) };
  return null;
}

async function handleGitApiRoute(request, url, route) {
  try {
    if (route.kind === "create_worktree") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      const payload = await jsonRequestPayload(request, "worktree_create_request");
      return jsonResponse(
        await createWorktreeFromPlan({
          companiesRoot,
          repoKey: route.repoKey,
          planPath: payload.planPath,
          branch: payload.branch,
          createdBy: payload.createdBy,
        }),
      );
    }
    if (route.kind === "publish_worktree") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      const payload = await jsonRequestPayload(request, "worktree_publish_request");
      return jsonResponse(
        await publishWorktreeDraft({
          companiesRoot,
          repoKey: route.repoKey,
          slug: route.slug,
          commitMessage: payload.commitMessage,
          publisher: payload.publisher,
        }),
      );
    }
    if (route.kind === "repo_pull") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      return jsonResponse(await gitStatusService.withRemoteRefreshPaused(() =>
        buildRepoPullResponse({ companiesRoot, repoKey: route.repoKey, statusService: gitStatusService })));
    }
    if (route.kind === "repo_autostash_pull") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      return jsonResponse(await gitStatusService.withRemoteRefreshPaused(() =>
        buildRepoAutostashPullResponse({ companiesRoot, repoKey: route.repoKey, statusService: gitStatusService })));
    }
    if (route.kind === "pull_all") {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      return jsonResponse(await gitStatusService.withRemoteRefreshPaused(() =>
        buildPullAllResponse({ companiesRoot, statusService: gitStatusService })));
    }
    if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
    if (route.kind === "repos") {
      return jsonResponse(await buildGitApiResponse({
        companiesRoot,
        organization: url.searchParams.get("company"),
        refresh: url.searchParams.get("refresh") === "1",
        statusService: gitStatusService,
      }));
    }
    if (route.kind === "repo") {
      return jsonResponse(
        await buildRepoResponse({
          companiesRoot,
          repoKey: route.repoKey,
          refresh: url.searchParams.get("refresh") === "1",
          statusService: gitStatusService,
        }),
      );
    }
    if (route.kind === "repo_changes") {
      return jsonResponse(await buildRepoChangesResponse({ companiesRoot, repoKey: route.repoKey }));
    }
    if (route.kind === "worktrees") {
      return jsonResponse(
        await buildWorktreesResponse({
          companiesRoot,
          organization: url.searchParams.get("organization"),
          module: url.searchParams.get("module"),
        }),
      );
    }
    if (route.kind === "plans") {
      return jsonResponse(
        await buildPlansResponse({
          companiesRoot,
          organization: url.searchParams.get("organization"),
          module: url.searchParams.get("module"),
        }),
      );
    }
    return notFound();
  } catch (error) {
    return apiErrorResponse(error);
  }
}

async function jsonRequestPayload(request, code) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new WorktreeActionError("Request body musí být application/json.", { status: 400, code: `invalid_${code}` });
  }
  const text = await request.text();
  try {
    const payload = JSON.parse(text || "{}");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be object");
    return payload;
  } catch {
    throw new WorktreeActionError("Request body musí být validní JSON object.", { status: 400, code: `invalid_${code}` });
  }
}

async function handleRuntimeRoute(request, route) {
  try {
    const runtimeOptions = request.method === "POST" ? await runtimeRequestOptions(request) : {};
    if (route.action === "health" && (request.method === "GET" || request.method === "POST")) {
      return jsonResponse(await runtimeManager.health(route.appId, runtimeOptions));
    }
    if (route.action === "logs" && request.method === "GET") {
      return jsonResponse(await runtimeManager.logs(route.appId));
    }
    if ((route.action === "install" || route.action === "repair") && request.method === "POST") {
      return jsonResponse(await runtimeManager.install(route.appId, { action: route.action, ...runtimeOptions }));
    }
    if (route.action === "start" && request.method === "POST") {
      return jsonResponse(await runtimeManager.start(route.appId, runtimeOptions));
    }
    // One-click builder chain (CAC-0044): ensure install → ensure start → URL.
    if (route.action === "open" && request.method === "POST") {
      return jsonResponse(await runtimeManager.open(route.appId, runtimeOptions));
    }
    if (route.action === "stop" && request.method === "POST") {
      return jsonResponse(await runtimeManager.stop(route.appId, runtimeOptions));
    }
    if (route.action === "restart" && request.method === "POST") {
      return jsonResponse(await runtimeManager.restart(route.appId, runtimeOptions));
    }
    return jsonResponse({ error: "method_not_allowed" }, 405);
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}

async function runtimeRequestOptions(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  const text = await request.text();
  if (!text.trim()) return {};
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new RuntimeActionError(400, "invalid_runtime_request", "Runtime request body musí být validní JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload.source ? { source: payload.source } : {};
}

function startServer(startPort) {
  return Bun.serve({
    hostname: host,
    port: startPort,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (url.pathname.startsWith("/api/personalspace") && !isTrustedLocalRequest(request, url)) {
          return jsonResponse({ error: "personalspace_request_forbidden" }, 403);
        }
        if (isMutatingApiRequest(request, url) && !isTrustedLocalRequest(request, url)) {
          return jsonResponse({ error: "mutating_request_forbidden" }, 403);
        }
        // Personalspace lane (CAC-0048) — kontroluj PŘED generickými /api/apps
        // a /api/... routami, ať se osobní prostor nikdy nesmíchá s org lane.
        const personalRuntimeRoute = personalAppRuntimeRoute(url.pathname);
        if (personalRuntimeRoute) return handlePersonalRuntimeRoute(request, personalRuntimeRoute);
        const gbrainMatch = gbrainRoute(url.pathname);
        if (gbrainMatch) return handleGbrainRoute(request, url, gbrainMatch);
        if (url.pathname === "/api/personalspace") return jsonResponse(await buildPersonalspace());
        const organizationLogoMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/logo$/);
        if (organizationLogoMatch) {
          return serveOrganizationLogo(request, url, decodeURIComponent(organizationLogoMatch[1]));
        }

        const runtimeRoute = appRuntimeRoute(url.pathname);
        if (runtimeRoute) return handleRuntimeRoute(request, runtimeRoute);
        const gitRoute = gitApiRoute(url.pathname);
        if (gitRoute) return handleGitApiRoute(request, url, gitRoute);
        // Update lane Conglomerate rootu (decision 0059, draft 0080): oddělená
        // od org git inventáře; mutace jde přes trusted-local guard výše a
        // serializuje se s background fetchi přes withRemoteRefreshPaused.
        // I GET status je trusted-local: dělá git fetch (síť + credentials),
        // cizí origin ho nesmí spouštět ani jako drive-by bez čtení odpovědi.
        if (url.pathname.startsWith("/api/update") && !isTrustedLocalRequest(request, url)) {
          return jsonResponse({ error: "update_request_forbidden" }, 403);
        }
        if (url.pathname === "/api/update/status" && request.method === "GET") {
          return jsonResponse(await gitStatusService.withRemoteRefreshPaused(() =>
            readRootUpdateStatus({ rootPath: companiesRoot })));
        }
        if (url.pathname === "/api/update" && request.method === "POST") {
          const payload = await request.json().catch(() => ({}));
          const result = await gitStatusService.withRemoteRefreshPaused(() =>
            performRootUpdate({ rootPath: companiesRoot, mode: payload?.mode ?? "ff_only" }));
          return jsonResponse(result, result.ok ? 200 : 409);
        }
        if (url.pathname === "/api/apps") return jsonResponse(await buildAppsResponse());
        // Synchronizovat (decision 0042): znovu projede lokální auto-discovery
        // organizations/*/company.gen3.json bez ruční editace root manifestu.
        // Nový lokální mount (git clone / doctor sync) se objeví bez restartu.
        if (url.pathname === "/api/sync" && request.method === "POST") {
          const response = await buildAppsResponse();
          return jsonResponse({
            action: "sync",
            synced_at: response.generated_at,
            ...response,
          });
        }
        if (url.pathname === "/api/doctor") return jsonResponse(await buildDoctorReport());
        if (url.pathname === "/api/recent-changes") return jsonResponse(await buildRecentChangesResponse(url.searchParams.get("company")));
        if (url.pathname === "/api/most-used") return jsonResponse(await buildMostUsedResponse(url.searchParams.get("company")));
        if (url.pathname === "/health") return jsonResponse({ status: "ok" });
        return serveStatic(url.pathname);
      } catch (error) {
        return jsonResponse({ error: "launchpad_error", message: error.message }, 500);
      }
    },
  });
}
