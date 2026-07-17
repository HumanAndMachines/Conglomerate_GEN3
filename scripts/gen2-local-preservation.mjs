#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EVIDENCE_DIR = ".gen2-preservation";
const INCOMPLETE_FILE = "INCOMPLETE.json";
const MANIFEST_FILE = "manifest.json";
const SUCCESS_FILE = "SUCCESS.json";
const SCHEMA_VERSION = 1;
const REBUILDABLE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".astro",
  "coverage",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".vite",
  "__pycache__",
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizePath(path) {
  return resolve(path.replace(/^~(?=$|\/)/, homedir()));
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function containsOrganizationsSegment(path) {
  return normalizePath(path).split(sep).includes("organizations");
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertMode(path, expectedMode, label) {
  const info = await lstat(path);
  const actualMode = info.mode & 0o777;
  if (actualMode !== expectedMode) {
    const expected = expectedMode.toString(8).padStart(4, "0");
    const actual = actualMode.toString(8).padStart(4, "0");
    throw new Error(`${label} mode must be ${expected}, got ${actual}`);
  }
}

async function resolveProspectivePath(path) {
  const absolute = normalizePath(path);
  const missing = [];
  let cursor = absolute;
  while (!(await pathExists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`cannot resolve destination parent: ${absolute}`);
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const resolvedAncestor = await realpath(cursor);
  return join(resolvedAncestor, ...missing);
}

async function assertDirectory(path, message) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}

async function run(command, args, { cwd, allowFailure = false } = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", rejectRun);
    child.on("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0 && !allowFailure) {
        rejectRun(new Error(`${command} failed with exit ${code}: ${result.stderr.trim() || "no stderr"}`));
      } else {
        resolveRun(result);
      }
    });
  });
}

