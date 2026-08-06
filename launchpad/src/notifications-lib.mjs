// Notifikace (CAC-0095): nástupce panelu „Poslední změny". Stejný bounded,
// read-only `git log`, ale jiná jednotka — ne modul, nýbrž **jedna změna**
// popsaná trojicí, kterou zadala Principálka: kdo (actor), v jakém modulu
// (scope) a co je jejím obsahem (payload).
//
// Kontrakt `recent_modules` zůstává vedle tohohle beze změny (spec 13.4);
// tohle je vědomě verzovaný nástupce `notifications.v1`, ne jeho přepis.
//
// Stav přečtení tady nežije. Je per Principál a per mašina, drží ho klient
// v localStorage — server o tom, co kdo četl, nic nevede.

import { existsSync } from "fs";
import {
  GIT_COMMAND_CONCURRENCY,
  GIT_LOCAL_TIMEOUT_MS,
  mapWithConcurrency,
  resolveGitExecutable,
  runGit,
  safeGitRemoteEnv,
} from "./git-lib.mjs";
import { moduleReposFromApps } from "./recent-changes-lib.mjs";

const DEFAULT_COMMIT_LIMIT = 10;
const DEFAULT_NOTIFICATION_LIMIT = 40;
// Kolik cest ze změny ukázat v payloadu. Zbytek se shrne do počtu — dlouhý
// výpis souborů je v notifikaci šum, ne informace.
const PAYLOAD_FILE_LIMIT = 5;

// Stejné oddělovače jako recent-changes-lib: US mezi poli, RS mezi commity.
// RS je tady na *začátku* formátu, aby `--numstat` řádky spadly do záznamu
// svého commitu, ne do začátku toho následujícího.
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

// Podpisy, které bezpečně poznají Agenta. Držíme je úzké schválně: špatná
// atribuce („Kolega udělal změnu", kterou udělal Agent, nebo naopak) je horší
// než přiznané „nevím". Cokoli mimo tenhle seznam je člověk.
// Pozn.: `@users.noreply.github.com` tu schválně není. Používají ji i lidé,
// kteří si schovávají e-mail, takže by z nich udělala Agenty.
const AGENT_EMAIL_PATTERNS = [
  /^bot@/i,
  /^agent@/i,
  /noreply@anthropic\.com$/i,
  /\+bot@/i,
];
const AGENT_NAME_PATTERNS = [
  /\[bot\]$/i,
  /^codex\b/i,
  /^claude\b/i,
  /\bcopilot\b/i,
  /\bcursor agent\b/i,
  /\bai\b.*\bagent\b/i,
  /\bagent\b/i,
];

export function classifyActor(name, email) {
  const safeName = (name ?? "").trim();
  const safeEmail = (email ?? "").trim();
  const emailLooksAutomated = AGENT_EMAIL_PATTERNS.some((pattern) => pattern.test(safeEmail));
  const nameLooksAutomated = AGENT_NAME_PATTERNS.some((pattern) => pattern.test(safeName));
  return emailLooksAutomated || nameLooksAutomated ? "agent" : "human";
}

export function actorInitials(name) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// Co-Authored-By trailer je jediné místo, kde je vidět, že člověk publikoval
// práci Agenta (nebo naopak). Bez něj by notifikace tvrdila, že to celé napsal
// ten, kdo commitoval.
export function parseCoAuthors(body) {
  const matches = (body ?? "").matchAll(/^\s*Co-Authored-By:\s*(.+?)\s*<([^>]*)>\s*$/gim);
  const seen = new Set();
  const coAuthors = [];
  for (const match of matches) {
    const name = match[1].trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    coAuthors.push({ name, kind: classifyActor(name, match[2]) });
  }
  return coAuthors;
}

// Tělo commitu bez trailerů — ty se ukazují zvlášť jako co-authors.
function stripTrailers(body) {
  return (body ?? "")
    .split("\n")
    .filter((line) => !/^\s*Co-Authored-By:/i.test(line))
    .join("\n")
    .trim();
}

