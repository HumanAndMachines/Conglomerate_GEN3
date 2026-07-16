# Jak přispívat do Conglomerate

Conglomerate je **sdílený framework pro celou komunitu** HumanAndMachine GEN3.
Každá mašina ho používá jako direct-pull klon (decision 0030 v
HumanAndMachines/docs/decisions/): jedna codebase, žádné lokální úpravy kódu,
vylepšení výhradně přes pull request do tohoto repa. Tahle příručka platí pro
lidi i pro agenty a její cíl je jediný — aby PR do sdíleného repa přidávaly
hodnotu celé komunitě, ne chaos.

## Zlaté pravidlo: konfigurace první, kód poslední

Než sáhneš do sdíleného kódu, projdi tenhle žebřík shora dolů a zastav se na
prvním stupni, který problém řeší:

1. **Nastavení.** Per-machine chování patří do gitignored
   `launchpad.gen3.local.json`; chování aplikace do jejího `package.json`
   manifestu (`companyascode.app`); chování Organizace do jejího
   `company.gen3.json`.
2. **Deklarativní plugin.** Read-only rozšíření detailu aplikace patří do
   `launchpad.plugin.json` (viz `launchpad/plugins/README.md`). Plugin v1
   nesmí spouštět kód ani přidávat akce — pokud tvůj záměr tohle potřebuje,
   patří do sdíleného core (stupeň 4).
3. **Repo Organizace.** Cokoli company-specific — data, moduly, pravidla,
   vzhled, workflow jedné firmy — patří do repa té Organizace
   (`organizations/<Org>_GEN3/`), které si každá Organizace upravuje, jak se
   jí zlíbí. Do sdíleného Conglomerate nikdy.
4. **PR do Conglomerate.** Teprve generický bug fix nebo funkce užitečná
   každé instalaci na světě.

**Pravidlo pro agenty:** když tvůj Principál chce změnit chování Launchpadu,
nenavrhuj úpravu „pro nás" — navrhni ji tak, aby byla aplikovatelná pro celou
komunitu (konfigurovatelná, org-agnostic, forkable). Pokud to nejde, není to
změna Conglomerate, ale kandidát na plugin nebo obsah Organizace.

## Než otevřeš PR

- **Bug fix** s jasnou reprodukcí můžeš poslat rovnou jako malý PR.
- **Funkce nebo změna chování** začíná issue/návrhem, ne hotovým diffem.
  Popiš záměr, koho v komunitě se týká a proč nestačí nižší stupeň žebříku.
  Velké přepisy a refactory bez předchozí domluvy se zavírají.
- Pracuj ve worktree (`.worktrees/<kód>/`), nikdy v primárním checkoutu —
  ten zůstává na `main` a slouží jako referenční strom. Dlouhodobá lokální
  větev na mašině je zakázaný stav; práce, která nemíří do PR, do
  Conglomerate nepatří.

## Kvalita PR — co musí platit

- **Scope:** jedna změna, jeden PR. Nemíchej úrovně — sdílený root vs.
  Organizace vs. modul mají vlastní source of truth (viz `AGENTS.md`).
- **Forkability:** žádná reálná jména firem, klientů ani osob v kódu,
  fixtures a příkladech — používej placeholdery (`ExampleOrg`). Žádné
  secrets, tokeny, OAuth data ani osobní overlay. Shared Launchpad nesmí
  hardcodovat porty ani seznam aplikací jedné organizace.
- **Akce v UI:** žádné nové tlačítko bez vyplněného action contractu
  (Intent, Source of truth, Preconditions, Side effects, Failure mode,
  Access boundary, Verification — viz `launchpad/README.md`). Mutace jsou
  POST, guarded, fail-closed; Doctor zůstává read-only diagnostika.
- **Testy a ověření:** nová logika má test vedle sebe (`*.test.mjs`).
  Před odesláním musí projít `bun run check` a `bun run --cwd launchpad
  test`; po změně configů i `bun run doctor`. Výsledky napiš do popisu PR.
- **Jazykový kontrakt:** strojové identifikátory (klíče, slugs, stavy, CLI)
  anglicky bez diakritiky; lidský text (UI copy, dokumentace, commit
  messages) česky s háčky a čárkami.
- **Čitelnost pro dalšího agenta:** PR musí být srozumitelný bez kontextu
  chatu, ve kterém vznikl. Rozhodnutí a poznatky patří do dokumentace repa,
  ne do konverzace.

## Review a merge

Otevřený PR je Draft — je vidět, dá se editovat a dá se zavřít. Merge dělá
výhradně Organization Steward nebo Organization Admin; přímý push na `main`
nemá nikdo kromě Admina. PRs prochází nočním Steward review (Nightly Steward
PR Sweep). Otevření PR nezakládá nárok na merge — nekvalitní nebo scope-cizí
PR Steward zavře s vysvětlením.

## Jak se změna dostane k lidem

Merge do `main` ještě není release. Dnes se změny šíří direct-pull modelem:
každá mašina si aktualizuje svůj klon z `main`. **Plánované** (decision draft
0078 v HumanAndMachines) jsou dva release kanály: **Nightly** sleduje `main`
(automatický prerelease build) a **Stable** dostává ruční kurátorský řez
`vX.Y.Z` od maintainera frameworku (Steward/Admin GitHub organizace
HumanAndMachines). Release smí spustit jen GitHub user s právy — Release
není Publikace dat.

## Fork policy

Osobní fork na vlastní GitHub účet je dovolený („If you don't like something,
fork it."), netechnickým uživatelům ho ale nedoporučujeme — přicházejí tím
o sdílené aktualizace a podporu. Preferovaná cesta je vždy: nastavení →
plugin → Organizace → PR sem.
