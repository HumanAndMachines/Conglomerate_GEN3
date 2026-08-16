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

## Hostované odkazy na aplikace

Stejný Launchpad build může za privátním ingress adapterem otevřít modulovou
aplikaci na operátorem určeném originu. Runtime, health a port ownership dál
pracují výhradně s lokálním `127.0.0.1:<port>`; přepisuje se pouze URL vrácená
pro otevření nového tabu.

Lokální profil je výchozí a zachovává loopback URL. Hosted profil se zapíná
`LAZURIO_WORKSPACE_PROFILE=hosted`, vyžaduje exact Team binding v
`LAZURIO_TEAM_ID` a přijímá jedinou generovanou autoritu:
`LAZURIO_TEAM_SERVICE_CATALOG_JSON` se schématem
`lazurio.team_service_catalog.v1`, například:

```json
{
  "schema_version": "lazurio.team_service_catalog.v1",
  "team_id": "example-builders",
  "generated_at": "2026-08-13T10:00:00Z",
  "services": [
    {
      "app_id": "exampleorg-knowledgebase-v2",
      "module_lease_key": "exampleorg/knowledgebase",
      "external_origin": "https://knowledgebase.team.example.com/"
    }
  ]
}
```

`team_id` musí přesně odpovídat `LAZURIO_TEAM_ID` a každý
`module_lease_key` discovery identitě `company/module` dané aplikace. Hosted
origin musí být čisté HTTPS origin bez credentials, cesty, query, fragmentu
nebo loopback hostname/adresy. Chybějící app id je fail-closed: `Open` vrátí
`hosted_app_url_missing` a nikdy nepropustí `127.0.0.1` vzdálenému klientovi.
`LAUNCHPAD_HOSTED_APP_URLS_JSON` z PR #104 zůstává pouze dočasný injected
compatibility seam, použije se jen když katalog chybí; přítomnost obou vstupů
je chyba. Katalog je navigační projekce, nikoli ACL ani portová autorita:
generátor ingressu a brokeru jej spojuje s module lease registry a síťový
obal dál vynucuje autentizaci i Team boundary.

Hosted profil je privátní vývojový preview povrch uvnitř schváleného
Tailscale/VPN access plane, nikoli produkční deployment. Zdroj lze editovat bez
běžící aplikace a Launchpad spouští dev proces pouze pro UI/API/MCP preview,
testování nebo debugging. `lazurio.runtime.v1` popisuje runnable listenery a
lifecycle pro Launchpad a Doctor; není úplným produkčním kontraktem pro
deployment, ingress, identity ani MCP.

Když je Team Workspace zapnutý, T3 Code a Launchpad jsou `desired-running`;
tenký supervisor hlídá pouze je. Dashboard Development smí projektovat jen
tyto dva stabilní vstupy a žádný modulový lifecycle nevlastní. Modulové dev
preview se spouští a otevírá přes Launchpad. Produkční aplikace smí Dashboard
zobrazit až z pozdějšího ověřeného deployment katalogu, nikdy z Workspace
service katalogu nebo dev desired state.

Produkční release patří do samostatného follow-upu: protected source/tag →
reproducible immutable artifact → isolated production runtime s explicitním
`public | authenticated | internal` ingressem, app authn/authz, secrets,
daty, backupem, rollbackem, observability a stateless remote MCP. Produkční
runtime neobsahuje T3, Codex, Launchpad, dev checkouty ani worktrees. Tento
Launchpad kontrakt proto nezavádí per-module produkční kontejnery.

## Durable desired runtime

Úspěšný `Start` nebo `Open` atomicky přijme přesný module-owned desired source
`main` nebo `worktree/<canonical slug>` do
`launchpad/runtime/desired-modules/`. Zápis je schema-validní, bez secrets a
publikuje se atomickým rename pod stejným module mutexem jako takeover.
Explicitní `Stop` nejdřív commitne `enabled=false` a až potom signalizuje známý
managed proces: selhání persistence neposílá signál, selhání signálu už nikdy
nezpůsobí boot resurrection.

