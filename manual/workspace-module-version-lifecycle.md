# Workspace module application version lifecycle

Tento dokument je kanonický kontrakt pro verzování standardních Workspace modulů a jejich aplikací. Říká, co znamená `v0`, `v1`, `v2` a `v3`, kdy modul smí migrovat mezi verzemi, jak vypadá writer/draft/publish pipeline a jak se ověřený pattern promuje přes `TemplatesRozjedeme-ai` do dalších Organizací a klientských Workspaců.

## Proč vzniká

Founder chce, aby se migrace modulů nedělala ad hoc. Ověřený lifecycle vznikl ve flagship Workspace GEN2 na modulech `Deals`, `Warehouse` a částečně `Pricebook`:

- `v0` je první MVP splácané dohromady, bez stabilní datové hranice.
- `v1` je první použitelná aplikace napojená na externí/Firebase/Firestore/Sheet zdroj.
- `v2` odděluje aplikační kód od datové složky v témže modulovém repu: `app/v2`, `data/v2`, `generated/v2`, YAML records, writer a Git diff.
- `v3` odděluje app/code repo a data repo: aplikace běží nad repository-db checkoutem `db/`, data mají vlastní `<module>-data` repo a branch `v3`, změny vznikají jako lokální draft a publikují se explicitním commit/push flow.

Tenhle lifecycle je primárně určený pro:

1. migraci flagship Workspace modulů na v3,
2. následné promování ověřeného patternu do template vrstvy,
3. aplikaci stejného patternu v dalších Organizacích,
4. dogfood migraci `Pricebook` na v3.

## Research základ

Tento kontrakt syntetizuje ověřené v2/v3 migrace reálných modulů (Deals,
Warehouse, Pricebook) ve flagship Organizaci a engine kontrakt repository-db.
Interní reference (module ARCHITECTURE dokumenty, Mission Control DEV plány
migrací a golden-path kontrakty) drží privátní engine repo
`Rozjedeme-ai/HumanAndMachines`; veřejný kánon mechanismu je
`HumanAndMachines/docs/git-filesystem-database.md` a
`HumanAndMachines/docs/template-promotion-workflow.md`.

## Univerzální invarianty pro všechny verze

Tyto věci platí bez ohledu na generaci:

1. **Generace se nepřepisuje potichu.** Breaking změna je nová `app/vN`, datový namespace/branch nebo nový pojmenovaný kontrakt, ne rewrite staré appky.
2. **Starší generace je audit/rollback/migration reference.** Po cutoveru ji lze odstranit z hlavní větve až po archive branchi a green v3 smoke.
3. **Data mají vlastníka.** Modul vlastní jen svoji doménu. `pricebook` nevlastní produktovou identitu ani warehouse ledger; `warehouse` nevlastní prodejní cenu; `deals` nevlastní Pricebook ani ClickUp koordinaci.
4. **Generated není source of truth.** `generated/` je deklarovaný, deterministický read model; ruční změna generated souboru je drift.
5. **Migrace má parity gate.** Každý přechod musí pojmenovat old SOT, new SOT, transform, parity check, cutover, rollback/archive a downstream dopad.
6. **Writer je jedna pravda.** UI, CLI, MCP a agentní migrace nesmí validovat jinak. Povrchy se mohou lišit oprávněním, ne pravdou.
7. **Template nikdy nedostane firemní data.** Z template se přenáší layout, schema, writer/publish contract, fixture data a anonymizované examples; ne reálná data žádné Organizace ani klientů.
8. **Agent hlásí verzi explicitně.** Handoff vždy říká `Pricebook v2`, `Deals v3`, `warehouse-data@v3` apod., ne jen „appka“.

## Definice verzí

### `v0` — scrappy MVP / důkaz potřeby

`v0` je účelově špinavý prototyp. Dovoluje rychle zjistit, jestli modul vůbec dává smysl.

**Univerzální koncept:** objev pracovní reality před tím, než se stabilizuje data model.

Typické znaky:

- jeden soubor, lokální script, spreadsheet, ručně poskládaný JSON, prototyp v Launchpadu nebo ad hoc UI;
- žádný garantovaný writer;
- žádný dlouhodobý schema contract;
- data mohou být neúplná, ručně opravená nebo spojená s appkou.

`v0` smí existovat jen pokud je jasně označený jako experiment. Nesmí být výchozí coworker workflow ani template baseline.

