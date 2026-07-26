import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitRemoteEnv,
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
  } = validation;
  const existing = await lstatOrNull(targetPath);
  if (existing) {
    return {
      ok: false,
      outcome: "target_exists",
      code: "materialization_target_exists",
      message: "Cílová cesta už existuje; Launchpad ji nepřepíše ani nepřevezme.",
    };
  }

  // Přístup ověříme ještě před vytvořením targetu. Běžný access failure tak
  // nikdy nezanechá ani prázdný checkout, natož částečný klon.
  const source = await run(
    ["ls-remote", "--exit-code", "--heads", "--", remote, `refs/heads/${branch}`],
    {
      cwd: organizationRoot,
      timeoutMs: GIT_CLONE_TIMEOUT_MS,
      env: safeGitRemoteEnv(),
    },
  );
  if (!source.ok || !source.stdout) {
    return {
      ok: false,
      outcome: "missing_access",
      code: "materialization_source_unavailable",
      message: "Manifestované repo nebo jeho větev nejsou s aktuálními GitHub přístupy dostupné; nic se nenaklonovalo.",
    };
  }

  const anchored = await materializeAnchored({
    organizationRoot,
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

  // Helper drží parent i target jako no-follow directory handly po celou dobu
  // všech mkdir/Git zápisů. Teprve po jeho ukončení ověříme, že publikovaná
  // pathname stále ukazuje na checkout uvnitř stejného Organization rootu.
  const completedBoundary = await inspectCanonicalPathBoundary({
    rootPath: organizationRoot,
    targetPath,
  });
  if (!completedBoundary.ok) {
    return boundaryFailure(
      "Cílová pathname se během ukotvené materializace změnila; Launchpad ji nepublikoval ani nesmazal.",
    );
  }

  const verification = await verifyClonedCheckout({
    path: targetPath,
    branch,
    remote,
    run,
  });
  if (!verification.ok || verification.head !== anchored.head) {
    return verification.ok
      ? verificationFailure("Ukotvený helper a finální checkout nemají stejný HEAD.")
      : verification;
  }

  return {
    ...anchored,
    head: verification.head,
  };
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

  const [rootCheck, ignoreCheck, refCheck] = await Promise.all([
    run(["rev-parse", "--show-toplevel"], { cwd: organizationRoot, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    // Directory-only ignore patterns (např. /workspace/*/) potřebují trailing
    // separator i pro zatím neexistující target.
    run(["check-ignore", "--quiet", "--no-index", "--", `${targetPath}/`], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    run(["check-ref-format", "--branch", branch], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
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
    slotSegments,
    branch,
    remote,
  };
}

async function verifyClonedCheckout({ path, branch, remote, run }) {
  const [root, currentBranch, origin, head, status] = await Promise.all([
    run(["rev-parse", "--show-toplevel"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["branch", "--show-current"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["remote", "get-url", "origin"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    run(["status", "--porcelain=v1"], { cwd: path, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  if ([root, currentBranch, origin, head, status].some((result) => !result.ok)) {
    return verificationFailure("Naklonovaný checkout nejde spolehlivě ověřit.");
  }
  let realRoot;
  let realPath;
  try {
    [realRoot, realPath] = await Promise.all([realpath(root.stdout), realpath(path)]);
  } catch {
    return verificationFailure("Naklonovaný checkout nemá ověřitelný Git root.");
  }
  if (
    !isSamePath(realRoot, realPath)
    || currentBranch.stdout !== branch
    || origin.stdout !== remote
    || status.stdout !== ""
    || !/^[0-9a-f]{40}$/.test(head.stdout)
  ) {
    return verificationFailure("Naklonovaný checkout neodpovídá manifestovanému repu, branchi nebo čistému HEADu.");
  }
  return { ok: true, head: head.stdout };
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

function verificationFailure(message) {
  return {
    ok: false,
    outcome: "failed",
    code: "materialization_verification_failed",
    message,
  };
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
