import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitMaterializationEnv,
  safeGitRemoteArgs,
} from "./git-lib.mjs";
import {
  inspectCanonicalPathBoundary,
  isSamePath,
} from "./path-boundary-lib.mjs";

export const GIT_CLONE_TIMEOUT_MS = 120_000;

// Explicit sync/update action for an active manifest slot whose checkout is
// missing. Doctor remains read-only: it only reports missing_access. The
// trusted-local synchronization flow validates the manifest, confirms remote
// access, then lets Git create the missing checkout in its declared target.
export async function materializeRepoCheckout({
  companiesRoot,
  repo,
  deps = {},
} = {}) {
  if (!companiesRoot) throw new Error("materializeRepoCheckout requires companiesRoot");
  const { run = runGit } = deps;
  const validation = await validateMaterializationTarget({ companiesRoot, repo, run });
  if (!validation.ok) return validation;

  const {
    organizationRoot,
    targetPath,
    branch,
    remote,
  } = validation;
  if (await lstatOrNull(targetPath)) return targetExists();

  // Check access before clone so a missing/private remote does not leave a
  // newly-created target behind. The following clone is intentionally ordinary
  // Git pathname behavior under the trusted-local workspace contract.
  // Git reads local .git/config from cwd. Remote transport must therefore not
  // run from the Organization checkout, where core.gitProxy or protocol.ext
  // could execute before the source preflight returns. `-c core.gitProxy=`
  // does not override an existing local multi-value config, so the neutral cwd
  // is the actual configuration boundary.
  const transportCwd = await mkdtemp(join(tmpdir(), "launchpad-materialization-"));
  try {
    const source = await runMaterializationGit(
      run,
      ["ls-remote", "--exit-code", "--heads", "--", remote, `refs/heads/${branch}`],
      {
        cwd: transportCwd,
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
      },
    );
    if (!source.ok || !source.stdout) return missingAccess();

    // git clone accepts an existing empty directory. Claim the final target
    // atomically after remote preflight so ordinary concurrent syncs cannot
    // take over another process's declared manifest slot.
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await mkdir(targetPath);
    } catch (error) {
      if (error?.code === "EEXIST") return targetExists();
      return cloneFailure();
    }

    const clone = await runMaterializationGit(
      run,
      ["clone", "--branch", branch, "--single-branch", "--", remote, targetPath],
      {
        cwd: transportCwd,
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
      },
    );
    if (!clone.ok) return cloneFailure();
  } finally {
    await rm(transportCwd, { recursive: true, force: true });
  }

  const verification = await verifyClonedCheckout({
    path: targetPath,
    branch,
    remote,
    run,
  });
  if (!verification.ok) return verification;

  return {
    ok: true,
    outcome: "materialized",
    code: null,
    message: "Nový manifestovaný modul byl naklonovaný do deklarovaného targetu.",
    remote,
    branch,
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
    runMaterializationGit(run, ["rev-parse", "--show-toplevel"], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    runMaterializationGit(run, ["check-ignore", "--quiet", "--no-index", "--", `${targetPath}/`], {
      cwd: organizationRoot,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    }),
    runMaterializationGit(run, ["check-ref-format", "--branch", branch], {
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
    branch,
    remote,
  };
}

async function verifyClonedCheckout({ path, branch, remote, run }) {
  const options = {
    cwd: path,
    timeoutMs: GIT_LOCAL_TIMEOUT_MS,
  };
  const [root, currentBranch, origin, head, status] = await Promise.all([
    runMaterializationGit(run, ["rev-parse", "--show-toplevel"], options),
    runMaterializationGit(run, ["branch", "--show-current"], options),
    runMaterializationGit(run, ["remote", "get-url", "origin"], options),
    runMaterializationGit(run, ["rev-parse", "--verify", "HEAD^{commit}"], options),
    runMaterializationGit(run, ["status", "--porcelain=v1"], options),
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

function runMaterializationGit(run, args, options) {
  return run(safeGitRemoteArgs(args), {
    ...options,
    env: safeGitMaterializationEnv(),
  });
}

function targetExists() {
  return {
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_exists",
    message: "Cílová cesta už existuje; Launchpad ji nepřepíše ani nepřevezme.",
  };
}

function missingAccess() {
  return {
    ok: false,
    outcome: "missing_access",
    code: "materialization_source_unavailable",
    message: "Manifestované repo nebo jeho větev nejsou s aktuálními GitHub přístupy dostupné; nic se nenaklonovalo.",
  };
}

function cloneFailure() {
  return {
    ok: false,
    outcome: "failed",
    code: "materialization_clone_failed",
    message: "Git nedokončil klon manifestovaného modulu; případný částečný target zůstal pro kontrolu.",
  };
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