**Gate do v1:** existuje prokazatelný pracovní use case, owner modulu a rozhodnutí, jaký první zdroj dat bude dočasně autoritativní.

### `v1` — první aplikace nad externím/legacy zdrojem

`v1` je první použitelná aplikace. Ve flagship Organizaci typicky navazovala na Firebase/Firestore mirror, HubSpot, Google Sheet nebo jiný externí zdroj.

**Univerzální koncept:** naučit se UI/workflow a doménu na existujícím zdroji, aniž by se hned stavěla vlastní databázová platforma.

Typické znaky:

- `app/v1` nebo historická první app generace;
- externí DB/mirror jako source/audit reference (`companydata/v1`, Firebase mirror, Google Sheets export, HubSpot snapshot);
- appka často čte data přes adapter nebo mirror;
- writeback je buď externí, omezený, nebo explicitně zakázaný;
- historická parita se měří proti external/mirror baseline.

Příklady:

- Pricebook v1: Firebase-backed UI odstavené na branchi `app_v1`; mirror je auditní reference.
- Warehouse v1: starý `app/v1` smazaný po cutoffu, dohledatelný v git historii; Firebase/Google Sheets `SKLAD_V1` zůstávají read-only audit.
- Deals v1/Firebase/HubSpot vrstvy: archivní/reference vrstva, ne nový authoring.

**Gate do v2:** víme, které kolekce patří modulu, jak vypadají canonical records, jak se validují, jak se generují read modely, a umíme v1/mirror stav deterministicky importovat do Git-native YAML.

### `v2` — Git filesystem DB v modulovém repu

`v2` je první standardní Workspace modulová generace. App code a data jsou pořád v jednom modulovém repu, ale jsou jasně oddělené.

**Univerzální koncept:** Git-readable data pro lidi i agenty, reviewovatelný diff a modulový writer.

Minimální layout:

```text
modules/<module>/
├── app/v2/
├── data/v2/
│   └── <collection>/<id>.yaml
├── generated/v2/
├── migrations/v2/
├── module-data.v2.json
├── README.md
├── ARCHITECTURE.md
└── AGENTS.md
```

Povinné vlastnosti:

- canonical data jsou YAML v `data/v2`;
- generated/read modely jsou v `generated/v2` a lze je znovu vytvořit;
- runtime appka čte data runtime cestou nebo kontrolovaným bundlingem podle fáze, ale data path je explicitní;
- writer/proposal flow zapisuje YAML, regeneruje generated, validuje a dává Git diff;
- citlivé změny mohou jít přes proposal/approval queue;
- historická v1/mirror parita je audit gate, ne nový live sync.

Příklady:

- Pricebook v2: `data/v2/entries`, `categories`, `labor-rates`, `generated/v2/product-price-summaries`, inline PUT pro běžné ceny a proposal flow pro citlivé změny.
- Warehouse v2: `data/v2/items`, `movements`, `suppliers`, `purchase-orders`, append-only movement writer a movement proposals.
- Deals v2: `data/v2`, `generated/v2`, writer/proposal a výkonové patterny, ze kterých se následně vytěžil v3 pilot.

**Gate do v3:** app/data boundary musí být dost jasná, aby se data dala vyjmout do samostatného data repa. Musí existovat import v2→v3, parity report, schema contract, writer contract, generated policy a rollback/archive plán.

### `v3` — repository-db data repo + explicit draft/publish

`v3` je současný cílový standard pro standardní Workspace business aplikace.

**Univerzální koncept:** app code je přenosný template pattern, data patří konkrétní Organizaci/klientovi ve vlastním data repu. Změny jsou lokální drafty, publish je explicitní auditovaný Git commit.

Minimální layout v code/module repu:

```text
modules/<module>/
├── app/v3/
├── db/                    # gitignored repository-db checkout
│   ├── data/
│   ├── generated/
│   ├── scripts/
│   └── repository-db.yaml
├── migrations/v3/
├── README.md
├── ARCHITECTURE.md
└── AGENTS.md
```

Minimální layout data repa:

```text
<org>/<module>-data.git @ branch v3
├── data/
├── generated/
├── scripts/
└── repository-db.yaml
```

Povinné vlastnosti:

