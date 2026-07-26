import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitMaterializationEnv,
} from "./git-lib.mjs";
import { runAnchoredMaterialization } from "./git-materialization-helper-lib.mjs";
import {
  inspectCanonicalPathBoundary,
  isSamePath,
} from "./path-boundary-lib.mjs";

export const GIT_CLONE_TIMEOUT_MS = 120_000;

// Explicit sync/update action for an active manifest slot whose checkout is
// missing. Doctor remains read-only: it only reports missing_access. This
// helper materializes exactly the manifest-declared repository and branch,
// while GitHub/Git credentials remain the only access authority.
export async function materializeRepoCheckout({
  companiesRoot,
  repo,
  deps = {},
} = {}) {
  if (!companiesRoot) throw new Error("materializeRepoCheckout requires companiesRoot");
  const {
    run = runGit,
    materializeAnchored = runAnchoredMaterialization,
    anchorTestHook = null,
  } = deps;

  const validation = await validateMaterializationTarget({ companiesRoot, repo, run });
  if (!validation.ok) return validation;

  const {
    organizationRoot,
    targetPath,
    slotSegments,
    branch,
    remote,
    organizationIdentity,
  } = validation;

  const anchored = await materializeAnchored({
    organizationRoot,
    organizationIdentity,
    slotSegments,
    branch,
    remote,
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
    testHook: anchorTestHook,
    platform: deps.platform,
    environment: deps.environment,
    pathExists: deps.pathExists,
    spawn: deps.spawn,
  });
  if (!anchored.ok) return anchored;

  const publishedTarget = await verifyPublishedTarget({
    targetPath,
    anchor: anchored.anchor,
  });
  if (!publishedTarget.ok) return publishedTarget;

  return anchored;
}

async function validateMaterializationTarget({ companiesRoot, repo, run }) {
  if (!repo || typeof repo !== "object") {
    return invalidTarget("Manifestovaný repo záznam chybí.");
  }
  if (repo.repo_kind === "organization_root") {
    return invalidTarget("Organization root se materializuje provisioningem, ne module sync akcí.");
  }
  const remote = typeof repo.repo === "string" ? repo.repo.trim() : "";
  const branch = typeof repo.expected_branch === "string" ? repo.expected_branch.trim() : "";
  const organizationPath = typeof repo.organization_path === "string" ? repo.organization_path.trim() : "";
  const slotPath = typeof repo.slot_path === "string" ? repo.slot_path.trim() : "";
  if (!remote || !branch || !organizationPath || !slotPath || !repo.absolute_path) {
    return invalidTarget("Aktivní manifestovaný slot nemá úplné repo, branch nebo path souřadnice.");
  }
  const slotSegments = slotPath.split("/");
  if (
    slotPath.includes("\\")
    || slotSegments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return invalidTarget("Manifestovaný slot nemá bezpečnou POSIX-relative cestu.");
  }

  const organizationRoot = resolve(companiesRoot, organizationPath);
  const targetPath = resolve(organizationRoot, slotPath);
  if (!isSamePath(targetPath, repo.absolute_path)) {
    return boundaryFailure("Manifestovaná cesta neodpovídá akčnímu Git inventáři.");
  }
  const boundary = await inspectCanonicalPathBoundary({
    rootPath: organizationRoot,
    targetPath,
    allowMissingTarget: true,
  });
  if (!boundary.ok) {
    return boundaryFailure("Manifestovaná cesta vede mimo kanonický root Organizace.");
  }
  let organizationIdentity;
  try {
    const stat = await lstat(organizationRoot, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return boundaryFailure("Organization root musí být přímý adresář s ověřitelnou identitou.");
    }
    organizationIdentity = {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
    };
  } catch {
    return boundaryFailure("Organization root nejde bezpečně ukotvit.");
  }

  const [rootCheck, ignoreCheck, refCheck] = await Promise.all([
    run(["rev-parse", "--show-toplevel"], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      env: safeGitMaterializationEnv(),
    }),
    // Directory-only ignore patterns (např. /workspace/*/) potřebují trailing
    // separator i pro zatím neexistující target.
    run(["check-ignore", "--quiet", "--no-index", "--", `${targetPath}/`], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      env: safeGitMaterializationEnv(),
    }),
    run(["check-ref-format", "--branch", branch], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      env: safeGitMaterializationEnv(),
    }),
  ]);
  if (!rootCheck.ok) {
    return invalidTarget("Organization mount není použitelný Git checkout.");
  }
  let realDeclaredRoot;
  let realOrganizationRoot;
  try {
    [realDeclaredRoot, realOrganizationRoot] = await Promise.all([
      realpath(rootCheck.stdout),
      realpath(organizationRoot),
    ]);
  } catch {
    return boundaryFailure("Git root Organizace nejde kanonicky ověřit.");
  }
  if (!isSamePath(realDeclaredRoot, realOrganizationRoot)) {
    return boundaryFailure("Manifestovaný checkout by nevznikl v kořenovém Git repu Organizace.");
  }
  if (!ignoreCheck.ok) {
    return invalidTarget("Manifestovaná checkout cesta není gitignored v Organization rootu.");
  }
  if (!refCheck.ok) {
    return invalidTarget("Manifest deklaruje neplatný název Git branche.");
  }
  return {
    ok: true,
    organizationRoot,
    targetPath,
    organizationIdentity,
    slotSegments,
    branch,
    remote,
  };
}

async function verifyPublishedTarget({ targetPath, anchor }) {
  const expectedDevice = typeof anchor?.device === "string" ? anchor.device : "";
  const expectedInode = typeof anchor?.inode === "string" ? anchor.inode : "";
  if (!expectedDevice || !expectedInode) {
    return boundaryFailure("Ukotvený helper nevrátil ověřitelnou identitu cíle.");
  }
  let stat;
  try {
    stat = await lstat(targetPath, { bigint: true });
  } catch {
    return boundaryFailure("Cílová pathname po ukotvené materializaci zmizela.");
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev.toString() !== expectedDevice
    || stat.ino.toString() !== expectedInode
  ) {
    return boundaryFailure("Cílová pathname po ukotvené materializaci neodpovídá drženému directory anchoru.");
  }
  return { ok: true };
}

function invalidTarget(message) {
  return {
    ok: false,
    outcome: "failed",
    code: "materialization_manifest_invalid",
    message,
  };
}

function boundaryFailure(message) {
  return {
    ok: false,
    outcome: "failed",
    code: "materialization_path_forbidden",
    message,
  };
}
