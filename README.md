# HumanAndMachine GEN3 / Conglomerate root

Sdílený framework repo pro **HumanAndMachine GEN3** (dříve pracovní název **Conglomerate GEN3**): jedno místo na počítači člověka nebo AI kolegy, odkud se načítá jeho osobní kontext a více GitHub-like Organizací.

Tenhle root není jedna firma ani klientské workspace repo. Je to společný framework, který vyvíjí Rozjedeme.ai a který je na GitHubu hostovaný jako `HumanAndMachines/Conglomerate_GEN3`, protože organizace `HumanAndMachine` byla zabraná. Drží sdílený Launchpad, Guide, šablony, manuály, privátní `personalspace/` mountpoint a lokální mountpointy Organizací; Organizace v něm zůstávají oddělené access hranice a vlastní git repozitáře.

## Navržený tvar

```text
Conglomerate/
├── launchpad/
├── guide/
├── templates/
├── manual/
├── launchpad.gen3.json
├── personalspace/              # lokální gitignored osobní/Buddy mount
└── organizations/
    ├── README.md               # jediný soubor trackovaný v root repu
    ├── ExampleOrg_GEN3/        # lokální gitignored Organization repo checkout
    ├── OtherOrg_GEN3/          # lokální gitignored Organization repo checkout
    └── <ClientOrg>_GEN3/       # lokální gitignored Organization repo checkout
        ├── workspace/          # plochá složka všech workspace modulů
        │   └── <modul>/        # Workspace příslušnost deklaruje manifest
        └── productionspace/    # org-level repa mimo workspace moduly
```

## Hlavní pojmy

- HumanAndMachine GEN3 — současný název systému/frameworku dříve označovaného jako Conglomerate GEN3.
- Konglomerát — lokální celek více Organizací pod jedním Launchpad rootem na jedné mašině; dostupné Organizace se auto-discoverují z `organizations/*/company.gen3.json`, `launchpad.gen3.json` drží jen sdílená root metadata; `planned` sloty jsou per-machine v gitignored `launchpad.gen3.local.json`.
- `launchpad/` — sdílený **builder-first Launchpad GEN3** (decision 0047 v HumanAndMachines/docs/decisions/, reviduje CEO-first 0024): surface pro Buildery Organizace (Organization Builder) — spouštění aplikací z `main` i z worktrees podle Mission Control plánů (decision 0049), read-only přehled productionspace a dynamické načítání Organizací/Workspaces/modulů se stavy `available` / `missing_access` / `planned_slot`; Admin Organizace (Organization Admin), vstup Uživatelů Organizace (Organization User) do produkčních workspace aplikací a deploy/server konfigurace patří do Conglomerate Dashboardu GEN3.
- `guide/` — sdílený netechnický onboarding kurz do práce s digitální kanceláří a AI kolegy; technická cesta „mapa systému“ (Launchpad root, Organizace, workspaces, productionspace, personalspace) je plánovaná budoucí část kurzu.
- `launchpad.gen3.json` — strojově čitelná sdílená root metadata (root, lokální povrchy), ne allowlist Organizací; Organizace i šablony se auto-discoverují skenem disku a `planned` sloty s personalspace ownerem žijí per-machine v gitignored `launchpad.gen3.local.json` — flow „GitHub přístup → Synchronizovat → modul/Organizace se objeví v Launchpadu“ (decision 0042 v HumanAndMachines/docs/decisions/).
- `personalspace/` — privátní osobní repo vlastníka počítače nebo autonomního AI kolegy. Nepatří do GitHub organizace firmy. Směřuje k privátním modulům analogickým workspace modulům: per-user/per-colleague aplikace, osobní/Buddy runtime a GBrain rozhraní pro nahlížení do soukromé paměti.
- `organizations/` — lokální mountpoint pro Organizace ve smyslu GitHub Organization. V root repu je trackovaný pouze `organizations/README.md`; konkrétní `organizations/<org>/` jsou samostatné nested git checkouty Organizací a jsou gitignored.
- Workspace uvnitř Organizace — pojmenovaná skupina modulů (digitální kancelář jednoho týmu NEBO značky/venture, „Oddělení“/„Kancelář“) s vlastním doctorem, pravidly a access hranicí. Všechny workspace moduly Organizace žijí fyzicky v jedné ploché složce `workspace/`; Workspace je logická deklarace v manifestu, ne adresář. Modul patří právě do jednoho Workspace; příslušnost deklaruje definice modulu (`modules[].workspace` / `module_slots[].workspace`), deklarace je autorita a UI grupuje podle ní; chybějící deklarace = default Workspace `workspace`; hosted vzor `<modul>.<workspace>.<doména>` se generuje z deklarace (decision 0041 v HumanAndMachines/docs/decisions/).
- `organizations/<org>/productionspace/` — org-level složka pro repozitáře dané Organizace, které nejsou workspace moduly, například firmware, connect a monorepo. Každé productionspace repo si definuje vlastní pravidla (branch model, release proces); doctor k nim přistupuje jinak než k workspace modulům a vynucuje jen bezpečné minimum (decision 0041 body 6–7 v HumanAndMachines/docs/decisions/).

