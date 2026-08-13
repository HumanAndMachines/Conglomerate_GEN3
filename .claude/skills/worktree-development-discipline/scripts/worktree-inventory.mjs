#!/usr/bin/env bun

import { access, lstat, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
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
      ? await inspectRemoteState(record.path, {
          allowFreshUnpublished: pathClass === "canonical" && sidecar.valid,
          baseRef: "origin/main",
        })
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
          freshUnpublished: false,
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
      conversation_origin: sidecar.conversationOrigin ?? null,
      recovery_handoff: sidecar.recoveryHandoff ?? null,
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
      fresh_unpublished: remote.freshUnpublished,
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
    if (
      worktree.path_class === "canonical"
      && worktree.branch
      && !worktree.upstream
      && !worktree.fresh_unpublished
    ) {
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
      fresh_unpublished: enriched.filter(
        (item) => item.path_class === "canonical" && item.fresh_unpublished,
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
  if (isPortableAbsolutePath(data.mission_control_plan_path)) {
    return { valid: false, error: "mission_control_plan_path must be relative", planPath: null };
  }
  const authority = await resolveSidecarAuthority(
    primaryRoot,
    authorityRoot,
    data.mission_control_authority_path,
  );
  if (!authority.valid) {
    return { valid: false, error: authority.error, planPath: null };
  }
  const effectiveAuthorityRoot = authority.root;
  const planPath = resolveAuthorityPlanPath(
    primaryRoot,
    data.mission_control_plan_path,
    effectiveAuthorityRoot,
  );
  const acceptedPlanRoots = await missionControlPlanRoots(effectiveAuthorityRoot);
  if (!acceptedPlanRoots.some((root) => isWithin(root, planPath))) {
    return {
      valid: false,
      error: "Mission Control plan is outside the declared authority",
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
  const conversationError = validateConversationOrigin(data.conversation_origin);
  if (conversationError) {
    return { valid: false, error: conversationError, planPath };
  }
  const recoveryError = validateRecoveryHandoff(data.recovery_handoff);
  if (recoveryError) {
    return { valid: false, error: recoveryError, planPath };
  }
  const advisories = [
    "last_touched",
    "pr_url",
    "purpose",
    "cleanup_rule",
    "conversation_origin",
    "recovery_handoff",
  ]
    .filter((field) => !Object.hasOwn(data, field))
    .map((field) => `recommended operational field is missing: ${field}`);
  const authorityAvailable = await pathExists(effectiveAuthorityRoot);
  if (!authorityAvailable) {
    const error = "Mission Control authority checkout is unavailable; plan ownership was not verified";
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
    effectiveAuthorityRoot,
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
  return {
    valid: true,
    error: null,
    planPath,
    advisories,
    conversationOrigin: data.conversation_origin ?? null,
    recoveryHandoff: data.recovery_handoff ?? null,
  };
}

async function resolveSidecarAuthority(primaryRoot, defaultAuthorityRoot, declaredPath) {
  if (declaredPath === undefined) {
    return { valid: true, error: null, root: defaultAuthorityRoot };
  }
  if (typeof declaredPath !== "string" || declaredPath.trim() === "") {
    return {
      valid: false,
      error: "mission_control_authority_path must be a non-empty relative path",
      root: null,
    };
  }
  if (isPortableAbsolutePath(declaredPath) || declaredPath.includes("\\")) {
    return {
      valid: false,
      error: "mission_control_authority_path must use a portable relative path",
      root: null,
    };
  }
  const segments = declaredPath.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || !/^organizations\/[^/]+\/mission-control\/db$/.test(declaredPath)
  ) {
    return {
      valid: false,
      error: "mission_control_authority_path must be organizations/<organization>/mission-control/db",
      root: null,
    };
  }

  let cursor = resolve(primaryRoot);
  try {
    for (const segment of segments) {
      cursor = join(cursor, segment);
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("authority path contains a symlink or non-directory component");
      }
    }
    const realPrimary = await realpath(primaryRoot);
    const realAuthority = await realpath(cursor);
    if (!isWithin(realPrimary, realAuthority)) {
      throw new Error("authority path escapes the Lazurio root");
    }

    const organizationRoot = join(primaryRoot, segments[0], segments[1]);
    const markerPath = join(organizationRoot, "company.gen3.json");
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error("Organization marker is not a regular file");
    }
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker?.organization_kind !== "organization") {
      throw new Error("authority owner is not a runtime Organization");
    }

    const manifestPath = join(cursor, "repository-db.manifest.json");
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error("repository-db manifest is not a regular file");
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest?.schema_version !== "companiesascode.repository_db.manifest.v1"
      || manifest?.data_mode !== "repository-db"
      || manifest?.data_root !== "data/mission-control"
    ) {
      throw new Error("repository-db manifest is not a canonical Mission Control authority");
    }
    return { valid: true, error: null, root: cursor };
  } catch (error) {
    return {
      valid: false,
      error: `Mission Control authority is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      root: null,
    };
  }
}

async function missionControlPlanRoots(authorityRoot) {
  const repositoryDbRoot = repositoryDbRootFromAuthority(authorityRoot);
  return [join(repositoryDbRoot, "data", "mission-control", "plans")];
}

function isPortableAbsolutePath(path) {
  return isAbsolute(path)
    || /^[A-Za-z]:[\\/]/.test(path)
    || path.startsWith("\\\\");
}

function validateConversationOrigin(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "conversation_origin must be an object";
  }
  if (typeof value.surface !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(value.surface)) {
    return "conversation_origin.surface is not canonical";
  }
  if (typeof value.agent_label !== "string" || value.agent_label.trim() === "") {
    return "conversation_origin.agent_label is missing";
  }
  if (!["captured", "unavailable", "not_applicable"].includes(value.thread_locator_status)) {
    return "conversation_origin.thread_locator_status is not canonical";
  }
  if (value.thread_locator_status === "captured") {
    if (typeof value.thread_id !== "string" || value.thread_id.trim() === "") {
      return "captured conversation_origin requires thread_id";
    }
  } else if (value.thread_id !== null) {
    return "non-captured conversation_origin must use null thread_id";
  }
  if (value.local_only !== true) return "conversation_origin.local_only must be true";
  if (!Number.isFinite(Date.parse(value.captured_at))) {
    return "conversation_origin.captured_at is not a date";
  }
  return null;
}

function validateRecoveryHandoff(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "recovery_handoff must be an object";
  }
  const states = new Set([
    "in_progress",
    "blocked",
    "paused",
    "ready_to_commit",
    "ready_to_push",
    "ready_for_pr",
    "ready_for_review",
    "completed",
  ]);
  if (!states.has(value.state)) return "recovery_handoff.state is not canonical";
  for (const field of ["summary", "next_action"]) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      return `recovery_handoff.${field} is missing`;
    }
  }
  if (value.blocker !== null && (typeof value.blocker !== "string" || value.blocker.trim() === "")) {
    return "recovery_handoff.blocker must be a non-empty string or null";
  }
  if (!Number.isFinite(Date.parse(value.updated_at))) {
    return "recovery_handoff.updated_at is not a date";
  }
  return null;
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

export async function validateCanonicalMissionControlPlan(
  authorityRoot,
  planPath,
  planSource,
  plan,
) {
  const repositoryDbRoot = repositoryDbRootFromAuthority(authorityRoot);
  const repositoryDbPlansRoot = join(
    repositoryDbRoot,
    "data",
    "mission-control",
    "plans",
  );
  if (!isWithin(repositoryDbPlansRoot, planPath)) {
    return {
      valid: false,
      error: "Mission Control plan is outside the canonical repository-db plan root",
    };
  }

  const manifestPath = join(repositoryDbRoot, "repository-db.manifest.json");
  const schemaPath = join(repositoryDbRoot, "schemas", "mission-control-plan.schema.json");
  const semanticValidatorPath = join(
    repositoryDbRoot,
    "scripts",
    "validate-mission-control-data.mjs",
  );

  try {
    const realRepositoryDbRoot = await realpath(repositoryDbRoot);
    const realRepositoryDbPlansRoot = await realpath(repositoryDbPlansRoot);
    const expectedRepositoryDbPlansRoot = join(
      realRepositoryDbRoot,
      "data",
      "mission-control",
      "plans",
    );
    if (realRepositoryDbPlansRoot !== expectedRepositoryDbPlansRoot) {
      throw new Error("canonical repository-db plan root resolves through a redirected path");
    }

    const expectedRealPaths = new Map([
      [
        manifestPath,
        join(realRepositoryDbRoot, "repository-db.manifest.json"),
      ],
      [
        planPath,
        resolve(
          realRepositoryDbPlansRoot,
          relative(repositoryDbPlansRoot, resolve(planPath)),
        ),
      ],
      [
        schemaPath,
        join(realRepositoryDbRoot, "schemas", "mission-control-plan.schema.json"),
      ],
      [
        semanticValidatorPath,
        join(
          realRepositoryDbRoot,
          "scripts",
          "validate-mission-control-data.mjs",
        ),
      ],
    ]);
    for (const [path, expectedRealPath] of expectedRealPaths) {
      const stat = await lstat(path);
      const realPath = await realpath(path);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || !isWithin(realRepositoryDbRoot, realPath)
        || realPath !== expectedRealPath
      ) {
        throw new Error("canonical repository-db path is redirected or outside authority root");
      }
    }

    if (await readFile(planPath, "utf8") !== planSource) {
      throw new Error("validated plan source does not match the authority checkout");
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest?.schema_version !== "companiesascode.repository_db.manifest.v1"
      || manifest?.data_mode !== "repository-db"
      || manifest?.data_root !== "data/mission-control"
    ) {
      throw new Error("repository-db manifest contract is invalid");
    }

    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const failures = validateAgainstSchema(plan, schema, "Mission Control plan");
    if (failures.length > 0) {
      return {
        valid: false,
        error: `Mission Control plan schema validation failed: ${failures.slice(0, 3).join("; ")}`,
      };
    }

    const expectedPlanId = typeof plan.dev_code === "string"
      ? `mcplan-${plan.dev_code.toLowerCase()}`
      : null;
    if (!expectedPlanId || plan.id !== expectedPlanId) {
      return {
        valid: false,
        error: "Mission Control plan id must match dev_code",
      };
    }

    const semanticValidator = await import(
      pathToFileURL(semanticValidatorPath).href
    );
    if (typeof semanticValidator.validateMissionControlData !== "function") {
      throw new Error(
        "canonical semantic validator export is unavailable: validateMissionControlData",
      );
    }
    const semanticFailures = semanticValidator.validateMissionControlData(repositoryDbRoot);
    if (!Array.isArray(semanticFailures)) {
      throw new Error("canonical semantic validator returned an invalid result");
    }
    if (semanticFailures.length > 0) {
      return {
        valid: false,
        error: `Mission Control repository-db semantic validation failed: ${semanticFailures.slice(0, 3).join("; ")}`,
      };
    }
    return { valid: true, error: null };
  } catch (error) {
    return {
      valid: false,
      error: `cannot validate Mission Control repository data: ${
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

async function inspectRemoteState(
  worktreePath,
  { allowFreshUnpublished = false, baseRef = "origin/main" } = {},
) {
  const upstream = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    worktreePath,
  );
  if (!upstream.ok) {
    const fresh = allowFreshUnpublished
      ? await inspectFreshUnpublishedState(worktreePath, baseRef)
      : null;
    if (fresh) return fresh;
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
      freshUnpublished: false,
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
    freshUnpublished: false,
    error: remoteHeadMatches ? null : "live remote HEAD differs from local HEAD",
  };
}

async function inspectFreshUnpublishedState(worktreePath, baseRef) {
  const [branch, localHead, baseHead] = await Promise.all([
    runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath),
    runGit(["rev-parse", "HEAD"], worktreePath),
    runGit(["rev-parse", "--verify", baseRef], worktreePath),
  ]);
  if (!branch.ok || !localHead.ok || !baseHead.ok) return null;
  if (localHead.stdout.trim() !== baseHead.stdout.trim()) return null;

  const slash = baseRef.indexOf("/");
  if (slash <= 0 || slash === baseRef.length - 1) return null;
  const remoteName = baseRef.slice(0, slash);
  const branchName = branch.stdout.trim();
  const liveBranch = await runGit(
    ["ls-remote", "--exit-code", "--heads", remoteName, `refs/heads/${branchName}`],
    worktreePath,
  );
  if (liveBranch.ok || liveBranch.exitCode !== 2) return null;

  return {
    upstream: null,
    ahead: 0,
    behind: 0,
    remoteName,
    remoteRef: null,
    remoteBranchExists: false,
    remoteHead: null,
    remoteHeadMatches: null,
    verified: true,
    preserved: true,
    freshUnpublished: true,
    error: null,
  };
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function repositoryDbRootFromAuthority(authorityRoot) {
  const candidate = resolve(authorityRoot);
  if (existsSync(join(candidate, "repository-db.manifest.json"))) return candidate;
  return join(candidate, "mission-control", "db");
}

export function resolveAuthorityRoot(primaryRoot) {
  if (process.env.MISSION_CONTROL_AUTHORITY_ROOT) {
    const candidate = resolve(process.env.MISSION_CONTROL_AUTHORITY_ROOT);
    const repositoryDbRoot = repositoryDbRootFromAuthority(candidate);
    if (existsSync(join(repositoryDbRoot, "repository-db.manifest.json"))) {
      return repositoryDbRoot;
    }
    return candidate;
  }
  return join(primaryRoot, ".mission-control-authority-unconfigured");
}

function validateAgainstSchema(value, schema, label) {
  const failures = validateSchemaVocabulary(schema, "schema");
  if (failures.length > 0) return failures;
  validateSchemaValue(value, schema, label, failures);
  return failures;
}

function validateSchemaVocabulary(node, path) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return [`${path}: schema node must be an object`];
  }
  const supported = new Set([
    "$id",
    "$schema",
    "additionalProperties",
    "const",
    "description",
    "enum",
    "items",
    "maxItems",
    "minItems",
    "minLength",
    "minimum",
    "pattern",
    "properties",
    "required",
    "title",
    "type",
    "uniqueItems",
  ]);
  const failures = [];
  for (const key of Object.keys(node)) {
    if (!supported.has(key)) failures.push(`${path}: unsupported schema keyword '${key}'`);
  }
  if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
    for (const [key, child] of Object.entries(node.properties)) {
      failures.push(...validateSchemaVocabulary(child, `${path}.properties.${key}`));
    }
  }
  if (node.items && typeof node.items === "object") {
    failures.push(...validateSchemaVocabulary(node.items, `${path}.items`));
  }
  if (
    node.additionalProperties
    && typeof node.additionalProperties === "object"
    && !Array.isArray(node.additionalProperties)
  ) {
    failures.push(
      ...validateSchemaVocabulary(node.additionalProperties, `${path}.additionalProperties`),
    );
  }
  return failures;
}