async function writePrivateJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function sha256File(path) {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

function entryClassification(relativePath) {
  const segments = relativePath.split("/");
  if (segments.includes(".git")) return "git-metadata";
  if (segments.some((segment) => REBUILDABLE_DIRS.has(segment))) return "rebuildable-cache";
  if (segments[0] === "ClientCompanies") return "quarantined-client-data";
  return "preserved-local-data";
}

async function isPortableSymlinkChain(root, startPath) {
  const queue = relative(root, startPath).split(sep).filter(Boolean);
  let resolvedSegments = [];
  const visited = new Set();
  for (let steps = 0; steps < 512; steps += 1) {
    if (queue.length === 0) return true;
    const segment = queue.shift();
    if (segment === ".") continue;
    if (segment === "..") {
      if (resolvedSegments.length === 0) return false;
      resolvedSegments.pop();
      continue;
    }
    const candidate = join(root, ...resolvedSegments, segment);
    let info;
    try {
      info = await lstat(candidate);
    } catch {
      return false;
    }
    if (!info.isSymbolicLink()) {
      resolvedSegments.push(segment);
      continue;
    }
    const target = await readlink(candidate);
    if (isAbsolute(target)) return false;
    const targetPath = resolve(dirname(candidate), target);
    if (!isWithin(root, targetPath)) return false;
    const marker = `${relative(root, candidate)}\0${target}`;
    if (visited.has(marker)) return false;
    visited.add(marker);
    const targetSegments = relative(root, targetPath).split(sep).filter(Boolean);
    queue.unshift(...targetSegments);
    resolvedSegments = [];
  }
  return false;
}

async function walkTree(root, { includeEntries = true } = {}) {
  root = await realpath(root);
  const entries = [];
  let count = 0;
  let logicalBytes = 0;
  let nonportableRebuildableSymlinks = 0;
  const stack = [""];

  while (stack.length > 0) {
    const relDir = stack.pop();
    const absoluteDir = relDir ? join(root, relDir) : root;
    const children = await readdir(absoluteDir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      const relativePath = relDir ? `${relDir}/${child.name}` : child.name;
      if (relativePath === EVIDENCE_DIR || relativePath.startsWith(`${EVIDENCE_DIR}/`)) continue;
      const absolutePath = join(root, ...relativePath.split("/"));
      const info = await lstat(absolutePath);
      const mode = info.mode & 0o7777;
      const classification = entryClassification(relativePath);
      count += 1;

      if (info.isDirectory()) {
        if (includeEntries) entries.push({ path: relativePath, type: "directory", mode, classification });
        stack.push(relativePath);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        const portable = await isPortableSymlinkChain(root, absolutePath);
        if (!portable && classification !== "rebuildable-cache") {
          throw new Error(`non-portable symlink outside rebuildable cache: ${relativePath}`);
        }
        if (!portable) nonportableRebuildableSymlinks += 1;
        if (includeEntries) entries.push({ path: relativePath, type: "symlink", mode, target, classification, portable });
      } else if (info.isFile()) {
        logicalBytes += info.size;
        const entry = {
          path: relativePath,
          type: "file",
          mode,
          size: info.size,
          mtime_ms: Math.trunc(info.mtimeMs),
          classification,
        };
        if (includeEntries && classification !== "rebuildable-cache") {
          entry.sha256 = await sha256File(absolutePath);
        }
        if (includeEntries) entries.push(entry);
      } else {
        if (includeEntries) entries.push({ path: relativePath, type: "special", mode, classification });
      }
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    count,
    logical_bytes: logicalBytes,
    nonportable_rebuildable_symlinks: nonportableRebuildableSymlinks,
    entries,
  };
}

function parseNullPairs(text) {
  if (!text) return [];
  const fields = text
    .split("\0")
    .map((field) => field.replace(/^[\r\n]+|[\r\n]+$/g, ""))
    .filter(Boolean);
  const pairs = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    pairs.push([fields[index], fields[index + 1]]);
  }
  return pairs;
}

async function gitRepoInventory(root, relativeRoot) {
  const cwd = relativeRoot === "." ? root : join(root, ...relativeRoot.split("/"));
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd, allowFailure: true });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;

  const headResult = await run("git", ["rev-parse", "HEAD"], { cwd, allowFailure: true });
  const branchResult = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    allowFailure: true,
  });
  const refsResult = await run(
    "git",
    ["for-each-ref", "--format=%(refname)%00%(objectname)%00", "refs/heads", "refs/remotes", "refs/tags", "refs/stash"],
    { cwd },
  );
  const stashResult = await run("git", ["stash", "list", "--format=%gd%x00%H%x00"], {
    cwd,
    allowFailure: true,
  });
  const statusResult = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", `:(exclude)${EVIDENCE_DIR}`],
    { cwd },
  );
  const indexResult = await run("git", ["ls-files", "--stage", "-z"], { cwd });
  try {
    await run("git", ["-c", "core.commitGraph=false", "fsck", "--connectivity-only", "--no-dangling"], { cwd });
  } catch (error) {
    throw new Error(`git fsck connectivity check failed for ${relativeRoot}: ${error.message}`);
  }

  const refs = parseNullPairs(refsResult.stdout).map(([name, object]) => ({ name, object }));
  refs.sort((a, b) => a.name.localeCompare(b.name));
  const stashes = parseNullPairs(stashResult.stdout).map(([selector, object]) => ({ selector, object }));
  const statusCounts = {};
  for (const line of statusResult.stdout.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2);
    statusCounts[code] = (statusCounts[code] ?? 0) + 1;
  }

  return {
    root: relativeRoot,
    branch: branchResult.code === 0 ? branchResult.stdout.trim() : null,
    head: headResult.code === 0 ? headResult.stdout.trim() : null,
    ref_count: refs.length,
    stash_count: stashes.length,
    status_count: Object.values(statusCounts).reduce((sum, value) => sum + value, 0),
    status_summary: statusCounts,
    status_hash: createHash("sha256").update(statusResult.stdout).digest("hex"),
    index_hash: createHash("sha256").update(indexResult.stdout).digest("hex"),
    object_connectivity: "ok",
    refs,
    stashes,
  };
}

async function discoverGitRepositories(root) {
  const roots = [];
  const stack = [""];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absoluteDir = relDir ? join(root, ...relDir.split("/")) : root;
    const children = await readdir(absoluteDir, { withFileTypes: true });
    if (children.some((child) => child.name === ".git")) roots.push(relDir || ".");

    for (const child of children) {
      if (!child.isDirectory() || child.name === ".git" || child.name === EVIDENCE_DIR) continue;
      const next = relDir ? `${relDir}/${child.name}` : child.name;
      stack.push(next);
    }
  }
  roots.sort();
  return roots;
}

