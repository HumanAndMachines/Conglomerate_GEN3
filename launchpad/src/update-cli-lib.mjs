import { basename } from "path";
import { buildGitInventory } from "./git-inventory-lib.mjs";
import {
  pullRepoFastForward,
  pullRepoWithAutostash,
  readGitRepoStatus,
} from "./git-status-lib.mjs";
import { performRootUpdate, readRootUpdateStatus } from "./update-lib.mjs";
import { GIT_REMOTE_REFRESH_CONCURRENCY } from "./git-status-lib.mjs";
import { mapWithConcurrency } from "./git-lib.mjs";

// Guarded headless update lane (CAC-0083). Doctor zůstává read-only
// diagnostika (decisions 0018/0059); tahle lane je oddělená mutační akce se
// stejnými invarianty jako Launchpad UI: výhradně fast-forward, dirty-safe,
// productionspace read-only, žádný rebase ani reset. Agentní task-start
// rutina: `bun run doctor:task` -> při behind `bun run update` -> doctor znovu.

export const UPDATE_CLI_USAGE = `Použití: bun run update [-- <volby>]

Bezpečně aktualizuje Conglomerate root (ff-only podle update kanálu) a
volitelně namountované Organizace. Nikdy nepřepisuje lokální práci; dirty,
diverged nebo ahead stavy fail-closed ohlásí a nechá beze změny.

Volby:
  --org <slug>   Aktualizuj i Organizaci (root repo + workspace moduly).
                 Lze opakovat; přijímá company slug i název mount složky.
  --all-orgs     Aktualizuj všechny namountované Organizace.
  --check        Jen zjisti a vypiš stav; nic nestahuj.
  --preserve     Povol autostash variantu (odlož a obnov lokální změny) pro
                 stavy, které ji bezpečně umí. Bez této volby jsou lokální
                 změny vždy blokující.
  --json         Strojový výstup.
  --root <path>  Explicitní cesta ke Conglomerate rootu.
  --help         Tahle nápověda.`;

export function parseUpdateCliArgs(argv) {
  const options = {
    orgs: [],
    allOrgs: false,
    check: false,
    preserve: false,
    json: false,
    help: false,
    root: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--org") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, error: "--org vyžaduje slug Organizace." };
      }
      options.orgs.push(value);
      index += 1;
    } else if (arg === "--all-orgs") options.allOrgs = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--preserve") options.preserve = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, error: "--root vyžaduje cestu." };
      }
      options.root = value;
      index += 1;
    } else {
      return { ok: false, error: `Neznámá volba ${JSON.stringify(arg)}.` };
    }
  }
  return { ok: true, options };
}

// Stejná hranice jako Launchpad builder pull scope (git-api-lib):
// productionspace zůstává read-only, root sloty se neaktualizují odsud.
export function updateLanePullAllowed(repo) {
  return repo.repo_kind === "organization_root"
    || (repo.repo_kind === "module" && repo.workspace !== "productionspace");
}

export function matchOrganizationSelector(repo, selector) {
  const wanted = String(selector).toLowerCase();
  return repo.organization?.toLowerCase() === wanted
    || basename(repo.organization_path ?? "").toLowerCase() === wanted;
}

export async function runUpdateLane({ rootPath, options, deps = {} } = {}) {
  if (!rootPath) throw new Error("runUpdateLane requires rootPath");
  const {
    readRootStatus = readRootUpdateStatus,
    performRoot = performRootUpdate,
    buildInventory = buildGitInventory,
    readRepoStatus = readGitRepoStatus,
    pullFastForward = pullRepoFastForward,
    pullWithAutostash = pullRepoWithAutostash,
  } = deps;

  const root = options.check
    ? rootCheckOutcome(await readRootStatus({ rootPath, refresh: true }))
    : rootUpdateOutcome(
      await performRoot({ rootPath, mode: options.preserve ? "preserve_changes" : "ff_only" }),
    );

  let organizations = [];
  let selectorErrors = [];
  if (options.allOrgs || options.orgs.length > 0) {
    const inventory = await buildInventory({ companiesRoot: rootPath });
    let repos = inventory.repos;
    if (!options.allOrgs) {
      const known = new Set();
      repos = [];
      for (const selector of options.orgs) {
        const matched = inventory.repos.filter((repo) => matchOrganizationSelector(repo, selector));
        if (matched.length === 0) {
          selectorErrors.push(
            `Organizace ${JSON.stringify(selector)} není v git inventáři. Dostupné: ${
              [...new Set(inventory.repos.map((repo) => repo.organization))].sort().join(", ") || "žádné"
            }.`,
          );
          continue;
        }
        for (const repo of matched) {
          if (!known.has(repo.key)) {
            known.add(repo.key);
            repos.push(repo);
          }
        }
      }
    }
    organizations = await mapWithConcurrency(repos, GIT_REMOTE_REFRESH_CONCURRENCY, (repo) =>
      updateOrganizationRepo({
        repo,
        options,
        readRepoStatus,
        pullFastForward,
        pullWithAutostash,
      }));
  }

  const attention = [
    ...(rootNeedsAttention(root, options) ? [root] : []),
    ...organizations.filter((entry) => ORG_ATTENTION_OUTCOMES.has(entry.outcome)),
    ...selectorErrors.map((message) => ({ outcome: "failed", message })),
  ];
  return {
    schema_version: "companiesascode.launchpad.update_cli.v1",
    mode: options.check ? "check" : "update",
    ok: attention.length === 0,
    root,
    organizations,
    selector_errors: selectorErrors,
    summary: buildSummary({ root, organizations, selectorErrors }),
  };
}

