import { expect, test } from "bun:test";
import {
  changeKindLabel,
  changeOriginLabel,
  humanCommitCopy,
  topicLabel,
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
  expect(copy.authorText).toBe(
    "Design system: codify social avatars\n\nAdd downloadable square logo assets.",
  );
});

test("druh změny se pozná i z anglického slovesa za oblastí", () => {
  // Tohle je ten podíl, který slovník sloves opravdu pokryje: 215 ze 410
  // skutečných commitů tohohle workspace.
  const add = humanCommitCopy({ subject: "Knowledgebase: Add Spectoda reference guidance" });
  expect(changeKindLabel({}, add)).toBe("Přidání");

  const fix = humanCommitCopy({ subject: "Website: Fix IZOLAS reference image format" });
  expect(changeKindLabel({}, fix)).toBe("Oprava");

  const std = humanCommitCopy({ subject: "Design system: standardize official logo usage" });
  expect(changeKindLabel({}, std)).toBe("Sjednocení");
});

test("Conventional Commits prefix má přednost před slovesem", () => {
  const copy = humanCommitCopy({ subject: "docs: refresh digital office content assets" });
  expect(changeKindLabel({}, copy)).toBe("Dokumentace");
});

test("u neznámého slovesa se druh změny nevymýšlí", () => {
  // „Commit Bun lockfile" — sloveso ve slovníku není. Radši nic než domněnka
  // o cizí práci.
  const copy = humanCommitCopy({ subject: "Design system app: Commit Bun lockfile" });
  expect(changeKindLabel({}, copy)).toBeNull();
});

test("český commit se nechává být", () => {
  const copy = humanCommitCopy({ subject: "Logo: Vystředit čtvercové exporty Lazuria" });
  expect(copy.title).toBe("Logo: Vystředit čtvercové exporty Lazuria");
  expect(changeKindLabel({}, copy)).toBeNull();
});

test("původ změny se řekne jen když je znám", () => {
  expect(changeOriginLabel({ pullRequest: "15" })).toBe("přes schválený návrh #15");
  expect(changeOriginLabel({})).toBeNull();
});

test("téma se bere ze složek, ne z textu commitu", () => {
  // Přesně ten případ, na kterém ztroskotal překlad textu: „standardize
  // official logo usage" přeložit nejde, ale `content/brand/logo/…` říká,
  // čeho se změna týkala.
  expect(topicLabel({ topics: ["logo"] })).toBe("logo");
  expect(topicLabel({ topics: ["socialni-site"] })).toBe("sociální sítě");
  expect(topicLabel({ topics: ["logo", "brand"] })).toBe("logo a značka");
  // Neznámá složka se ukáže tak, jak se jmenuje — pořád je to slovo, ne věta.
  expect(topicLabel({ topics: ["cenik-2026"] })).toBe("cenik 2026");
  expect(topicLabel({ topics: [] })).toBeNull();
  expect(topicLabel({})).toBeNull();
});
