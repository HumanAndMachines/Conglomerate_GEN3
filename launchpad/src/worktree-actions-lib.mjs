import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, join, posix, relative } from "path";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import { GIT_LOCAL_TIMEOUT_MS, runGit, safeGitRemoteEnv } from "./git-lib.mjs";
import { readGitRepoStatus } from "./git-status-lib.mjs";
import { isMissionControlPlanPath, readMissionControlPlanAt } from "./mission-control-plan-lib.mjs";
import { inspectCanonicalPathBoundary } from "./path-boundary-lib.mjs";
import { buildWorktreeIndex } from "./worktree-lib.mjs";

export class WorktreeActionError extends Error {
  constructor(message, { status = 500, code = "worktree_action_error", details = [] } = {}) {
    super(message);
    this.name = "WorktreeActionError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function createWorktreeFromPlan({
  companiesRoot,
  repoKey,
  planPath,
  branch,
  createdBy = "launchpad-builder",
} = {}) {
  if (!companiesRoot) throw new Error("createWorktreeFromPlan requires companiesRoot");
  const repo = await resolveRepo(companiesRoot, repoKey);
  const normalizedPlanPath = normalizeOrganizationRelativePath(planPath, "planPath");
  if (normalizedPlanPath !== planPath || !isMissionControlPlanPath(normalizedPlanPath)) {
    throw new WorktreeActionError("Mission Control plán musí být přesná YAML cesta pod mission-control/db/data/mission-control/plans/ nebo legacy mission-control/plans/.", {
      status: 400,
      code: "invalid_plan_path",
    });
  }
  const plan = await readMissionControlPlanAt({
    companiesRoot,
    organizationPath: repo.organization_path,
    planPath: normalizedPlanPath,
  });
  if (!plan) {
    throw new WorktreeActionError(`Mission Control plán neexistuje: ${normalizedPlanPath}`, {
      status: 404,
      code: "plan_not_found",
    });
  }
  const normalizedBranch = validateBranch(branch ?? `${plan.code}-${repo.module}`);
  if (!normalizedBranch.includes(plan.code)) {
    throw new WorktreeActionError(`Branch musí obsahovat kód plánu ${plan.code}.`, {
      status: 400,
      code: "branch_missing_plan_code",
    });
  }

  await assertRepoCanCreateWorktree(repo);

  const paths = worktreePathsForRepo({ companiesRoot, repo, branch: normalizedBranch });
  await assertWorktreePathsInsideOrganization({
    companiesRoot,
    repo,
    paths: [paths.absoluteWorktreePath, paths.absoluteSidecarPath],
    allowMissingTarget: true,
  });
  if (existsSync(paths.absoluteWorktreePath) || existsSync(paths.absoluteSidecarPath)) {
    throw new WorktreeActionError(`Worktree nebo sidecar už existuje: ${paths.relativeWorktreePath}`, {
      status: 409,
      code: "worktree_already_exists",
    });
  }
  await assertBranchDoesNotExist(repo, normalizedBranch);
  await mkdir(dirname(paths.absoluteWorktreePath), { recursive: true });

  const added = await runGit(["worktree", "add", "-b", normalizedBranch, paths.absoluteWorktreePath], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!added.ok) {
    throw new WorktreeActionError(`Git worktree create selhal: ${added.stderr || added.error || added.stdout}`, {
      status: 500,
      code: "git_worktree_create_failed",
      details: [added.stderr || added.error || added.stdout].filter(Boolean),
    });
  }

  const metadata = {
    schema_version: "companiesascode.worktree.v1",
    organization: repo.organization,
    organization_path: repo.organization_path,
    workspace: repo.workspace,
    module: repo.module,
    module_path: repo.slot_path ?? repo.repo_path.replace(`${repo.organization_path}/`, ""),
    repo_kind: repo.repo_kind,
    base_branch: repo.expected_branch ?? "main",
    branch: normalizedBranch,
    mission_control_plan_code: plan.code,
    mission_control_plan_path: normalizedPlanPath,
    worktree_path: paths.organizationRelativeWorktreePath,
    created_at: new Date().toISOString(),
    created_by: createdBy,
    status: "active",
  };
  await writeJson(paths.absoluteSidecarPath, metadata);

  const worktree = await findWorktree(companiesRoot, repo, paths.slug);
  return {
    schema_version: "companiesascode.launchpad.worktree_action.v1",
    action: "create_worktree",
    repo_key: repo.key,
    created_at: metadata.created_at,
    worktree,
  };
}

