import { existsSync } from "fs";
import { readFile, readdir, realpath } from "fs/promises";
import { basename, join, posix, relative, resolve } from "path";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import {
  inspectCanonicalPathBoundary,
  isPathDescendant,
} from "../../lazurio/core/path-boundary-lib.mjs";

// Mission Control v3 keeps its canonical filesystem database in a nested
// organization-local data checkout. The legacy root remains readable during
// migration, but no other organization-relative path may own a worktree.
const missionControlPlanRoots = [
  "mission-control/db/data/mission-control/plans",
  "mission-control/plans",
];
const planLinkItemFields = new Set(["label", "path", "url"]);

export async function buildMissionControlPlanIndex({
  companiesRoot,
  organization = null,
  module = null,
} = {}) {
  if (!companiesRoot) throw new Error("buildMissionControlPlanIndex requires companiesRoot");
  const inventory = await buildGitInventory({ companiesRoot });
  const realCompaniesRoot = await realpath(companiesRoot);
  const organizations = uniqueOrganizations(inventory.repos);
  const plans = [];
  for (const org of organizations) {
    if (organization && org.slug !== organization) continue;
    let realOrganizationRoot;
    try {
      realOrganizationRoot = await realpath(join(companiesRoot, org.path));
    } catch {
      continue;
    }
    if (!isPathDescendant(realCompaniesRoot, realOrganizationRoot)) continue;
    for (const planRoot of missionControlPlanRoots) {
      const plansRoot = join(companiesRoot, org.path, planRoot);
      if (!existsSync(plansRoot)) continue;
      const plansBoundary = await inspectCanonicalPathBoundary({
        rootPath: join(companiesRoot, org.path),
        rootRealPath: realOrganizationRoot,
        targetPath: plansRoot,
      });
      if (!plansBoundary.ok) continue;
      for (const file of await walkFiles(plansRoot, {
        rootRealPath: plansBoundary.targetRealPath,
      })) {
        if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
        const text = await readFile(file, "utf8");
        const plan = parsePlanFile({ companiesRoot, organization: org, file, text, module });
        if (module && plan.module_match === "none") continue;
        plans.push(plan);
      }
    }
  }
  plans.sort((a, b) => moduleRank(a.module_match) - moduleRank(b.module_match) || a.code.localeCompare(b.code));
  return {
    schema_version: "companiesascode.launchpad.mission_control_plans.v1",
    generated_at: new Date().toISOString(),
    plans,
  };
}

export async function readMissionControlPlanAt({ companiesRoot, organizationPath, planPath }) {
  if (!isMissionControlPlanPath(planPath)) return null;
  if (typeof organizationPath !== "string" || organizationPath.trim() !== organizationPath || organizationPath.includes("\0")) {
    return null;
  }

  const absoluteCompaniesRoot = resolve(companiesRoot);
  const organizationRoot = resolve(absoluteCompaniesRoot, organizationPath);
  if (!isPathDescendant(absoluteCompaniesRoot, organizationRoot)) return null;

  const planRoot = missionControlPlanRoots.find((root) => planPath.startsWith(`${root}/`));
  const absolutePlanRoot = resolve(organizationRoot, planRoot);
  const absolutePath = resolve(organizationRoot, planPath);
  if (!isPathDescendant(absolutePlanRoot, absolutePath)) return null;
  if (!existsSync(absolutePath)) return null;

  // Reject symlink escapes as well as lexical traversal. Nested data repos are
  // normal directories; a plan resolving outside its allowed root cannot own
  // a Launchpad worktree.
  try {
    const [realCompaniesRoot, realOrganizationRoot, realPlanRoot, realPlanPath] = await Promise.all([
      realpath(absoluteCompaniesRoot),
      realpath(organizationRoot),
      realpath(absolutePlanRoot),
      realpath(absolutePath),
    ]);
    if (!isPathDescendant(realCompaniesRoot, realOrganizationRoot)) return null;
    if (!isPathDescendant(realOrganizationRoot, realPlanRoot)) return null;
    if (!isPathDescendant(realPlanRoot, realPlanPath)) return null;
  } catch {
    return null;
  }

  const text = await readFile(absolutePath, "utf8");
  return parsePlanFile({
    companiesRoot,
    organization: { slug: basename(organizationPath).replace(/_GEN3$/, ""), path: organizationPath },
    file: absolutePath,
    text,
    module: null,
  });
}

export function isMissionControlPlanPath(planPath) {
  if (typeof planPath !== "string" || planPath === "" || planPath.trim() !== planPath) return false;
  if (planPath.includes("\\") || planPath.includes("\0") || planPath.startsWith("/")) return false;
  if (posix.normalize(planPath) !== planPath || !/\.ya?ml$/.test(planPath)) return false;
  return missionControlPlanRoots.some((root) => planPath.startsWith(`${root}/`));
}

