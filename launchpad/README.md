# Launchpad GEN3

Launchpad GEN3 je sdílený control plane pro Launchpad GEN3 root. Patří do
Launchpad GEN3 rootu, protože má obsluhovat více firem a má se
updatovat přes jeden template upstream.

Není to místo pro business pravdu konkrétní firmy.

## Co Launchpad vlastní

- UI shell pro seznam dostupných firem a aplikací
- discovery firemních manifestů
- start, stop, health a status aplikací
- kontrolu port kolizí
- načtení read-only plugin metadat
- čitelný stav pro kolegy a agenty

## Co Launchpad nevlastní

- business data jedné firmy
- pevný seznam firemních aplikací
- pevný port map konkrétní firmy
- secrets
- source of truth pro access policy
- přímé zápisy do modulových dat bez validovaného writeru

## Stabilní odkazy na prostor

Launchpad přijímá a při přepnutí prostoru sám udržuje stabilní hash route:

- `/#/org/<URL-encoded company.slug>` otevře přesnou lokálně dostupnou
  Organizaci;
- `/#/personalspace` otevře Personalspace Principála na této mašině. Route je
  záměrně local-only a neobsahuje username, jméno ani osobní data;
- `/` bez hash route zachová výchozí výběr a po načtení URL kanonizuje podle
  aktivního prostoru.

Neznámý Organization slug, nedostupný Personalspace nebo neplatná route se
nepoužijí jako nový scope: Launchpad zůstane v dostupném bezpečném prostoru,
adresu kanonizuje a zobrazí varování. Slug je přesná hodnota `company.slug`
z `company.gen3.json`, ne display name.

Odkaz vždy stav na originu, který ohlásila skutečně běžící instance. Port
nehádej ani nehardcoduj; výchozí `127.0.0.1:4174` je jen příklad a Launchpad při
kolizi zvolí jiný port. Tento Organization/Personalspace slice je první část
širšího Builder Bridge kontraktu pro stabilní odkazy na moduly, Doctor a
worktrees.

## Discovery model

Launchpad skládá dostupné Organizace ze dvou vrstev:

1. `launchpad.gen3.json` — explicitní registry/metadatová vrstva pro planned
   položky, template mounty, remote/repository metadata a ruční override.
2. `organizations/*/company.gen3.json` — automatické lokální mount discovery
   (decision 0042). Když uživatel na počítači získá přístup k nové Organization
   a checkout se objeví pod `organizations/`, zobrazí se bez ruční úpravy root
   registry — buď akcí **Synchronizovat** (`POST /api/sync`, v UI tlačítko
   v horní liště), nebo po restartu Launchpadu.

Registry není vyčerpávající allowlist. Pokud stejný `company.slug` existuje v
registry i jako další lokální checkout, registry mount vyhrává a duplicitní
filesystem mount se přeskočí s warningem.

Synchronizovat flow „GitHub přístup → Synchronizovat → objeví se v Launchpadu“
dnes pokrývá lokální část: checkout pořizuje `git clone` nebo Doctor sync dané
Organizace, Synchronizovat potom znovu projede lokální discovery bez restartu
a bez editace root manifestu. Lokální část je implementovaná
(vyřešeno 2026-07); automatické
klonování z GitHub přístupu zůstává navazující krok.

Launchpad čte Launchpad GEN3 root a Organization GEN3 manifesty:

```text
launchpad.gen3.json
organizations/*/company.gen3.json
organizations/*/modules.manifest.json
organizations/*/workspace/*/package.json
organizations/*/workspace/*/app/*/package.json
organizations/*/modules/*/package.json         (přechodový legacy layout)
organizations/*/modules/*/app/*/package.json   (přechodový legacy layout)
organizations/*/apps/*/package.json
```

### Workspace grouping (decision 0041)

Deklarace v manifestu je autorita pro grupování aplikací do Workspaces:

- Aplikace patří do Workspace svého modulu podle `module_slots[].workspace`
  v `modules.manifest.json` (přednost) nebo `modules[].workspace`
  v `company.gen3.json`.