- `db/` je samostatný Git checkout, gitignored v code repu, ne Doctor-managed modul;
- major data generation je Git branch (`v3`, později `v4` jako orphan branch s migrací z v3 worktree);
- `repository-db.yaml` deklaruje `app`, `data_repo.remote`, `data_repo.branch`, `layout`, `schema`, `generated_manifest` a `validate`;
- app používá repository-db engine (nebo kompatibilní);
- user edit vytváří lokální draft v data repo working tree;
- `Publikovat změny` provede validate → materialize generated → remote integration/pull guard → jeden commit s `Repository-Db-*` trailery → push;
- konflikt je explicitní stav, ne tichý přepis;
- host/server je vlastník freshness/syncu; browser nemá opakovaně spouštět vlastní Git pull;
- UI ukazuje draft/published/remote/conflict/mount-missing stav v lidském jazyce;
- writer musí mít `baseRevision` nebo ekvivalent optimistic concurrency u editovaných resources;
- Review Surface/adaptér mapuje technické paths na lidské resource labely.

Příklady:

- Deals v3: `<Org>/deals-data@v3`, mount `modules/deals/db`, schema `deals-data@3.0.0-alpha.0`, destructive-sync guard, explicit publish.
- Warehouse v3: `<Org>/warehouse-data@v3`, mount `modules/warehouse/db`, schema `warehouse-data@3.0.0-alpha.0`, writer pro items/movements/suppliers/purchase orders, hosted Steward smoke.

#### Závazný v3 UI kontrakt: draft popup + Publikovat + pull

Každá v3 aplikace nad repository-db data repem **musí** mít tyhle dvě
uživatelské vrstvy. Nejsou volitelné — bez nich nefunguje koordinace mezi
AI Kolegy nad sdíleným data repem. **Mission Control v3 je referenční
implementace** (`MissionControlTemplate/app/v3`).

1. **Globální draft indikátor s tlačítkem Publikovat.** Na **každé** stránce
   aplikace je viditelný stav draftu data repa: nepublikovaný draft (dirty
   working tree), changeset čekající na publikaci, nebo konflikt. Bez draftu
   a bez novějších dat je indikátor **tichý** (nic neruší). Tlačítko
   **Publikovat** provede publish flow podle role uživatele přes stejný
   backend jako detailní Publish/Repository stránka; publish sémantika
   zůstává create → approve → publish (decision 0035
   v HumanAndMachines/docs/decisions/), žádný auto-publish. Indikátor odkazuje
   na detailní stránku.
2. **Pull / freshness mechanismus.** Host/server detekuje remote změny data
   repa **bounded** operací (git fetch s intervalem + manuální refresh
   endpoint, timeout, neinteraktivní git prostředí — browser nespouští vlastní
   opakovaný Git pull). UI ukazuje stav „novější data k dispozici" a nabízí
   **bezpečný pull**. Pull je **fail-closed**: na dirty working tree ani na
   konfliktu/divergenci se nespustí, aby nikdy nepřepsal lokální draft — žádný
   auto-pull a žádný tichý `reset --hard`. Konflikt je viditelný stav
   s handoffem, ne tichý přepis. Koordinace více writerů se ověřuje
   automatizovaným concurrent-writer smoke testem.

**Gate do template-ready:** nestačí, že appka buildí lokálně. Musí projít source/data gates, app gates, API smoke, browser route smoke, hosted edge smoke a template extraction/data-isolation review. Součástí app gate je i tenhle v3 UI kontrakt (draft popup + Publikovat + fail-closed pull).

## Upgrade pipeline mezi verzemi

### 1. Inventarizace aktuální generace

Agent nejdřív sepíše:

- aktuální provozní app verzi (`app/v1`, `app/v2`, `app/v3`);
- canonical data path nebo external source;
- generated/read modely;
- writer/proposal flow;
- validační skripty;
- downstream consumers;
- staré authoring cesty, které bude nutné zablokovat po cutoveru.

Bez inventáře nevzniká migrační PR.

### 2. Migrace `v1 → v2`

1. Zamraz v1/external baseline nebo ho označ jako audit snapshot.
2. Definuj v2 kolekce a YAML envelope (`schemaVersion`, `id`, `record`, audit metadata).
3. Napiš import/migration runner z v1/mirroru do `data/v2`.
4. Napiš generated materializery do `generated/v2`.
5. Napiš parity/state compare proti v1 baseline.
6. Vytvoř `app/v2` a module-owned writer/proposal flow.
7. Přepiš AGENTS/README/ARCHITECTURE tak, aby v1 bylo archive/audit, ne authoring.
8. Po cutoveru nech rollback window; v1 maž nebo archivuj až po samostatném archive gate.

