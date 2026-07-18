import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, rm, symlink, writeFile } from "fs/promises";
import { createServer } from "net";
import { join } from "path";
import { createLaunchpadGitFixture, createPackageApp, initGitRepo, runGit, writeJson } from "./git-fixture-helpers.test.mjs";
import { platformTestTimeout } from "./test-platform-setup.mjs";

const tempRoots = [];
const servers = [];

afterAll(async () => {
  // Počkej, až servery opravdu skončí — kill() jen pošle SIGTERM a nečeká na
  // uvolnění portu, takže bez await by port mohl přežít do dalšího test filu.
  await Promise.all(
    servers.map((server) => {
      server.kill();
      return server.exited;
    }),
  );
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("Launchpad server exposes read-only git and Mission Control routes", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const dealsRepo = join(root, "organizations", "BetaCo_GEN3", "modules", "deals");
  await initGitRepo(dealsRepo);
  await writeFile(join(dealsRepo, "draft.md"), "local draft\n");
  const omegacoRoot = join(root, "organizations", "OmegaCo_GEN3");
  await writeJson(join(omegacoRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    module_slots: [
      {
        path: "productionspace/firmware",
        category: "firmware",
        repo: "git@github.com:OmegaCo/firmware.git",
        branch: "main",
      },
    ],
  });
  await initGitRepo(join(omegacoRoot, "productionspace", "firmware"));
  const { port } = await startLaunchpadServer(root);

  const repos = await getJson(port, "/api/git/repos");
  const deals = await getJson(port, "/api/git/repos/BetaCo%3A%3Adeals");
  const changes = await getJson(port, "/api/git/repos/BetaCo%3A%3Adeals/changes");
  const blockedPull = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/pull", {}, 409);
  const blockedAutostashPull = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/pull-autostash", {}, 409);
  const blockedProductionPull = await postJson(port, "/api/git/repos/OmegaCo%3A%3Afirmware/pull", {}, 403);
  const pullAll = await postJson(port, "/api/git/pull-all", {});
  const worktrees = await getJson(port, "/api/git/worktrees?organization=BetaCo&module=deals");
  const plans = await getJson(port, "/api/mission-control/plans?organization=BetaCo&module=deals");

  expect(repos.schema_version).toBe("companiesascode.launchpad.git.v1");
  expect(deals.repo.key).toBe("BetaCo::deals");
  expect(deals.repo.status).toBe("draft_changes");
  expect(changes.changes[0]).toMatchObject({ path: "draft.md", porcelain: "??" });
  expect(blockedPull.error).toBe("pull_not_safe");
  expect(blockedPull.message).toContain("rozepsaná práce");
  expect(blockedAutostashPull.error).toBe("autostash_pull_not_safe");
  expect(blockedProductionPull.error).toBe("pull_scope_forbidden");
  expect(blockedProductionPull.message).toContain("productionspace");
  expect(pullAll.schema_version).toBe("companiesascode.launchpad.git_pull_all.v1");
  expect(pullAll.results.some((result) => result.repo_key === "OmegaCo::firmware" && result.outcome === "policy_skipped")).toBe(true);
  expect(worktrees.schema_version).toBe("companiesascode.launchpad.worktrees.v1");
  expect(plans.schema_version).toBe("companiesascode.launchpad.mission_control_plans.v1");
});

test("identity endpoint is local-only and a foreign root cannot reuse the port", async () => {
  const root = await createLaunchpadGitFixture();
  const otherRoot = await createLaunchpadGitFixture();
  tempRoots.push(root, otherRoot);
  const { port } = await startLaunchpadServer(root);

  const identity = await getJson(port, "/api/launchpad/identity");
  expect(identity.schema_version).toBe("companiesascode.launchpad.identity.v1");
  expect(identity.root_id).toMatch(/^[a-f0-9]{64}$/);

  const crossOriginIdentity = await fetch(`http://127.0.0.1:${port}/api/launchpad/identity`, {
    headers: { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" },
  });
  expect(crossOriginIdentity.status).toBe(403);

  const otherRootLauncher = Bun.spawn(
    ["bun", "src/server.mjs", "--root", otherRoot, "--port", String(port), "--open"],
    { cwd: join(import.meta.dirname, ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect(await otherRootLauncher.exited).not.toBe(0);
  expect(await new Response(otherRootLauncher.stderr).text()).toContain("EADDRINUSE");
});

test("organization branding serves local logos and design-system themes without symlink escapes", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const omegacoLogo = join(root, "organizations", "OmegaCo_GEN3", "launchpad", "app", "v1", "web", "launchpad-icon.png");
  const betacoLogo = join(root, "organizations", "BetaCo_GEN3", "launchpad", "app", "v1", "web", "launchpad-icon.png");
  const secretDirectory = join(root, "secret-logo-directory");
  await mkdir(join(omegacoLogo, ".."), { recursive: true });
  await mkdir(join(betacoLogo, ".."), { recursive: true });
  await writeFile(omegacoLogo, "safe-logo");
  await writeFile(
    join(omegacoLogo, "..", "style.css"),
    `:root {
      --bg: #fff;
      --surface: #fff;
      --text: #1b1348;
      --accent: #6058e9;
      --font-body: "Manrope", sans-serif;
    }
    [data-theme="dark"] {
      --bg: #0b0e14;
      --surface: #151a24;
      --text: #f3f4f8;
      --accent: #728efc;
    }`,
  );
  await mkdir(secretDirectory, { recursive: true });
  await writeFile(join(secretDirectory, "launchpad-icon.png"), "must-not-leak");
  await rm(join(betacoLogo, ".."), { recursive: true, force: true });
  await symlink(
    secretDirectory,
    join(betacoLogo, ".."),
    process.platform === "win32" ? "junction" : "dir",
  );
  const { port } = await startLaunchpadServer(root);

  const apps = await getJson(port, "/api/apps");
  expect(apps.organizations.find((organization) => organization.slug === "OmegaCo")?.logo_url).toBe(
    "/api/organizations/OmegaCo/logo",
  );
  expect(apps.organizations.find((organization) => organization.slug === "BetaCo")?.logo_url).toBeUndefined();
  expect(apps.organizations.find((organization) => organization.slug === "OmegaCo")?.theme).toMatchObject({
    source: "launchpad/app/v1/web/style.css",
    light: { "--accent": "#6058e9", "--font-body": '"Manrope", sans-serif' },
    dark: { "--accent": "#728efc" },
  });
  expect(apps.organizations.find((organization) => organization.slug === "BetaCo")?.theme).toBeUndefined();

  const safeResponse = await fetch(`http://127.0.0.1:${port}/api/organizations/OmegaCo/logo`);
  expect(safeResponse.status).toBe(200);
  expect(safeResponse.headers.get("content-type")).toBe("image/png");
  expect(await safeResponse.text()).toBe("safe-logo");
  expect(safeResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");

  const crossOriginResponse = await fetch(`http://127.0.0.1:${port}/api/organizations/OmegaCo/logo`, {
    headers: { origin: "https://example.com", "sec-fetch-site": "cross-site" },
  });
  expect(crossOriginResponse.status).toBe(403);

  const escapedResponse = await fetch(`http://127.0.0.1:${port}/api/organizations/BetaCo/logo`);
  expect(escapedResponse.status).toBe(404);
  expect(await escapedResponse.text()).not.toContain("must-not-leak");
});

test("personalspace API rejects cross-origin and DNS-rebinding requests", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { port } = await startLaunchpadServer(root);

  const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/personalspace`, {
    headers: { origin: "https://example.com", "sec-fetch-site": "cross-site" },
  });
  expect(crossOrigin.status).toBe(403);

  const rebound = await fetch(`http://127.0.0.1:${port}/api/personalspace`, {
    headers: { host: "attacker.example" },
  });
  expect(rebound.status).toBe(403);
});

test("mutating APIs reject cross-origin and DNS-rebinding requests before routing", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const { port } = await startLaunchpadServer(root);
  const mutatingPaths = [
    "/api/git/pull-all",
    "/api/git/repos/BetaCo%3A%3Adeals/pull",
    "/api/git/repos/BetaCo%3A%3Adeals/pull-autostash",
    "/api/git/repos/BetaCo%3A%3Adeals/worktrees/create",
    "/api/git/repos/BetaCo%3A%3Adeals/worktrees/review-fix/publish",
    "/api/apps/deals-v1/health",
    "/api/apps/deals-v1/install",
    "/api/apps/deals-v1/repair",
    "/api/apps/deals-v1/start",
    "/api/apps/deals-v1/open",
    "/api/apps/deals-v1/stop",
    "/api/apps/deals-v1/restart",
    "/api/sync",
  ];

  for (const path of mutatingPaths) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.invalid",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "mutating_request_forbidden" });
  }

  const rebound = await fetch(`http://127.0.0.1:${port}/api/git/pull-all`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "attacker.example" },
    body: "{}",
  });
  expect(rebound.status).toBe(403);
  expect(await rebound.json()).toEqual({ error: "mutating_request_forbidden" });
});