- Chybějící deklarace znamená default Workspace se slugem `workspace`.
- Odvozování Workspace z filesystem cesty je zrušené; plochý fyzický layout
  `workspace/<modul>/` i přechodový `modules/<modul>/` se grupují stejně —
  podle deklarace.
- `productionspace` je rezervovaný slug: nesmí být položkou `workspaces[]`
  ani hodnotou `modules[].workspace`. Productionspace repozitáře určuje cesta
  `productionspace/*` a Launchpad je zobrazuje read-only, bez lifecycle akcí;
  fyzická path boundary má přednost i před konfliktním `space`.
- Konflikt explicitního `space` s fyzickou path boundary je blokující Doctor
  chyba. Ostatní přechodové konflikty deklarace vs. realita hlásí Doctor check
  `launchpad.workspace_declarations` jako warn.
- Neúplný aktivní Organization root slot bez celého `git.url` + `git.branch`
  se do akčního git/worktree inventáře vůbec nedostane; root branch se nikdy
  nedoplňuje z Organization defaultu.

Module sloty z manifestu mají readiness stav (decision 0042):

- `available` — mount existuje,
- `missing_access` — slot deklaruje repo, ale checkout chybí (typicky chybějící
  GitHub přístup nebo zatím nespuštěný Doctor sync),
- `planned_slot` — slot bez repo deklarace.

Fyzický `status` sám neurčuje závažnost. Sdílená diagnostická knihovna proto
ke každému slotu přidává `readiness.severity` (`ok` / `neutral` / `blocking`):

- `missing_access` s `default_access: expected` je blokátor, protože modul má
  být dostupný každému kolegovi;
- `missing_access` s `role_based`, `restricted` nebo `private` je neutrální jen
  když principal-scoped `organization_roles` v gitignored
  `launchpad.gen3.local.json` doloží, že žádná z rolí aktuálního Kolegy není
  mezi `required_roles`; bez lokálního role evidence zůstává fail-closed
  blokátorem;
- `planned_slot` je neutrální, dokud jej jiný kanonický check neoznačí jako
  blokující.

Doctor check `launchpad.workspace_declarations` tuto klasifikaci vlastní a UI
ji jen agreguje. Stavový hero aktivní Organizace počítá její appky, manifestované
workspace moduly i productionspace sloty; zelený stav smí ukázat jen bez
`blocking` slotu a bez blokujícího app stavu (například `invalid_manifest`).
Do agregace patří i vnořené deklarované datové mounty, přestože se samostatně
nevykreslují jako dlaždice.
Chip Doctora odděleně říká, zda kontrola běží/doběhla a jak dopadla root
diagnostika. Nestrukturovaná rootová chyba se nepřipisuje každé Organizaci;
tvrdé selhání Personalspace se naopak v jeho aktivním banneru počítá jako
blokátor.

Agregovaná karta `Stav prostoru` je jediný výchozí alarm v denním surface.
Na desktopu je první v pravém sloupci, aby pravdivý stav zůstal viditelný bez
vizuálního překrytí hlavního launcheru; na úzkém viewportu ji zpřístupňuje
stavový badge tlačítka panelů. Podrobný
diagnostický panel se nevykresluje mezi filtry a aplikacemi automaticky;
uživatel jej odhalí až explicitní akcí `Zobrazit problémy` ze stavové karty nebo
stavovým tlačítkem Doctora. Druhá cesta zachovává dosažitelnost globálních
diagnostik, které záměrně nejsou součástí agregace stavové karty.
Výjimkou je skutečné selhání Personalspace: protože osobní surface nemá
prostorový hero banner, zobrazí nenápadný sbalený diagnostický signál sám.
Ruční sbalení detailu přežije tichý refresh.

Pouhá absence repozitáře v lokálním GitHub tokenu není negativní ACL důkaz:
může znamenat SAML, omezený token, rename i chybu manifestu. Doctor ji proto
nesmí použít k neutralizaci blokátoru. `organization_roles` mění pouze
závažnost diagnostiky; nepřiděluje přístup a GitHub zůstává access autoritou.

