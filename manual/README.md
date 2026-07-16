# HumanAndMachine GEN3 / Conglomerate root Manual

Tento manuál je source of truth pro maintenance agenty, kteří udržují **HumanAndMachine GEN3 / Conglomerate root**.

HumanAndMachine GEN3 je současný název systému dříve označovaného jako Conglomerate GEN3. Tento root (`HumanAndMachines/Conglomerate_GEN3`) není jedna firma ani klientská organizace; je to sdílený framework pro Launchpad, Guide, templates, manuály, privátní `personalspace/` a lokální mountpointy GitHub-like organizací v `organizations/`.

## Maintenance účel

Maintenance agent před zásahem ověřuje:

1. Jestli úkol patří do Launchpad rootu, nebo do konkrétní organizace.
2. Jestli je source of truth `launchpad.gen3.json`, root dokument, nebo konkrétní Organization GEN3.
3. Jestli změna neporušuje cross-organization isolation.
4. Jestli změna patří do template, nebo do konkrétního forku.
5. Jestli po změně projde Launchpad validace.

## Hlavní source of truth

- `launchpad.gen3.json` — sdílená root metadata a lokální povrchy (ne allowlist Organizací; decision 0042). Organizace i šablony se auto-discoverují skenem disku; `planned` sloty a personalspace owner jsou per-machine v gitignored `launchpad.gen3.local.json`.
- `package.json` — root workflow pro `bun run check`, `bun run doctor` a spuštění Launchpadu.
- `AGENTS.md` — rozhodovací pravidla pro agenty před vstupem do organizace.
- `MAP.md` — lidský rozcestník.
- `launchpad/` — sdílený builder-first Launchpad GEN3 (decision 0047 v HumanAndMachines/docs/decisions/, reviduje CEO-first 0024): surface pro Buildery Organizace (Organization Builder) — spouštění aplikací z `main` i z worktrees podle Mission Control plánů (decision 0049), read-only přehled productionspace a dynamické načítání Organizací/Workspaces/modulů se stavy `available` / `missing_access` / `planned_slot`; Admin Organizace (Organization Admin), vstup Uživatelů Organizace (Organization User) do produkčních workspace aplikací a deploy/server konfigurace patří do Conglomerate Dashboardu GEN3.
- `guide/` — sdílený netechnický onboarding kurz do práce s digitální kanceláří a AI kolegy; mechanismy rootu a Organizací drží `manual/` a MAP.md, dokud nevznikne plánovaná cesta „mapa systému“.
- `organizations/README.md` — jediné trackované vysvětlení lokálního Organization mountpointu; konkrétní `organizations/*` jsou gitignored nested repos.
- `personalspace/` — privátní osobní repo mimo GitHub organizace.
- `templates/` — doplňkové šablony.
- `drafts/` — lokální prostor bez dlouhodobé autority.
- `manual/security/local-secret-custody.md` — standard pro lokální držení
  OAuth client JSONů, token helper souborů a dalších secret artefaktů mimo Git.
- `manual/first-client-organization-rollout.md` — obecný rollout runbook pro první klientskou Organization: repo hranice, mount, manifesty, Doctor/Launchpad support-loop gate, Install/Repair smoke a rollback.
- `manual/desktop-execution-agent-collaboration.md` — baseline spolupráce Buddy a workspace-local AI kolegů s Claude/Codex Desktop App agenty: Desktop agent dělá maximum práce, Buddy drží QA gate a reviewer routing.
- `manual/worktree-management.md` — cílový CAC-0065 kontrakt pro standardizované
  Conglomerate a Organization worktree environments, manifestovou dependency
  hydrataci, Launchpad read model a PR-aware bezpečný cleanup; do implementace
  je výrazně označený jako plán, ne jako aktivní CLI návod.
- `manual/personalspace-modules-and-hosted-gbrain.md` — seed koncept pro personalspace privátní moduly, per-user/per-colleague aplikace, hosted GBrain a Obsidian-compatible sync/reader model.
- `manual/app/v1/` — statická read-only aplikace technického manuálu (`index.html`); nesmí držet pravidla, která nejsou zapsaná v manuálu nebo root dokumentech.

## Organization GEN3 tvar

Reálná organizace má směřovat k tvaru:

```text
organizations/<org>/
├── workspace/              # plochá složka všech workspace modulů
│   └── <modul>/            # Workspace příslušnost deklaruje manifest
└── productionspace/        # org-level repa mimo workspace moduly
```

- Všechny workspace moduly Organizace žijí fyzicky v jedné ploché složce
  `workspace/`; složky `workspaces/<slug>/` se nezavádějí. Pojmenované
  Workspaces („Oddělení“/„Kanceláře“ — digitální kancelář jednoho týmu NEBO
  značky/venture) s vlastním doctorem, pravidly a access hranicí jsou
  logická deklarace v manifestu (`modules[].workspace` /
  `module_slots[].workspace`), ne adresář. Modul patří právě do jednoho
  Workspace; deklarace je autorita a UI grupuje podle ní; chybějící
  deklarace = default Workspace se slugem `workspace`; hosted vzor
  `<modul>.<workspace>.<doména>` se generuje z deklarace
  (decisions 0021/0023 v HumanAndMachines/docs/decisions/; fyzický layout
  revidován decision 0041 tamtéž).