async function walkGitdirPointers(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    const children = await readdir(directory, { withFileTypes: true });
    const gitEntry = children.find((child) => child.name === ".git");
    if (gitEntry?.isFile()) {
      await visit({ repoRoot: directory, gitFile: join(directory, ".git") });
    } else if (gitEntry && !gitEntry.isDirectory()) {
      throw new Error(`${relative(root, directory) || "."}: .git must be a file or directory`);
    }
    for (const child of children) {
      if (!child.isDirectory() || child.name === ".git" || child.name === EVIDENCE_DIR) continue;
      stack.push(join(directory, child.name));
    }
  }
}

async function assertSelfContainedGitdirPointers(root, { archive = false } = {}) {
  const realRoot = await realpath(root);
  const external = [];
  await walkGitdirPointers(realRoot, async ({ repoRoot, gitFile }) => {
    const raw = (await readFile(gitFile, "utf8")).trim();
    if (!raw.startsWith("gitdir:")) {
      external.push(`${relative(realRoot, repoRoot) || "."}: malformed .git file`);
      return;
    }
    const pointer = raw.slice("gitdir:".length).trim();
    const target = resolve(repoRoot, pointer);
    let realTarget;
    try {
      realTarget = await realpath(target);
    } catch {
      external.push(`${relative(realRoot, repoRoot) || "."}: missing gitdir target`);
      return;
    }
    // Absolute pointers remain bound to the source after copy even when their
    // current target is inside it. Relative pointers are safe only if the
    // preserved directory layout keeps the target inside the same archive.
    if (isAbsolute(pointer) || !isWithin(realRoot, realTarget)) {
      external.push(`${relative(realRoot, repoRoot) || "."}: external gitdir`);
    }
  });
  if (external.length > 0) {
    throw new Error(`${archive ? "archive" : "source"} contains external gitdir pointer(s): ${external.join(", ")}`);
  }
}

async function gitInventory(root) {
  const roots = await discoverGitRepositories(root);
  const repositories = [];
  for (const relativeRoot of roots) {
    const inventory = await gitRepoInventory(root, relativeRoot);
    if (inventory) repositories.push(inventory);
  }
  return { repositories };
}

function publicGitInventory(git) {
  return {
    repositories: git.repositories.map((repo) => ({
      root: repo.root,
      branch: repo.branch,
      head: repo.head,
      ref_count: repo.ref_count,
      stash_count: repo.stash_count,
      status_count: repo.status_count,
      status_summary: repo.status_summary,
      status_hash: repo.status_hash,
      index_hash: repo.index_hash,
      object_connectivity: repo.object_connectivity,
    })),
  };
}

function classificationSummary() {
  return {
    client_companies:
      "quarantined archive only; ClientCompanies are not activated into the Rozjedeme-ai Organization",
    activated_organization: false,
    archive_scope: "complete local fallback copy; activation into workspace/productionspace is a separate reviewed step",
  };
}

export async function buildInventory(source, { includeEntries = false, allowEvidenceDir = false } = {}) {
  const normalizedSource = normalizePath(source);
  await assertDirectory(normalizedSource, "source must exist and be a directory");
  if (!allowEvidenceDir && await pathExists(join(normalizedSource, EVIDENCE_DIR))) {
    throw new Error(`source contains reserved ${EVIDENCE_DIR} path`);
  }
  const git = await gitInventory(normalizedSource);
  // Git commands (zejména status) mohou refreshnout index. File/hash snapshot
  // proto vzniká až po nich, aby source i archive porovnávaly stabilní stav.
  const files = await walkTree(normalizedSource, { includeEntries });
  if (includeEntries) {
    const gitMetadataEntries = files.entries
      .filter((entry) => entry.classification === "git-metadata" && !isNormalizedGitMetadataEntry(entry))
      .map(comparableFileEntry);
    files.git_metadata_hash = createHash("sha256")
      .update(JSON.stringify(gitMetadataEntries))
      .digest("hex");
  }
  return {
    schema_version: SCHEMA_VERSION,
    source: normalizedSource,
    files,
    git,
    classification: classificationSummary(),
  };
}