Nevalidní `companyascode.app` manifest izoluje jen dotčenou appku (decision
0043): appka je viditelná ve stavu `invalid_manifest`, runtime akce jsou pro ni
zamčené a zbytek rootu běží. Duplicitní app id je také scoped: druhý manifest
(deterministicky podle cesty) se izoluje jako `invalid_manifest`, první platí.
Bezpečnostní invarianty (port kolize, plugin read-only violation, únik plugin
cesty mimo Organizaci) zůstávají hard failure pro registry i auto-discovered
Organizace (decision 0042 bezpečnostní parita).

Aplikace deklaruje vlastní port ve svém `package.json`:

```json
{
  "companyascode": {
    "app": {
      "schema_version": "companyascode.launchpad_app.v1",
      "id": "exampleorg-deals-v2",
      "title": "Deals",
      "company": "ExampleOrg",
      "module": "deals",
      "surface": "internal",
      "port": 4301,
      "host": "127.0.0.1",
      "health_path": "/health",
      "dev_script": "dev",
      "tags": ["deals", "git-database"],
      "plugin": "./launchpad.plugin.json"
    }
  }
}
```

Launchpad port nepřiděluje. Port jen čte, validuje a použije při startu.

V multi-company rootu platí:

- `companyascode.app.company` musí odpovídat čistému `organizations[].slug`, pod
  kterým aplikace leží. Fyzická cesta smí mít přechodový generační suffix,
  například `organizations/ExampleOrg_GEN3`, ale app manifest dál používá
  čistou proper-case identitu `ExampleOrg`; shoda je case-sensitive.
- `companyascode.app.id` musí být unikátní v celém Launchpad GEN3 rootu a
  používat lowercase kebab tvar.
- doporučený tvar ID je
  `<lowercase-company-slug>-<module-or-app>-<version>`.
- port namespace je společný pro celý Launchpad GEN3 root.
- port collision je fail-closed invariant: runtime nikdy tiše nepřepne aplikaci
  na jiný port. Discovery ale staví computed port ownership index a u duplicate
  portu vypíše vlastníky plus deterministic `suggested_free_port` pro následný
  manifest edit / PR. Algoritmus hledá první volný port v rozsahu schématu
  `1024..65535`, od kolidujícího portu + 1 nahoru a potom jednou wrapne.
- shared root nesmí držet hardcoded mapu portů konkrétních Organizací. Budoucí
  rezervace pro nemountnuté/planned appky musí být owner-declared metadata, ne
  centrální root tabulka.

## Personalspace (decision 0051, CAC-0048)

Personalspace je **oddělená privátní discovery lane** vedle Organization
discovery. Materializuje pouze osobní prostor Principála této mašiny; jde o
privátní repo
`<username>/<username>_GEN3` na osobním GitHubu, mimo firemní GitHub organizace.

**Privátní hranice je tvrdá.** Personalspace se NIKDY nemíchá do
`organizations/*` auto-discovery, do `/api/apps` ani do sdílených/doctor
reportů. Osobní data (obsah osobních modulů a gbrain zápisů) neopouštějí mašinu
přes sdílené výstupy. Doctor personalspace check reportuje jen metadata (počty,
validitu, gbrain mount stav), nikdy obsah. Server API pro gbrain je local-only
(server běží jen na `127.0.0.1`) a bounded na vault cestu (žádný path escape).

Lane skenuje výhradně:

```text
personalspace/*/personal.gen3.json
personalspace/*/modules.manifest.json
personalspace/*/workspace/*/**/package.json   (companyascode.app manifesty)
personalspace/*/gbrain/                        (Obsidian-compatible markdown vault)
```

- `personal.gen3.json` má vlastní schema (`launchpad/schemas/personal.gen3.schema.json`
  — kopie identická s upstream `HumanAndMachines/schemas/personal.gen3.schema.json`),
  aby se osobní prostor NIKDY nesmíchal do org auto-discovery.
- **Identity invariant** (fail-closed): `owner.github_username` ↔ mount
  `personalspace/<username>_GEN3` ↔ repo `<username>/<username>_GEN3` musí
  souhlasit. Nesouhlas → prostor se nematerializuje (žádné osobní appky, žádný
  gbrain), jen se nahlásí chyba.