test("Launchpad server forwards runtime source from POST body to worktree open", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const dealsRepo = join(orgRoot, "modules", "deals");
  await initGitRepo(dealsRepo);
  const mainPort = await findFreePort();
  await createPackageApp({
    root,
    packagePath: "organizations/BetaCo_GEN3/modules/deals/app/v1",
    app: {
      id: "deals-v1",
      title: "Deals v1",
      company: "BetaCo",
      module: "deals",
      port: mainPort,
    },
  });
  await writeFile(join(dealsRepo, "app", "v1", "server.mjs"), fixtureServerSource(), "utf8");

  const worktreeSlug = "CAC-0042-deals-runtime-selector";
  const worktreeRoot = join(orgRoot, ".worktrees", "workspace", "deals", worktreeSlug);
  await mkdir(join(orgRoot, ".worktrees", "workspace", "deals"), { recursive: true });
  await cp(dealsRepo, worktreeRoot, { recursive: true });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-deals-runtime-selector.yaml"),
    "dev_code: CAC-0042\ntitle: Deals runtime selector\nstatus: in_progress\nlinks:\n  - path: modules/deals\n",
  );
  await writeJson(join(orgRoot, ".worktrees", "workspace", "deals", `${worktreeSlug}.worktree.json`), {
    schema_version: "companiesascode.worktree.v1",
    organization: "BetaCo",
    organization_path: "organizations/BetaCo_GEN3",
    workspace: "workspace",
    module: "deals",
    module_path: "modules/deals",
    repo_kind: "module",
    base_branch: "main",
    branch: "CAC-0042-deals-runtime-selector",
    mission_control_plan_code: "CAC-0042",
    mission_control_plan_path: "mission-control/plans/2026/07/CAC-0042-deals-runtime-selector.yaml",
    worktree_path: ".worktrees/workspace/deals/CAC-0042-deals-runtime-selector",
    created_at: "2026-07-04T00:00:00.000Z",
    created_by: "examplebuddy-buddy",
    status: "active",
  });

  const { port } = await startLaunchpadServer(root);

  try {
    const opened = await postJson(port, "/api/apps/deals-v1/open", {
      source: { type: "worktree", slug: worktreeSlug },
    });

    expect(opened.runtime_source).toMatchObject({ type: "worktree", slug: worktreeSlug, plan_code: "CAC-0042" });
    expect(opened.url).not.toBe(`http://127.0.0.1:${mainPort}`);

    const health = await postJson(port, "/api/apps/deals-v1/health", {
      source: { type: "worktree", slug: worktreeSlug },
    });

    expect(health.runtime_source).toMatchObject({ type: "worktree", slug: worktreeSlug, plan_code: "CAC-0042" });
    expect(health.port).toBe(opened.runtime.port);
  } finally {
    await postJson(port, "/api/apps/deals-v1/stop", { source: { type: "worktree", slug: worktreeSlug } }).catch(() => null);
    await postJson(port, "/api/apps/deals-v1/stop", {}).catch(() => null);
  }
}, platformTestTimeout(15_000));