async function validatePaths({ source, destination, personalspaceRoot, requireDestination = false }) {
  const normalizedSource = normalizePath(source);
  const normalizedDestination = normalizePath(destination);
  const normalizedPersonalspaceRoot = normalizePath(personalspaceRoot);

  await assertDirectory(normalizedSource, "source must exist and be a directory");
  await assertDirectory(normalizedPersonalspaceRoot, "personalspace root must exist and be a directory");

  if (containsOrganizationsSegment(normalizedDestination)) {
    throw new Error("destination must not be inside organizations; private/client data belongs in personalspace custody");
  }

  const realSource = await realpath(normalizedSource);
  const realPersonalspaceRoot = await realpath(normalizedPersonalspaceRoot);
  const resolvedDestination = await resolveProspectivePath(normalizedDestination);

  if (containsOrganizationsSegment(realPersonalspaceRoot) || containsOrganizationsSegment(resolvedDestination)) {
    throw new Error("resolved destination must not be inside organizations; private/client data belongs in personalspace custody");
  }

  if (isWithin(realSource, resolvedDestination)) {
    throw new Error("destination must not be inside source");
  }
  if (!isWithin(realPersonalspaceRoot, resolvedDestination) || resolvedDestination === realPersonalspaceRoot) {
    throw new Error("destination must stay under the explicit personalspace root");
  }

  const exists = await pathExists(normalizedDestination);
  if (requireDestination && !exists) throw new Error("destination archive does not exist");
  if (!requireDestination && exists) throw new Error("destination must not exist");

  return {
    source: realSource,
    destination: resolvedDestination,
    personalspaceRoot: realPersonalspaceRoot,
  };
}