- Buddy binding je volitelný. Je-li přítomný, validuje se celý; není-li
  přítomný, vlastník dál používá osobní moduly i gbrain bez placeholder identity.
- Verzovaný Buddy binding musí mít
  `deployment_target: owner-dedicated-personalspace-vps` a
  `local_execution: forbidden`. Buddy není personal app a Launchpad mu
  neposkytuje Install/Start/Stop/Restart ani localhost fallback; smí zobrazit
  pouze hosted prezentační metadata a schválený odkaz.
- `modules.manifest.json` drží **identický kontrakt jako Organizace** (stejné
  `module_slots[]`, stejné readiness stavy `available`/`missing_access`/`planned_slot`).
  Modul bez lokálního checkoutu s deklarovaným repo je `missing_access`; jde o
  stav ownerova repa, ne mechanismus sdílení Personalspace.
- Osobní aplikace nesou příznaky `personal: true` a `surface_scope: "private"`,
  dostávají prefixované runtime id (`personal--<prostor>--<app-id>`) a jsou
  vyloučené z každého org-scoped / shared výstupu. V Launchpad Personalspace
  rail mají **Private badge** a stejné runtime akce jako firemní aplikace
  (Instalovat / Spustit / Zastavit / Restart / Logy / Otevřít) přes oddělenou
  lane `POST /api/personalspace/apps/:id/:action`.
- Prostor Principála mašiny určuje výhradně gitignored
  `launchpad.gen3.local.json` → `personalspace_owner`. Bez něj se žádný prostor
  nematerializuje; cizí mount vyvolá failure (decision 0091).

### gbrain (root-level vrstva prostoru)

gbrain je privátní paměťová vrstva vlastníka a volitelně jeho Buddyho
(Obsidian-compatible markdown vault), analogie `mission-control/` v rootu
Organizace — ne modul.
Defaultně se nesdílí. Kanonický mount je `personalspace/<owner>_GEN3/gbrain/`;
`personal.gen3.json` může přechodně (`gbrain.transitional_source_path`) ukázat
na živý vault vedle prostoru, dokud neproběhne fyzická migrace.

`gbrain/` je Doctor-managed gitignored checkout samostatného private data repa.
Veřejný `garrytan/gbrain` je pouze software source; nesmí se zaměnit za
Markdown data vlastníka.

Agenti pracují s pamětí VÝHRADNĚ přes gbrain MCP server. Launchpad nabízí jen
read-only lidské rozhraní:

- tlačítko **Otevřít v Obsidianu** (`obsidian://open` deep link; pokud vault
  v Obsidianu není zaregistrovaný, UI ukáže cestu jako fallback),
- read-only **listování zápisů** (strom .md souborů), **náhled zápisu**
  (client-side markdown render) a jednoduchý **fulltext** — vše bounded na vault
  přes `GET /api/personalspace/:space/gbrain/{tree,note,search}`.

### API

```text
GET  /api/personalspace                         # prostory + osobní aplikace (metadata)
POST /api/personalspace/apps/:id/:action        # runtime akce osobní aplikace (oddělená lane)
GET  /api/personalspace/:space/gbrain/tree      # strom .md zápisů (jen metadata)
GET  /api/personalspace/:space/gbrain/note?path=# obsah zápisu pro render (bounded)
GET  /api/personalspace/:space/gbrain/search?q= # fulltext (kontextové výřezy)
```

## Příkazy

```sh
cd launchpad
bun run dev
bun run launch
bun run discover
bun run check
bun run check:strict
bun run test
bun run doctor
bun run doctor:json
```

