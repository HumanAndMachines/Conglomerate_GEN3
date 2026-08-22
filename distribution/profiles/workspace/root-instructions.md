<!-- generated:lazurio-resident-profile=workspace -->

# Lazurio Runtime — profil Workspace

Tento adresář je immutable Lazurio runtime artefakt. Není to pracovní Git
checkout a nesmí se v něm vytvářet branche, commity, stashe ani lokální
hotfixy. Jeho exact source commit a digest dokazuje `lazurio.resident.json`.

Pracovní prostor Kolegy nebo AI Kolegy žije v odděleném mutable Lazurio Rootu.
Lokálně i hosted používá stejný model a stejné mechanismy; lišit se smí pouze
transport, custody, aktivní Team projekce a provozní nasazení runtime.

Launchpad se spouští z tohoto runtime rootu a pracovní checkout dostává jako
explicitní `WORKSPACE_ROOT`/`--root`. `LAZURIO_RUNTIME_ROOT` musí přesně
ukazovat na tento adresář. Pokud se runtime a working root překrývají, update
se musí zablokovat před první Git mutací.

`lazurio update` spravuje jen Lazurio Root → Organization Rooty → Workspace
Moduly. Productionspace, Personalspace, task/PR worktrees a root-space
repository-db včetně Mission Control dat mají vlastní lifecycle a zůstávají
nedotčené. Update je vždy explicitní; první Launchpad render je GET-only a
nespouští fetch ani mutaci.

Skutečné přístupy určuje přihlášená identita a živá GitHub práva. Runtime,
textová role ani prompt nevytvářejí druhý ACL. Nejasný nebo nebezpečný Git stav
se neopravuje odhadem: zachová se a předá Kolegovi jako prompt pro Codex.

Při řešení problému nejdřív urči kořenovou příčinu, její source of truth a
přirozeného ownera; přečti nejbližší Lazurio manuál a scoped `AGENTS.md` a
spusť relevantní Doctor nebo repo-native check. Oprav nejmenší správnou
autoritativní vrstvu a znovupoužij existující kontrakt místo paralelní
výjimky, konfigurace nebo procesu. Hotfix je jen výslovně dočasné omezení
dopadu s rollbackem a dohledatelným systémovým follow-upem, ne konečné řešení.
Systémové řešení zároveň není licence k velkému refaktoru nebo abstrakci pro
hypotetickou budoucnost.

Po implementaci si polož otázku: „Není to, co jsem právě navrhnul, zbytečně
komplexní mašinerie, kterou by šlo vyřešit elegantněji?“ Odstraň vše, co není
nutné pro správnost, bezpečnost, srozumitelnost nebo provoz, aniž bys obnovil
původní příčinu či oslabil ověření.

Runtime nemá self-update službu. Novou verzi instaluje image/release pipeline
z exact-digest artefaktu; mutable working root se aktualizuje výhradně
centrálním Lazurio update enginem.
