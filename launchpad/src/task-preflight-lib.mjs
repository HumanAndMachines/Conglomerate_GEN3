import { resolve } from "path";
import { realpath } from "fs/promises";
import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_LOCAL_TIMEOUT_MS,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";

const BASE = {
  id: "git.task_preflight",
  severity: "required",
  title: "Task preflight proti origin/main",
  paths: ["."],
  links: [],
};

export async function taskPreflightGitCheck(companiesRoot, { gitRunner = runGit } = {}) {
  const cwd = resolve(companiesRoot);
  const local = (args, timeoutMs = GIT_LOCAL_TIMEOUT_MS) => gitRunner(args, { cwd, timeoutMs });
  const remote = (args) => gitRunner(args, {
    cwd,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
    env: safeGitRemoteEnv(),
  });

  const topLevel = await local(["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok || await canonicalPath(topLevel.stdout) !== await canonicalPath(cwd)) {
    return failure(
      "Task preflight neběží v primárním Conglomerate Git rootu.",
      [topLevel.stderr || topLevel.error || `nalezený root: ${topLevel.stdout || "-"}`],
    );
  }

  const fetch = await remote(["fetch", "origin", "main", "--prune"]);
  if (!fetch.ok) {
    return failure(
      "Aktuálnost origin/main nejde ověřit; task nesmí začít se stale nebo neznámým basem.",
      [fetch.stderr || fetch.error || "git fetch origin main --prune selhal"],
    );
  }

  const [branch, upstream, status, head, originMain, relation] = await Promise.all([
    local(["branch", "--show-current"]),
    local(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    local(["status", "--porcelain=v1", "--untracked-files=normal"]),
    local(["rev-parse", "--verify", "HEAD^{commit}"]),
    local(["rev-parse", "--verify", "origin/main^{commit}"]),
    local(["rev-list", "--left-right", "--count", "HEAD...origin/main"]),
  ]);
  const failed = [branch, status, head, originMain, relation].find((result) => !result.ok);
  if (failed) {
    return failure(
      "Po fetchi nejde spolehlivě určit stav primárního checkoutu.",
      [failed.stderr || failed.error || "lokální Git kontrola selhala"],
    );
  }

  const dirty = status.stdout.split("\n").filter(Boolean);
  const [ahead, behind] = relation.stdout.split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return failure("Git vrátil neplatný ahead/behind stav.", [relation.stdout]);
  }

  const evidence = [
    `HEAD: ${head.stdout}`,
    `origin/main: ${originMain.stdout}`,
    `ahead: ${ahead}; behind: ${behind}`,
  ];
  if (branch.stdout !== "main") {
    return failure(
      `Primární checkout je na ${branch.stdout || "detached HEAD"}, očekává se main.`,
      [...evidence, "Zachovej práci v plan-owned worktree a vrať primary na čistý main."],
    );
  }
  if (!upstream.ok || upstream.stdout !== "origin/main") {
    return failure(
      `Primární main sleduje ${upstream.stdout || "žádný upstream"}, očekává se origin/main.`,
      [...evidence, "Oprav upstream bez přepisování historie a task preflight spusť znovu."],
    );
  }
  if (dirty.length > 0) {
    return failure(
      `Primární main má ${dirty.length} lokálních změn; automatický autostash není bezpečný default.`,
      [
        ...evidence,
        ...dirty.slice(0, 20),
        "Zachovej práci v plan-owned worktree, vyčisti primary a task preflight spusť znovu.",
      ],
    );
  }
  if (ahead > 0 && behind > 0) {
    return failure(
      `Primární main divergovala od origin/main (${ahead} ahead, ${behind} behind).`,
      [...evidence, "Fail-closed: zachovej lokální commity v worktree; žádný reset --hard ani slepý autostash rebase."],
    );
  }
  if (ahead > 0) {
    return failure(
      `Primární main má ${ahead} lokálních commitů navíc.`,
      [...evidence, "Přesuň lokální práci do plan-owned worktree; primary main se přímo nepublikuje."],
    );
  }
  if (behind > 0) {
    return failure(
      `Primární main je ${behind} commitů za origin/main.`,
      [...evidence, "Spusť git pull --ff-only a potom bun run doctor:task znovu."],
    );
  }

  return {
    ...BASE,
    status: "ok",
    message: `Primární main je čistý a odpovídá čerstvě ověřenému origin/main (${head.stdout.slice(0, 12)}).`,
    details: evidence,
  };
}

function failure(message, details) {
  return {
    ...BASE,
    status: "fail",
    message,
    details: details.filter(Boolean),
  };
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
