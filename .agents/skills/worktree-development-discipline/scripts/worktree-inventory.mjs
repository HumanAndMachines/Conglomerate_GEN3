#!/usr/bin/env bun

import { access, lstat, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const GIT_TIMEOUT_MS = 10_000;
const MAX_PARALLEL_GIT_CHECKS = 4;
const DISK_SCAN_BUDGET_MS = 20_000;
const DISK_SCAN_ENTRY_BUDGET = 500_000;
const ORPHAN_SCAN_BUDGET_MS = 5_000;
const ORPHAN_SCAN_ENTRY_BUDGET = 20_000;

export async function auditRepository(startPath = process.cwd(), options = {}) {
  const includeDisk = options.includeDisk ?? false;
  const start = resolve(startPath);
  const currentTop = await gitText(start, ["rev-parse", "--show-toplevel"]);
  const commonDirRaw = await gitText(currentTop, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const commonDir = isAbsolute(commonDirRaw)
    ? resolve(commonDirRaw)
    : resolve(currentTop, commonDirRaw);
  const primaryRoot = basename(commonDir) === ".git"
    ? dirname(commonDir)
    : currentTop;
  const authorityRoot = options.authorityRoot
    ? resolve(options.authorityRoot)
    : resolveAuthorityRoot(primaryRoot);
  const repositoryIdentity = await resolveRepositoryIdentity(primaryRoot);
  const records = parseWorktreePorcelain(
    await gitText(primaryRoot, ["worktree", "list", "--porcelain", "-z"]),
  );
  const orphanScan = await scanLocalOrphans(primaryRoot, commonDir, records, options);
  const orphanEntries = orphanScan.entries;
  const primaryRecord = records.find((record) => resolve(record.path) === resolve(primaryRoot))
    ?? records[0];
  const diskBudget = includeDisk
    ? {
        deadline: Date.now() + DISK_SCAN_BUDGET_MS,
        remainingEntries: DISK_SCAN_ENTRY_BUDGET,
      }
    : null;
  const enriched = await mapLimit(records, MAX_PARALLEL_GIT_CHECKS, async (record) => {
    const pathClass = classifyWorktreePath(primaryRoot, record.path);
    const exists = await pathExists(record.path);
    const sidecarPath = pathClass === "primary"
      ? null
      : join(dirname(record.path), `${basename(record.path)}.worktree.json`);
    const sidecarExists = sidecarPath ? await pathExists(sidecarPath) : false;
    const sidecar = sidecarExists
      ? await validateSidecar(
          primaryRoot,
          authorityRoot,
          repositoryIdentity,
          record,
          sidecarPath,
        )
      : { valid: false, error: "missing sidecar", planPath: null };
    const status = exists
      ? await runGit(["status", "--porcelain=v1", "--untracked-files=all"], record.path)
      : { ok: false, stdout: "", stderr: "missing path", timedOut: false };
    const remote = exists && record.branch
      ? await inspectRemoteState(record.path)
      : {
          upstream: null,
          ahead: null,
          behind: null,
          remoteName: null,
          remoteRef: null,
          remoteBranchExists: null,
          remoteHead: null,
          remoteHeadMatches: null,
          verified: false,
          preserved: false,
          error: null,
        };
    const disk = includeDisk && exists && pathClass !== "primary"
      ? await directorySize(record.path, diskBudget)
      : { bytes: null, complete: null };
    const dirty = status.ok ? status.stdout.trim().length > 0 : null;
    return {
      ...record,
      path_class: pathClass,
      exists,
      sidecar_path: sidecarPath,
      sidecar_exists: sidecarExists,
      sidecar_valid: sidecarPath ? sidecar.valid : null,
      sidecar_error: sidecarPath && !sidecar.valid ? sidecar.error : null,
      sidecar_advisories: sidecar.advisories ?? [],
      plan_path: sidecar.planPath,
      dirty,
      status_error: status.ok ? null : status.timedOut ? "git timeout" : status.stderr.trim(),
      upstream: remote.upstream,
      ahead: remote.ahead,
      behind: remote.behind,
      remote_name: remote.remoteName,
      remote_ref: remote.remoteRef,
      remote_branch_exists: remote.remoteBranchExists,
      remote_head: remote.remoteHead,
      remote_head_matches: remote.remoteHeadMatches,
      remote_verified: remote.verified,
      remote_error: remote.error,
      remote_preserved: remote.preserved,
      disk_bytes: disk.bytes,
      disk_scan_complete: disk.complete,
      lifecycle: classifyLifecycle({
        pathClass,
        exists,
        sidecarValid: sidecar.valid,
        dirty,
        remotePreserved: remote.preserved,
        remoteError: remote.error,
      }),
    };
  });
  const primary = enriched.find((record) => record.path_class === "primary")
    ?? primaryRecord
    ?? null;
  const violations = [];
  if (!primary) {
    violations.push("primary checkout was not found in the Git worktree registry");
  } else {
    if (primary.branch !== "main") {
      violations.push(`primary checkout is on ${primary.branch ?? "detached HEAD"}, expected main`);
    }
    if (primary.upstream !== "origin/main") {
      violations.push(`primary checkout tracks ${primary.upstream ?? "no upstream"}, expected origin/main`);
    }
    if ((primary.ahead ?? 0) > 0) {
      violations.push(`primary checkout has ${primary.ahead} local-only commit(s)`);
    }
    if ((primary.behind ?? 0) > 0) {
      violations.push(`primary checkout is ${primary.behind} commit(s) behind origin/main`);
    }
    if (primary.remote_error) {
      violations.push(`primary checkout remote state is unknown (${primary.remote_error})`);
    }
    if (primary.dirty) {
      violations.push("primary checkout has local changes");
    }
  }
  for (const worktree of enriched) {
    if (worktree.path_class === "legacy" || worktree.path_class === "external") {
      violations.push(`${worktree.path_class} worktree: ${worktree.path}`);
    }
    if (worktree.path_class === "canonical" && !worktree.sidecar_exists) {
      violations.push(`canonical worktree is missing sidecar: ${worktree.path}`);
    }
    if (
      worktree.path_class === "canonical"
      && worktree.sidecar_exists
      && !worktree.sidecar_valid
    ) {
      violations.push(`canonical worktree has invalid sidecar: ${worktree.path} (${worktree.sidecar_error})`);
    }
    if (worktree.path_class === "canonical" && worktree.dirty === true) {
      violations.push(`canonical worktree has local changes and is not cleanup-ready: ${worktree.path}`);
    }
    if (worktree.exists && worktree.status_error) {
      violations.push(`worktree Git status is unknown: ${worktree.path} (${worktree.status_error})`);
    }
    if (worktree.path_class === "canonical" && !worktree.branch) {
      violations.push(`canonical worktree is detached: ${worktree.path}`);
    }
    if (worktree.path_class === "canonical" && worktree.branch && !worktree.upstream) {
      violations.push(`canonical worktree branch has no upstream: ${worktree.path}`);
    }
    if (worktree.path_class === "canonical" && (worktree.ahead ?? 0) > 0) {
      violations.push(`canonical worktree has ${worktree.ahead} local-only commit(s): ${worktree.path}`);
    }
    if (worktree.path_class === "canonical" && (worktree.behind ?? 0) > 0) {
      violations.push(`canonical worktree is ${worktree.behind} commit(s) behind upstream: ${worktree.path}`);
    }
    if (worktree.path_class === "canonical" && worktree.remote_error) {
      violations.push(`canonical worktree remote state is unknown: ${worktree.path} (${worktree.remote_error})`);
    }
    if (!worktree.exists) {
      violations.push(`registered worktree path is missing: ${worktree.path}`);
    }
  }
  for (const orphan of orphanEntries) {
    violations.push(`unregistered ${orphan.kind}: ${orphan.path}`);
  }
  if (!orphanScan.complete) {
    violations.push("bounded orphan scan did not complete");
  }
  return {
    schema_version: "humanandmachine.worktree_audit.v1",
    repository_root: primaryRoot,
    canonical_root: join(primaryRoot, ".worktrees", "root"),
    generated_at: new Date().toISOString(),
    primary,
    worktrees: enriched,
    orphan_entries: orphanEntries,
    orphan_scan_complete: orphanScan.complete,
    global_orphan_scan_complete: orphanScan.globalComplete,
    violations,
    summary: {
      registered: enriched.length,
      canonical: enriched.filter((item) => item.path_class === "canonical").length,
      legacy: enriched.filter((item) => item.path_class === "legacy").length,
      external: enriched.filter((item) => item.path_class === "external").length,
      dirty: enriched.filter((item) => item.dirty === true).length,
      missing: enriched.filter((item) => !item.exists).length,
      invalid_sidecars: enriched.filter(
        (item) => item.path_class === "canonical"
          && item.sidecar_exists
          && item.sidecar_valid === false,
      ).length,
      orphan_directories: orphanEntries.filter((item) => item.kind === "worktree directory").length,
      orphan_sidecars: orphanEntries.filter((item) => item.kind === "sidecar").length,
      orphan_scan_complete: orphanScan.complete,
      global_orphan_scan_complete: orphanScan.globalComplete,
      operational_metadata_advisories: enriched.reduce(
        (sum, item) => sum + item.sidecar_advisories.length,
        0,
      ),
      no_upstream: enriched.filter(
        (item) => item.path_class === "canonical" && item.branch && !item.upstream,
      ).length,
      local_only_commits: enriched
        .filter((item) => item.path_class === "canonical")
        .reduce((sum, item) => sum + (item.ahead ?? 0), 0),
      disk_bytes: includeDisk
        ? enriched
            .filter((item) => item.path_class !== "primary")
            .reduce((sum, item) => sum + (item.disk_bytes ?? 0), 0)
        : null,
      disk_scan_complete: includeDisk
        ? enriched
            .filter((item) => item.path_class !== "primary")
            .every((item) => item.disk_scan_complete === true)
        : null,
    },
  };
}

export function classifyWorktreePath(primaryRoot, worktreePath) {
  const primary = resolve(primaryRoot);
  const target = resolve(worktreePath);
  if (target === primary) return "primary";
  const canonicalRoot = join(primary, ".worktrees", "root");
  const canonicalRelative = relative(canonicalRoot, target);
  if (
    canonicalRelative !== ""
    && !canonicalRelative.startsWith("..")
    && !isAbsolute(canonicalRelative)
    && !canonicalRelative.includes(sep)
  ) {
    return "canonical";
  }
  if (isWithin(join(primary, ".worktrees"), target)) return "legacy";
  return "external";
}

export function parseWorktreePorcelain(output) {
  const nulTerminated = output.includes("\0");
  const blocks = nulTerminated
    ? output.split("\0\0")
    : output.trim().split(/\n\s*\n/);
  return blocks
    .filter(Boolean)
    .map((block) => {
      const record = {
        path: null,
        head: null,
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
      };
      for (const line of block.split(nulTerminated ? "\0" : "\n").filter(Boolean)) {
        const [key, ...rest] = line.split(" ");
        const value = rest.join(" ");
        if (key === "worktree") record.path = value;
        else if (key === "HEAD") record.head = value;
        else if (key === "branch") record.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "detached") record.detached = true;
        else if (key === "locked") record.locked = value || true;
        else if (key === "prunable") record.prunable = value || true;
      }
      return record;
    })
    .filter((record) => record.path);
}

function classifyLifecycle({
  pathClass,
  exists,
  sidecarValid,
  dirty,
  remotePreserved,
  remoteError,
}) {
  if (pathClass === "primary") return "reference";
  if (!exists) return "missing_path";
  if (
    pathClass !== "canonical"
    || !sidecarValid
    || dirty !== false
    || !remotePreserved
    || remoteError
  ) {
    return "needs_attention";
  }
  return "active";
}

async function validateSidecar(
  primaryRoot,
  authorityRoot,
  repositoryIdentity,
  record,
  sidecarPath,
) {
  let data;
  try {
    data = JSON.parse(await readFile(sidecarPath, "utf8"));
  } catch (error) {
    return {
      valid: false,
      error: `cannot parse JSON: ${error instanceof Error ? error.message : String(error)}`,
      planPath: null,
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, error: "root value is not an object", planPath: null };
  }
  if (data.schema_version !== "companiesascode.worktree.v1") {
    return { valid: false, error: "unsupported schema_version", planPath: null };
  }
  for (const field of [
    "organization",
    "organization_path",
    "workspace",
    "module",
    "module_path",
    "repo_kind",
    "base_branch",
    "branch",
    "mission_control_plan_code",
    "mission_control_plan_path",
    "worktree_path",
    "created_at",
    "created_by",
    "status",
  ]) {
    if (typeof data[field] !== "string" || data[field].trim() === "") {
      return { valid: false, error: `missing ${field}`, planPath: null };
    }
  }
  if (!repositoryIdentity) {
    return {
      valid: false,
      error: "cannot derive canonical Organization/module identity from origin",
      planPath: null,
    };
  }
  const canonicalIdentity = {
    organization: repositoryIdentity.organization,
    organization_path: ".",
    workspace: "root",
    module: repositoryIdentity.module,
    module_path: ".",
    repo_kind: "root_repo",
    base_branch: "main",
  };
  for (const [field, expected] of Object.entries(canonicalIdentity)) {
    if (data[field] !== expected) {
      return {
        valid: false,
        error: `${field} does not match canonical repository identity`,
        planPath: null,
      };
    }
  }
  if (data.branch !== record.branch) {
    return { valid: false, error: "branch does not match Git registry", planPath: null };
  }
  const declaredWorktree = isAbsolute(data.worktree_path)
    ? resolve(data.worktree_path)
    : resolve(primaryRoot, data.worktree_path);
  if (declaredWorktree !== resolve(record.path)) {
    return { valid: false, error: "worktree_path does not match Git registry", planPath: null };
  }
  if (isAbsolute(data.mission_control_plan_path)) {
    return { valid: false, error: "mission_control_plan_path must be relative", planPath: null };
  }
  const planPath = resolveAuthorityPlanPath(
    primaryRoot,
    data.mission_control_plan_path,
    authorityRoot,
  );
  const acceptedPlanRoots = [
    join(authorityRoot, "mission-control", "db", "data", "mission-control", "plans"),
    join(authorityRoot, "mission-control", "plans"),
  ];
  if (!acceptedPlanRoots.some((root) => isWithin(root, planPath))) {
    return {
      valid: false,
      error: "Mission Control plan is outside the HumanAndMachines authority",
      planPath,
    };
  }
  const planBasename = basename(planPath).replace(/\.ya?ml$/i, "");
  if (planBasename !== basename(record.path)) {
    return {
      valid: false,
      error: "worktree basename does not match canonical plan basename",
      planPath,
    };
  }
  const codeMatch = planBasename.match(/^([A-Z]{2,6}-[0-9]{4})(?:-|$)/);
  if (!codeMatch || codeMatch[1] !== data.mission_control_plan_code) {
    return { valid: false, error: "plan code does not match plan basename", planPath };
  }
  if (!record.branch.includes(data.mission_control_plan_code)) {
    return { valid: false, error: "branch does not contain Mission Control plan code", planPath };
  }
  const allowedRepoKinds = new Set([
    "module",
    "organization_root",
    "root_repo",
    "productionspace",
  ]);
  if (!allowedRepoKinds.has(data.repo_kind)) {
    return { valid: false, error: "repo_kind is not canonical", planPath };
  }
  const allowedStatuses = new Set([
    "active",
    "draft",
    "published_branch",
    "pr_open",
    "merged_cleanup_needed",
    "stale",
    "orphan_missing_plan",
    "invalid",
  ]);
  if (!allowedStatuses.has(data.status)) {
    return { valid: false, error: "status is not canonical", planPath };
  }
  if (Object.hasOwn(data, "pr_url") && data.pr_url !== null && typeof data.pr_url !== "string") {
    return { valid: false, error: "pr_url must be a string or null", planPath };
  }
  if (!Number.isFinite(Date.parse(data.created_at))) {
    return { valid: false, error: "created_at is not a date", planPath };
  }
  if (
    Object.hasOwn(data, "last_touched")
    && (
      typeof data.last_touched !== "string"
      || !Number.isFinite(Date.parse(data.last_touched))
    )
  ) {
    return { valid: false, error: "last_touched is not a date", planPath };
  }
  for (const field of ["purpose", "cleanup_rule"]) {
    if (
      Object.hasOwn(data, field)
      && (typeof data[field] !== "string" || data[field].trim() === "")
    ) {
      return { valid: false, error: `${field} must be a non-empty string`, planPath };
    }
  }
  const advisories = ["last_touched", "pr_url", "purpose", "cleanup_rule"]
    .filter((field) => !Object.hasOwn(data, field))
    .map((field) => `recommended operational field is missing: ${field}`);
  const authorityAvailable = await pathExists(authorityRoot);
  if (!authorityAvailable) {
    const error = "HumanAndMachines authority checkout is unavailable; plan ownership was not verified";
    advisories.push(error);
    return { valid: false, error, planPath, advisories };
  }
  try {
    const stat = await lstat(planPath);
    if (!stat.isFile()) {
      return { valid: false, error: "Mission Control plan is not a file", planPath, advisories };
    }
  } catch {
    return { valid: false, error: "Mission Control plan does not exist", planPath, advisories };
  }
  let plan;
  let planSource;
  try {
    planSource = await readFile(planPath, "utf8");
    plan = Bun.YAML.parse(planSource);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      error: `cannot parse Mission Control plan: ${reason}`,
      planPath,
      advisories,
    };
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      valid: false,
      error: "Mission Control plan root value is not an object",
      planPath,
      advisories,
    };
  }
  const schemaValidation = await validateCanonicalMissionControlPlan(
    authorityRoot,
    planPath,
    planSource,
    plan,
  );
  if (!schemaValidation.valid) {
    return {
      valid: false,
      error: schemaValidation.error,
      planPath,
      advisories,
    };
  }
  if (
    typeof plan.dev_code !== "string"
    || !/^[A-Z]{2,6}-[0-9]{4}$/.test(plan.dev_code)
  ) {
    return {
      valid: false,
      error: "Mission Control plan dev_code is not canonical",
      planPath,
      advisories,
    };
  }
  if (plan.dev_code !== data.mission_control_plan_code) {
    return {
      valid: false,
      error: "Mission Control plan dev_code does not match sidecar",
      planPath,
      advisories,
    };
  }
  return { valid: true, error: null, planPath, advisories };
}

