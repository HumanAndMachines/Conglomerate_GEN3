import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

export async function createLaunchpadGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "launchpad-git-fixture-"));
  await mkdir(join(root, "launchpad"), { recursive: true });
  await mkdir(join(root, "guide"), { recursive: true });
  await mkdir(join(root, "manual"), { recursive: true });
  await mkdir(join(root, "organizations"), { recursive: true });
  // Scan-first (decision 0042): root nese jen generický kontrakt; Organizace se
  // zjišťují skenem organizations/*/company.gen3.json (createOrganization níže).
  await writeJson(join(root, "launchpad.gen3.json"), {
    workspace_generation: "gen3",
    launchpad_root: { slug: "test-root", display_name: "Test Root", root_role: "launchpad-root" },
  });

  await createOrganization({
    root,
    orgPath: "organizations/OmegaCo_GEN3",
    slug: "OmegaCo",
    moduleSlots: [
      {
        path: "workspace/studio",
        workspace: "workspace",
        category: "product",
        repo: "git@github.com:OmegaCo/studio.git",
        branch: "main",
      },
      {
        path: "infra",
        category: "engineering",
        repo: "git@github.com:OmegaCo/infra.git",
        branch: "main",
      },
      {
        path: "workspace/future-module",
        workspace: "workspace",
        category: "planned",
      },
    ],
  });

  await createOrganization({
    root,
    orgPath: "organizations/BetaCo_GEN3",
    slug: "BetaCo",
    moduleSlots: [
      {
        path: "modules/deals",
        workspace: "workspace",
        category: "sales",
        git: { url: "git@github.com:BetaCo/deals.git", branch: "main" },
      },
      {
        path: "modules/knowledgebase",
        workspace: "workspace",
        category: "knowledge",
        repo: "git@github.com:BetaCo/knowledgebase.git",
        branch: "main",
      },
      {
        path: "modules/brainstorm",
        workspace: "workspace",
        category: "planned",
      },
    ],
  });

  return root;
}

export async function createOrganization({ root, orgPath, slug, moduleSlots }) {
  const orgRoot = join(root, orgPath);
  await mkdir(join(orgRoot, "manual"), { recursive: true });
  await mkdir(join(orgRoot, "company", "colleagues"), { recursive: true });
  await mkdir(join(orgRoot, "mission-control", "plans", "2026", "07"), { recursive: true });
  await writeJson(join(orgRoot, "company.gen3.json"), {
    organization_generation: "gen3",
    company: { slug, display_name: `${slug} GEN3` },
    workspaces: [{ slug: "workspace", display_name: `${slug} Workspace`, default: true }],
  });
  await writeJson(join(orgRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    module_slots: moduleSlots,
  });
  await writeJson(join(orgRoot, "TODO.tasks.json"), {});
  await writeJson(join(orgRoot, "DONE.tasks.json"), {});
  await writeJson(join(orgRoot, "ISSUES.open.json"), {});
}

export async function createPackageApp({ root, packagePath, app }) {
  const packageJsonPath = join(root, packagePath, "package.json");
  await writeJson(packageJsonPath, {
    name: app.id,
    private: true,
    type: "module",
    scripts: { dev: "bun server.mjs" },
    companyascode: {
      app: {
        schema_version: "companyascode.launchpad_app.v1",
        surface: "internal",
        host: "127.0.0.1",
        health_path: "/health",
        dev_script: "dev",
        tags: [],
        ...app,
      },
    },
  });
}

export async function initGitRepo(path, { branch = "main", remotePath = null } = {}) {
  await mkdir(path, { recursive: true });
  runGit(["init", "-b", branch], path);
  runGit(["config", "user.email", "fixture@example.com"], path);
  runGit(["config", "user.name", "Fixture"], path);
  await writeFile(join(path, "README.md"), `# ${branch}\n`);
  runGit(["add", "README.md"], path);
  runGit(["commit", "-m", "initial"], path);
  if (remotePath) {
    await mkdir(dirname(remotePath), { recursive: true });
    runGit(["init", "--bare", remotePath], path);
    runGit(["remote", "add", "origin", remotePath], path);
    runGit(["push", "-u", "origin", branch], path);
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function runGit(args, cwd) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}