Po startu Launchpadu proběhne jednorázový idempotentní boot reconcile. Přesný
desired source znovu projde discovery, takeoverem, listener proof a health;
chybějící nebo již nevlastněný worktree skončí `degraded` bez fallbacku na
main. Neočekávaný child exit spouští event-driven bounded restart/backoff v
tomtéž runtime manageru. Není zde externí `/open` polling loop ani druhý
supervisor modulových aplikací.

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

Launchpad skládá dostupné Organizace scan-first:

1. `launchpad.gen3.json` drží jen sdílená root metadata a mountpointy; není to
   allowlist ani authored business registry.
2. `organizations/*/company.gen3.json` je autorita lokálních Organization
   mountů (decision 0042). Když checkout přibude pod `organizations/`, objeví
   se akcí **Synchronizovat** (`POST /api/sync`) nebo po restartu Launchpadu.
3. Uvnitř každé namountované Organizace je
   `modules.manifest.json#module_slots[]` autorita dostupných, omezených a
   plánovaných modulových repozitářů.

Pro aktualizaci musí `company.gen3.json#company.repository` deklarovat Git URL
Organization rootu. Každý aktivní modul pak deklaruje vlastní `git.url`,
`git.branch` a cílovou `path` v `modules.manifest.json#module_slots[]`.

`Synchronizovat` je read-only rediscovery už existujících lokálních mountů.
Mutační **Stáhnout změny** u aktivní Organizace v Launchpadu a
`bun run update --org <slug>` (CLI)
provádějí manifest-driven materializaci ve dvou fázích: nejdřív bezpečně
fast-forwardnou Organization root, potom z nového manifestu sestaví čerstvý
inventář a chybějící aktivní Workspace/root sloty naklonují na přesně
deklarovanou větev. `planned_slot` bez Git souřadnic se nikdy neklonuje.
Když aktuální GitHub identita repo nebo branch nedokáže načíst, checkout
zůstane `missing_access`; Launchpad žádný paralelní ACL ani grant nevytváří.

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
  GitHub přístup nebo zatím nespuštěný update/sync),
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

Nevalidní `lazurio.runtime.v1` nebo read-compatible legacy manifest izoluje jen dotčenou appku (decision
0043): appka je viditelná ve stavu `invalid_manifest`, runtime akce jsou pro ni
zamčené a zbytek rootu běží. Duplicitní app id je také scoped: druhý manifest
(deterministicky podle cesty) se izoluje jako `invalid_manifest`, první platí.
Bezpečnostní invarianty (plugin read-only violation, únik plugin cesty mimo
Organizaci) zůstávají hard failure pro registry i auto-discovered Organizace
(decision 0042 bezpečnostní parita). Deklarovaný překryv žádný modul neschová:
Doctor ho hlásí jako hard failure a Start/Open zablokuje. Stejný port smí
deklarovat jen více `app/vN` verzí stejného module listener lease.

Port vlastní kořen modulu v `lazurio.module.json`:

```json
{
  "schema_version": "lazurio.module.v1",
  "id": "deals",
  "company": "ExampleOrg",
  "tcp_port_policy": { "mode": "single" },
  "port_leases": [{
    "id": "main",
    "host": "127.0.0.1",
    "port": 24001
  }],
  "apps": ["app/v1/package.json"],
  "default_app": "app/v1/package.json"
}
```

Konkrétní app verze deklaruje runnable shape ve svém `package.json`, ale na
číselný port pouze odkazuje:

```json
{
  "lazurio": {
    "runtime": {
      "schema_version": "lazurio.runtime.v1",
      "id": "exampleorg-deals-v2",
      "title": "Deals",
      "company": "ExampleOrg",
      "module": "deals",
      "surface": "internal",
      "dev_script": "dev",
      "tags": ["deals", "git-database"],
      "plugin": "./launchpad.plugin.json",
      "listeners": [{
        "id": "web",
        "role": "entrypoint",
        "lease": "main",
        "protocol": "http",
        "health": { "kind": "http", "path": "/health" }
      }]
    }
  }
}
```

Runtime má právě jeden `entrypoint` listener a libovolný počet `auxiliary`
listenerů. Jejich topologie popisuje procesy spuštěné přes `dev_script`,
jediný lifecycle skript, který Launchpad skutečně spouští. `preview_script`
a `build_script` jsou volitelná metadata a nesmějí předstírat další
Launchpad runtime.

