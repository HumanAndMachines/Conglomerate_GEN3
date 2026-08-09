import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";
import {
  inspectCanonicalPathBoundary,
  isSamePath,
} from "./path-boundary-lib.mjs";

export const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;

const GENERATED_RESIDUE_DIRECTORIES = new Set([
  "node_modules",
  ".astro",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vite",
  ".cache",
  ".turbo",
]);
const AMBIGUOUS_OUTPUT_DIRECTORIES = new Set(["build", "dist", "out"]);

// Explicit sync/update action for an active manifest slot whose checkout is
// missing. Doctor remains read-only: it only reports missing_access. This
// helper materializes exactly the manifest-declared repository and branch.
// The explicit update action owns the write; GitHub credentials remain the
// only access authority and app dependencies stay in Launchpad's app lifecycle.
export async function materializeRepoCheckout({
  companiesRoot,
  repo,
  deps = {},
} = {}) {
  if (!companiesRoot) throw new Error("materializeRepoCheckout requires companiesRoot");
  const {
    run = runGit,
    makeDirectory = mkdir,
    makeTempDirectory = mkdtemp,
    makeRecoveryDirectory = mkdtemp,
    move = rename,
    remove = rm,
    recoveryStateRoot = defaultRecoveryStateRoot(),
    now = () => new Date(),
  } = deps;

  const validation = await validateMaterializationTarget({ companiesRoot, repo, run });
  if (!validation.ok) return validation;

  const {
    organizationRoot,
    targetPath,
    branch,
    remote,
  } = validation;

  const existingTarget = await lstatOrNull(targetPath);
  if (
    existingTarget
    && !(await isGeneratedOnlyMigrationResidue(targetPath))
  ) {
    return targetExists(
      "Cílová cesta už existuje, není samostatným Git checkoutem a obsahuje neznámá nebo uživatelská data; Launchpad ji nepřepíše ani nepřesune.",
    );
  }

  const targetParent = dirname(targetPath);
  let transportCwd = null;
  let residueRecovery = null;
  try {
    transportCwd = await makeTempDirectory(join(tmpdir(), "launchpad-materialization-"));
    // Probe access from a neutral cwd so the Organization checkout cannot
    // supply transport configuration. A missing/private source leaves no
    // manifest target behind.
    const source = await run(
      ["ls-remote", "--exit-code", "--heads", "--", remote, `refs/heads/${branch}`],
      {
        cwd: transportCwd,
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
        env: safeGitRemoteEnv(),
      },
    );
    if (!source.ok || !source.stdout) return missingAccess();

    await makeDirectory(targetParent, { recursive: true });
    const parentBoundary = await inspectCanonicalPathBoundary({
      rootPath: organizationRoot,
      targetPath: targetParent,
      allowMissingTarget: false,
      allowTargetEqual: true,
    });
    if (!parentBoundary.ok) {
      return boundaryFailure("Rodič cílového checkoutu vede mimo kanonický root Organizace.");
    }

    if (existingTarget) {
      residueRecovery = await quarantineGeneratedResidue({
        targetPath,
        repo,
        recoveryStateRoot,
        now,
        makeDirectory,
        makeRecoveryDirectory,
        move,
        remove,
      });
      if (!residueRecovery.ok) {
        return recoveryFailure(
          "Cílová cesta se během kontroly změnila nebo bezpečné odložení rozpoznaných odvozených artefaktů selhalo; nic se neklonovalo.",
          residueRecovery.recoveryDirectory,
        );
      }
    }

    // Claim the final path atomically. Concurrent update actions can observe
    // the target, but never overwrite or adopt each other's checkout.
    try {
      await makeDirectory(targetPath);
    } catch (error) {
      if (residueRecovery) {
        const restored = await restoreGeneratedResidue({
          targetPath,
          recoveryPath: residueRecovery.recoveryPath,
          move,
        });
        if (!restored) {
          return recoveryFailure(
            "Cílovou cestu mezitím převzala jiná operace; původní odvozené artefakty zůstávají v recovery a je potřeba je zkontrolovat ručně.",
            residueRecovery.recoveryDirectory,
          );
        }
      }
      if (error?.code === "EEXIST") return targetExists();
      return cloneFailure();
    }

    const clone = await run(
      [
        "clone",
        "--branch",
        branch,
        "--single-branch",
        "--origin",
        "origin",
        "--",
        remote,
        targetPath,
      ],
      {
        cwd: transportCwd,
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
        env: safeGitRemoteEnv(),
      },
    );
    if (!clone.ok) {
      if (residueRecovery) {
        return rollbackMaterializationFailure({
          targetPath,
          residueRecovery,
          move,
          message:
            "Git clone selhal; původní odvozené artefakty byly obnoveny a neúplný clone zůstal v recovery.",
          failureCode: "materialization_clone_failed",
        });
      }
      return cloneFailure();
    }

    const verification = await verifyClonedCheckout({
      path: targetPath,
      branch,
      remote,
      run,
    });
    if (!verification.ok) {
      if (residueRecovery) {
        return rollbackMaterializationFailure({
          targetPath,
          residueRecovery,
          move,
          message:
            "Naklonovaný checkout neprošel ověřením; původní odvozené artefakty byly obnoveny a neplatný clone zůstal v recovery.",
          failureCode: "materialization_verification_failed",
        });
      }
      return verification;
    }

    return {
      ok: true,
      outcome: "materialized",
      code: null,
      message: "Nový manifestovaný modul byl naklonovaný do deklarovaného targetu.",
      branch,
      head: verification.head,
      remote,
      residue_recovery_path: residueRecovery?.recoveryPath ?? null,
    };
  } catch {
    return cloneFailure();
  } finally {
    if (transportCwd) {
      await remove(transportCwd, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function generatedResiduePathAllowed(relativePath) {
  const normalized = String(relativePath ?? "").replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.length === 0
    || normalized.startsWith("/")
    || segments.some((segment) => segment === "." || segment === "..")
    || segments.some((segment) => AMBIGUOUS_OUTPUT_DIRECTORIES.has(segment))
  ) {
    return false;
  }
  const leaf = segments.at(-1);
  return leaf === ".DS_Store"
    || leaf?.endsWith(".tsbuildinfo")
    || segments.some((segment) => GENERATED_RESIDUE_DIRECTORIES.has(segment));
}

export async function isGeneratedOnlyMigrationResidue(targetPath) {
  const rootEntry = await lstatOrNull(targetPath);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) return false;

  let leafCount = 0;
  const stack = [{ absolutePath: targetPath, relativePath: "" }];
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = await readdir(current.absolutePath, { withFileTypes: true });
      if (entries.length === 0) {
        if (current.relativePath === "") return true;
        if (!generatedResiduePathAllowed(current.relativePath)) return false;
        leafCount += 1;
        continue;
      }

      for (const entry of entries) {
        const absolutePath = join(current.absolutePath, entry.name);
        const relativePath = current.relativePath
          ? `${current.relativePath}/${entry.name}`
          : entry.name;
        const metadata = await lstat(absolutePath);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          stack.push({ absolutePath, relativePath });
          continue;
        }
        if (
          (!metadata.isFile() && !metadata.isSymbolicLink())
          || !generatedResiduePathAllowed(relativePath)
        ) {
          return false;
        }
        leafCount += 1;
      }
    }
  } catch {
    return false;
  }
  return leafCount > 0;
}