export async function probeCloneCapability(destinationParent) {
  const root = await mkdtemp(join(destinationParent, ".clone-probe-"));
  try {
    const source = join(root, "source.bin");
    const clone = join(root, "clone.bin");
    await writeFile(source, Buffer.alloc(1024 * 1024, 0x5a), { mode: 0o600 });
    const result = await run("/bin/cp", ["-c", "-p", source, clone], { allowFailure: true });
    if (result.code !== 0) return false;
    const [sourceInfo, cloneInfo] = await Promise.all([stat(source), stat(clone)]);
    if (sourceInfo.size !== cloneInfo.size) return false;
    return (await sha256File(source)) === (await sha256File(clone));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function defaultCopyTree({ source, destination, cloneOnWrite }) {
  const args = cloneOnWrite ? ["-c", "-R", "-p", `${source}/.`, destination] : ["-R", "-p", `${source}/.`, destination];
  await run("/bin/cp", args);
}

function comparableFileEntry(entry) {
  const comparable = {
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    classification: entry.classification,
  };
  if (entry.type === "file") {
    comparable.size = entry.size;
    comparable.mtime_ms = entry.mtime_ms;
    if (entry.sha256) comparable.sha256 = entry.sha256;
  }
  if (entry.type === "symlink") {
    comparable.target = entry.target;
    comparable.portable = entry.portable;
  }
  return comparable;
}

function isNormalizedGitMetadataEntry(entry) {
  if (entry.classification !== "git-metadata" || entry.type !== "file") return false;
  const name = basename(entry.path);
  return (
    name === "index" ||
    name.startsWith("sharedindex.") ||
    name === "fsmonitor--daemon.ipc" ||
    name.endsWith(".lock")
  );
}

function gitComparable(repo) {
  return {
    root: repo.root,
    branch: repo.branch,
    head: repo.head,
    status_count: repo.status_count,
    status_summary: repo.status_summary,
    status_hash: repo.status_hash,
    index_hash: repo.index_hash,
    object_connectivity: repo.object_connectivity,
    refs: repo.refs,
    stashes: repo.stashes,
  };
}

function compareInventories(sourceInventory, destinationInventory) {
  // Git object databases, refs and reflogs are compared structurally below.
  // Comparing their implementation files first would turn a ref drift into a
  // generic file error and would also make linked-worktree metadata brittle.
  const sourceEntries = new Map(
    sourceInventory.files.entries
      .filter((entry) => entry.classification !== "git-metadata")
      .map((entry) => [entry.path, comparableFileEntry(entry)]),
  );
  const destinationEntries = new Map(
    destinationInventory.files.entries
      .filter((entry) => entry.classification !== "git-metadata")
      .map((entry) => [entry.path, comparableFileEntry(entry)]),
  );

  for (const [path, sourceEntry] of sourceEntries) {
    const destinationEntry = destinationEntries.get(path);
    if (!destinationEntry) throw new Error(`file inventory drift: missing archive path ${path}`);
    if (sourceEntry.type !== destinationEntry.type) {
      throw new Error(`file inventory drift: type changed for ${path}`);
    }
    if (sourceEntry.mode !== destinationEntry.mode) throw new Error(`mode changed for ${path}`);
    if (sourceEntry.type === "symlink" && sourceEntry.target !== destinationEntry.target) {
      throw new Error(`symlink target changed for ${path}`);
    }
    if (sourceEntry.type === "file") {
      if (sourceEntry.size !== destinationEntry.size) throw new Error(`file inventory drift: size changed for ${path}`);
      if (sourceEntry.sha256 && sourceEntry.sha256 !== destinationEntry.sha256) {
        throw new Error(`file inventory drift: content changed for ${path}`);
      }
    }
  }
  for (const path of destinationEntries.keys()) {
    if (!sourceEntries.has(path)) throw new Error(`file inventory drift: archive-only path ${path}`);
  }

  const sourceGit = sourceInventory.git.repositories.map(gitComparable);
  const destinationGit = destinationInventory.git.repositories.map(gitComparable);
  if (JSON.stringify(sourceGit) !== JSON.stringify(destinationGit)) {
    throw new Error("Git repository inventory drift");
  }
  if (sourceInventory.files.git_metadata_hash !== destinationInventory.files.git_metadata_hash) {
    throw new Error("Git metadata drift");
  }
}

export async function verifyPreservation({ source, destination, personalspaceRoot, refreshSuccess = false }) {
  const paths = await validatePaths({
    source,
    destination,
    personalspaceRoot,
    requireDestination: true,
  });
  await assertSelfContainedGitdirPointers(paths.source);
  await assertSelfContainedGitdirPointers(paths.destination, { archive: true });
  const evidenceDir = join(paths.destination, EVIDENCE_DIR);
  const manifestPath = join(evidenceDir, MANIFEST_FILE);
  const successPath = join(evidenceDir, SUCCESS_FILE);
  await assertMode(paths.destination, 0o700, "archive root");
  await assertMode(evidenceDir, 0o700, "archive evidence directory");
  if (!(await pathExists(manifestPath))) throw new Error("archive manifest is missing");
  await assertMode(manifestPath, 0o600, "archive manifest");
  if (refreshSuccess) {
    if (!(await pathExists(successPath))) throw new Error("archive success marker is missing");
    await assertMode(successPath, 0o600, "archive success marker");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.source !== paths.source || manifest.destination !== paths.destination) {
    throw new Error("archive manifest source/destination does not match the requested verification");
  }

  const [sourceInventory, destinationInventory] = await Promise.all([
    buildInventory(paths.source, { includeEntries: true }),
    buildInventory(paths.destination, { includeEntries: true, allowEvidenceDir: true }),
  ]);
  compareInventories(sourceInventory, destinationInventory);
  const result = {
    command: "verify",
    verified: true,
    source: paths.source,
    destination: paths.destination,
    files: {
      count: sourceInventory.files.count,
      logical_bytes: sourceInventory.files.logical_bytes,
      nonportable_rebuildable_symlinks: sourceInventory.files.nonportable_rebuildable_symlinks,
    },
    git: publicGitInventory(sourceInventory.git),
    classification: classificationSummary(),
  };
  if (refreshSuccess) {
    await writePrivateJson(successPath, {
      schema_version: SCHEMA_VERSION,
      status: "verified",
      verified_at: nowIso(),
      source: paths.source,
      destination: paths.destination,
      copy_strategy: manifest.copy_strategy,
      verification_contract: "files-git-connectivity-v2",
      manifest_sha256: await sha256File(manifestPath),
    });
  }
  return result;
}

export async function applyPreservation(
  { source, destination, personalspaceRoot, allowFullCopy = false },
  dependencies = {},
) {
  const paths = await validatePaths({ source, destination, personalspaceRoot });
  await assertSelfContainedGitdirPointers(paths.source);
  // Reserved evidence-path collisions, Git connectivity and symlink portability
  // are validated before the destination is created, so failures cannot leave
  // behind a huge partial archive.
  await buildInventory(paths.source, { includeEntries: false });
  const platform = dependencies.platform ?? process.platform;
  const cloneProbe = dependencies.cloneProbe ?? probeCloneCapability;
  const copyTree = dependencies.copyTree ?? defaultCopyTree;
  const evidenceDir = join(paths.destination, EVIDENCE_DIR);
  const incompletePath = join(evidenceDir, INCOMPLETE_FILE);
  const manifestPath = join(evidenceDir, MANIFEST_FILE);
  const successPath = join(evidenceDir, SUCCESS_FILE);

  await mkdir(paths.destination, { recursive: true, mode: 0o700 });
  await chmod(paths.destination, 0o700);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await chmod(evidenceDir, 0o700);
  await writePrivateJson(incompletePath, {
    schema_version: SCHEMA_VERSION,
    status: "incomplete",
    started_at: nowIso(),
    source: paths.source,
    destination: paths.destination,
  });

  try {
    const cloneOnWrite = platform === "darwin" ? await cloneProbe(dirname(paths.destination)) : false;
    if (!cloneOnWrite && !allowFullCopy) {
      throw new Error(
        "copy-on-write clone is unavailable; refusing a full copy without --allow-full-copy and an explicit free-space review",
      );
    }

    await copyTree({
      source: paths.source,
      destination: paths.destination,
      cloneOnWrite,
    });
    await assertSelfContainedGitdirPointers(paths.destination, { archive: true });
    await chmod(paths.destination, 0o700);

    const sourceInventory = await buildInventory(paths.source, { includeEntries: true });
    const manifest = {
      schema_version: SCHEMA_VERSION,
      created_at: nowIso(),
      source: paths.source,
      destination: paths.destination,
      copy_strategy: cloneOnWrite ? "apfs-clone-on-write" : "explicit-full-copy",
      files: sourceInventory.files,
      git: sourceInventory.git,
      classification: classificationSummary(),
    };
    await writePrivateJson(manifestPath, manifest);

    const verified = await verifyPreservation(paths);
    await writePrivateJson(successPath, {
      schema_version: SCHEMA_VERSION,
      status: "verified",
      verified_at: nowIso(),
      source: paths.source,
      destination: paths.destination,
      copy_strategy: manifest.copy_strategy,
      verification_contract: "files-git-connectivity-v2",
      manifest_sha256: await sha256File(manifestPath),
    });
    await rm(incompletePath, { force: true });

    return {
      command: "apply",
      verified: true,
      source: paths.source,
      destination: paths.destination,
      copy_strategy: manifest.copy_strategy,
      files: verified.files,
      git: verified.git,
      classification: classificationSummary(),
    };
  } catch (error) {
    await rm(successPath, { force: true }).catch(() => {});
    throw error;
  }
}

function parseCli(argv) {
  const args = [...argv];
  let command = "inventory";
  if (args[0] && !args[0].startsWith("--")) command = args.shift();
  if (!["inventory", "apply", "verify"].includes(command)) throw new Error(`unknown command: ${command}`);

  const options = { command, allowFullCopy: false };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--allow-full-copy") {
      options.allowFullCopy = true;
      continue;
    }
    if (!["--source", "--destination", "--personalspace-root"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = args.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--source") options.source = value;
    if (flag === "--destination") options.destination = value;
    if (flag === "--personalspace-root") options.personalspaceRoot = value;
  }
  if (!options.source) throw new Error("--source is required");
  if (command !== "inventory") {
    if (!options.destination) throw new Error("--destination is required");
    if (!options.personalspaceRoot) throw new Error("--personalspace-root is required");
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  let result;
  if (options.command === "inventory") {
    const inventory = await buildInventory(options.source, { includeEntries: false });
    result = {
      schema_version: SCHEMA_VERSION,
      command: "inventory",
      dry_run: true,
      source: inventory.source,
      files: {
        count: inventory.files.count,
        logical_bytes: inventory.files.logical_bytes,
        nonportable_rebuildable_symlinks: inventory.files.nonportable_rebuildable_symlinks,
      },
      git: publicGitInventory(inventory.git),
      classification: inventory.classification,
    };
  } else if (options.command === "apply") {
    result = await applyPreservation(options);
  } else {
    result = await verifyPreservation({ ...options, refreshSuccess: true });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isDirect = process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  main().catch((error) => {
    process.stderr.write(`gen2-local-preservation: ${error.message}\n`);
    process.exitCode = 1;
  });
}
