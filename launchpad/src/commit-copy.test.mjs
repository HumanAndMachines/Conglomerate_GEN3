import { expect, test } from "bun:test";
import {
  agree,
  countLabel,
  humanChangeSentence,
  humanCommitCopy,
  humanScopeSentence,
  topFileKinds,
} from "../public/commit-copy.js";

test("Conventional Commits prefix se přeloží na druh změny a zmizí z názvu", () => {
  const copy = humanCommitCopy({ subject: "feat(launchpad): notifikace pod zvonečkem" });
  expect(copy.kind).toBe("Nová funkce");
  expect(copy.area).toBe("launchpad");
  expect(copy.title).toBe("notifikace pod zvonečkem");
});

test("neznámý prefix se nevydává za druh změny", () => {
  // `wip:` není Conventional Commits typ — nesmí se z něj stát vymyšlená
  // kategorie, radši žádná.
  const copy = humanCommitCopy({ subject: "wip: zkouším něco" });
  expect(copy.kind).toBeNull();
  expect(copy.title).toBe("wip: zkouším něco");
});

test("merge commit vytáhne skutečný název z těla a číslo návrhu stranou", () => {
  const copy = humanCommitCopy(
    { subject: "Merge pull request #15 from Lumbiocz/codex/negotiate-escalation" },
    "fix(deals): opravit eskalaci\n\nDelší popis změny.",
  );
  expect(copy.pullRequest).toBe("15");
  expect(copy.kind).toBe("Oprava");
  expect(copy.area).toBe("deals");
  expect(copy.title).toBe("opravit eskalaci");
  expect(copy.authorText).toContain("Delší popis změny.");
});

test("koncová reference (#22) se z názvu vyjme", () => {
  const copy = humanCommitCopy({ subject: "Sociální sítě a karta se schématem (#22)" });
  expect(copy.pullRequest).toBe("22");
  expect(copy.title).toBe("Sociální sítě a karta se schématem");
});

test("anglická věta autora se nepřekládá ani nepřepisuje", () => {
  // Launchpad je offline a překládat neumí. Slova autora musí zůstat jeho.
  const copy = humanCommitCopy(
    { subject: "Design system: codify social avatars" },
    "Add downloadable square logo assets.",
  );
  expect(copy.title).toBe("Design system: codify social avatars");
  expect(copy.authorText).toBe("Design system: codify social avatars\n\nAdd downloadable square logo assets.");
});

test("věta o změně řekne druh, místo i původ", () => {
  const copy = humanCommitCopy({ subject: "feat: něco" });
  expect(humanChangeSentence({}, copy, "Design system")).toBe("Nová funkce v modulu Design system.");
  const withArea = humanCommitCopy({ subject: "fix(api): něco (#7)" });
  expect(humanChangeSentence({}, withArea, "Design system")).toBe(
    "Oprava v části api. Přišlo přes schválený návrh #7.",
  );
});

test("věta o rozsahu popíše počet, druh souborů i řádky", () => {
  const sentence = humanScopeSentence({
    files_changed: 21,
    insertions: 111,
    deletions: 44,
    file_kinds: { code: 15, docs: 4, styles: 2 },
  });
  expect(sentence).toBe("Upraveno 21 souborů, hlavně kód a dokumentace. Přibylo 111 řádků, ubylo 44.");
});

test("beze změny souborů se řekne důvod, ne holá nula", () => {
  expect(humanScopeSentence({ files_changed: 0 })).toContain("sloučení práce z jiné větve");
});

test("druhy souborů se shrnou, nevypisují", () => {
  expect(topFileKinds({ docs: 3 })).toBe("dokumentace");
  expect(topFileKinds({ docs: 3, code: 5 })).toBe("kód a dokumentace");
  expect(topFileKinds({ docs: 3, code: 5, images: 1 })).toBe("hlavně kód a dokumentace");
  expect(topFileKinds({})).toBe("");
});

test("česká shoda čísla sedí pro 1, 2–4 i 5+", () => {
  expect(countLabel(1, "soubor", "soubory", "souborů")).toBe("1 soubor");
  expect(countLabel(3, "soubor", "soubory", "souborů")).toBe("3 soubory");
  expect(countLabel(21, "soubor", "soubory", "souborů")).toBe("21 souborů");
});

test("sloveso se shodne s počtem, ne jen podstatné jméno", () => {
  const verbs = ["Upraven", "Upraveny", "Upraveno"];
  const nouns = ["soubor", "soubory", "souborů"];
  expect(agree(1, verbs, nouns)).toBe("Upraven 1 soubor");
  expect(agree(3, verbs, nouns)).toBe("Upraveny 3 soubory");
  expect(agree(21, verbs, nouns)).toBe("Upraveno 21 souborů");
});

test("rozsahová věta drží shodu i u jednoho souboru a jednoho řádku", () => {
  expect(humanScopeSentence({ files_changed: 1, insertions: 1, deletions: 0, file_kinds: { docs: 1 } }))
    .toBe("Upraven 1 soubor, dokumentace. Přibyl 1 řádek.");
  expect(humanScopeSentence({ files_changed: 3, insertions: 0, deletions: 2, file_kinds: { code: 3 } }))
    .toBe("Upraveny 3 soubory, kód. Ubyly 2 řádky.");
});