test("Launchpad server creates and publishes a Mission-Control-owned worktree via explicit builder actions", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const orgRoot = join(root, "organizations", "BetaCo_GEN3");
  const dealsRepo = join(orgRoot, "modules", "deals");
  const remotePath = join(root, "remotes", "deals.git");
  await initGitRepo(dealsRepo, { remotePath });
  await writeFile(
    join(orgRoot, "mission-control", "plans", "2026", "07", "CAC-0042-deals-publish.yaml"),
    "dev_code: CAC-0042\ntitle: Deals publish assistant\nstatus: in_progress\nlinks:\n  - path: modules/deals\n",
  );

  const { port } = await startLaunchpadServer(root);

  const created = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/worktrees/create", {
    planPath: "mission-control/plans/2026/07/CAC-0042-deals-publish.yaml",
    branch: "CAC-0042-deals-publish",
    createdBy: "test-agent",
  });
  expect(created.worktree).toMatchObject({
    slug: "CAC-0042-deals-publish",
    ownership_status: "owned",
    owner_plan: { code: "CAC-0042" },
  });

  await writeFile(join(root, created.worktree.path, "draft.md"), "publish through server\n");
  const published = await postJson(port, "/api/git/repos/BetaCo%3A%3Adeals/worktrees/CAC-0042-deals-publish/publish", {
    commitMessage: "feat: publish via launchpad",
    publisher: "test-agent",
  });

  expect(published).toMatchObject({
    action: "publish_worktree",
    repo_key: "BetaCo::deals",
    branch: "CAC-0042-deals-publish",
    pushed: true,
    pr_opened: false,
  });
  expect(runGit(["--git-dir", remotePath, "rev-parse", "refs/heads/CAC-0042-deals-publish"], root)).toBe(
    published.commit.sha,
  );
});