async function quarantineGeneratedResidue({
  targetPath,
  repo,
  recoveryStateRoot,
  now,
  makeDirectory,
  makeRecoveryDirectory,
  move,
  remove,
}) {
  const organization = safeRecoverySegment(repo.organization ?? "organization");
  const slot = safeRecoverySegment(repo.slot_path ?? repo.module ?? "slot");
  const recoveryRoot = join(
    recoveryStateRoot,
    "companiesascode",
    "doctor-recovery",
    organization,
  );
  let recoveryDirectory = null;
  try {
    // Re-read immediately before the atomic move. This closes the ordinary
    // stale-read window between the initial classification and quarantine;
    // an adversarial same-user concurrent filesystem mutator remains outside
    // the capability boundary of this local helper.
    if (!(await isGeneratedOnlyMigrationResidue(targetPath))) {
      return { ok: false, recoveryDirectory: null, recoveryPath: null };
    }
    await makeDirectory(recoveryRoot, { recursive: true });
    const timestamp = now().toISOString().replaceAll(/[-:.]/g, "");
    recoveryDirectory = await makeRecoveryDirectory(
      join(recoveryRoot, `${timestamp}-${slot}-`),
    );
    const recoveryPath = join(recoveryDirectory, "residue");
    await move(targetPath, recoveryPath);
    return { ok: true, recoveryDirectory, recoveryPath };
  } catch {
    if (recoveryDirectory) {
      await remove(recoveryDirectory, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: false, recoveryDirectory: null, recoveryPath: null };
  }
}

async function rollbackMaterializationFailure({
  targetPath,
  residueRecovery,
  move,
  message,
  failureCode,
}) {
  const failedClonePath = join(residueRecovery.recoveryDirectory, "failed-clone");
  try {
    await move(targetPath, failedClonePath);
    await move(residueRecovery.recoveryPath, targetPath);
    return failureCode === "materialization_verification_failed"
      ? verificationFailure(message, residueRecovery.recoveryDirectory, true)
      : cloneFailure(message, residueRecovery.recoveryDirectory, true);
  } catch {
    return recoveryFailure(
      "Materializace selhala a automatické obnovení původních artefaktů se nepodařilo; zkontroluj cílovou i recovery cestu ručně.",
      residueRecovery.recoveryDirectory,
    );
  }
}

async function restoreGeneratedResidue({ targetPath, recoveryPath, move }) {
  if (await lstatOrNull(targetPath)) return false;
  try {
    await move(recoveryPath, targetPath);
    return true;
  } catch {
    return false;
  }
}

function defaultRecoveryStateRoot() {
  const configured = process.env.XDG_STATE_HOME?.trim();
  if (configured) return resolve(configured);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return resolve(localAppData);
  }
  const userHome = homedir();
  return userHome ? resolve(userHome, ".local", "state") : resolve(tmpdir());
}

function safeRecoverySegment(value) {
  const sanitized = String(value).replaceAll(/[^A-Za-z0-9._-]+/g, "-");
  return sanitized.replaceAll(/^-+|-+$/g, "") || "unknown";
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

function verificationFailure(message, recoveryPath = null, restored = false) {
  return {
    ok: false,
    outcome: "failed",
    code: "materialization_verification_failed",
    message,
    recovery_path: recoveryPath,
    residue_restored: restored,
  };
}

function targetExists(
  message = "Cílová cesta už existuje; Launchpad ji nepřepíše ani nepřevezme.",
) {
  return {
    ok: false,
    outcome: "target_exists",
    code: "materialization_target_exists",
    message,
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

function cloneFailure(
  message = "Git nedokončil klon manifestovaného modulu; částečný target zůstal viditelný pro kontrolu.",
  recoveryPath = null,
  restored = false,
) {
  return {
    ok: false,
    outcome: "failed",
    code: "materialization_clone_failed",
    message,
    recovery_path: recoveryPath,
    residue_restored: restored,
  };
}

function recoveryFailure(message, recoveryPath = null) {
  return {
    ok: false,
    outcome: "failed",
    code: "materialization_recovery_required",
    message,
    recovery_path: recoveryPath,
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
