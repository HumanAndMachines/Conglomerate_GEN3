# Lazurio root

Sdílený framework repo pro **Lazurio**: jedno místo na počítači člověka nebo AI kolegy, odkud se načítá jeho osobní kontext a více GitHub-like Organizací.

Tenhle root není jedna firma ani klientské workspace repo. Je to společný
framework vyvíjený Rozjedeme.ai. Historická GitHub organization zůstává
`HumanAndMachines` a canonical repo `HumanAndMachines/Lazurio`; tyto interní
identity nejsou uživatelský název systému. Root drží sdílený Launchpad, Guide,
šablony, manuály, privátní `personalspace/` mountpoint a lokální mountpointy
Organizací; Organizace v něm zůstávají oddělené access hranice a vlastní Git
repozitáře.

Cílové základy budoucího `Lazurio/Lazurio` drží
[ARCHITECTURE.md](ARCHITECTURE.md): čtyři základní pojmy `Owner`, `Machine`,
`Resident` a `Agent`, společný technický základ Buddyho a AI Kolegy a role
Lazuria jako distribuční a lifecycle vrstvy. Dnešní názvy a provider cesty se
od cíle mohou lišit do dokončení migrace `CAC-0092`.

## Lazurio CLI v0

První interní řez Lazurio CLI je nestabilní. Read-only příkazy Agentovi
zpřístupňují bezpečnou projekci identity Principála, aktuální Mašiny a stavu
Personalspace, na explicitní selektor jednu lokálně objevenou Organization a
úzký manifest-scoped search pilot pro Lazurio; nečte SOUL, obsah GBrainu, chat,
sessions, secrets ani mandáty.
Chybějící lokální mount není tvrzení o GitHub přístupu — provider authority
zůstává `not_evaluated`, dokud ji neověří živý provider readback.

Ve vývojovém checkoutu se CLI spouští přes Bun:

```sh
bun run lazurio -- context --json
bun run lazurio -- context --organization HumanAndMachine-ai
bun run lazurio -- doctor
bun run lazurio -- update
bun run lazurio -- search "český dotaz"
bun run lazurio -- search --status
```

Všechny příkazy přijímají `--root <cesta>`. Root může být buď tento Launchpad root
s `launchpad.gen3.json`, nebo samostatný Personalspace root na Buddy VPS s
`personal.gen3.json`. `lazurio doctor` nevlastní diagnostická pravidla: v
Launchpad rootu používá existující strukturované Doctor jádro, v Personalspace
rootu spouští přesně doctor command deklarovaný jeho manifestem. CLI v0 není
distribuční package, veřejné Core API, MCP server ani write surface.
Jediný mutační příkaz `lazurio update` sekvenčně aktualizuje Lazurio Root →
Organization Rooty → Workspace Moduly na clean `main` přes ff-only; jeho přesný
kontrakt drží [manual/lazurio-runtime-install-interface.md](manual/lazurio-runtime-install-interface.md).
Organization selektor nepředstírá membership ani effective permissions:
Organization, Team, modul i aplikace ve výstupu drží provider access
`not_evaluated` a oddělují jej od lokální přítomnosti checkoutu.

## Rezidentní distribuce

`distribution/` drží build kontrakt pro non-Git Lazurio Root profilů Buddy a
Workspace. Z čistého exact source commitu generuje jediný root
`AGENTS.md`, manifest s hashi payloadu, public-safe offline manuál, Resident
Doctor a deterministický per-platformní USTAR artefakt. Profilové fragmenty se
ve source nejmenují `AGENTS.md`, takže v development checkoutu nejsou aktivní.

```sh
bun run resident:build -- --profile buddy --target linux-x64 \
  --version 0.1.0-candidate.1 --channel candidate
```

Build sám nic nereleasuje ani nemění na živém hostu. Kontrakt a omezení jsou v
[distribution/README.md](distribution/README.md), veřejné vysvětlení ekosystému
v [manual/lazurio-resident-profiles.md](manual/lazurio-resident-profiles.md).
Oddělený source-only [operator plane](provisioning/README.md) připravuje
Mašinu a volá stejný updater; není součástí resident artefaktu ani druhým
lifecycle enginem.

Search ve výchozím `exact` režimu čte aktuální filesystem přes `rg`, takže vidí
i novou neindexovanou změnu v explicitně deklarovaném nested repu, přestože
jeho Organization mount ignoruje parent root Git. Nespouští však plošné
`rg --no-ignore` nad Lazuriem: povolené zdroje skládá z Launchpad discovery,
Organization manifestu a verzovaného pilotního registru. QMD lane je volitelný
lokální index pro `lexical`, `semantic` a `hybrid`; jeho stav a čerstvost ukáže
`search --status` a rozbitý QMD neblokuje exact lane. Úplný kontrakt, bezpečnostní
hranice a příkazy drží [lazurio/README.md](lazurio/README.md).

