// Lidské texty commitů (CAC-0095). Launchpad je builder surface pro Kolegy,
// kteří nemusejí umět Git — commit message je ale psaný pro programátory:
// `feat(launchpad): add bell`, `Merge pull request #15 from org/codex/...`,
// seznam cest, `+111 / −44`. Tenhle modul z toho dělá větu v češtině.
//
// **Hranice, kterou tenhle modul nepřekračuje: nepřekládá a nevymýšlí.**
// Launchpad běží lokálně a offline; není tu žádný model, který by uměl
// anglickou větu autora převést do češtiny. Česky se proto říká jen to, co
// jde spolehlivě odvodit ze struktury commitu — druh změny, kde, jak velká
// a čeho se týkala. Vlastní slova autora se ukazují beze změny a označená
// jako jeho, ne přebarvená na češtinu, která by tvrdila víc, než víme.
//
// Čistá prezentační vrstva: žádný git, žádné IO, žádná org-specific pravda.

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

const FILE_KIND_LABELS = {
  docs: "dokumentace",
  styles: "styly",
  images: "obrázky",
  config: "nastavení",
  pages: "stránky",
  code: "kód",
  tests: "testy",
  other: "ostatní soubory",
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

// Věta „co se stalo" — to jediné, co umíme říct česky a pravdivě.
export function humanChangeSentence(payload = {}, copy = {}, scopeName = "") {
  const kind = copy.kind ?? "Změna";
  const where = copy.area ? `v části ${copy.area}` : scopeName ? `v modulu ${scopeName}` : "";
  const via = copy.pullRequest ? ` Přišlo přes schválený návrh #${copy.pullRequest}.` : "";
  return `${kind}${where ? " " + where : ""}.${via}`;
}

// Věta „jak velká změna to byla" — rozsah a čeho se týkala.
export function humanScopeSentence(payload = {}) {
  const files = payload.files_changed ?? 0;
  if (files === 0) {
    return "Beze změny souborů — nejspíš jen sloučení práce z jiné větve.";
  }
  const kinds = topFileKinds(payload.file_kinds);
  const kindPart = kinds ? `, ${kinds}` : "";
  const changed = agree(files, ["Upraven", "Upraveny", "Upraveno"], ["soubor", "soubory", "souborů"]);
  return `${changed}${kindPart}. ${linesSentence(payload)}`;
}

// Nejvýraznější druhy souborů; víc než dva už je výčet, ne shrnutí.
export function topFileKinds(fileKinds) {
  const entries = Object.entries(fileKinds ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "";
  const labels = entries.slice(0, 2).map(([kind]) => FILE_KIND_LABELS[kind] ?? FILE_KIND_LABELS.other);
  const prefix = entries.length > 2 ? "hlavně " : "";
  return `${prefix}${labels.join(" a ")}`;
}

const ADDED_VERBS = ["Přibyl", "Přibyly", "Přibylo"];
const REMOVED_VERBS = ["Ubyl", "Ubyly", "Ubylo"];
const LINE_NOUNS = ["řádek", "řádky", "řádků"];

function linesSentence(payload) {
  const added = payload.insertions ?? 0;
  const removed = payload.deletions ?? 0;
  if (added === 0 && removed === 0) return "Počet řádků se nezměnil.";
  if (removed === 0) return `${agree(added, ADDED_VERBS, LINE_NOUNS)}.`;
  if (added === 0) return `${agree(removed, REMOVED_VERBS, LINE_NOUNS)}.`;
  return `${agree(added, ADDED_VERBS, LINE_NOUNS)}, ubylo ${removed}.`;
}

// Česká shoda čísla: 1 soubor / 2–4 soubory / 5+ souborů.
export function countLabel(count, one, few, many) {
  if (count === 1) return `1 ${one}`;
  if (count >= 2 && count <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

// Sloveso se v češtině musí shodnout se skloněným počtem: „Upraven 1 soubor",
// „Upraveny 3 soubory", „Upraveno 21 souborů". Bez toho věta drhne.
export function agree(count, [verbOne, verbFew, verbMany], [one, few, many]) {
  if (count === 1) return `${verbOne} 1 ${one}`;
  if (count >= 2 && count <= 4) return `${verbFew} ${count} ${few}`;
  return `${verbMany} ${count} ${many}`;
}
