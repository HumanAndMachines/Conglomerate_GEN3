// Lidské texty commitů (CAC-0095). Launchpad je builder surface pro Kolegy,
// kteří nemusejí umět Git — commit message je ale psaný pro programátory:
// `feat(launchpad): add bell`, `Merge pull request #15 from org/codex/...`.
// Tenhle modul z toho vytáhne to, co jde říct spolehlivě.
//
// **Hranice, kterou tenhle modul nepřekračuje: nepřekládá a nevymýšlí.**
// Launchpad běží lokálně a offline; není tu žádný model, který by uměl
// anglickou větu autora převést do češtiny. Česky se proto říká jen to, co
// jde odvodit ze struktury: druh změny, její původ a téma podle složek, ve
// kterých se soubory měnily. Vlastní slova autora se ukazují beze změny
// a označená jako jeho, ne přebarvená na češtinu, která by tvrdila víc,
// než víme.
//
// Čistá prezentační vrstva: žádný git, žádné IO, žádná org-specific pravda.

import { TOPIC_LABELS, VERBS } from "./commit-glossary.js";

// Conventional Commits prefix → co to pro člověka znamená.
const CHANGE_KINDS = {
  feat: "Nová funkce",
  fix: "Oprava",
  docs: "Dokumentace",
  chore: "Údržba",
  refactor: "Přepis kódu",
  test: "Testy",
  style: "Úprava formátování",
  perf: "Zrychlení",
  build: "Sestavení aplikace",
  ci: "Automatické kontroly",
  revert: "Vrácení dřívější změny",
};

// „Merge pull request #15 from org/branch" nikomu nic neřekne. Skutečný název
// změny bývá až v těle merge commitu (GitHub tam dává titulek pull requestu).
const MERGE_SUBJECT = /^Merge pull request #(\d+) from \S+/i;
// Conventional Commits: `typ(rozsah)!: text`.
const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
// Koncová reference na pull request: „… (#22)".
const TRAILING_PR = /\s*\(#(\d+)\)\s*$/;

export function humanCommitCopy(payload = {}, description = "") {
  const rawSubject = (payload.subject ?? "").trim();
  const rawDescription = (description ?? "").trim();

  let subject = rawSubject;
  let body = rawDescription;
  let pullRequest = null;

  // 1) Merge commit: titulek si vyzvedneme z těla, číslo PR si necháme stranou.
  const merge = subject.match(MERGE_SUBJECT);
  if (merge) {
    pullRequest = merge[1];
    const [firstBodyLine, ...restBody] = rawDescription.split("\n");
    if (firstBodyLine?.trim()) {
      subject = firstBodyLine.trim();
      body = restBody.join("\n").trim();
    } else {
      subject = "";
    }
  }

  // 2) Koncové „(#22)" je taky reference na pull request, ne část názvu.
  const trailing = subject.match(TRAILING_PR);
  if (trailing) {
    pullRequest = pullRequest ?? trailing[1];
    subject = subject.replace(TRAILING_PR, "").trim();
  }

  // 3) Conventional Commits prefix → druh změny; zbytek je název.
  let kind = null;
  let area = null;
  const conventional = subject.match(CONVENTIONAL);
  if (conventional && CHANGE_KINDS[conventional[1].toLowerCase()]) {
    kind = CHANGE_KINDS[conventional[1].toLowerCase()];
    area = conventional[2]?.trim() || null;
    subject = conventional[4].trim();
  }

  return {
    kind,
    area,
    pullRequest,
    title: subject,
    authorText: [subject, body].filter(Boolean).join("\n\n").trim(),
  };
}

// Štítek druhu změny v češtině: z Conventional Commits prefixu, jinak
// z anglického slovesa na začátku. Když ani jedno, vrací null — vymýšlet
// kategorii pro cizí práci je horší než žádná.
export function changeKindLabel(payload = {}, copy = {}) {
  if (copy.kind) return copy.kind;
  const title = (copy.title ?? payload.subject ?? "").trim();
  if (!title) return null;
  const withoutArea = title.replace(/^[^:]{2,40}:\s*/, "");
  const first = withoutArea.split(/\s+/)[0]?.toLowerCase();
  return VERBS[first] ?? null;
}

// Odkud změna přišla — jediná další věc, kterou umíme říct spolehlivě.
export function changeOriginLabel(copy = {}) {
  return copy.pullRequest ? `přes schválený návrh #${copy.pullRequest}` : null;
}

// Čeho se změna týkala. Neodvozuje se z textu commitu (tam jsou vlastní jména,
// která přeložit nejde), ale ze složek, ve kterých se soubory měnily.
export function topicLabel(payload = {}) {
  const topics = (payload.topics ?? []).map(humanTopic).filter(Boolean);
  return topics.length > 0 ? topics.join(" a ") : null;
}

function humanTopic(segment) {
  const key = String(segment ?? "").trim();
  if (!key) return null;
  return TOPIC_LABELS[key.toLowerCase()] ?? key.replace(/[-_]+/g, " ");
}