const ORG_ATTENTION_OUTCOMES = new Set(["blocked_dirty", "conflict", "failed"]);

async function updateOrganizationRepo({ repo, options, readRepoStatus, pullFastForward, pullWithAutostash }) {
  const identity = {
    repo_key: repo.key,
    organization: repo.organization,
    module: repo.module,
    repo_kind: repo.repo_kind,
    repo_path: repo.repo_path,
  };
  if (!updateLanePullAllowed(repo)) {
    return {
      ...identity,
      outcome: "policy_skipped",
      message: "Productionspace zůstává podle Organization policy read-only.",
    };
  }

  const preflight = await readRepoStatus(repo, { refresh: true });
  const counts = preflight.counts ?? {};
  if (preflight.status === "up_to_date") {
    return { ...identity, outcome: "up_to_date", message: "Repo už je aktuální." };
  }
  if (preflight.status === "pull_available") {
    if (options.check) {
      return {
        ...identity,
        outcome: "update_available",
        message: `K dispozici ${formatCommits(counts.incoming)} ke stažení.`,
        incoming: counts.incoming ?? null,
      };
    }
    const result = await pullFastForward(repo, { preflight });
    return pullOutcome(identity, result, { autostash: false });
  }
  const autostashEligible = preflight.status === "draft_changes"
    && (counts.incoming ?? 0) > 0
    && (counts.outgoing ?? 0) === 0;
  if (autostashEligible) {
    if (options.check) {
      return {
        ...identity,
        outcome: "update_available",
        message: `K dispozici ${formatCommits(counts.incoming)}; lokální změny vyžadují --preserve.`,
        incoming: counts.incoming ?? null,
      };
    }
    if (!options.preserve) {
      return {
        ...identity,
        outcome: "blocked_dirty",
        message: "Repo má lokální změny; nic se nestáhlo. Spusť znovu s --preserve, nebo změny commitni/odlož.",
        incoming: counts.incoming ?? null,
      };
    }
    const result = await pullWithAutostash(repo, { preflight });
    return pullOutcome(identity, result, { autostash: true });
  }
  return {
    ...identity,
    outcome: preflight.status === "check_failed" ? "failed" : "skipped",
    message: skipMessage(preflight),
    status: preflight.status,
  };
}

function pullOutcome(identity, result, { autostash }) {
  if (!result.ok) {
    return {
      ...identity,
      outcome: result.code === "autostash_conflict" ? "conflict" : "failed",
      message: result.message,
      stash_preserved: Boolean(result.stash_preserved),
    };
  }
  return {
    ...identity,
    outcome: autostash ? "autostash_pulled" : "pulled",
    message: autostash
      ? "Nová verze stažená a lokální změny obnovené."
      : "Nová verze stažená fast-forwardem.",
    stash_preserved: Boolean(result.stash_preserved),
  };
}

function skipMessage(status) {
  if (status.status === "wrong_branch") return "Repo není na očekávané branchi; aktualizaci proveď ručně z worktree disciplíny.";
  if (status.status === "push_required") return "Repo má lokální commity k odeslání; nejdřív je publikuj přes PR.";
  if (status.status === "diverged") return "Lokální a vzdálená branch divergovaly; vyřeš fail-closed bez přepisu historie.";
  if (status.status === "draft_changes") return "Lokální změny teď nejdou bezpečně zkombinovat s pull flow.";
  if (status.status === "repo_missing") return "Lokální checkout chybí.";
  if (status.status === "git_unavailable") return "Git není dostupný.";
  if (status.status === "check_failed") return "Git nebo vzdálenou verzi se nepodařilo spolehlivě ověřit.";
  return status.message || "Repo se nepodařilo bezpečně aktualizovat.";
}