`dev` spustí webový Launchpad server od `127.0.0.1:4174`; pokud je výchozí port
nebo port z environment `PORT` obsazený, použije další volný port. Pouze
explicitní CLI `--port` je fail-closed a zůstává na zadaném portu; chybějící
hodnota explicitního flagu skončí okamžitou chybou. `launch`
spustí server a pokusí se otevřít prohlížeč. Když na stejném portu už běží
Launchpad GEN3 ze stejného kanonického rootu, druhé spuštění ověří hash identity
rootu a pouze otevře existující instanci. Launchpad z jiného rootu ani cizí HTTP
server se nepřevezme.
`discover` vypíše nalezené aplikace. Discovery nejdřív načte registry metadata
z `launchpad.gen3.json`, potom automaticky proskenuje lokální
`organizations/*/company.gen3.json`. `check` validuje `companyascode.app`
podle `launchpad/schemas/launchpad-app.schema.json`. Nevalidní app manifest
uvnitř konkrétní Organization se přeskočí a reportuje jako warning, aby jeden
stale modul neshodil celý Launchpad. `check` dál selže, pokud chybí Launchpad
GEN3 root struktura, registry Organization mountpoint, povinné Organization
soubory, plugin deklarace poruší read-only bezpečnost, nebo dvě validní
aplikace používají stejný port.

V template repozitáři `check` toleruje chybějící ukázkové organizace. V
reálném Launchpad GEN3 root používej `check:strict`, aby chybějící organization
neprošel potichu.

`doctor` vrací read-only diagnostiku pro Launchpad discovery i runtime
stav aplikací. Runtime checks říkají, jestli app-owned port stojí, startuje,
odpovídá, je adoptovaný po restartu Launchpadu nebo je v problému. Doctor
nikdy aplikace nespouští ani nezastavuje.

Na macOS navíc ověřuje klikací `HumanAndMachine Launchpad GEN3.app`, její
bundle ID, executable, ikonu, přesný root a přítomnost v Docku. Mutace je pouze
explicitní repair lane `bun run doctor -- --repair-launchpad-dock`; běžný
Doctor zůstává read-only. Když chybí `dockutil`, repair otevře aplikaci ve
Finderu a vyžádá ruční přetažení do Docku místo zápisu nestabilního indexu.

Doctor report zároveň obsahuje platform, Git a `.gitignore` checks:

- podporovaný OS, Bun a Git v PATH
- Git root a working tree stav Launchpad GEN3 root
- použitelnost submodulů a organization mountpointů
- ochranu runtime/log cest v rootu a `private/`/`archive/` cest v Company
  Workspace repozitářích

Tyto checks jsou součást stejného JSON reportu, který čte Launchpad přes
`/api/doctor`.

Z Launchpad GEN3 rootu existují stejné spouštěče pro lidi:

- macOS: `Launchpad.command` nebo nainstalovaná `HumanAndMachine Launchpad GEN3.app`
- Windows: `Launchpad.cmd` nebo `Launchpad.ps1`
- Linux: `launchpad.sh`

Windows launchery a runtime nespoléhají na PATH zděděný z interaktivního
terminálu: Bun hledají také v uživatelských instalačních cestách a Git také ve
standardních cestách Git for Windows. Každého kandidáta před použitím ověří
pomocí `--version`, takže nefunkční WindowsApps alias nezastíní skutečnou
instalaci. `Launchpad.ps1` musí mít právě jeden UTF-8 BOM, aby český text
správně načetl i Windows PowerShell 5.1. Git probe jsou neinteraktivní, bez
POSIX askpass cesty a se skrytými child okny.

## Web shell v1

RM-0006 redesign source of truth: `launchpad/docs/launchpad-gen3-redesign-spec.md`.
It turns the local spike/wireframe drafts into an implementation spec for the
left rail, Personalspace, Organization grouping, Workspace apps,
Productionspace systems, Doctor/support loop and action policies.

Web shell v1 je pracovní dashboard nad discovery a runtime daty. Poskytuje:

- `/` statické UI
- `/api/apps` pro nalezené aplikace, firmy, cesty a discovery chyby
- `POST /api/sync` pro Synchronizovat: znovu projede lokální auto-discovery a
  vrátí čerstvý apps response (decision 0042); nový lokální mount se objeví bez
  restartu Launchpadu
- `/api/doctor` pro strukturovaný Doctor report nad discovery a runtime
  checks
- `/health` pro health samotného Launchpadu
- `/api/apps/:id/health` pro runtime status konkrétní aplikace
- `/api/apps/:id/start` pro spuštění manifestem povoleného `dev_script`
- `/api/apps/:id/install` pro lokální app-scoped dependency install v app package
  cwd