function validateSchemaValue(value, node, path, failures) {
  if (Object.hasOwn(node, "const") && stableStringify(value) !== stableStringify(node.const)) {
    failures.push(`${path}: const mismatch`);
  }
  if (
    Array.isArray(node.enum)
    && !node.enum.some((candidate) => stableStringify(candidate) === stableStringify(value))
  ) {
    failures.push(`${path}: value is outside enum`);
  }
  const actualType = Array.isArray(value)
    ? "array"
    : value === null
      ? "null"
      : Number.isInteger(value)
        ? "integer"
        : typeof value;
  if (node.type && actualType !== node.type) {
    failures.push(`${path}: expected ${node.type}`);
    return;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) failures.push(`${path}: missing required field '${key}'`);
    }
    const properties = node.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchemaValue(value[key], child, `${path}.${key}`, failures);
    }
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) continue;
      if (node.additionalProperties === false) failures.push(`${path}: unexpected field '${key}'`);
      else if (node.additionalProperties && typeof node.additionalProperties === "object") {
        validateSchemaValue(value[key], node.additionalProperties, `${path}.${key}`, failures);
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      failures.push(`${path}: expected at least ${node.minItems} items`);
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      failures.push(`${path}: expected at most ${node.maxItems} items`);
    }
    if (node.uniqueItems === true) {
      const serialized = value.map((item) => stableStringify(item));
      if (new Set(serialized).size !== serialized.length) failures.push(`${path}: items must be unique`);
    }
    if (node.items) {
      value.forEach((item, index) => validateSchemaValue(item, node.items, `${path}[${index}]`, failures));
    }
  }
  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      failures.push(`${path}: expected at least ${node.minLength} characters`);
    }
    if (node.pattern && !new RegExp(node.pattern).test(value)) {
      failures.push(`${path}: pattern mismatch`);
    }
  }
  if (typeof value === "number" && typeof node.minimum === "number" && value < node.minimum) {
    failures.push(`${path}: value is below minimum ${node.minimum}`);
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function resolveAuthorityPlanPath(primaryRoot, planPath, authorityRoot) {
  const resolvedAuthority = authorityRoot
    ? resolve(authorityRoot)
    : resolveAuthorityRoot(primaryRoot);
  const repositoryDbRoot = repositoryDbRootFromAuthority(resolvedAuthority);
  const normalized = planPath.replaceAll("\\", "/");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    return join(repositoryDbRoot, ".invalid-mission-control-plan-locator");
  }
  const legacyPrefixes = [
    "mission-control/db/data/mission-control/plans/",
    "mission-control/plans/",
    "data/mission-control/plans/",
  ];
  const prefix = legacyPrefixes.find((candidate) => normalized.startsWith(candidate));
  if (prefix) {
    return join(
      repositoryDbRoot,
      "data",
      "mission-control",
      "plans",
      normalized.slice(prefix.length),
    );
  }
  return resolve(repositoryDbRoot, normalized);
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
      worktree.fresh_unpublished
        ? "fresh-unpublished"
        : worktree.upstream
        ? `upstream:${worktree.upstream}`
        : worktree.branch
        ? "no-upstream"
        : null,
      (worktree.ahead ?? 0) > 0 ? `ahead:${worktree.ahead}` : null,
      (worktree.behind ?? 0) > 0 ? `behind:${worktree.behind}` : null,
      worktree.conversation_origin
        ? `thread:${worktree.conversation_origin.surface}:${shortThreadId(worktree.conversation_origin)}`
        : "thread:unknown",
      worktree.recovery_handoff ? `handoff:${worktree.recovery_handoff.state}` : "handoff:missing",
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

function shortThreadId(origin) {
  if (!origin || origin.thread_locator_status !== "captured" || !origin.thread_id) {
    return origin?.thread_locator_status ?? "unavailable";
  }
  const id = origin.thread_id;
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-6)}`;
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