- `productionspace/` drží org-level repozitáře, které nejsou workspace
  moduly. productionspace nedefinuje pevná pravidla — každé repo si
  definuje vlastní branch model a release proces; doctor u nich vynucuje
  jen bezpečné minimum, na rozdíl od jednotného kontraktu workspace modulů
  (decision 0041 body 6–7 v HumanAndMachines/docs/decisions/).

Při migraci z Workspace GEN2 rozděl Organizace repozitáře mezi `workspace/` a `productionspace/`: product/runtime repozitáře, které nejsou workspace moduly, patří do `productionspace/`; kancelářské a firemní aplikace do `workspace/`.

## Personalspace pravidlo

`personalspace/` je vedle `organizations/`, protože patří do osobního GitHub účtu vlastníka počítače nebo AI kolegy. Není to repo v žádné klientské ani provozní GitHub organizaci. Cílově nemá být jen privátní složka: má mít privátní moduly analogické workspace modulům, per-user/per-colleague aplikace a GBrain rozhraní pro nahlížení do osobní/Buddy paměti. Viz `manual/personalspace-modules-and-hosted-gbrain.md`.

Root/Buddy/operator secrets, které nepatří do konkrétní Organizace, patří do
gitignored `personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>` s adresáři
`0700` a soubory `0600`. Secrets konkrétního kolegy uvnitř Organizace patří
do `organizations/<org>/company/colleagues/<os-user>/private/secrets/...`.
Tool-specific cesty typu `~/.config/...` nebo `~/.local/share/...` jsou jen
runtime/cache cesty, ne custody source of truth.

## Maintenance pravidla

- Root nesmí být použit jako místo pro business pravdu jedné organizace.
- Citlivá data, zákaznická data a osobní overlaye nesmí přetéct mezi organizacemi.
- Pokud se mění registry nebo mountpointy, změna musí být propsaná do docs, test fixtures a Launchpad discovery.
- V `organizations/` root repo nikdy netrackuje konkrétní Organization checkouty ani submodule pointery; na GitHubu tam patří jen `organizations/README.md`.
- Pokud je otevřená otázka bez rozhodnutého řešení, patří do `ISSUES.open.json`, ne do ad-hoc Markdown poznámky.
- Shared Launchpad nesmí držet hardcodované porty jedné organizace; port deklaruje aplikace ve svém `package.json`.
- Doctor je read-only. Když hlásí problém v Git stavu, submodulech nebo `.gitignore` ochraně runtime/private/archive cest, oprav source-of-truth soubor nebo mountpoint.
- Secret hodnoty, OAuth URL/kódy, tokeny, hesla a obsah JSON credential souborů
  se nesmí posílat chatem ani commitovat; closeout používej jen metadata-only
  ověření a funkční smoke.

## Rollout runbooky

- [First-client Organization rollout](first-client-organization-rollout.md) — od čistého root preflightu přes klientský Organization mount po zelený Doctor/Launchpad handoff.
- [GEN2 → GEN3 migration manual](gen2-to-gen3-migration.md) — převod GEN2 workspace do Organization modelu včetně pravidla, že obecný Organization-local `guide/` se maže a nahrazuje shared `Conglomerate/guide`.
- [Workspace module version lifecycle](workspace-module-version-lifecycle.md) — standard `v0`/`v1`/`v2`/`v3` pro standardní workspace moduly, repository-db v3 writer/draft/publish pipeline, template propagation a Pricebook v3 dogfood.
- [Doctor worktree management](worktree-management.md) — shaping manuál a
  implementační řezy CAC-0065 pro jeden Organization environment se skutečnými
  nested Git worktrees, dependencies a bezpečným uvolněním disku po PR.

## Migrační roadmapa a inventáře

- [Template promotion a sync](template-promotion-and-sync.md) — operativní runbook obou směrů template flow: update Organizací z OrganizationTemplate (content sync, managed/override/manual, hash kontrola) a promotion org poznatků do template (anonymizovaná extrakce); template-first default.
- [GEN2 → GEN3 organization sync inventory](gen2-gen3-sync-inventory.md) — read-only inventory pro explicitně zadaný legacy→GEN3 Organization pár, včetně shared-root/template promotion hints bez ukládání Organization-specific dat do rootu.

## Spolupráce s Desktop agenty

- [Desktop execution agent collaboration](desktop-execution-agent-collaboration.md) — baseline pro spolupráci Buddy a AI kolegů s Claude/Codex Desktop App agenty.

## Aktivní maintenance plány


## Validace

```sh
bun run check
bun run doctor
```

Tyto příkazy ověřují root strukturu, `launchpad.gen3.json`, organizace, Launchpad discovery, testy a read-only doctor report.