- `/api/apps/:id/repair` pro stejný app-scoped install mechanismus v repair
  intentu, typicky pro `stale_lockfile` nebo opakované ověření dependencies
- `/api/apps/:id/stop` pro zastavení procesu na app-owned portu
- `/api/apps/:id/restart` pro bezpečný restart procesu na app-owned portu
- `/api/apps/:id/logs` pro log tail z lokálních runtime logů

Při adopci procesu, který už poslouchá na app-owned portu, Launchpad vyžaduje
pozitivní důkaz, že jeho pracovní adresář odpovídá manifestovanému `cwd`.
Explicitní mismatch je `foreign-port`; neověřitelný CWD je `unknown-port`.
Ani jeden stav Launchpad nepřevezme, nenabídne mu Stop/Restart a automaticky
jej neukončí. Tím se například legacy GEN2 proces na stejném portu nemůže
vydávat za GEN3 aplikaci ani na OS s omezeným CWD lookupem.

Web shell nemění konfiguraci a nezapisuje business data. Runtime stav drží
mimo Git v `launchpad/runtime/` a `launchpad/logs/`. Výjimka k riziku side
effectů je `Install`: spouští package-manager command v cílovém app checkoutu,
takže může stáhnout lokální dependency artefakty a v budoucích lockfile repair
scénářích i odhalit app-local package/lockfile drift. První GEN3 slice používá
`bun install`, loguje command/cwd/exit/output a očekává čistý Git stav, pokud
jsou dependencies už aktuální; případný package/lockfile diff po installu je
vědomý app-local side effect k review, ne Launchpad business-data zápis.

`/api/apps` a `/api/apps/:id/health` vrací sdílený dependency stav
`dependencies.state`, který používá stejné labely v UI i Doctor detailech:

- `ready` — package je čitelný a Start je povolený;
- `needs_install` — chybí `node_modules` pro appku s lockfilem/dependency
  deklarací; UI nabízí `Install`, Start je blokovaný;
- `stale_lockfile` — `package.json` je novější než lockfile; Install/Repair je
  povolený, ale případný lockfile diff patří do explicitního review;
- `missing_package` — manifest ukazuje na chybějící nebo nečitelný package;
- `unknown_package_manager` — Launchpad neumí bezpečně spustit package manager,
  takže Install/Start patří přes Doctor nebo terminál;
- `invalid_manifest` — `companyascode.app` manifest není validní; appka je
  viditelná, runtime akce jsou zamčené, oprava patří do app manifestu
  (decision 0043).

Dependency objekt zároveň nese `package_manager`, `install_command`, `cwd`,
`package_path`, `node_modules_present`, lockfile metadata a `checked_at`.

Runtime akční chyby z `Start`/`Install` vrací kromě `error`, `message` a
`details` také `failure_kind`, když ho Launchpad umí určit. Aktuální hodnoty jsou
`missing_dependencies`, `missing_script`, `port_conflict`, `bad_cwd`,
`start_spawn_failed`, `unknown_early_exit` a dependency-state labely pro případy,
kdy akci blokuje připravenost appky.

UI v1 je wireframe. Design není finální, ale každý ovládací prvek musí mít
jasný mechanismus:

- `Synchronizovat` volá `POST /api/sync` (nový průchod lokálního discovery) a
  znovu čte `/api/doctor`; tichý refresh běží po 15 sekundách pouze ve viditelné
  a fokusované kartě. Při `document.hidden` nebo ztrátě fokusu se úplně zastaví
  a po návratu proběhne jeden okamžitý refresh.
- `Otevřít` otevře URL z manifestu, aplikaci nestartuje.
- Filtry mění jen lokální pohled nad načteným API výstupem.
- Detail aplikace ukazuje source-of-truth cestu a manifest data.
- Read-only plugin zobrazí metadata, odkazy a sekce v detailu aplikace.
- `Start` spustí jen aplikaci objevenou discovery vrstvou a jen její
  `dev_script`.