Každý listener odkazuje na module-owned lease. Main, verze a worktrees jedné
aplikace tím používají přesně stejné lease; číselný port, `allocation`, `host`
ani `claim` do runtime kontraktu nepatří. Modul s více skutečně oddělenými
aplikacemi může vlastnit více pojmenovaných lease pouze přes zdůvodněnou
`tcp_port_policy.mode: exception`. Dynamické porty ani worktree remap nejsou
povolené. Na jednom lease v jednu chvíli běží jen jedna varianta. Legacy
`companyascode.app` se jen čte jako
jeden známý entrypoint a neprohlašuje, že modul nemá skryté pomocné listenery.
Runtime `dev_script` je implementační vstup Launchpadu, ne samostatné
operátorské API: podporovaný Start/Open vždy vede přes sdílený Launchpad daemon
a jeho module lock. Ruční `bun run dev` může sloužit jen k izolovanému
debugování po vědomém zastavení Launchpadu; nesmí zavádět náhradní port ani být
uváděný jako běžná provozní cesta.

Pro audit/migraci použij
`bun scripts/lazurio-runtime-migrate.mjs [--write] <package.json|adresář>`.
Automatika migruje živé package manifesty, vytvoří kořenový module lease a
ověří shodu všech app verzí. Historické changelogy, dokončené tasky a generované
soubory neprochází. Split web/API appky zachová jako zdůvodněnou výjimku; nový
modul standardně používá jeden TCP listener pro `/` a `/api`.

Read-only inventář před vlastnickými PR spustíš z Lazurio rootu přes
`bun run runtime:inventory -- --organization <slug> --json`. Vychází jen z
deklarovaných workspace slotů, materializovaný Module vyžaduje vlastní Git
checkout a `productionspace`, planned sloty i `repository-db-data` vypisuje
odděleně jako vyloučené položky. Nic nezapisuje a cross-Organization výstup
není nový source of truth.
Doctor navíc prohledá živý runtime source příslušného package a odmítne jako
hard error jak číselnou kopii module lease, tak jiný číselný fallback napojený
na `PORT` nebo listener env. Build, testy, fixtures, migrace, archivy, data a
generované výstupy z této kontroly záměrně vynechává.

`apps` je explicitní inventář runnable package souborů relativně ke kořeni
Modulu. Neprázdný seznam má právě jeden `default_app`; `apps: []` pravdivě říká,
že Modul vlastní data nebo know-how, ale nemá aplikaci. Chybějící `apps` se po
dobu GEN3 rollout čte jako legacy stav, nikdy jako prázdný seznam. Jakmile
`apps` existuje, nový `lazurio.runtime` mimo tento seznam je nevalidní.

Existující číselný port je stabilní vlastnictví Modulu a migrace jej nemění.
Organization blok v `lazurio.port-registry.json` slouží pouze k přidělování
nových lease; není renumbering autoritou pro již provozované aplikace. Stejné
číslo v různých Organizacích je kompatibilní s jejich oddělenými Team
Workspace, zatímco dvě různá Module ID uvnitř jedné Organizace kolidovat nesmějí.

V multi-company rootu platí:

- `lazurio.runtime.company` musí odpovídat čistému Organization slugu, pod
  kterým aplikace leží. Fyzická cesta smí mít přechodový generační suffix,
  například `organizations/ExampleOrg_GEN3`, ale app manifest dál používá
  čistou proper-case identitu `ExampleOrg`; shoda je case-sensitive.
- `lazurio.runtime.id` musí být unikátní v celém Launchpad GEN3 rootu a
  používat lowercase kebab tvar.
- povinný Organization-owned tvar ID je
  `<lowercase-company-slug>-<module-or-app>-<version>`.
  Pole `company` ve v1 vždy nese přesný Organization slug; Team, brand ani
  GitHub repository owner se do této osy nepromítají.
