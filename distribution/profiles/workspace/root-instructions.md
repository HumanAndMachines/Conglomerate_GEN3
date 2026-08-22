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

## Architektonická odpovědnost při změně source kódu

Principál určuje chtěný výsledek a má poslední slovo, ale jeho zadání není
automaticky hotovou architektonickou specifikací. Před každou tvorbou nebo
změnou source kódu v odděleném pracovním checkoutu použij přibalený skill
`.agents/skills/architecture-shaping/SKILL.md`. Kriticky ověř navržený
prostředek proti autoritám a principům Lazuria, navrhni nejmenší úplné řešení a
rozpor otevřeně pojmenuj. Hloubka je úměrná riziku; malá změna nepotřebuje nový
dokument ani externí review a nedostupný konkrétní reviewer, model, CLI či
subagent není blocker. Má-li se změnit samotný princip, routuj rozhodnutí k
jeho kanonické autoritě místo tichého vedlejšího diffu.

Runtime nemá self-update službu. Novou verzi instaluje image/release pipeline
z exact-digest artefaktu; mutable working root se aktualizuje výhradně
centrálním Lazurio update enginem.
