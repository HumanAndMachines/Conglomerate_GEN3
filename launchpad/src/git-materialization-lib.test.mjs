import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { materializeRepoCheckout } from "./git-materialization-lib.mjs";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import { runGit } from "./git-lib.mjs";
import {
  createLaunchpadGitFixture,
  initGitRepo,
  writeJson,
} from "./git-fixture-helpers.test.mjs";

const tempRoots = [];
const posixTest = test.if(process.platform !== "win32");

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("materializes an active manifest slot on its exact repository and branch", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  const repo = await createManifestRepo({ root, organizationRoot, remote, slot: "workspace/lazurio" });

  const result = await materializeRepoCheckout({ companiesRoot: root, repo });

  expect(result).toMatchObject({
    ok: true,
    outcome: "materialized",
    branch: "main",
    remote,
  });
  expect(result.head).toMatch(/^[0-9a-f]{40}$/);
  expect(await Bun.file(join(organizationRoot, "workspace", "lazurio", "README.md")).text())
    .toContain("# main");
});

test("leaves no target when the declared source is unavailable", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const target = join(organizationRoot, "workspace", "private-module");
  await prepareOrganizationRoot(organizationRoot);
  const repo = await createManifestRepo({
    root,
    organizationRoot,
    remote: join(root, "remotes", "not-accessible.git"),
    slot: "workspace/private-module",
  });

  const result = await materializeRepoCheckout({ companiesRoot: root, repo });

  expect(result).toMatchObject({
    ok: false,
    outcome: "missing_access",
    code: "materialization_source_unavailable",
  });
  expect(existsSync(target)).toBe(false);
});

test("never overwrites an existing target", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const target = join(organizationRoot, "workspace", "lazurio");
  await prepareOrganizationRoot(organizationRoot);
  const remote = join(root, "remotes", "lazurio.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "lazurio"), { remotePath: remote });
  const repo = await createManifestRepo({ root, organizationRoot, remote, slot: "workspace/lazurio" });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "existing-owner.txt"), "preserve me\n");

  const result = await materializeRepoCheckout({ companiesRoot: root, repo });

  expect(result).toMatchObject({
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_exists",
  });
  expect(await Bun.file(join(target, "existing-owner.txt")).text()).toBe("preserve me\n");
  expect(existsSync(join(target, ".git"))).toBe(false);
});

test("refuses a target that differs from the manifest inventory boundary", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const outside = join(root, "outside");

  const result = await materializeRepoCheckout({
    companiesRoot: root,
    repo: {
      organization: "BetaCo",
      organization_path: "organizations/BetaCo_GEN3",
      repo_kind: "module",
      slot_path: "workspace/lazurio",
      absolute_path: outside,
      expected_branch: "main",
      repo: "git@github.com:BetaCo/lazurio.git",
    },
  });

  expect(result).toMatchObject({
    ok: false,
    outcome: "failed",
    code: "materialization_path_forbidden",
  });
  expect(existsSync(outside)).toBe(false);
});

posixTest("materialization ignores Organization-local core.sshCommand", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const marker = join(root, "local-ssh-command-ran");
  const helper = join(root, "local-ssh-command.sh");
  await prepareOrganizationRoot(organizationRoot);
  await writeFile(helper, `#!/bin/sh\nprintf attacker > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(helper, 0o755);
  await runGit(["config", "core.sshCommand", helper], { cwd: organizationRoot });
  const repo = await createManifestRepo({
    root,
    organizationRoot,
    remote: "ssh://git@127.0.0.1:1/nope",
    slot: "workspace/private-module",
  });

  const result = await materializeRepoCheckout({ companiesRoot: root, repo });

  expect(result).toMatchObject({ ok: false, outcome: "missing_access" });
  expect(existsSync(marker)).toBe(false);
});

posixTest("materialization removes inherited GIT_SSH_COMMAND and GIT_SSH", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const commandMarker = join(root, "inherited-ssh-command-ran");
  const binaryMarker = join(root, "inherited-ssh-binary-ran");
  const commandHelper = join(root, "inherited-ssh-command.sh");
  const binaryHelper = join(root, "inherited-ssh-binary.sh");
  await prepareOrganizationRoot(organizationRoot);
  await writeFile(commandHelper, `#!/bin/sh\nprintf attacker > ${JSON.stringify(commandMarker)}\nexit 1\n`);
  await writeFile(binaryHelper, `#!/bin/sh\nprintf attacker > ${JSON.stringify(binaryMarker)}\nexit 1\n`);
  await chmod(commandHelper, 0o755);
  await chmod(binaryHelper, 0o755);
  const repo = await createManifestRepo({
    root,
    organizationRoot,
    remote: "ssh://git@127.0.0.1:1/nope",
    slot: "workspace/private-module",
  });
  const previousCommand = process.env.GIT_SSH_COMMAND;
  const previousBinary = process.env.GIT_SSH;
  process.env.GIT_SSH_COMMAND = commandHelper;
  process.env.GIT_SSH = binaryHelper;
  try {
    const result = await materializeRepoCheckout({ companiesRoot: root, repo });
    expect(result).toMatchObject({ ok: false, outcome: "missing_access" });
  } finally {
    if (previousCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousCommand;
    if (previousBinary === undefined) delete process.env.GIT_SSH;
    else process.env.GIT_SSH = previousBinary;
  }

  expect(existsSync(commandMarker)).toBe(false);
  expect(existsSync(binaryMarker)).toBe(false);
});

posixTest("materialization ignores HOME global hooks", async () => {
  const root = await createLaunchpadGitFixture();
  tempRoots.push(root);
  const organizationRoot = join(root, "organizations", "BetaCo_GEN3");
  const home = join(root, "hostile-home");
  const hooks = join(home, "hooks");
  const marker = join(root, "global-hook-ran");
  await prepareOrganizationRoot(organizationRoot);
  await mkdir(hooks, { recursive: true });
  const hook = join(hooks, "post-checkout");
  await writeFile(hook, `#!/bin/sh\nprintf global-hook > ${JSON.stringify(marker)}\n`);
  await chmod(hook, 0o755);
  await writeFile(join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
  const remote = join(root, "remotes", "private-module.git");
  await mkdir(join(root, "sources"), { recursive: true });
  await initGitRepo(join(root, "sources", "private-module"), { remotePath: remote });
  const repo = await createManifestRepo({ root, organizationRoot, remote, slot: "workspace/private-module" });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await materializeRepoCheckout({ companiesRoot: root, repo });
    expect(result).toMatchObject({ ok: true, outcome: "materialized" });
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }

  expect(existsSync(marker)).toBe(false);
});

async function createManifestRepo({ root, organizationRoot, remote, slot }) {
  const module = slot.split("/").at(-1);
  await writeJson(join(organizationRoot, "modules.manifest.json"), {
    organization_generation: "gen3",
    company: "BetaCo",
    github_org: "BetaCo",
    module_slots: [{ path: slot, teams: [module], git: { url: remote, branch: "main" } }],
  });
  const inventory = await buildGitInventory({ companiesRoot: root });
  const repo = inventory.repos.find((entry) => entry.key === `BetaCo::${module}`);
  if (!repo) throw new Error(`Missing fixture inventory repo for ${slot}`);
  return repo;
}

async function prepareOrganizationRoot(organizationRoot) {
  await writeFile(join(organizationRoot, ".gitignore"), "/workspace/*/\n");
  await initGitRepo(organizationRoot);
}