function parsePlanFile({ companiesRoot, organization, file, text, module }) {
  const fileName = basename(file);
  const code = topLevelValue(text, "dev_code") ?? topLevelValue(text, "code") ?? fileName.match(/[A-Z]+-\d+/)?.[0] ?? fileName.replace(/\.ya?ml$/, "");
  const title = topLevelValue(text, "title") ?? topLevelValue(text, "name") ?? humanizeFileName(fileName);
  const status = topLevelValue(text, "status") ?? "unknown";
  const linkedPaths = topLevelLinkPaths(text);
  const plan = {
    code,
    organization: organization.slug,
    organization_path: organization.path,
    path: relative(companiesRoot, file).replace(/\\/g, "/"),
    organization_relative_path: relative(join(companiesRoot, organization.path), file).replace(/\\/g, "/"),
    title,
    status,
    module_match: module ? moduleMatch(linkedPaths, module) : "general",
  };
  // Public plan projection needs structured ownership evidence, but link paths
  // are internal resolver plumbing and must not expand the API payload.
  Object.defineProperty(plan, "linked_paths", {
    value: linkedPaths,
    enumerable: false,
  });
  return plan;
}

function moduleMatch(linkedPaths, module) {
  if (linkedPaths.some((path) => planPathBelongsToSlot(path, `modules/${module}`))) return "direct";
  if (linkedPaths.some((path) => planPathBelongsToSlot(path, `workspace/${module}`))) return "direct";
  return "none";
}

function topLevelLinkPaths(text) {
  const paths = [];
  let inLinks = false;
  let item = null;
  let invalid = false;
  const finishItem = () => {
    if (item?.path) paths.push(item.path);
    item = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!inLinks) {
      if (/^links:\s*(?:#.*)?$/.test(line)) inLinks = true;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*/.test(line)) {
      finishItem();
      break;
    }
    if (/^\s*(?:#.*)?$/.test(line)) continue;

    const itemStart = line.match(/^(\s*)-\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (itemStart) {
      finishItem();
      item = { indent: itemStart[1].length, fields: new Set(), path: null };
      if (!readLinkItemField(item, itemStart[2], itemStart[3])) invalid = true;
      if (invalid) break;
      continue;
    }

    const field = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!item || !field || field[1].length !== item.indent + 2) {
      invalid = true;
      break;
    }
    if (!readLinkItemField(item, field[2], field[3])) {
      invalid = true;
      break;
    }
  }
  if (inLinks && !invalid) finishItem();
  return invalid ? [] : [...new Set(paths)];
}

function readLinkItemField(item, key, rawValue) {
  if (!planLinkItemFields.has(key) || item.fields.has(key)) return false;
  item.fields.add(key);
  if (key !== "path") return true;
  const raw = rawValue.trim();
  if (!raw || raw === "|" || raw === ">" || raw === ">-") return false;
  item.path = canonicalPlanLinkPath(stripYamlScalar(raw));
  return Boolean(item.path);
}

function canonicalPlanLinkPath(value) {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")) return null;
  const path = value.split("#", 1)[0];
  if (!path || path.startsWith("/")) return null;
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized === "." || normalized.startsWith("../")) return null;
  return normalized;
}

function planPathBelongsToSlot(path, slotPath) {
  return path === slotPath || path.startsWith(`${slotPath}/`);
}

function topLevelValue(text, key) {
  const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`, "m");
  const match = text.match(pattern);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw || raw === "|" || raw === ">" || raw === ">-") return null;
  return stripYamlScalar(raw);
}

function stripYamlScalar(raw) {
  const quoted = raw.match(/^(["'])(.*)\1$/);
  if (quoted) return quoted[2];
  return raw.replace(/\s+#.*$/, "").trim();
}

async function walkFiles(root, { rootRealPath }) {
  const output = [];
  async function walk(current) {
    const directoryBoundary = await inspectCanonicalPathBoundary({
      rootPath: root,
      rootRealPath,
      targetPath: current,
      allowTargetEqual: true,
    });
    if (!directoryBoundary.ok) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      const entryBoundary = await inspectCanonicalPathBoundary({
        rootPath: root,
        rootRealPath,
        targetPath: path,
      });
      if (!entryBoundary.ok) continue;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        output.push(path);
      }
    }
  }
  await walk(root);
  return output;
}

function uniqueOrganizations(repos) {
  const bySlug = new Map();
  for (const repo of repos) {
    if (!bySlug.has(repo.organization)) {
      bySlug.set(repo.organization, { slug: repo.organization, path: repo.organization_path });
    }
  }
  return [...bySlug.values()];
}

function moduleRank(match) {
  if (match === "direct") return 0;
  if (match === "general") return 1;
  return 2;
}

function humanizeFileName(fileName) {
  return fileName.replace(/\.ya?ml$/, "").replace(/^[A-Z]+-\d+-/, "").split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