function rootCheckOutcome(status) {
  return {
    mode: "check",
    state: status.state,
    channel: status.channel,
    message: status.message,
    behind: status.counts?.behind ?? 0,
    ahead: status.counts?.ahead ?? 0,
    head: status.head?.short_sha ?? null,
    target: status.target?.short_sha ?? null,
    updated: false,
    ok: !["diverged", "wrong_branch", "fetch_failed"].includes(status.state),
  };
}

// Stavy „není co stáhnout": stable kanál bez release tagu a lokální verze
// před cílem kanálu nejsou chyby rutiny — root je tak aktuální, jak kanál
// dovoluje. Blokující zůstávají dirty/diverged/wrong-branch/fetch_failed.
const BENIGN_ROOT_STATES = new Set(["up_to_date", "no_release_tag", "ahead_of_channel_target"]);

function rootUpdateOutcome(result) {
  return {
    mode: "update",
    state: result.state,
    channel: result.channel,
    message: result.message,
    updated: Boolean(result.updated),
    ok: Boolean(result.ok) || BENIGN_ROOT_STATES.has(result.state),
    code: result.code ?? null,
    from_commit: result.from_commit ?? null,
    to_commit: result.to_commit ?? null,
    behind: result.after?.counts?.behind ?? result.before?.counts?.behind ?? 0,
    stash_preserved: Boolean(result.stash_preserved),
  };
}

function rootNeedsAttention(root, options) {
  if (options.check) return !root.ok;
  return !root.ok;
}

function buildSummary({ root, organizations, selectorErrors }) {
  const count = (outcome) => organizations.filter((entry) => entry.outcome === outcome).length;
  return {
    root_state: root.state,
    root_updated: Boolean(root.updated),
    org_repo_count: organizations.length,
    org_updated_count: count("pulled") + count("autostash_pulled"),
    org_update_available_count: count("update_available"),
    org_up_to_date_count: count("up_to_date"),
    org_skipped_count: count("skipped") + count("policy_skipped"),
    org_blocked_count: count("blocked_dirty") + count("conflict") + count("failed") + selectorErrors.length,
  };
}

export function formatCommits(value) {
  const number = Number(value ?? 0);
  if (number === 1) return "1 commit";
  if (number >= 2 && number <= 4) return `${number} commity`;
  return `${number} commitů`;
}

export function formatUpdateLaneReport(result) {
  const lines = [];
  const root = result.root;
  const rootLabel = `Conglomerate root · ${root.channel ?? "stable"}`;
  if (root.mode === "check") {
    if (root.state === "update_available") {
      lines.push(`${rootLabel}: k dispozici ${formatCommits(root.behind)} ke stažení (${root.head} → ${root.target}). Spusť bun run update.`);
    } else {
      lines.push(`${rootLabel}: ${root.message}`);
    }
  } else if (root.updated && root.ok) {
    lines.push(`${rootLabel}: aktualizováno ${shortSha(root.from_commit)} → ${shortSha(root.to_commit)}.`);
  } else if (root.ok) {
    lines.push(`${rootLabel}: ${root.message}`);
  } else {
    lines.push(`${rootLabel}: BLOKOVÁNO — ${root.message}`);
  }

  for (const entry of result.organizations) {
    const marker = ORG_ATTENTION_OUTCOMES.has(entry.outcome) ? "BLOKOVÁNO — " : "";
    lines.push(`${entry.organization} · ${entry.repo_path}: ${marker}${entry.message}`);
  }
  for (const message of result.selector_errors) lines.push(`BLOKOVÁNO — ${message}`);

  const summary = result.summary;
  if (summary.org_repo_count > 0) {
    lines.push(
      `Souhrn Organizací: ${summary.org_updated_count} aktualizováno, ${summary.org_up_to_date_count} aktuálních, `
      + `${summary.org_update_available_count} ke stažení, ${summary.org_skipped_count} přeskočeno, `
      + `${summary.org_blocked_count} vyžaduje pozornost.`,
    );
  }
  lines.push(result.ok
    ? "Update lane: ok. Ověř stav přes bun run doctor:task."
    : "Update lane: vyžaduje pozornost. Nic se nepřepsalo; vyřeš blokované stavy fail-closed.");
  return lines.join("\n");
}

function shortSha(value) {
  return typeof value === "string" && value.length >= 7 ? value.slice(0, 7) : String(value ?? "?");
}
