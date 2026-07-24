---
name: worktree-development-discipline
description: Povinná disciplína pro každou Git změnu, branch, PR, review, předávku a cleanup z Conglomerate rootu. Drží primary checkout na main, worktrees v .worktrees/root pod owner repem, sidecar a bezpečné cleanup guardy.
---

# Worktree development discipline

## Kdy použít

Použij před každou změnou Git-trackovaného obsahu v Conglomerate rootu a při
inventuře, předávce nebo úklidu worktrees. Kanonický upstream kontrakt je
HumanAndMachines decision 0049 a stejnojmenný skill; lokální kopie je
samostatně použitelný consumer kontrakt pro agenta, který startoval přímo zde.

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
3. Použij existující HumanAndMachines Mission Control plán. Worktree cesta je
   výhradně
   `<Conglomerate>/.worktrees/root/<canonical-plan-basename>/`; basename je
   název kanonického plan souboru bez `.yaml`. Branch obsahuje kód plánu.
4. Vedle worktree vytvoř
   `<canonical-plan-basename>.worktree.json` podle
   `companiesascode.worktree.v1` s kanonickými identity/path poli, přesným
   HumanAndMachines plánem, branchí/base, `created_at`, `created_by` a stavem.
   Pro bezpečný provoz nový agent doplní také `last_touched`, PR URL, purpose
   a cleanup pravidlo; u staršího schema-valid sidecaru jsou jejich absence
   advisory, ne falešná nevalidita. Owner se čte z plánu, sidecar není druhá
   autorita.
5. Nevytvářej nové worktrees v `/tmp`, vedle repa, v
   `~/.hermes/worktrees`, `.claude/worktrees`, `.codex-tmp`,
   `.pr-worktrees`, legacy `.worktrees/<code>` ani uvnitř jiného repa.
6. Pokud primary není na `main` nebo je dirty, nic nezahazuj. Zachovej cizí
   práci a nový worktree založ z ověřeného `origin/main`.
7. Před každým pushem PR branche spusť v edit worktree `bun run
   pr:preflight`. Gate fetchne `origin/main`, vyžaduje clean commit a čerstvý
   main jako předka HEAD. Pokud neprojde, udělej `git rebase origin/main`,
   zopakuj validace a gate; přepsanou branch pushni pouze příkazem s exact
   `--force-with-lease`, který gate vypíše. Po pushi ověř na GitHubu PR base
   `main`, exact head, mergeability a checks.
8. Commituj a pushuj do PR branche průběžně — po každém uzavřeném pracovním
   kroku, nejpozději před každou odpovědí Principálovi, která ohlašuje stav
   práce. Po prvním pushi branch hned otevři PR proti správné base branchi
   jako GitHub Draft PR, pokud Principál výslovně neřekl, že PR otevřít
   nemáš; v handoffu ho přepni na Ready for review. Remote branch bez PR
   není dokončený handoff: snadno zapadne, Steward ji nemusí vidět a další
   agent ji nemusí převzít. Rozdělaná práce, která existuje jen lokálně, je
   porušení disciplíny (decision 0103).
9. Před handoffem aktualizuj sidecar a znovu spusť audit i
   `bun run worktrees:check`. Check je nutný, ale ne dostačující — teprve po
   něm pokládej otázku na Publikaci.
10. Handoff veď průvodcovsky (decision 0103): závěrečná zpráva začíná
   standardizovaným handoff blokem (PR URL, base, exact HEAD, lidské
   shrnutí, ověření, odkaz na aplikaci běžící z worktree) a končí
   standardizovanou otázkou „Mám změny Publikovat?". Před otázkou zjisti
   živá GitHub práva Principála a řiď se jimi, ne textovým labelem role —
   např. `gh api repos/<owner>/<repo> --jq .permissions`,
   `gh api repos/<owner>/<repo>/branches/<base>/protection`,
   `gh repo view <owner>/<repo> --json
   rebaseMergeAllowed,squashMergeAllowed,mergeCommitAllowed`,
   `gh pr view <číslo> --json mergeable,mergeStateStatus,reviewDecision`.
   Po explicitním „Publikuj" v threadu PR mergni metodou, kterou repozitář
   povoluje (při více povolených je default rebase, pokud Organizace ve svém
   `AGENTS.md` nedeklaruje jinak), v primárním checkoutu stáhni main
   (`bun run doctor:task`, `git pull --ff-only`) a pokračuj krokem 11. Když
   GitHub merge Principálovi nedovoluje, řekni to rovnou v handoffu;
   „Publikuj" pak znamená předání: přepni PR na Ready, vyžádej review
   Stewarda (`gh pr edit --add-reviewer <steward>` + @zmínka v komentáři
   PR) a předej Principálovi, kdo rozhoduje. Merge neobcházej ani na
   opakovanou žádost — GitHub ho fyzicky blokuje. Bez zelené PR zůstává
   otevřený a nic se neděje.
11. Worktree odstraň jen když je clean včetně untracked souborů, nemá
   local-only commit, exact HEAD je na remote, PR je merged nebo explicitně
   abandoned se snapshotem, runtime ho nepoužívá a neexistuje aktivní writer.
   Pak použij owner repo `git worktree remove <path>` a `git worktree prune`;
   sidecar smaž až potom.
12. Plošné `rm -rf`, `--force`, `git branch -D` a automatické mazání podle stáří
   nejsou běžný cleanup. Nesplněný guard se předává konkrétně.

## Ověření

```bash
bun run worktrees:status
bun run worktrees:check
# pouze před taskem z primárního main checkoutu
bun run doctor:task
# před každým PR pushem z edit worktree
bun run pr:preflight
git status --short --branch
git -C <worktree> status --short --branch
bun run check
bun run doctor
```

Handoff začíná standardizovaným blokem podle decision 0103 (PR URL, base,
exact HEAD, lidské shrnutí, ověření, otázka „Mám změny Publikovat?")
a obsahuje primary stav, worktree cestu/branch/plán/sidecar, provedené
ověření a výsledek cleanupu nebo konkrétní důvod ponechání.