## Proč Organization místo Space

`Organization GEN3` líp sedí na existující paritu s GitHubem:

- ExampleOrg a OtherOrg jsou GitHub organizace (příkladové názvy).
- Sdílené firemní systémy patří do GitHub organizace.
- `personalspace` naopak patří mimo organizaci — do osobního GitHub účtu člověka nebo AI kolegy.
- Uvnitř Organizace může existovat víc povrchů: jeden nebo více workspaces (tým nebo značka/venture) pro každodenní práci a org-level `productionspace/` pro produkční systémy.

## Aktuální pilot

Aktuální lokální GEN3 pilot je HumanAndMachine GEN3 / Conglomerate root
s několika živými Organization checkouty, např.:

```text
organizations/ExampleOrg_GEN3/
organizations/OtherOrg_GEN3/
organizations/ClientX_GEN3/
```

Tyhle adresáře jsou na konkrétní mašině samostatné git repozitáře Organizací a
jsou v root repu ignorované. Na GitHubu v `HumanAndMachines/Conglomerate_GEN3` má být
uvnitř `organizations/` trackovaný pouze `README.md`; template a scaffold kód
patří do `templates/`, ne jako submodule pod `organizations/`.

## Základní agentní balík

- `.agents/skills/` — sdílené postupy pro Buddy a AI kolegy v Launchpad rootu.
- `manual/desktop-execution-agent-collaboration.md` — baseline pro spolupráci s Claude/Codex Desktop App: Desktop agent dělá maximum práce, Buddy drží QA gate a reviewer routing.

## Spuštění a validace

```sh
bun run launchpad
bun run check
bun run doctor
```

### Windows: Start Menu a hlavní panel

Sdílený Launchpad lze na Windows nainstalovat jako uživatelskou zkratku bez
administrátorských práv:

```powershell
bun run install:windows-shortcut
```

Instalátor vytvoří položku `HumanAndMachine Launchpad GEN3` ve Start Menu,
nastaví pracovní složku na tento Conglomerate root, použije dodanou ikonu a
požádá Windows o připnutí na hlavní panel. Případnou existující stejnojmennou
zkratku nejdřív zálohuje do
`%LOCALAPPDATA%\HumanAndMachine\Launchpad\shortcut-backups\<timestamp>`.

Windows 11 může programové připnutí na hlavní panel podle místní policy
odmítnout. V takovém případě zůstane ověřená položka ve Start Menu: vyhledej
`HumanAndMachine Launchpad GEN3`, klikni pravým tlačítkem a zvol
**Připnout na hlavní panel**. Instalátor nevypíná ani nemaže starší launchery.

Jen Start Menu bez pokusu o připnutí:

```powershell
& .\Install-LaunchpadShortcut.ps1 -StartMenuOnly
```

Launchpad manifesty a aplikace se objevují z Organizací auto-discovernutých skenem `organizations/*/company.gen3.json`; `launchpad.gen3.json` k tomu drží jen sdílená root metadata a `planned` sloty jdou per-machine do gitignored `launchpad.gen3.local.json`.

## První klientský rollout

Pro nový klientský mount použij [manual/first-client-organization-rollout.md](manual/first-client-organization-rollout.md). Runbook drží hranici shared root vs klientská Organization, minimální mount/manifest postup, Doctor/Launchpad support-loop gate, Install/Repair smoke, secret custody a rollback bez mazání klientských dat.

## Licence

Repo je source-available pod licencí **FSL-1.1-Apache-2.0** (Functional
Source License): volné užití, úpravy a forky pro vlastní potřebu; zakázané
je konkurenční hostování/přeprodej. Každá vydaná verze se dva roky po
vydání automaticky uvolňuje pod Apache 2.0. Plné znění: [LICENSE.md](LICENSE.md).
