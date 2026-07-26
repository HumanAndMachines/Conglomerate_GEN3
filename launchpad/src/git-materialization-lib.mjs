import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";
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
    makeDirectory = mkdir,
    claimDirectory = mkdir,
    pinDirectory = mkdir,
  } = deps;

  const validation = await validateMaterializationTarget({ companiesRoot, repo, run });
  if (!validation.ok) return validation;

  const {
    organizationRoot,
    targetPath,
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

  const targetParent = dirname(targetPath);
  let claimedTarget = false;
  try {
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

    // mkdir bez recursive je atomický no-clobber claim. Na rozdíl od POSIX
    // rename nikdy nenahradí prázdný adresář, který mezi kontrolou a zápisem
    // vytvořil jiný Pull/CLI proces.
    try {
      await claimDirectory(targetPath);
      claimedTarget = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        return {
          ok: false,
          outcome: "target_exists",
          code: "materialization_target_appeared",
          message: "Cílový checkout mezitím vytvořil jiný proces; Launchpad ho ponechal beze změny.",
        };
      }
      throw error;
    }
    const claimedBoundary = await inspectCanonicalPathBoundary({
      rootPath: organizationRoot,
      rootRealPath: parentBoundary.rootRealPath,
      targetPath,
    });
    if (!claimedBoundary.ok) {
      // Parent mohl být mezi preflightem a mkdir nahrazený symlinkem nebo
      // Windows junction. Cizí cesty se nedotkneme; především do nich nic
      // neklonujeme.
      return boundaryFailure("Cílový parent po claimu změnil kanonickou hranici; Launchpad do něj nic nezapsal.");
    }

    // Target už vlastníme, ale před vzdáleným zápisem ho uděláme neprázdný:
    // `.git` je ownership pin a běžný rename/rmdir pak target ani žádného
    // jeho předka nenahradí. Kanonickou hranici znovu ověříme po vytvoření
    // pinu. Proces se stejnými právy, který by pin rekurzivně smazal, už umí
    // přímo měnit libovolný lokální checkout a není synchronizační race.
    await pinDirectory(join(targetPath, ".git"));
    const pinnedBoundary = await inspectCanonicalPathBoundary({
      rootPath: organizationRoot,
      rootRealPath: parentBoundary.rootRealPath,
      targetPath,
    });
    if (!pinnedBoundary.ok) {
      return boundaryFailure("Cílový checkout před Git zápisem změnil kanonickou hranici; Launchpad do něj nic nenaklonoval.");
    }

    const initialized = await initializePinnedCheckout({
      organizationRoot,
      targetPath,
      branch,
      remote,
      run,
    });
    if (!initialized.ok) {
      // Rekurzivní cleanup zde záměrně není: pathname mohl změnit cizí proces.
      // Částečný checkout proto zůstane fail-closed jako viditelný lokální
      // blocker a nikdy neriskujeme smazání cizího adresáře.
      return {
        ok: false,
        outcome: "failed",
        code: "materialization_incomplete",
        message: "Git checkout po bezpečném claimu selhal; částečný adresář zůstal beze smazání pro ruční kontrolu.",
      };
    }

    const verification = await verifyClonedCheckout({
      path: targetPath,
      branch,
      remote,
      run,
    });
    if (!verification.ok) return verification;
    const completedBoundary = await inspectCanonicalPathBoundary({
      rootPath: organizationRoot,
      rootRealPath: parentBoundary.rootRealPath,
      targetPath,
    });
    if (!completedBoundary.ok) {
      return boundaryFailure("Cílový checkout během materializace změnil kanonickou hranici; Launchpad ho nepublikoval ani nesmazal.");
    }

    return {
      ok: true,
      outcome: "materialized",
      code: null,
      message: "Nový manifestovaný modul byl bezpečně naklonovaný.",
      branch,
      head: verification.head,
      remote,
    };
  } catch {
    if (claimedTarget) {
      return {
        ok: false,
        outcome: "failed",
        code: "materialization_incomplete",
        message: "Git checkout po bezpečném claimu selhal; částečný adresář zůstal beze smazání pro ruční kontrolu.",
      };
    }
    return {
      ok: false,
      outcome: "failed",
      code: "materialization_failed",
      message: "Checkout se nepodařilo bezpečně vytvořit; existující data zůstala beze změny.",
    };
  }
}

async function initializePinnedCheckout({
  organizationRoot,
  targetPath,
  branch,
  remote,
  run,
}) {
  const commands = [
    {
      args: ["init", `--initial-branch=${branch}`, "--", targetPath],
      options: { cwd: organizationRoot, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    },
    {
      args: ["remote", "add", "origin", remote],
      options: { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    },
    {
      args: [
        "config",
        "remote.origin.fetch",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      options: { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    },
    {
      args: ["fetch", "--no-tags", "origin"],
      options: {
        cwd: targetPath,
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
        env: safeGitRemoteEnv(),
      },
    },
    {
      args: ["checkout", "--force", "-B", branch, "--track", `origin/${branch}`],
      options: { cwd: targetPath, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    },
  ];
  for (const command of commands) {
    const result = await run(command.args, command.options);
    if (!result.ok) return result;
  }
  return { ok: true };
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
