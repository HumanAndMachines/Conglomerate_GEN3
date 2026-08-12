---
name: worktree-development-discipline
description: Povinná disciplína pro každou Git změnu, branch, PR, review, předávku a cleanup z Conglomerate rootu. Drží primary checkout na main, worktrees v .worktrees/root pod owner repem, sidecar a bezpečné cleanup guardy.
---

# Worktree development discipline

## Kdy použít

Použij před každou změnou Git-trackovaného obsahu v Conglomerate rootu a při
inventuře, předávce nebo úklidu worktrees. Tato lokálně verzovaná kopie je
samostatně použitelný consumer kontrakt pro agenta, který startoval přímo zde;
veřejný root kvůli němu nepotřebuje privátní Knowledgebase ani Mission Control.

## Postup

1. Primární checkout `<Conglomerate>` je reference pro Launchpad/Doctor.
   Neměň v něm trackovaný obsah, nezakládej v něm feature branch a drž ho na
   `main`, pokud tomu nebrání už existující zachovaná práce. Před převzetím
   každého tasku v něm spusť `bun run doctor:task`. Freshness lane provede
   bounded fetch `origin/main`; clean-behind main aktualizuj guarded lane
   `bun run update` (ff-only) a gate zopakuj. Dirty/ahead/diverged/wrong-branch
   stav zachovej a oprav přes worktree — automatický `pull --rebase
   --autostash` není default a `--preserve` je jen explicitní volba.
2. Než něco vytvoříš, spusť `bun run worktrees:status`. Audit čte Git registry,
   takže ukáže i linked worktrees mimo root. Je to informativní inventura;
   `bun run worktrees:check` je fail-closed kontrola umístění, metadat a Git
   zachování. Její PASS není cleanup autorizace.
3. Použij existující Mission Control plán jeho vlastníka a worktree založ
   kanonickou lane `bun run worktrees:create -- --plan <KOD-XXXX>` — odvodí
   basename z kanonického plan souboru, založí branch z čerstvého
   `origin/main` a vygeneruje schema-validní sidecar. Create lane vyhledá exact
   kód plánu v připojených
   `organizations/*/mission-control/db`; přijme právě jednu shodu a při nule
   nebo více shodách failne. Připojenou Organization lze výslovně zvolit
   generickým `MISSION_CONTROL_AUTHORITY_ROOT=<organization-root-or-db>`;
   externí checkout se pro nový worktree nepřijímá.
   Organization authority musí být lokální
   `organizations/<organization>/mission-control/db`; create lane ji do
   tohoto tvaru normalizuje, uloží do sidecaru a nikdy nevytváří duplicitní
   plán v jiném repu.
   Worktree cesta je
   výhradně `<Conglomerate>/.worktrees/root/<canonical-plan-basename>/`;
   basename je název kanonického plan souboru bez `.yaml`. Branch obsahuje
   kód plánu.
4. Sidecar `<canonical-plan-basename>.worktree.json` (schema
   `companiesascode.worktree.v1`) generuje create lane — zkontroluj ho,
   nevytvářej podruhé a nepřepisuj odvozená identity/path pole; doplň jen
   to, co skript nemohl bezpečně odvodit: `last_touched`, PR URL, purpose
   a cleanup pravidlo. Organization-scoped plán nese odvozený relativní
   `mission_control_authority_path`; nepřepisuj ho absolutní cestou ani
   traversalem. Platný sidecar navíc obsahuje
   `conversation_origin` (`surface`, `agent_label`, opaque `thread_id` nebo
   výslovný locator status, `captured_at`, `local_only: true`) a
   `recovery_handoff` (stav, stručné netajné summary, blocker, next action,
   `updated_at`). Stabilní ID poskytované agentním povrchem, například
   `CODEX_THREAD_ID`, zachyť automaticky. U staršího schema-valid sidecaru jsou
   absence těchto polí advisory, ne falešná nevalidita. Owner se čte z plánu,
   sidecar není druhá autorita. Neukládej raw transcript, chain-of-thought,
   secrets ani absolutní transcript path.
5. Nevytvářej nové worktrees v `/tmp`, vedle repa, v
   `~/.hermes/worktrees`, `.claude/worktrees`, `.codex-tmp`,
   `.pr-worktrees`, legacy `.worktrees/<code>` ani uvnitř jiného repa.
6. Pokud primary není na `main` nebo je dirty, nic nezahazuj. Zachovej cizí
   práci a nový worktree založ z ověřeného `origin/main`.
7. Ještě před otevřením nebo předáním PR napiš rozhodnutelný popis: motivaci a
   relevantní souvislosti, cílový stav a přínos merge, skutečný rozsah včetně
   vědomě vynechaných částí, ověření a zbývající rizika, blokery či navazující
   kroky. Steward nesmí být nucen odvozovat „proč" jen z diffu. Popis po změně
   scope, rebase nebo zásadním review nálezu srovnej se skutečným HEADem a
   Mission Control plánem; samotný seznam souborů, commitů nebo testů není
   dokončený handoff.
8. Před každým pushem PR branche spusť v edit worktree `bun run
   pr:preflight`. Gate fetchne `origin/main`, vyžaduje clean commit a čerstvý
   main jako předka HEAD. Pokud neprojde, udělej `git rebase origin/main`,
   zopakuj validace a gate; přepsanou branch pushni pouze příkazem s exact
   `--force-with-lease`, který gate vypíše. Po pushi ověř na GitHubu PR base
   `main`, exact head, mergeability a checks.
