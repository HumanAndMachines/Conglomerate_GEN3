#!/usr/bin/env bun

import { access, lstat, opendir, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";

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
  const records = parseWorktreePorcelain(
    await gitText(primaryRoot, ["worktree", "list", "--porcelain", "-z"]),
  );
  const orphanScan = await scanLocalOrphans(primaryRoot, commonDir, records);
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
      ? await validateSidecar(primaryRoot, record, sidecarPath)
      : { valid: false, error: "missing sidecar", planPath: null };
    const status = exists
      ? await runGit(["status", "--porcelain=v1", "--untracked-files=all"], record.path)
      : { ok: false, stdout: "", stderr: "missing path", timedOut: false };
    const remote = exists && record.branch
      ? await inspectRemoteState(record.path)
      : { upstream: null, ahead: null, behind: null, error: null };
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
      plan_path: sidecar.planPath,
      dirty,
      status_error: status.ok ? null : status.timedOut ? "git timeout" : status.stderr.trim(),
      upstream: remote.upstream,
      ahead: remote.ahead,
      behind: remote.behind,
      remote_error: remote.error,
      remote_preserved: remote.upstream !== null && remote.ahead === 0,
      disk_bytes: disk.bytes,
      disk_scan_complete: disk.complete,
      lifecycle: classifyLifecycle({
        pathClass,
        exists,
        sidecarValid: sidecar.valid,
        dirty,
        remotePreserved: remote.upstream !== null && remote.ahead === 0,
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

async function validateSidecar(primaryRoot, record, sidecarPath) {
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
    "last_touched",
    "status",
    "purpose",
    "cleanup_rule",
  ]) {
    if (typeof data[field] !== "string" || data[field].trim() === "") {
      return { valid: false, error: `missing ${field}`, planPath: null };
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
  const planPath = resolve(primaryRoot, data.mission_control_plan_path);
  const authorityRoot = basename(primaryRoot) === "HumanAndMachines"
    ? primaryRoot
    : process.env.HUMANANDMACHINES_ROOT
      ? resolve(process.env.HUMANANDMACHINES_ROOT)
      : join(dirname(primaryRoot), "HumanAndMachines");
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
  if (!Object.hasOwn(data, "pr_url") || (data.pr_url !== null && typeof data.pr_url !== "string")) {
    return { valid: false, error: "pr_url must be present as a string or null", planPath };
  }
  if (!Number.isFinite(Date.parse(data.created_at)) || !Number.isFinite(Date.parse(data.last_touched))) {
    return { valid: false, error: "created_at or last_touched is not a date", planPath };
  }
  try {
    const stat = await lstat(planPath);
    if (!stat.isFile()) {
      return { valid: false, error: "Mission Control plan is not a file", planPath };
    }
  } catch {
    return { valid: false, error: "Mission Control plan does not exist", planPath };
  }
  return { valid: true, error: null, planPath };
}

async function scanLocalOrphans(primaryRoot, commonDir, records) {
  const registered = new Set(records.map((record) => resolve(record.path)));
  const found = [];
  const budget = {
    deadline: Date.now() + ORPHAN_SCAN_BUDGET_MS,
    remainingEntries: ORPHAN_SCAN_ENTRY_BUDGET,
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
      for await (const entry of directory) {
        if (Date.now() >= budget.deadline || budget.remainingEntries <= 0) {
          complete = false;
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
    if (!complete) break;
  }
  return { entries: found, complete };
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
      error: upstream.timedOut ? "upstream lookup timed out" : null,
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
      error: "ahead/behind output was invalid",
    };
  }
  return {
    upstream: upstream.stdout.trim(),
    ahead,
    behind,
    error: null,
  };
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
    lines.push("Bounded orphan scan: INCOMPLETE");
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