// `--numstat` řádky: "<přidáno>\t<smazáno>\t<cesta>". U binárních souborů je
// místo čísel "-", u přejmenování nese cesta šipkovou notaci; obojí necháváme
// tak, jak je — je to text pro člověka, ne strojový diff.
export function parseNumstat(tail) {
  const files = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of (tail ?? "").split("\n")) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    const added = match[1] === "-" ? 0 : Number(match[1]);
    const removed = match[2] === "-" ? 0 : Number(match[2]);
    insertions += added;
    deletions += removed;
    files.push(match[3]);
  }
  return { files, insertions, deletions };
}

async function readRepoNotifications(repo, { commitLimit }) {
  if (!existsSync(repo.absolute_path)) return [];
  const format =
    RECORD_SEP + ["%H", "%h", "%an", "%ae", "%aI", "%s", "%b"].join(FIELD_SEP) + FIELD_SEP;
  // `--first-parent -m` je tady podstatné, ne kosmetika:
  //   --first-parent … jedna notifikace = jeden mergnutý PR, ne třicet
  //                    interních commitů z jeho větve,
  //   -m             … bez něj git u merge commitu nevypíše žádný --numstat
  //                    a payload by u každého mergnutého PR tvrdil
  //                    „bez změny souborů".
  const result = await runGit(
    [
      "log",
      `-${commitLimit}`,
      "--first-parent",
      "-m",
      "--numstat",
      `--pretty=format:${format}`,
      "--no-color",
    ],
    {
      cwd: repo.absolute_path,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      env: safeGitRemoteEnv(),
    },
  );
  if (!result.ok || result.stdout.trim() === "") return [];

  return result.stdout
    .split(RECORD_SEP)
    .filter((record) => record.trim() !== "")
    .map((record) => toNotification(record, repo))
    .filter(Boolean);
}

function toNotification(record, repo) {
  const parts = record.split(FIELD_SEP);
  const [hash, shortHash, authorName, authorEmail, committedAt, subject, body] = parts;
  if (!hash) return null;
  const { files, insertions, deletions } = parseNumstat(parts[7] ?? "");
  const description = stripTrailers(body);
  return {
    id: `${repo.id}@${hash}`,
    occurred_at: committedAt ?? null,
    occurred_at_unix: committedAt ? Math.floor(Date.parse(committedAt) / 1000) : 0,
    actor: {
      name: authorName ?? "Neznámý autor",
      kind: classifyActor(authorName, authorEmail),
      kind_source: "heuristic",
      initials: actorInitials(authorName),
    },
    scope: {
      kind: "module",
      id: repo.id,
      name: repo.name,
      module: repo.module,
      company: repo.company,
      company_display_name: repo.company_display_name,
      icon: repo.icon,
      relative_path: repo.relative_path,
    },
    payload: {
      subject: subject ?? "",
      description,
      co_authors: parseCoAuthors(body),
      hash,
      short_hash: shortHash ?? "",
      files_changed: files.length,
      files: files.slice(0, PAYLOAD_FILE_LIMIT),
      files_truncated: Math.max(0, files.length - PAYLOAD_FILE_LIMIT),
      insertions,
      deletions,
    },
  };
}

export async function buildNotifications({
  companiesRoot,
  apps,
  commitLimit = DEFAULT_COMMIT_LIMIT,
  notificationLimit = DEFAULT_NOTIFICATION_LIMIT,
} = {}) {
  const gitAvailable = Boolean(await resolveGitExecutable());
  if (!gitAvailable) {
    return {
      schema_version: "companiesascode.launchpad.notifications.v1",
      generated_at: new Date().toISOString(),
      git_available: false,
      notifications: [],
    };
  }

  // Repa se neořezávají dopředu: seznam se řadí podle času změny, takže
  // useknutí podle pořadí discovery by mohlo zahodit zrovna ten modul, kde se
  // něco stalo před minutou. Strop drží `commitLimit` a `notificationLimit`.
  const repos = moduleReposFromApps(apps ?? [], companiesRoot);
  const perRepo = await mapWithConcurrency(repos, GIT_COMMAND_CONCURRENCY, (repo) =>
    readRepoNotifications(repo, { commitLimit }),
  );

  const notifications = perRepo
    .flat()
    .sort((a, b) => b.occurred_at_unix - a.occurred_at_unix)
    .slice(0, notificationLimit);

  return {
    schema_version: "companiesascode.launchpad.notifications.v1",
    generated_at: new Date().toISOString(),
    git_available: true,
    notifications,
  };
}