9. Commituj a pushuj do PR branche průběžně — po každém uzavřeném pracovním
   kroku, nejpozději před každou odpovědí Principálovi, která ohlašuje stav
   práce. Po prvním pushi branch hned otevři PR proti správné base branchi
   jako GitHub Draft PR. Pokud Principál výslovně zakázal PR otevřít,
   nepokračuj za hranici lokálního experimentu a před dalším pushem nebo
   koncem práce si vyžádej rozhodnutí: Draft zahodit, nebo PR povolit —
   samotná remote branch bez PR není přípustná náhrada.
   Jakmile je práce hotová a ověřená, přepni PR na Ready for review
   sám, ještě před handoffem — Ready není Publikace, říká jen „připraveno
   ke kontrole"; hotová práce nezůstává viset jako GitHub Draft. Remote
   branch bez PR není dokončený handoff: snadno zapadne, Steward ji nemusí
   vidět a další agent ji nemusí převzít. Rozdělaná práce, která existuje
   jen lokálně, je porušení disciplíny (decisions 0103/0112).
10. Při pauze, blockeru, předání a před koncem agentního běhu aktualizuj
   `last_touched`, conversation origin aktuálního writer ownera a recovery
   handoff. Morning/night/cleanup agent smí přes lokální thread dohledat
   kontext, ale před commitem, pushem, PR rozhodnutím nebo cleanupem ověří Git
   status/diff, remote, PR/checks, runtime a Mission Control. Nedostupný thread
   není důkaz opuštění práce.
11. Před handoffem aktualizuj sidecar a znovu spusť audit i
   `bun run worktrees:check`. Check je nutný, ale ne dostačující — teprve po
   něm pokládej otázku na Publikaci.
12. Handoff veď průvodcovsky (decisions 0103/0112): závěrečná zpráva začíná
   standardizovaným handoff blokem (PR URL, base, exact HEAD, lidské
   shrnutí, ověření, odkaz na aplikaci běžící z worktree) a končí
   standardizovanou dvojotázkou „Mám změny Publikovat tvým jménem? Nebo mám
   požádat jiného Kolegu o kontrolu a Publikaci?" — volbu vždy nabídni,
   nedomýšlej ji za Principála. Před otázkou zjisti
   živá GitHub práva Principála a řiď se jimi, ne textovým labelem role —
   např. `gh api repos/<owner>/<repo> --jq .permissions`,
   `gh api repos/<owner>/<repo>/branches/<base>/protection`,
   `gh repo view <owner>/<repo> --json
   rebaseMergeAllowed,squashMergeAllowed,mergeCommitAllowed`,
   `gh pr view <číslo> --json mergeable,mergeStateStatus,reviewDecision`.
   Po explicitním „Publikuj" v threadu PR mergni metodou, kterou repozitář
   povoluje (při více povolených je default rebase, pokud Organizace ve svém
   `AGENTS.md` nedeklaruje jinak), v primárním checkoutu stáhni main
   (`bun run doctor:task`, `git pull --ff-only`) a pokračuj cleanup guardy
   v kroku 13. Když Principál zvolí předání, nebo mu GitHub merge
   nedovoluje, vyžádej review Kolegy, kterého Principál zvolil
   (`gh pr edit --add-reviewer <login>` + @zmínka v komentáři PR); pokud
   nikoho neurčil, požádej ho o volbu — Stewarda použij bez další otázky
   jen tehdy, když ho jako výchozí rozhodující osobu určuje politika repa.
   Předej Principálovi, kdo teď rozhoduje. Merge neobcházej ani na
   opakovanou žádost — GitHub ho fyzicky blokuje. Bez zelené PR zůstává
   otevřený a nic se neděje.
13. Worktree odstraň jen když je clean včetně untracked souborů, nemá
   local-only commit, exact HEAD je na remote, PR je merged nebo explicitně
   abandoned se snapshotem, runtime ho nepoužívá a neexistuje aktivní writer.
   Pak použij owner repo `git worktree remove <path>` a `git worktree prune`;
   sidecar smaž až potom.
14. Plošné `rm -rf`, `--force`, `git branch -D` a automatické mazání podle stáří
   nejsou běžný cleanup. Nesplněný guard se předává konkrétně.

## Ověření

```bash
bun run worktrees:create -- --plan <KOD-XXXX> --dry-run
# pouze pro výslovný výběr připojené Organization; běžně se objeví automaticky:
MISSION_CONTROL_AUTHORITY_ROOT=<organization-root-or-db> bun run worktrees:create -- --plan <KOD-XXXX> --dry-run
bun run worktrees:status
bun run worktrees:check
# pouze před taskem z primárního main checkoutu
bun run doctor:task
# před každým PR pushem z edit worktree
bun run pr:preflight
git status --short --branch
git -C <worktree> status --short --branch
jq '{conversation_origin, recovery_handoff}' <sidecar.worktree.json>
bun run check
bun run doctor
```

Povinný obsah a zakončení handoffu drží krok 12; navíc uveď stav primary
checkoutu, worktree cestu/branch/plán/sidecar, provedené ověření a výsledek
cleanupu nebo konkrétní důvod ponechání.