export async function publishWorktreeDraft({
  companiesRoot,
  repoKey,
  slug,
  commitMessage,
  publisher = "launchpad-builder",
} = {}) {
  if (!companiesRoot) throw new Error("publishWorktreeDraft requires companiesRoot");
  const repo = await resolveRepo(companiesRoot, repoKey);
  const worktree = await findWorktree(companiesRoot, repo, validateSlug(slug));
  if (worktree.ownership_status !== "owned") {
    throw new WorktreeActionError("Publikovat lze jen worktree s Mission Control vlastníkem.", {
      status: 409,
      code: "worktree_not_owned",
    });
  }
  const message = validateCommitMessage(commitMessage);
  const absoluteWorktreePath = join(companiesRoot, worktree.path);
  const absoluteSidecarPath = join(companiesRoot, worktree.sidecar_path);
  await assertWorktreePathsInsideOrganization({
    companiesRoot,
    repo,
    paths: [absoluteWorktreePath, absoluteSidecarPath],
    allowMissingTarget: false,
  });
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: absoluteWorktreePath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (!status.ok) {
    throw new WorktreeActionError(`Git status selhal: ${status.stderr || status.error}`, {
      status: 500,
      code: "git_status_failed",
      details: [status.stderr || status.error].filter(Boolean),
    });
  }
  const draftRows = status.stdout.split("\n").filter(Boolean);
  if (draftRows.length === 0) {
    throw new WorktreeActionError("Worktree nemá žádný lokální draft k publikaci.", {
      status: 409,
      code: "no_draft_changes",
    });
  }

  const add = await runGit(["add", "-A"], { cwd: absoluteWorktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (!add.ok) throwGitPublishError("git_add_failed", add);
  const commit = await runGit(["commit", "-m", message], { cwd: absoluteWorktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (!commit.ok) throwGitPublishError("git_commit_failed", commit);
  const head = await runGit(["log", "-1", "--format=%H%x00%s"], { cwd: absoluteWorktreePath, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
  if (!head.ok) throwGitPublishError("git_head_failed", head);
  const [sha, subject] = head.stdout.split("\0");
  const push = await runGit(["push", "-u", "origin", worktree.branch], {
    cwd: absoluteWorktreePath,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });
  if (!push.ok) throwGitPublishError("git_push_failed", push);

  const publishedAt = new Date().toISOString();
  await updateSidecar(join(companiesRoot, worktree.sidecar_path), {
    last_touched: publishedAt,
    last_published_at: publishedAt,
    last_published_by: publisher,
    last_published_commit: sha,
    pr_url: null,
    status: "active",
  });

  return {
    schema_version: "companiesascode.launchpad.worktree_action.v1",
    action: "publish_worktree",
    repo_key: repo.key,
    branch: worktree.branch,
    pushed: true,
    pr_opened: false,
    published_at: publishedAt,
    commit: {
      sha,
      short_sha: sha.slice(0, 7),
      subject: subject ?? message,
    },
    draft: {
      changed_files: draftRows.length,
      paths: draftRows.map((line) => line.slice(3)),
    },
    next_action: "open_pull_request",
  };
}

async function resolveRepo(companiesRoot, repoKey) {
  if (!repoKey || typeof repoKey !== "string") {
    throw new WorktreeActionError("Chybí repoKey.", { status: 400, code: "missing_repo_key" });
  }
  const inventory = await buildGitInventory({ companiesRoot });
  const repo = inventory.repos.find((item) => item.key === repoKey);
  if (!repo) throw new WorktreeActionError(`Repo ${repoKey} nebylo nalezeno.`, { status: 404, code: "repo_not_found" });
  if (
    repo.repo_kind === "productionspace"
    || repo.space === "productionspace"
    || repo.workspace === "productionspace"
  ) {
    throw new WorktreeActionError("Productionspace repozitáře jsou v Launchpadu read-only; worktree create ani publish nejsou povolené.", {
      status: 403,
      code: "productionspace_read_only",
    });
  }
  if (!existsSync(repo.absolute_path)) {
    throw new WorktreeActionError(`Repo cesta neexistuje: ${repo.repo_path}`, { status: 404, code: "repo_missing" });
  }
  return repo;
}

async function assertRepoCanCreateWorktree(repo) {
  const status = await readGitRepoStatus(repo);
  if (status.status !== "up_to_date") {
    throw new WorktreeActionError("Create worktree vyžaduje čistý main checkout bez pull/push/draft driftu.", {
      status: 409,
      code: "repo_not_clean",
      details: [status.status, status.message].filter(Boolean),
    });
  }
}

async function assertWorktreePathsInsideOrganization({
  companiesRoot,
  repo,
  paths,
  allowMissingTarget,
}) {
  const organizationRoot = join(companiesRoot, repo.organization_path);
  let realOrganizationRoot = null;
  for (const path of paths) {
    const boundary = await inspectCanonicalPathBoundary({
      rootPath: organizationRoot,
      rootRealPath: realOrganizationRoot,
      targetPath: path,
      allowMissingTarget,
    });
    realOrganizationRoot = boundary.rootRealPath;
    if (!boundary.ok) {
      throw new WorktreeActionError(
        "Worktree cesta nebo sidecar se přes symlink/junction dostává mimo root Organizace.",
        { status: 403, code: "worktree_path_escape" },
      );
    }
  }
}

async function assertBranchDoesNotExist(repo, branch) {
  const local = await runGit(["show-ref", "--verify", `refs/heads/${branch}`], {
    cwd: repo.absolute_path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  });
  if (local.ok) {
    throw new WorktreeActionError(`Branch už existuje: ${branch}`, { status: 409, code: "branch_already_exists" });
  }
}

async function findWorktree(companiesRoot, repo, slug) {
  const index = await buildWorktreeIndex({ companiesRoot, organization: repo.organization, module: repo.module });
  const worktree = index.worktrees.find((item) => item.slug === slug);
  if (!worktree) throw new WorktreeActionError(`Worktree ${slug} nebyl nalezen.`, { status: 404, code: "worktree_not_found" });
  return worktree;
}

function worktreePathsForRepo({ companiesRoot, repo, branch }) {
  const slug = slugForBranch(branch);
  const orgRoot = join(companiesRoot, repo.organization_path);
  const relativeParent = parentPathForRepo(repo);
  const absoluteParent = join(orgRoot, relativeParent);
  const absoluteWorktreePath = join(absoluteParent, slug);
  const absoluteSidecarPath = join(absoluteParent, `${slug}.worktree.json`);
  return {
    slug,
    absoluteWorktreePath,
    absoluteSidecarPath,
    organizationRelativeWorktreePath: relative(join(companiesRoot, repo.organization_path), absoluteWorktreePath).replace(/\\/g, "/"),
    relativeWorktreePath: relative(companiesRoot, absoluteWorktreePath).replace(/\\/g, "/"),
  };
}

function parentPathForRepo(repo) {
  if (repo.repo_kind === "organization_root") return join(".worktrees", "root");
  if (repo.repo_kind === "productionspace") return join(".worktrees", "productionspace", repo.module);
  if (repo.repo_kind === "module") return join(".worktrees", "workspace", repo.module);
  return join(".worktrees", "root", repo.module);
}

function normalizeOrganizationRelativePath(path, label) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new WorktreeActionError(`${label} chybí.`, { status: 400, code: `missing_${label}` });
  }
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const resolved = posix.resolve("/org", normalized);
  if (
    !resolved.startsWith("/org/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes("\0")
  ) {
    throw new WorktreeActionError(`${label} není bezpečná organization-relative cesta.`, {
      status: 400,
      code: "unsafe_path",
    });
  }
  return normalized;
}

function validateBranch(branch) {
  if (typeof branch !== "string" || branch.trim() === "") {
    throw new WorktreeActionError("Branch chybí.", { status: 400, code: "missing_branch" });
  }
  const normalized = branch.trim();
  if (normalized.includes("\0") || normalized.startsWith("-") || normalized.includes("..")) {
    throw new WorktreeActionError("Branch obsahuje nepovolený tvar.", { status: 400, code: "invalid_branch" });
  }
  return normalized;
}

function validateSlug(slug) {
  if (typeof slug !== "string" || slug.trim() === "" || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new WorktreeActionError("Worktree slug je neplatný.", { status: 400, code: "invalid_worktree_slug" });
  }
  return slug.trim();
}

function slugForBranch(branch) {
  const slug = branch.replace(/[\\/]+/g, "--").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return validateSlug(slug || basename(branch));
}

function validateCommitMessage(commitMessage) {
  if (typeof commitMessage !== "string" || commitMessage.trim().length < 3) {
    throw new WorktreeActionError("Commit message musí být vyplněná.", { status: 400, code: "missing_commit_message" });
  }
  return commitMessage.trim();
}

function throwGitPublishError(code, result) {
  throw new WorktreeActionError(`Publikace selhala: ${result.stderr || result.error || result.stdout}`, {
    status: 500,
    code,
    details: [result.stderr || result.error || result.stdout].filter(Boolean),
  });
}

async function updateSidecar(path, patch) {
  const current = JSON.parse(await readFile(path, "utf8"));
  await writeJson(path, { ...current, ...patch });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
