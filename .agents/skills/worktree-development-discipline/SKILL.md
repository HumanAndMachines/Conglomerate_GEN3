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
   `main`, pokud tomu nebrání už existující zachovaná práce.
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
   HumanAndMachines plánem, branchí/base, `created_at`, `created_by`,
   `last_touched`, stavem, PR URL, purpose a cleanup pravidlem. Owner se čte z
   plánu, sidecar není druhá autorita.
5. Nevytvářej nové worktrees v `/tmp`, vedle repa, v
   `~/.hermes/worktrees`, `.claude/worktrees`, `.codex-tmp`,
   `.pr-worktrees`, legacy `.worktrees/<code>` ani uvnitř jiného repa.
6. Pokud primary není na `main` nebo je dirty, nic nezahazuj. Zachovej cizí
   práci a nový worktree založ z ověřeného `origin/main`.
7. Před handoffem aktualizuj sidecar a znovu spusť audit i
   `bun run worktrees:check`. Check je nutný, ale ne dostačující. Worktree
   odstraň jen
   když je clean včetně untracked souborů, nemá local-only commit, exact HEAD je
   na remote, PR je merged nebo explicitně abandoned se snapshotem, runtime ho
   nepoužívá a neexistuje aktivní writer. Pak použij owner repo
   `git worktree remove <path>` a `git worktree prune`; sidecar smaž až potom.
8. Plošné `rm -rf`, `--force`, `git branch -D` a automatické mazání podle stáří
   nejsou běžný cleanup. Nesplněný guard se předává konkrétně.

## Ověření

```bash
bun run worktrees:status
bun run worktrees:check
git status --short --branch
git -C <worktree> status --short --branch
bun run check
bun run doctor
```

Handoff obsahuje primary stav, worktree cestu/branch/plán/sidecar, push/PR,
provedené ověření a výsledek cleanupu nebo konkrétní důvod ponechání.