- každý materializovaný module lease vstupuje do owner-aware indexu. Dvě
  různá Module ID uvnitř stejné Organization nesmějí vlastnit shodný číselný
  port. Oddělené Organizations stejné stabilní číslo zachovat mohou; na jedné
  mašině pak listener používají po jednom a Start/Open přebírá jeho vlastnictví.
- více verzí nebo worktrees jedné aplikace musí odkazovat na shodný pojmenovaný
  lease a současně běží nejvýše jedna varianta.
- `lazurio.port-registry.json` v Conglomerate rootu je jediná autorita
  nepřekrývajících se Organization bloků. Creator pod OS-level lockem jednou
  přidělí volný module port; Organization manifest blok neduplikuje.
- chybějící module lease, inline/dynamický runtime port, odlišný Module ID na
  stejném portu uvnitř jedné Organization nebo drift referencí je hard failure.
  Nový lease přiděluje creator z Organization bloku; již deklarovaný stabilní
  port mimo dnešní blok se kvůli migraci nikdy nepřečísluje.
- Start/Open preflightuje všechny listenery. Když deklarovaný modulový port
  poslouchá, Launchpad ukončí jeho aktuálního vlastníka (SIGTERM, po timeoutu
  SIGKILL) a spustí vybranou verzi modulu. Port se nikdy nepřemapuje. Samotný
  Stop dál ukončuje jen proces spravovaný aktuální instancí Launchpadu.
- Start/Open je pod OS-level company/module mutexem napříč instancemi
  Launchpadu. Znovu zjistí vlastníka, ukončí celou process group SIGTERM →
  SIGKILL, ověří uvolnění, spustí variantu, ověří novou process group na všech
  listenerech a zapíše source/PID/takeover audit. Stop cílí jen managed instanci.
- POSIX runtime běží v samostatné process group a Stop cílí celou skupinu;
  Windows cílí jen známý managed process tree. Runtime po startu porovná
  deklarované a pozorované listenery a neohlášené/missing porty varuje.