### 3. Migrace `v2 → v3`

1. Vytvoř plán a označ v2 jako reference/rollback po dobu migrace.
2. Vytvoř data repo `<module>-data` s default branchí `v3`.
3. Mountni ho do `modules/<module>/db/` a gitignoruj `db/` v code repu.
4. Přidej `repository-db.yaml` s remote/branch/schema/generated/validate contractem.
5. Založ `app/v3` jako novou generaci; nekaz `app/v2` v místě.
6. Napiš `migrations/v3/importV2ToRepositoryDb` nebo ekvivalent.
7. Napiš parity gate mezi `data/v2` a `db/data`.
8. Přidej writer/read endpoints v3 nad repository-db, nejdřív read-only, potom write parity.
9. Přidej draft/publish/conflict/sync UI state.
10. Přidej destructive-sync guard: žádná v2→v3 bulk synchronizace nesmí smazat novější published v3 záznam bez explicitního konflikt reportu.
11. Spusť hosted smoke na Workspace Hostu.
12. Teprve potom přepni výchozí route a authoring instrukce na v3.
13. Legacy v1/v2 odstraň z main jen po archive branchi a explicitním grep gate.

## Repository-db writer contract pro v3

Každý v3 modul musí implementovat nebo napojit tyto vrstvy:

| Vrstva | Povinnost |
|---|---|
| Boundary guard | Git operace běží v `db/` repo rootu, remote a branch sedí na `repository-db.yaml`; operace z parent code repa selže. |
| Data schema | Doménové schema žije v owner modulu nebo package; generic repository-db nesmí obsahovat business logiku modulu. |
| Draft writes | UI edit zapisuje do working tree jako draft, ne commit na keypress. |
| Base revision | Writer chrání stale edit přes content hash nebo ekvivalent `baseRevision`. |
| Publish | Explicitní uživatelská akce, jeden auditovaný batch commit, `Repository-Db-*` trailery, push na `v3`. |
| Generated policy | Každý commitovaný generated výstup je deklarovaný a byte-deterministický. |
| Sync/freshness | Host/server detekuje remote změny; browser dostává status/eventy. |
| Conflict | Konflikt je viditelný lane/status s handoffem; žádný tichý reset nebo přepis. |
| Credentials | Publish používá approved credential provider; tokeny a secrets nejsou v code ani data repu. |
| Review Surface | Normal user vidí lidské resource labely a route targets, ne jen YAML paths. |
| Draft UI + pull | Globální draft indikátor s tlačítkem Publikovat na každé stránce a fail-closed pull mechanismus (viz „Závazný v3 UI kontrakt" výše); Mission Control v3 je referenční implementace. |

## Template pipeline přes TemplatesRozjedeme-ai

Standardní cesta je **flagship Organizace → template → klientský fork**.

1. **Ověřit ve flagship Organizaci.** Nový v3 pattern se nejdřív prokáže na reálném modulu, protože tam je celý lifecycle, data objem, hosted Steward i produkční QA.
2. **Zobecnit bez dat.** Z patternu se odstraní firemní názvy, reálná data, secrets, lokální paths a organization-only taxonomie.
3. **Promovat do template vrstvy.** Obecný Organization/runtime contract jde do `TemplatesRozjedeme-ai/OrganizationTemplate_GEN3`; modulově specifická app/data kostra patří do budoucího `<Module>Template` repa nebo do schválené module template vrstvy, ne do konkrétního klientského workspace.
4. **Aktualizovat HumanAndMachines/Conglomerate_GEN3 manuál.** Root agenti musí vidět novou verzi a upgrade flow v `manual/`.
5. **Spustit template sync review.** Downstream Organization fork nejdřív udělá `git fetch template` a `template-sync-report`; managed/override/manual diff se reviewuje.
6. **Aplikovat do další Organizace.** Ta přijímá pattern s vlastními business daty, ne s daty flagship Organizace. Pricebook je první dogfood kandidát.
7. **Aplikovat do klientských forků.** Klient přijímá template pattern a vlastní data/fixtures; žádná reálná data nejdou do upstream template.
8. **Zapsat lessons learned zpět.** Pokud downstream Organizace odhalí obecný problém, nejdřív issue/task, potom template promotion PR.

## Pricebook v3 dogfood plán

Pricebook je dobrý dogfood pro tento manuál, protože dnes existuje ve v2 tvaru a má jasný business dopad.

### Výchozí stav

- Flagship Pricebook: `app/v2`, `data/v2`, `generated/v2`, v1 Firebase UI na archive branchi `app_v1`.
- Druhá Organizace (Pricebook): `app/v2`, `data/v2`, `generated/v2`, writer endpointy `POST/PUT /api/pricebook-v2/...`.
- Další Organizace nemusí mít vlastní Pricebook modul; existují jen shared contracts v Launchpadu.

### Cílový v3 stav

```text
modules/pricebook/
├── app/v3/
├── db/                      # Pricebook data repo checkout
│   ├── data/entries/
│   ├── data/categories/
│   ├── data/labor-rates/
│   ├── generated/product-price-summaries/
│   ├── scripts/
│   └── repository-db.yaml
└── migrations/v3/
```

Data repo:

```text
<Org>/pricebook-data.git @ v3
```

Minimální v3 parity:

- počet entries, categories, labor-rates sedí proti v2 nebo je rozdíl vysvětlený;
- product refs jsou buď validní, nebo explicitně optional/unknown podle Organizace;
- generated product summaries jsou deterministické;
- change proposals se převedou buď do v3 draft/review surface, nebo zůstanou v2-only archive podle explicitního rozhodnutí;
- publish commit nese `Repository-Db-App: pricebook`, `Repository-Db-Data-Repo`, `Repository-Db-Branch: v3`, `Repository-Db-Schema-Version` a actor/source trailery.

### První writer slice

1. Read-only snapshot z `db/data`.
2. Edit existing entry metadata/price jako draft.
3. Create entry jako draft.
4. Generated summaries materializer.
5. Sync status bar / floating draft review surface.
6. `Publikovat změny` s repository-db publish.
7. Hosted smoke a rollback na v2.

### Co se nedělá v prvním Pricebook v3 řezu

- Nekopírovat reálná data žádné Organizace do PricebookTemplate.
- Nepřidávat Pricebook-only approval button, pokud má vzniknout shared approval/review surface.
- Nepřepisovat v2 na místě.
- Nepřeskočit destructive-sync guard, pokud bude v2→v3 import opakovatelný.

## Validation matrix pro v3 migraci

Každý v3 upgrade musí skončit reportem v tomto tvaru:

```text
Status: PASS | FAIL | BLOCKED
Module:
Version path: v1 -> v2 -> v3
Code repo status:
Data repo status:
Old SOT:
New SOT:
Migration command:
Parity result:
Writer/draft/publish evidence:
Generated determinism evidence:
Browser routes smoked:
Hosted smoke:
Template promotion status:
Downstream impact (další Organizace/klienti):
Rollback/archive path:
```

Minimální příkazy se liší podle modulu, ale vždy zahrnují:

```bash
git diff --check
bun run validate:v2:data        # pokud se sahá na v2 nebo migraci z v2
bun run validate:v3:data        # nebo repository-db validate ekvivalent
bun run validate:v3:app
(cd db && repository-db status --fetch && repository-db validate)
```

Když modul používá vlastní příkazy (`validate:v3:parity`, `guard:v3:destructive-sync`, hosted smoke), musí být pojmenované v README/ARCHITECTURE a v PR handoffu.

## Anti-patterny

- „Jen překopíruju složku `data/v2` do `data/v3`." Ne: v3 data jsou samostatné data repo + branch `v3`.
- „Template dostane reálná fixture data, protože jsou ověřená." Ne: template smí mít syntetická/anonymizovaná fixture data.
- „Publish znamená, že data už nikdo nemůže přepsat." Ne: publish je auditovaný commit; pozdější bulk sync musí chránit před clobberem guardem.
- „Browser si může pullovat data sám." Ne: host/server/coordinator vlastní freshness; browser dostává stav/eventy.
- „Když v3 funguje, můžeme smazat v2." Ne: nejdřív archive branch, grep gate, rollback window a hosted smoke.
- „Repository-db engine zná Pricebook/Deals/Warehouse schéma." Ne: engine je generický, doménové schéma žije v modulu nebo schema package.