## Začíná se v chatu

Kolega začíná práci přímým chatem s App Agentem. Agent otevře Launchpad GEN3
ve vestavěném browser povrchu na Organizaci nebo lokálním Personalspace, o kterém
je řeč. Launchpad je grafická vrstva stejného lokálního pracovního kontextu:
Kolega na něj může ukazovat a Agent jej může přes podporovanou browser capability
procházet a pomáhat s ním. Ruční opisování adresy ani Dock ikona proto nejsou
primární produktový vstup.

Tento onboardingový tok je určený pro přímý chat člověka s Codex/ChatGPT App
Agentem nebo Claude App Agentem. Neřídí životní cyklus Buddyho ani AI Kolegy.
Přesný agentní kontrakt je v [AGENTS.md](AGENTS.md#chat-first-vstup-do-launchpadu-pro-app-agenty)
a stabilní URL schéma v [launchpad/README.md](launchpad/README.md#stabilní-odkazy-na-prostor).

## Navržený tvar

```text
Lazurio/
├── launchpad/
├── guide/
├── templates/
├── manual/
├── launchpad.gen3.json
├── personalspace/              # lokální gitignored osobní/config mount
└── organizations/
    ├── README.md               # jediný soubor trackovaný v root repu
    ├── ExampleOrg_GEN3/        # lokální gitignored Organization repo checkout
    ├── OtherOrg_GEN3/          # lokální gitignored Organization repo checkout
    └── <ClientOrg>_GEN3/       # lokální gitignored Organization repo checkout
        ├── workspace/          # plochá složka všech workspace modulů
        │   └── <modul>/        # Workspace příslušnost deklaruje manifest
        └── productionspace/    # org-level repa mimo workspace moduly
```

## Personalspace je součást Lazuria

`personalspace/` není externí doplněk ani další Organizace. Je to integrální
privátní vrstva tohoto rootu: Lazurio drží mountpoint, isolation pravidla,
Doctor a onboarding, zatímco konkrétní obsah žije v samostatných privátních
repozitářích jejich vlastníků. Instance vlastníka může plnohodnotně fungovat bez
Buddyho; Buddy je volitelná navazující vazba.

`HumanAndMachines/Lazurio` zůstává veřejný direct-pull framework a
**není GitHub template**. Pro založení osobního prostoru bude po
public-readiness gate `CAC-0071` sloužit veřejný GitHub template
`HumanAndMachines/PersonalspaceTemplate_GEN3`; do té doby zůstává template
private. Výsledné repo musí být vždy privátní a pojmenované:

```text
<github-login>/<github-login>_GEN3
```

Lokální mount je `personalspace/<github-login>_GEN3/`. Gbrain software se
instaluje z veřejného `garrytan/gbrain`, ale osobní Markdown paměť patří do
odděleného privátního data repa vlastníka mountovaného v `gbrain/`. Detailní
custody a agentní pravidla drží [personalspace/README.md](personalspace/README.md);
kanonický model drží decisions 0079/0080 v
[lokálním registru](manual/decision-register.md).
Implementační self-service runbook je
[manual/create-personalspace.md](manual/create-personalspace.md).

Na jedné mašině se materializuje pouze Personalspace jejího Principála,
určený v gitignored `launchpad.gen3.local.json`. Cizí Personalspace se
nemountuje ani nezobrazuje; historický checkout je Doctor failure a musí se
odmountovat a jeho GitHub collaborator granty odebrat podle runbooku v
PersonalspaceTemplate_GEN3 (decision 0091 v `manual/decision-register.md`).

Root příkaz je připravený fail-closed. Dokud upstream public-readiness audit
drží template jako private, zastaví se ještě v preflightu a nic nevytvoří. Až
po explicitním publication gatu template spustí vlastník no-Buddy tok:

```text
bun run personalspace:create -- --display-name "<jméno>" --apply --install-gbrain
```

Třírepo onboarding s private Hermes profilem Buddyho zůstává **PENDING
`CAC-0072`**. Live root parser `--with-buddy` odmítá jako neznámý argument a
nesmí tvrdit vytvoření Buddy repa ani VPS handoffu, dokud nebude samostatný
adapter publikovaný a cross-repo otestovaný.

## Hlavní pojmy

- Lazurio root — lokální celek více Organizací pod jedním Launchpadem na jedné mašině; dostupné Organizace se auto-discoverují z `organizations/*/company.gen3.json`, `launchpad.gen3.json` drží jen sdílená root metadata; `planned` sloty jsou per-machine v gitignored `launchpad.gen3.local.json`.
- `launchpad/` — sdílený **builder-first Launchpad GEN3** (decision 0047 v manual/decision-register.md, reviduje CEO-first 0024): surface pro Buildery Organizace (Organization Builder) — spouštění aplikací z `main` i z worktrees podle Mission Control plánů (decision 0049), read-only přehled productionspace a dynamické načítání Organizací/Workspaces/modulů se stavy `available` / `missing_access` / `planned_slot`; Admin Organizace (Organization Admin), vstup Uživatelů Organizace (Organization User) do produkčních workspace aplikací a deploy/server konfigurace patří do Lazurio Dashboardu.
- `guide/` — sdílený netechnický onboarding kurz do práce s digitální kanceláří a AI kolegy; technická cesta „mapa systému“ (Launchpad root, Organizace, workspaces, productionspace, personalspace) je plánovaná budoucí část kurzu.
- `launchpad.gen3.json` — strojově čitelná sdílená root metadata (root, lokální povrchy), ne allowlist Organizací; Organizace i šablony se auto-discoverují skenem disku a `planned` sloty s personalspace ownerem žijí per-machine v gitignored `launchpad.gen3.local.json`. Nový Organization Modul se po stažení čerstvého manifestu přes `lazurio update` bezpečně materializuje podle živého GitHub přístupu a rediscovery jej ukáže v Launchpadu (decisions 0042/0129).
- `personalspace/` — integrální privátní mountpoint Lazurio rootu pro
  owner repa lidí a AI kolegů. Nepatří do GitHub organizace firmy, funguje i
  bez Buddyho a drží osobní moduly i Gbrain custody mimo firemní pravdu.
  Buddy-enabled instance zde lokálně drží jen konfiguraci; runtime je VPS-only.
- `organizations/` — lokální mountpoint pro Organizace ve smyslu GitHub Organization. V root repu je trackovaný pouze `organizations/README.md`; konkrétní `organizations/<org>/` jsou samostatné nested git checkouty Organizací a jsou gitignored.
- Workspace uvnitř Organizace — pojmenovaná skupina modulů (digitální kancelář jednoho týmu NEBO značky/venture, „Oddělení“/„Kancelář“) s vlastním doctorem, pravidly a access hranicí. Všechny workspace moduly Organizace žijí fyzicky v jedné ploché složce `workspace/`; Workspace je logická deklarace v manifestu, ne adresář. Modul patří právě do jednoho Workspace; příslušnost deklaruje definice modulu (`modules[].workspace` / `module_slots[].workspace`), deklarace je autorita a UI grupuje podle ní; chybějící deklarace = default Workspace `workspace`; hosted vzor `<modul>.<workspace>.<doména>` se generuje z deklarace (decision 0041 v manual/decision-register.md).
- `organizations/<org>/productionspace/` — org-level složka pro repozitáře dané Organizace, které nejsou workspace moduly, například firmware, connect a monorepo. Každé productionspace repo si definuje vlastní pravidla (branch model, release proces); doctor k nim přistupuje jinak než k workspace modulům a vynucuje jen bezpečné minimum (decision 0041 body 6–7 v manual/decision-register.md).

## Proč Organization místo Space

`Organization GEN3` líp sedí na existující paritu s GitHubem:

- ExampleOrg a OtherOrg jsou GitHub organizace (příkladové názvy).
- Sdílené firemní systémy patří do GitHub organizace.
- `personalspace` naopak patří mimo organizaci — do osobního GitHub účtu člověka nebo AI kolegy.
- Uvnitř Organizace může existovat víc povrchů: jeden nebo více workspaces (tým nebo značka/venture) pro každodenní práci a org-level `productionspace/` pro produkční systémy.

## Aktuální pilot

Aktuální lokální GEN3 pilot běží v Lazurio rootu
s několika živými Organization checkouty, např.:

```text
organizations/ExampleOrg_GEN3/
organizations/OtherOrg_GEN3/
organizations/ClientX_GEN3/
```

Tyhle adresáře jsou na konkrétní mašině samostatné git repozitáře Organizací a
jsou v root repu ignorované. Na GitHubu v `HumanAndMachines/Lazurio`
má být uvnitř `organizations/` trackovaný pouze `README.md`. Modulové template
a scaffold zdroje patří do `templates/`; pracovní Organization template smí
být samostatný nested repo checkout pouze uvnitř `productionspace/` spravující
Organizace (decision 0127), nikdy root submodule nebo druhý alias.

## Základní agentní balík

- `.agents/skills/` — sdílené postupy pro Buddy a AI kolegy v Launchpad rootu.
- `manual/desktop-execution-agent-collaboration.md` — baseline pro spolupráci s Claude/Codex Desktop App: Desktop agent dělá maximum práce, Buddy drží QA gate a reviewer routing.
- `manual/external-app-integrations.md` — závazný standard napojení na externí
  aplikace: lokálně kurátorované MCP servery a CLI na každé mašině místo
  cloudových konektorů a sdílených brokerů; per-provider runbooky v
  `manual/integrations/`.
- `manual/codex-manual-mcp-integrations.md` — Codex-specifický per-machine
  runbook pro ruční MCP napojení a řízený přechod ze sdíleného integračního
  brokeru; přímé STDIO a vzdálené HTTP integrace Docker nepotřebují.

## Spuštění a validace

```sh
bun run launchpad
bun run check
bun run doctor
```

### macOS: aplikace pro Dock

Z primárního Lazurio checkoutu nainstaluj stabilní uživatelskou aplikaci bez
administrátorských práv:

```sh
bun run install:macos-app
```

Instalátor vytvoří ad-hoc podepsanou aplikaci
`~/Applications/HumanAndMachine Launchpad.app`, takže nepotřebuje vývojářský
certifikát ani zápis do systémového `/Applications`. Aplikace drží pouze
kanonickou cestu rootu a otevírá jeho `Launchpad.command`; Bun resolution,
Server identity/install-generation, bezpečné nahrazení stale instance i porty
tak dál vlastní jediný Lazurio/Launchpad runtime. macOS instalace nezavádí
LaunchAgent, daemon ani druhou lifecycle autoritu.

Reinstalace se mezi souběžnými procesy serializuje a publikuje celý app bundle
nativní atomickou macOS výměnou, takže cesta připnutá v Docku během updatu
nezmizí. Předchozí aplikaci zachová jako jedinou skrytou, ne-launchovatelnou
rollback zálohu; starší zálohu odstraní až po úspěšném ověření nové generace.
Instalace z linked worktree se odmítne;
podporovaný je primární Git checkout, primární checkout se samostatným Git
metadata adresářem a directory-only root AI Kolegy/Buddyho. Pokud na stroji
zůstává historická `/Applications/Launchpad GEN3.app` nebo
`~/Applications/Launchpad GEN3.app`, instalátor ji nemaže ani nepřepisuje a
výslovně upozorní, že Dock má používat novou uživatelskou aplikaci. Do Docku ji
připneš přetažením z uživatelské složky `Applications`; instalátor Dock sám
nemění.

### Windows: Start Menu a hlavní panel

Sdílený Launchpad lze na Windows nainstalovat jako uživatelskou zkratku bez
administrátorských práv:

```powershell
bun run install:windows-shortcut
```

Instalátor atomicky připraví stabilní uživatelský bootstrap a konfiguraci pod
`%LOCALAPPDATA%\HumanAndMachine\Launchpad` (legacy interní instalační cesta),
vytvoří položku `Lazurio Launchpad` ve Start Menu a požádá Windows o připnutí na
hlavní panel. Zkratka neukazuje přímo do pohyblivého checkoutu: bootstrap
načte canonical root z `install.json` a spustí jeho `Launchpad.ps1`, který
zůstává jediným vlastníkem Bun resolution a startu Launchpadu. Instalace
z linked worktree — bez ohledu na název jeho složky — nebo přes junction se
odmítne; canonical cíl je primary checkout nebo podporovaný directory-only
root. Primary checkout se samostatným stabilním Git metadata adresářem
(`--separate-git-dir`) zůstává podporovaný; linked worktree se rozpozná podle
Git admin struktury, ne jen podle názvu cesty nebo existence `.git` souboru.
Port ani druhý lifecycle stav se do instalace nezapisují. Nový
`install.json` se aktivuje až po validaci bootstrapu a všech požadovaných
zkratek; selhání reinstalace zachová předchozí aktivní pointer a atomicky vrátí
i každou zkratku, jejíž nahrazení už začalo. Existující
aktivní zkratku se stejným názvem instalátor nahradí; její původní podobu
nejdřív zachová v oddělené záloze pro Start Menu nebo taskbar pod
`%LOCALAPPDATA%\HumanAndMachine\Launchpad\shortcut-backups\<timestamp>`.

Při prvním přechodu ze starého serveru může nový launcher vyžádat jeho ruční
ukončení a opakované spuštění. Chybová zpráva i návratový kód zůstanou v okně
viditelné; instalátor starý proces ani jeho port sám nepřebírá.

Windows 11 může programové připnutí na hlavní panel podle místní policy
odmítnout. V takovém případě zůstane ověřená položka ve Start Menu: vyhledej
`Lazurio Launchpad`, klikni pravým tlačítkem a zvol
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