- `Install`/`Repair` je lokální dependency repair pro objevenou aplikaci. Source
  of truth je app manifest + package cwd; precondition je validní app checkout s
  `package.json` a podporovaným package managerem. První slice spouští
  `bun install` v app package cwd, zapisuje do `launchpad/logs/apps/<app-id>.log`
  a vrací action, command, cwd, exit code, log path a output excerpt. Failure mode
  je `app_install_failed` nebo `app_install_unavailable` s `failure_kind` a log
  excerptem; tlačítko nesmí grantovat GitHub access, klonovat repozitáře,
  zapisovat business data ani obcházet Organization nebo Productionspace
  guardrails. Ověření: install/repair na již připravené appce má skončit
  `exit_code=0` a nezanechat package/lockfile diff; pokud diff vznikne, je to
  app-local dependency side effect k explicitnímu review.
- `Stop` zastaví proces na app-owned portu; pokud proces přežil restart nebo ho
  spustila jiná instance Launchpadu, Launchpad ho adoptuje jen tam, kde může
  pozitivně ověřit PID i CWD vlastníka portu. PID ověří znovu před `SIGTERM`
  i případným `SIGKILL`; neznámý nebo mezitím změněný PID se fail-closed
  nezabíjí. Windows tuto cross-instance CWD kontrolu zatím nemá: po restartu
  Launchpadu zůstane listener `unknown-port` a musí se uvolnit mimo Launchpad.
  Na Windows používá current-instance managed proces cílený
  `taskkill /PID <pid> /T /F` nad PID uloženým v runtime recordu a po ukončení
  čeká na potvrzení původního child handle. Pokud handle exit nepotvrdí,
  Launchpad ponechá managed ownership a selže bezpečně bez druhého signálu;
  opakovaný `Stop` vrátí `app_stop_in_progress`. Managed slot drží až do
  úspěšného zápisu stavu `stopped`, takže souběžný `Start` nemůže v krátkém
  okně mezi exitem a finalizací osiřet nový proces. Selhání ještě před signálem
  nebo potvrzená chyba `taskkill` vrátí živý managed proces do retryable stavu;
  po potvrzeném exitu opakuje další `Stop` už jen zápis finalizace, nikdy signál.
  Stejný child-handle kontrakt platí na POSIX po eskalaci `SIGTERM` → `SIGKILL`.
  Po potvrzeném exitu je každý nový listener na app-owned portu samostatný
  proces i při numericky shodném reused PID; Launchpad starý record uklidí,
  listener nezabije a `Start`/`Restart` ho klasifikuje standardním port-conflict
  guardem. Nikdy nepoužije `taskkill` jen podle obsazeného portu; neověřený
  nebo cizí listener zůstává nedotčený.
- `Restart` je `Stop` + `Start` nad app-owned portem.
- `Logs` čte lokální log mimo Git.
- `Stáhnout novější verzi` provede pouze fresh-remote-verified
  `git pull --ff-only` na čistém expected-branch checkoutu.
- `Stáhnout a zachovat změny` je explicitní autostash flow pro checkout s
  incoming commity a bez outgoing commitů: odloží tracked i untracked změny,
  provede fast-forward, obnoví i staged stav a stash smaže až po úspěšném
  obnovení. Při konfliktu je nová verze stažená, konflikt zůstane viditelný a
  bezpečnostní stash se nesmaže.
- `Pullnout vše` je jedna potvrzená builder akce přes všechny namountované
  Organizace. Zahrnuje Organization root repa a Workspace moduly, pro bezpečně
  autostashovatelné drafty použije stejné recovery flow a každý blocker izoluje,
  aby nezastavil ostatní repozitáře. Productionspace, wrong-branch, outgoing a
  diverged checkouty přeskočí a vypíše je v souhrnu.

Organization root repo není jen součást technického API: aktivní Organization
pohled ukazuje jeho Git stav, incoming počet, freshness a vhodnou pull/autostash
akci v panelu **Git Organizace**. Globální `Pullnout vše` je ve stejném panelu;
uživatel nemusí otevírat jednotlivé moduly.

### Čerstvost Git stavu

Údaj „novější verze / N commitů pozadu“ se počítá vůči lokálním remote refs,
ale jejich síťové obnovení je řízené samostatně:

- `/api/apps` používá krátkou sdílenou cache lokální Git kontroly a nikdy samo
  nespouští síťový fetch;