// Spustí launchpad server na OS-přiděleném volném portu (findFreePort) místo
// hádání z pevného rozsahu. Fixní rozsahy kolidovaly s reálnými dev servery
// běžícími na mašině (porty ~5288–5711): test si vylosoval obsazený port, jeho
// vlastní Bun.serve se nenabindoval, waitForHealth dostal 200 z /health cizího
// serveru a /api/git/repos pak vrátilo 404. OS přidělený port je garantovaně
// volný, takže health probe i git routy trefí vždy NÁŠ server.
async function startLaunchpadServer(root) {
  const port = await findFreePort();
  const server = Bun.spawn(["bun", "src/server.mjs", "--root", root, "--port", String(port)], {
    cwd: join(import.meta.dirname, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  servers.push(server);
  await waitForHealth(port, server);
  return { server, port };
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, server) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // Pokud server spadl při startu (např. port si mezi findFreePort a bindem
    // stihl vzít někdo jiný), neplýtvej 5 s timeoutem ani nepokračuj proti
    // cizímu serveru — vypíš rovnou proč.
    if (server && server.exitCode !== null) {
      const stderr = server.stderr ? await new Response(server.stderr).text() : "";
      throw new Error(`launchpad server on ${port} exited early (code ${server.exitCode}): ${stderr.trim()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server on ${port} did not become healthy`);
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  expect(response.status).toBe(200);
  return response.json();
}

async function postJson(port, path, body, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json();
}

function fixtureServerSource() {
  return [
    "const server = Bun.serve({",
    "  hostname: process.env.HOST,",
    "  port: Number(process.env.PORT),",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    "    if (url.pathname === '/health') return Response.json({ status: 'ok' });",
    "    return new Response('ok');",
    "  },",
    "});",
    "console.log(`fixture listening ${server.port}`);",
    "setInterval(() => {}, 2147483647);",
    "",
  ].join("\n");
}