- centrální registry drží jen Organization bloky; přesné porty vlastní vždy
  `lazurio.module.v1` v module rootu, nikoli duplicitní root tabulka.

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
personalspace/*/workspace/*/**/package.json   (lazurio.runtime; legacy companyascode.app je pouze čtecí fallback)
personalspace/*/gbrain/                        (Obsidian-compatible markdown vault)
```

- `personal.gen3.json` má vlastní lokální schema
  (`launchpad/schemas/personal.gen3.schema.json`),
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
`organizations/*/company.gen3.json`. `check` validuje `lazurio.runtime.v1`
podle `launchpad/schemas/lazurio-runtime.schema.json`; legacy
`companyascode.app` zůstává jen čtecí migrační fallback. Nevalidní app manifest
uvnitř konkrétní Organization se přeskočí a reportuje jako warning, aby jeden
stale modul neshodil celý Launchpad. `check` dál selže, pokud chybí Launchpad
GEN3 root struktura, registry Organization mountpoint, povinné Organization
soubory, plugin deklarace poruší read-only bezpečnost, dvě aplikace různých
modulů v jedné Organization používají stejný číselný port, verze stejného
module lease driftují v listener setu nebo se alokační Organization bloky
překrývají. Existující stabilní lease smí ležet mimo dnešní alokační blok;
nový port se z bloku přiděluje vždy. Stejné číslo v oddělených Organizations
je owner-aware kompatibilní překryv, nikoli licence spustit oba listenery
současně na jednom hostu.

V template repozitáři `check` toleruje chybějící ukázkové organizace. V
reálném Launchpad GEN3 root používej `check:strict`, aby chybějící organization
neprošel potichu.

`doctor` vrací read-only diagnostiku pro Launchpad discovery i runtime
stav aplikací. Runtime checks říkají, jestli module-owned lease stojí, startuje,
odpovídá, je adoptovaný po restartu Launchpadu nebo je v problému. Doctor
nikdy aplikace nespouští ani nezastavuje.

Doctor report zároveň obsahuje platform, Git a `.gitignore` checks:

- podporovaný OS, Bun a Git v PATH
- Git root a working tree stav Launchpad GEN3 root
- použitelnost submodulů a organization mountpointů
- ochranu runtime/log cest v rootu a `private/`/`archive/` cest v Company
  Workspace repozitářích

Tyto checks jsou součást stejného JSON reportu, který čte Launchpad přes
`/api/doctor`.

Z Launchpad GEN3 rootu existují stejné spouštěče pro lidi:

- macOS: `Launchpad.command`
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
- `/api/apps/:id/switch` pro potvrzené zastavení jiné známé aplikace na stejném
  portu a spuštění cílové aplikace
- `/api/apps/:id/install` pro lokální app-scoped dependency install v app package
  cwd
- `/api/apps/:id/repair` pro stejný app-scoped install mechanismus v repair
  intentu, typicky pro `stale_lockfile` nebo opakované ověření dependencies
- `/api/apps/:id/stop` pro zastavení managed procesu na module-owned lease
- `/api/apps/:id/restart` pro bezpečný restart procesu na module-owned lease
- `/api/apps/:id/logs` pro log tail z lokálních runtime logů

U legacy manifestu zůstává adopce diagnostická: Launchpad vyžaduje pozitivní
důkaz CWD a neověřený proces nesignalizuje. Platný `lazurio.module.v1` static
lease je naopak explicitní destruktivní autorita modulu. `Start`/`Open` pod
module mutexem zjistí aktuální PID a identitu, pošle celé process group
SIGTERM, po timeoutu SIGKILL, ověří volný port a teprve potom spustí cílový
main/worktree source. `Stop` zůstává užší a signalizuje pouze managed aktivní
instanci této Launchpad instance. Port ani hostname se při takeoveru nemění.

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
- `invalid_manifest` — `lazurio.runtime` (nebo čtený legacy
  `companyascode.app`) manifest není validní; appka je
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
- `Stop` zastaví pouze current-instance managed proces na module-owned lease;
  proces přeživší restart ani proces jiné instance pro samotný Stop neadoptuje
  a nesignalizuje. Nejdřív atomicky uloží disabled desired stav, potom nad
  známým recordem ověří PID a pošle signál. Na Windows používá managed proces cílený
  `taskkill /PID <pid> /T /F` nad PID uloženým v runtime recordu a po ukončení
  čeká na potvrzení původního child handle. Pokud handle exit nepotvrdí,
  Launchpad ponechá managed ownership a selže bezpečně bez druhého signálu;
  opakovaný `Stop` vrátí `app_stop_in_progress`. Managed slot drží až do
  úspěšného zápisu stavu `stopped`, takže souběžný `Start` nemůže v krátkém
  okně mezi exitem a finalizací osiřet nový proces. Selhání ještě před signálem
  nebo potvrzená chyba `taskkill` vrátí živý managed proces do retryable stavu;
  po potvrzeném exitu opakuje další `Stop` už jen zápis finalizace, nikdy signál.
  Stejný child-handle kontrakt platí na POSIX po eskalaci `SIGTERM` → `SIGKILL`.
  Po potvrzeném exitu je každý nový listener na module-owned lease samostatný
  proces i při numericky shodném reused PID; Launchpad starý record uklidí.
  Následující explicitní
  `Start`/`Restart`/`Otevřít` však u validního `lazurio.module.v1` lease
  vyhledá pod OS-level mutexem aktuální process group na deklarovaném portu,
  pošle `SIGTERM` a při potřebě `SIGKILL`, ověří uvolnění portu, spustí zvolený
  modul a ověří jeho nové vlastnictví před uvolněním mutexu. CWD ani původ
  procesu nejsou veto: vyhrazený port patří modulu.
- `Restart` je `Stop` + `Start` nad module-owned lease.
- `Otevřít` serializuje lifecycle podle `company/module`. Main, jiná
  `app/vN` verze i worktree jedné aplikace sdílejí přesné pojmenované lease;
  poslední explicitně otevřená varianta nahradí předchozí. Jiný modul uvnitř
  stejné Organization nesmí stejný číselný port deklarovat. Oddělené
  Organizations jej mohou stabilně vlastnit, ale na jedné mašině běží daný
  listener vždy jen jednou a další explicitní Start/Open jej převezme.
- `Logs` čte lokální log mimo Git.
- `Stáhnout novější verzi` nejdřív ověří, že lokální `origin` a upstream
  odpovídají repozitáři a větvi deklarovaným v Organization manifestu. Potom
  fetchne pouze tuto manifestovou větev, zapamatuje si její přesný commit a
  provede lokální `git merge --ff-only <ověřený-commit>` na čistém
  expected-branch checkoutu. Mutace proto nikdy znovu nečte pohyblivý
  `origin`/upstream.
- `Stáhnout a zachovat změny` je explicitní autostash flow pro checkout s
  incoming commity a bez outgoing commitů: odloží tracked i untracked změny,
  provede fast-forward, obnoví i staged stav a stash smaže až po úspěšném
  obnovení. Při konfliktu je nová verze stažená, konflikt zůstane viditelný a
  bezpečnostní stash se nesmaže.
- `Stáhnout změny` je jedna přímá builder akce pro právě otevřenou Organizaci.
  Samostatný řádek pod stavem Conglomerate ukazuje, v kolika modulech jsou nové
  změny. V první fázi stáhne Organization root repo; ve druhé znovu načte jeho
  manifest, aktualizuje existující Workspace/root sloty a chybějící
  aktivní sloty bezpečně naklonuje. GitHub credentials kolegy zůstávají access
  autoritou; nedostupný checkout se ohlásí jako `missing_access`, `planned_slot`
  se nematerializuje. Pro bezpečně autostashovatelné drafty použije stejné
  recovery flow a každý blocker izoluje, aby nezastavil ostatní repozitáře.
  Productionspace, wrong-branch, outgoing a diverged checkouty přeskočí a
  vypíše je v souhrnu. Klonování nespouští package skripty; app-scoped
  dependencies instaluje až explicitní `Install`/`Otevřít` runtime flow.

Aktivní Organization pohled shrnuje Git aktualizace do jednoduchého stavového
řádku přímo pod stavem Conglomerate. Při dostupných změnách ukáže počet modulů
a jediné tlačítko **Stáhnout změny**; technické stavy jednotlivých modulů dál
zůstávají na jejich kartách a v detailu.

Když se stažení nepovede, modulová karta drží chybu jako trvalý recovery
warning a instruuje uživatele, aby její screenshot vložil agentovi do Codexu.
Launchpad sám při `Stáhnout` stále nikdy nerebasuje: používá pouze `ff-only`
a explicitní autostash. Pokud ale Git read model zjistí rebase rozpracovaný
jiným nástrojem nebo agentem, karta nabídne guarded **Abortnout rebase**.
`POST /api/git/repos/<repo-key>/rebase-abort` před mutací znovu ověří deklarovaný
Organization/workspace scope i živý rebase marker, spustí jen `git rebase
--abort` a výsledek znovu přečte; nikdy nepoužívá `reset --hard` ani nemaže
stash.

`git am` používá na disku podobný marker jako apply-backend rebase. Launchpad
ho proto klasifikuje samostatně: ukáže trvalé recovery varování a žádost
o screenshot pro Agenta, ale nenabídne `git rebase --abort`. Skutečný
apply-backend rebase zůstává rozpoznaný jako rebase a guarded abort pro něj
funguje.

### Čerstvost Git stavu

Údaj „novější verze / N commitů pozadu“ se počítá vůči lokálním remote refs,
ale jejich síťové obnovení je řízené samostatně:

- `/api/apps` používá krátkou sdílenou cache lokální Git kontroly a nikdy samo
  nespouští síťový fetch;
- aktivní Organization pohled žádá `/api/git/repos?company=<slug>` jen pro
  zvolenou Organizaci; první požadavek asynchronně naplánuje kontrolovaný fetch
  přesně manifestové větve do jejího očekávaného `origin/<branch>` refu, takže
  síť neblokuje hlavní mřížku a cizí remote se nikdy nefetchuje;
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
- validitu `lazurio.runtime.v1` a read-compatible legacy manifestů jako warnings pro jednotlivé stale appky
  a jako hard failure jen pro root/security/konfliktní validní runtime případy
- owner-aware kolize materializovaných lease, chybějící module manifesty a
  odchylky od centrálního Conglomerate port registru
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