- aktivní Organization pohled žádá `/api/git/repos?company=<slug>` jen pro
  zvolenou Organizaci; první požadavek naplánuje `git fetch --all --prune`
  asynchronně, takže síť neblokuje hlavní mřížku;
- jedna Launchpad server instance deduplikuje požadavky všech karet a pro jedno
  repo obnovuje remote nejvýše jednou za 5 minut plus stabilní jitter do
  60 sekund; souběžně běží nejvýše dva fetch procesy;
- po chybě zůstane poslední známý Git stav viditelný, ale je označen jako
  neověřený; další pokus přijde přibližně za minutu. Chybová odpověď nepropouští
  stderr ani remote credentials;
- server nemá vlastní periodický fetch timer. Když není aktivní Launchpad okno,
  nevzniká žádný vzdálený Git provoz. `git fetch` používá Git transport, ne
  GitHub REST API limit; omezení přesto chrání síť, SSH a GitHub před bursty.
- explicitní pull akce jsou mezi kartami serializované a po dobu mutace pozastaví
  background remote refresh, aby dva Git procesy neměnily stejné repo současně.

API nese `freshness.local_checked_at`, `remote_checked_at`,
`remote_refresh_state`, `next_remote_refresh_at` a `remote_stale`. Detail modulu
ukazuje, kdy byla vzdálená verze ověřena, zda právě probíhá kontrola, nebo zda se
poslední kontrola nepovedla.

Nové tlačítko smí přibýt až po popisu intentu, source of truth,
preconditions, side effects, failure mode, access boundary a ověření.

Launchpad v1 binduje jen na `127.0.0.1` nebo `localhost`. Vzdálený přístup
má řešit bezpečný tunel, ne vystavení serveru na `0.0.0.0`.

Všechny mutující metody pod `/api/` procházejí před routingem jednotnou
local-request kontrolou: `Host` musí být `127.0.0.1` nebo `localhost`, případný
`Origin` musí přesně odpovídat request originu a `Sec-Fetch-Site` smí být jen
`same-origin` nebo `none`. Cross-origin a DNS-rebinding požadavky končí `403`
dřív, než se spustí Git, worktree, runtime nebo synchronizační akce. Nový
mutující endpoint tuto centrální ochranu dědí automaticky.

## Plugin model

Pluginy jsou firemní nebo modulová rozšíření sdíleného Launchpadu. V1 je
pouze deklarativní JSON manifest:

```text
launchpad.plugin.json
```

Plugin může dodat metadata, odkazy a read-only sekce do detailu aplikace.
Nesmí spouštět kód, definovat akce ani zapisovat data. Detailní kontrakt je
v `launchpad/plugins/README.md`.

## Doctor guard

Doctor musí hlídat:

- povinné Launchpad GEN3 root složky
- existenci firem uvedených v `launchpad.gen3.json`
- validitu `companyascode.app` manifestů jako warnings pro jednotlivé stale appky
  a jako hard failure jen pro root/security/konfliktní validní runtime případy
- duplicity portů mezi validními aplikacemi
- existenci `dev_script`
- existenci a validitu read-only plugin manifestu, pokud je uvedený
- u Organizací, které přijaly agent-skills entrypoint kontrakt, že
  `.claude/skills` přes `realpath` míří na kanonické `.agents/skills`; shared
  Doctor nikdy nespouští Organization skript ani nematerializuje odkaz, pouze
  vrací `ok`, `repair_needed` nebo `blocked`; explicitní capability mode
  `codex-only` lze pro lokální Doctor nastavit přes
  `COMPANYASCODE_AGENT_CAPABILITY_MODE=codex-only`. Jen v tomto režimu je na
  Windows chybějící odkaz nebo jeho textový Git placeholder stav `ok`, protože
  Codex čte přímo `.agents/skills`. V bezpečném výchozím režimu
  `claude-compatible` zůstává entrypoint vyžadovaný; skutečná druhá složka
  je blokovaná v obou režimech

Když Doctor selže, chyba má být napsaná tak, aby ji mohl opravit další
agent bez znalosti historie.