async function resolveRepositoryIdentity(primaryRoot) {
  let remoteUrl;
  try {
    remoteUrl = await gitText(primaryRoot, ["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
  const normalized = remoteUrl.trim().replaceAll("\\", "/");
  const githubMatch = normalized.match(
    /github\.com(?::|\/)([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  const parts = normalized
    .replace(/^file:\/\//i, "")
    .replace(/\/$/, "")
    .split("/")
    .filter(Boolean);
  const organization = githubMatch?.[1] ?? parts.at(-2);
  const repository = (githubMatch?.[2] ?? parts.at(-1) ?? "")
    .replace(/\.git$/i, "");
  if (!organization || !repository) return null;
  return {
    organization,
    module: repository.replace(/_GEN[0-9]+$/i, ""),
  };
}

async function validateCanonicalMissionControlPlan(
  authorityRoot,
  planPath,
  planSource,
  plan,
) {
  const schemaPath = join(
    authorityRoot,
    "schemas",
    "mission-control-plan.schema.json",
  );
  const validatorPath = join(
    authorityRoot,
    "scripts",
    "json-schema-mini.mjs",
  );
  const semanticValidatorPath = join(
    authorityRoot,
    "scripts",
    "mission-control-lib.mjs",
  );
  try {
    const realAuthorityRoot = await realpath(authorityRoot);
    for (const path of [planPath, schemaPath, validatorPath, semanticValidatorPath]) {
      const stat = await lstat(path);
      const realPath = await realpath(path);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || !isWithin(realAuthorityRoot, realPath)
      ) {
        throw new Error("canonical validator path is not a file inside authority root");
      }
    }
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const validator = await import(pathToFileURL(validatorPath).href);
    if (typeof validator.validateAgainstSchema !== "function") {
      throw new Error("canonical schema validator export is unavailable");
    }
    const failures = validator.validateAgainstSchema(
      plan,
      schema,
      "Mission Control plan",
    );
    if (!Array.isArray(failures)) {
      throw new Error("canonical schema validator returned an invalid result");
    }
    if (failures.length > 0) {
      return {
        valid: false,
        error: `Mission Control plan schema validation failed: ${failures.slice(0, 3).join("; ")}`,
      };
    }
    const semanticValidator = await import(
      pathToFileURL(semanticValidatorPath).href
    );
    for (const exportName of [
      "loadMissionControlConfig",
      "loadPlanSchema",
      "validatePlanShape",
    ]) {
      if (typeof semanticValidator[exportName] !== "function") {
        throw new Error(`canonical semantic validator export is unavailable: ${exportName}`);
      }
    }
    const config = semanticValidator.loadMissionControlConfig(authorityRoot);
    const semanticSchema = semanticValidator.loadPlanSchema(authorityRoot, config);
    const record = {
      path: relative(authorityRoot, planPath).split(sep).join("/"),
      filePath: planPath,
      plan,
      source: planSource,
      parseError: null,
    };
    const semanticFailures = semanticValidator.validatePlanShape(
      record,
      config,
      authorityRoot,
      semanticSchema,
    );
    if (!Array.isArray(semanticFailures)) {
      throw new Error("canonical semantic validator returned an invalid result");
    }
    if (semanticFailures.length > 0) {
      return {
        valid: false,
        error: `Mission Control plan semantic validation failed: ${semanticFailures.slice(0, 3).join("; ")}`,
      };
    }
    return { valid: true, error: null };
  } catch (error) {
    return {
      valid: false,
      error: `cannot validate Mission Control plan schema: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function scanLocalOrphans(primaryRoot, commonDir, records, options = {}) {
  const registered = new Set(records.map((record) => resolve(record.path)));
  const found = [];
  const localBudget = {
    deadline: Date.now() + ORPHAN_SCAN_BUDGET_MS,
    remainingEntries: options.orphanLocalEntryBudget ?? ORPHAN_SCAN_ENTRY_BUDGET,
  };
  const globalBudget = {
    deadline: Date.now() + ORPHAN_SCAN_BUDGET_MS,
    remainingEntries: options.orphanGlobalEntryBudget ?? ORPHAN_SCAN_ENTRY_BUDGET,
  };
  const containers = [
    {
      path: join(primaryRoot, ".worktrees", "root"),
      pathClass: "canonical",
      skippedNames: new Set(),
    },
    {
      path: join(primaryRoot, ".worktrees"),
      pathClass: "legacy",
      skippedNames: new Set(["root"]),
      ownerOnly: false,
    },
    {
      path: join(primaryRoot, ".claude", "worktrees"),
      pathClass: "external",
      skippedNames: new Set(),
      ownerOnly: false,
    },
    {
      path: join(primaryRoot, ".codex-tmp"),
      pathClass: "external",
      skippedNames: new Set(),
      ownerOnly: false,
    },
    {
      path: join(primaryRoot, ".pr-worktrees"),
      pathClass: "external",
      skippedNames: new Set(),
      ownerOnly: false,
    },
    {
      path: dirname(primaryRoot),
      pathClass: "external",
      skippedNames: new Set([basename(primaryRoot)]),
      ownerOnly: true,
    },
    {
      path: join(homedir(), ".hermes", "worktrees"),
      pathClass: "external",
      skippedNames: new Set(),
      ownerOnly: true,
    },
    {
      path: tmpdir(),
      pathClass: "external",
      skippedNames: new Set(),
      ownerOnly: true,
    },
    {
      path: "/tmp",
      pathClass: "external",
      skippedNames: new Set(),
      ownerOnly: true,
    },
  ];
  let complete = true;
  let globalComplete = true;
  const seenContainers = new Set();
  for (const container of containers) {
    const containerPath = resolve(container.path);
    if (seenContainers.has(containerPath)) continue;
    seenContainers.add(containerPath);
    let directory;
    try {
      directory = await opendir(container.path);
    } catch {
      continue;
    }
    try {
      const budget = container.ownerOnly ? globalBudget : localBudget;
      for await (const entry of directory) {
        if (Date.now() >= budget.deadline || budget.remainingEntries <= 0) {
          if (container.ownerOnly) globalComplete = false;
          else complete = false;
          break;
        }
        budget.remainingEntries--;
        if (container.skippedNames.has(entry.name)) continue;
        const entryPath = join(container.path, entry.name);
        const locallyWorktreeLooking = entry.isDirectory() || entry.isSymbolicLink()
          ? await pathExists(join(entryPath, ".git"))
            || await pathExists(`${entryPath}.worktree.json`)
          : false;
        const worktreeLooking = container.ownerOnly
          ? await isLinkedToCommonDir(entryPath, commonDir)
          : locallyWorktreeLooking;
        if (worktreeLooking && !registered.has(resolve(entryPath))) {
          found.push({
            kind: "worktree directory",
            path_class: container.pathClass,
            path: entryPath,
          });
        }
        if (entry.isFile() && entry.name.endsWith(".worktree.json")) {
          const worktreeName = entry.name.slice(0, -".worktree.json".length);
          const expectedWorktree = resolve(container.path, worktreeName);
          const sidecarOwned = !container.ownerOnly
            || await isLinkedToCommonDir(expectedWorktree, commonDir);
          if (sidecarOwned && !registered.has(expectedWorktree)) {
            found.push({
              kind: "sidecar",
              path_class: container.pathClass,
              path: entryPath,
            });
          }
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { entries: found, complete, globalComplete };
}

async function isLinkedToCommonDir(worktreePath, commonDir) {
  const dotGitPath = join(worktreePath, ".git");
  let stat;
  try {
    stat = await lstat(dotGitPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  let content;
  try {
    content = await readFile(dotGitPath, "utf8");
  } catch {
    return false;
  }
  const match = content.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) return false;
  const gitDir = isAbsolute(match[1])
    ? resolve(match[1])
    : resolve(worktreePath, match[1]);
  return isWithin(commonDir, gitDir);
}

async function inspectRemoteState(worktreePath) {
  const upstream = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    worktreePath,
  );
  if (!upstream.ok) {
    return {
      upstream: null,
      ahead: null,
      behind: null,
      remoteName: null,
      remoteRef: null,
      remoteBranchExists: null,
      remoteHead: null,
      remoteHeadMatches: null,
      verified: false,
      preserved: false,
      error: upstream.timedOut
        ? "upstream lookup timed out"
        : upstream.stderr.trim() || "upstream lookup failed",
    };
  }
  const counts = await runGit(
    ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    worktreePath,
  );
  if (!counts.ok) {
    return {
      upstream: upstream.stdout.trim(),
      ahead: null,
      behind: null,
      remoteName: null,
      remoteRef: null,
      remoteBranchExists: null,
      remoteHead: null,
      remoteHeadMatches: null,
      verified: false,
      preserved: false,
      error: counts.timedOut
        ? "ahead/behind lookup timed out"
        : counts.stderr.trim() || "ahead/behind lookup failed",
    };
  }
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return {
      upstream: upstream.stdout.trim(),
      ahead: null,
      behind: null,
      remoteName: null,
      remoteRef: null,
      remoteBranchExists: null,
      remoteHead: null,
      remoteHeadMatches: null,
      verified: false,
      preserved: false,
      error: "ahead/behind output was invalid",
    };
  }
  const branch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath);
  if (!branch.ok) {
    return {
      upstream: upstream.stdout.trim(),
      ahead,
      behind,
      remoteName: null,
      remoteRef: null,
      remoteBranchExists: null,
      remoteHead: null,
      remoteHeadMatches: null,
      verified: false,
      preserved: false,
      error: branch.timedOut
        ? "branch lookup timed out"
        : branch.stderr.trim() || "branch lookup failed",
    };
  }
  const branchName = branch.stdout.trim();
  const remoteNameResult = await runGit(
    ["config", "--get", `branch.${branchName}.remote`],
    worktreePath,
  );
  const remoteRefResult = await runGit(
    ["config", "--get", `branch.${branchName}.merge`],
    worktreePath,
  );
  if (!remoteNameResult.ok || !remoteRefResult.ok) {
    return {
      upstream: upstream.stdout.trim(),
      ahead,
      behind,
      remoteName: remoteNameResult.ok ? remoteNameResult.stdout.trim() : null,
      remoteRef: remoteRefResult.ok ? remoteRefResult.stdout.trim() : null,
      remoteBranchExists: null,
      remoteHead: null,
      remoteHeadMatches: null,
      verified: false,
      preserved: false,
      error: "upstream remote/ref configuration is unavailable",
    };
  }
  const remoteName = remoteNameResult.stdout.trim();
  const remoteRef = remoteRefResult.stdout.trim();
  if (!remoteName || remoteName === "." || !remoteRef.startsWith("refs/heads/")) {
    return {
      upstream: upstream.stdout.trim(),
      ahead,
      behind,
      remoteName,
      remoteRef,
      remoteBranchExists: null,
      remoteHead: null,
      remoteHeadMatches: null,
      verified: false,
      preserved: false,
      error: "upstream does not identify a live remote branch",
    };
  }
  const liveRemote = await runGit(
    ["ls-remote", "--exit-code", "--heads", remoteName, remoteRef],
    worktreePath,
  );
  if (!liveRemote.ok) {
    const missing = liveRemote.exitCode === 2;
    return {
      upstream: upstream.stdout.trim(),
      ahead,
      behind,
      remoteName,
      remoteRef,
      remoteBranchExists: missing ? false : null,
      remoteHead: null,
      remoteHeadMatches: false,
      verified: missing,
      preserved: false,
      error: missing
        ? "live remote branch does not exist"
        : liveRemote.timedOut
        ? "live remote lookup timed out"
        : liveRemote.stderr.trim() || "live remote lookup failed",
    };
  }
  const remoteLine = liveRemote.stdout.trim().split(/\r?\n/).find(Boolean);
  const remoteHead = remoteLine?.split(/\s+/)[0] ?? "";
  const localHeadResult = await runGit(["rev-parse", "HEAD"], worktreePath);
  const objectFormatResult = await runGit(
    ["rev-parse", "--show-object-format"],
    worktreePath,
  );
  const objectIdLength = objectFormatResult.stdout.trim() === "sha1"
    ? 40
    : objectFormatResult.stdout.trim() === "sha256"
    ? 64
    : null;
  const localHead = localHeadResult.stdout.trim();
  if (
    !localHeadResult.ok
    || !objectFormatResult.ok
    || objectIdLength === null
    || !new RegExp(`^[0-9a-f]{${objectIdLength}}$`, "i").test(remoteHead)
    || !new RegExp(`^[0-9a-f]{${objectIdLength}}$`, "i").test(localHead)
  ) {
    return {
      upstream: upstream.stdout.trim(),
      ahead,
      behind,
      remoteName,
      remoteRef,
      remoteBranchExists: true,
      remoteHead: remoteHead || null,
      remoteHeadMatches: null,
      verified: false,
      preserved: false,
      error: "live remote HEAD verification failed",
    };
  }
  const remoteHeadMatches = remoteHead === localHead;
  return {
    upstream: upstream.stdout.trim(),
    ahead,
    behind,
    remoteName,
    remoteRef,
    remoteBranchExists: true,
    remoteHead,
    remoteHeadMatches,
    verified: true,
    preserved: remoteHeadMatches,
    error: remoteHeadMatches ? null : "live remote HEAD differs from local HEAD",
  };
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveAuthorityRoot(primaryRoot) {
  if (basename(primaryRoot) === "HumanAndMachines") return primaryRoot;
  if (process.env.HUMANANDMACHINES_ROOT) {
    return resolve(process.env.HUMANANDMACHINES_ROOT);
  }
  return join(dirname(primaryRoot), "HumanAndMachines");
}

export function resolveAuthorityPlanPath(primaryRoot, planPath, authorityRoot) {
  const resolvedAuthority = authorityRoot
    ? resolve(authorityRoot)
    : resolveAuthorityRoot(primaryRoot);
  return resolve(resolvedAuthority, planPath);
}

async function gitText(cwd, args) {
  const result = await runGit(args, cwd);
  if (!result.ok) {
    const reason = result.timedOut ? "timed out" : result.stderr.trim() || "unknown error";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${reason}`);
  }
  return result.stdout.trim();
}

async function runGit(args, cwd) {
  const env = { ...process.env };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_WORK_TREE",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
  });
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
    windowsHide: true,
  });
  let timedOut = false;
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolveTimeout(null);
    }, GIT_TIMEOUT_MS);
  });
  const exitCode = await Promise.race([proc.exited, timeout]);
  clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    ok: !timedOut && exitCode === 0,
    exitCode,
    stdout,
    stderr,
    timedOut,
  };
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(root, budget) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    if (Date.now() >= budget.deadline || budget.remainingEntries <= 0) {
      return { bytes: total, complete: false };
    }
    budget.remainingEntries--;
    const path = stack.pop();
    let stat;
    try {
      stat = await lstat(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      total += stat.size;
      continue;
    }
    let entries;
    try {
      entries = await readdir(path);
    } catch {
      continue;
    }
    for (const entry of entries) stack.push(join(path, entry));
  }
  return { bytes: total, complete: true };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "not measured";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatHuman(report) {
  const lines = [
    `Worktree audit: ${report.repository_root}`,
    `Canonical root: ${report.canonical_root}`,
    `Registered: ${report.summary.registered} · canonical ${report.summary.canonical} · legacy ${report.summary.legacy} · external ${report.summary.external}`,
  ];
  if (report.summary.disk_bytes !== null) {
    const qualifier = report.summary.disk_scan_complete ? "" : " (partial lower bound)";
    lines.push(`Measured worktree size: ${formatBytes(report.summary.disk_bytes)}${qualifier}`);
  }
  lines.push("");
  for (const worktree of report.worktrees) {
    const flags = [
      worktree.path_class,
      worktree.lifecycle,
      worktree.branch ?? "detached",
      worktree.dirty === true ? "dirty" : worktree.dirty === false ? "clean" : "unknown",
      worktree.sidecar_path && !worktree.sidecar_exists ? "missing-sidecar" : null,
      worktree.sidecar_exists && worktree.sidecar_valid === false ? "invalid-sidecar" : null,
      worktree.upstream ? `upstream:${worktree.upstream}` : worktree.branch ? "no-upstream" : null,
      (worktree.ahead ?? 0) > 0 ? `ahead:${worktree.ahead}` : null,
      (worktree.behind ?? 0) > 0 ? `behind:${worktree.behind}` : null,
      worktree.disk_bytes !== null
        ? `${formatBytes(worktree.disk_bytes)}${worktree.disk_scan_complete ? "" : "+"}`
        : null,
    ].filter(Boolean);
    lines.push(`- [${flags.join(" · ")}] ${worktree.path}`);
  }
  if (report.orphan_entries.length > 0) {
    lines.push("");
    lines.push("Unregistered local leftovers:");
    for (const orphan of report.orphan_entries) {
      lines.push(`- [${orphan.path_class} · ${orphan.kind}] ${orphan.path}`);
    }
  }
  if (!report.orphan_scan_complete) {
    lines.push("");
    lines.push("Bounded repo-local orphan scan: INCOMPLETE");
  }
  if (!report.global_orphan_scan_complete) {
    lines.push("");
    lines.push("Global leftover scan: PARTIAL (advisory only)");
  }
  lines.push("");
  if (report.violations.length === 0) {
    lines.push("Contract: PASS");
  } else {
    lines.push("Contract: NEEDS ATTENTION");
    for (const violation of report.violations) lines.push(`  - ${violation}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const check = args.includes("--check");
  const includeDisk = args.includes("--disk");
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
  if (rootIndex >= 0 && !root) {
    console.error("--root requires a path");
    process.exit(2);
  }
  try {
    const report = await auditRepository(root, { includeDisk });
    console.log(json ? JSON.stringify(report, null, 2) : formatHuman(report));
    if (check && report.violations.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
