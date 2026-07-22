# Doctor worktree management

Status: **cílový kontrakt a implementační plán CAC-0065**. Fresh-main task
preflight a PR push preflight popsané níže jsou aktivní; plánované
`doctor worktrees ...` create/hydrate/cleanup příkazy zatím aktivním
operátorským postupem nejsou.

Tento dokument přesně definuje, jak má HumanAndMachine GEN3 vytvářet,
zobrazovat, kontrolovat a uklízet Git worktrees pro Conglomerate root a pro
Organizace. Příkazy označené jako plánované se nesmí vydávat za dnešní
implementaci. Do dokončení CAC-0065 platí decision 0049 a současné Doctor /
Launchpad guardy.

Autoritativní shaping plán:
`HumanAndMachines/mission-control/db/data/mission-control/plans/2026/07/CAC-0065-organization-worktree-environments.yaml`.

## Výsledek, který chceme

Agent ani člověk nemá ručně rozhodovat:

- kam worktree uložit;
- zda použít `git clone`, `git worktree add` nebo dočasnou složku;
- které dependency moduly potřebuje;
- jak napsat sidecar;
- zda už je worktree bezpečné odstranit.

Místo toho požádá Doctor action layer o jeden **worktree environment**. Doctor
vytvoří kanonický filesystem, zapíše metadata, Launchpad jej načte ze stejného
read modelu a cleanup později vyhodnotí live Git/PR/Mission Control/runtime
evidence.

Environment ID se nevymýšlí v CLI. Je přesně basename kanonického Mission
Control plan souboru bez `.yaml`, například
`DEV-6500-installations-history`. Doctor plán najde podle unikátního kódu,
ověří tvar `<PREFIX>-<čtyři číslice>-<kebab-case>` a použije basename jako
adresář i sidecar prefix. Jeden plán tak může mít v jednom scope právě jeden
environment. Opakované vytvoření stejné specifikace je idempotentní; stejný
plán s jinou specifikací skončí vysvětleným konfliktem a vyžádá explicitní
`hydrate`, `add-edit` nebo nový Mission Control plán.

Environment ID je po vytvoření neměnné. Přejmenování nebo přesun Mission
Control plan souboru je blokovaný, dokud vlastní živý environment. Pokud k
renamu dojde mimo guarded flow, Doctor environment označí `needs_attention`;
teprve explicitní `adopt --path <environment> --plan <code>` po ověření kódu,
historie a nového locatoru smí vazbu opravit. Adopce nikdy sama nepřejmenuje
adresář ani branch.

## Neměnné invarianty

1. Primární Conglomerate, Organization a module checkouty jsou reference pro
   `main`; feature práci do nich nezapisujeme.
2. Jedna Organization feature práce má jeden plan-owned Organization
   environment.
3. Organization environment drží přirozený tvar celé Organizace, ale každý
   nested repo zůstává samostatná Git historie a access hranice.
4. Editovaný modul je skutečný Git worktree na plan-code branchi. Dependency
   je defaultně detached na přesném SHA a není publish target.
5. Žádný nový worktree nevzniká v `/tmp`, `.claude/worktrees`, `.codex-tmp`,
   `.pr-worktrees` ani v jiné agentem zvolené cestě.
6. Sidecar deklaruje záměr a membership. Dirty/ahead/behind/PR/runtime stav se
   vždy znovu odvozuje z reality; ručně zapsaný status neopravňuje k mazání.
7. Výchozí diagnostický Doctor je read-only vůči Git refs i tracked obsahu.
   Explicitní `doctor:task` freshness lane smí provést pouze bounded fetch
   remote-tracking `origin/main`; working tree, current branch ani lokální
   commity nemění. `create`, `hydrate`, `refresh-prs`, `cleanup`, `prune` a
   `adopt` jsou zvláštní guarded akce pod stejným CLI prefixem a sdílenou
   knihovnou.
8. Cleanup je defaultně dry-run, odstraňuje child worktrees před root obálkou
   a nikdy implicitně nemaže lokální ani remote branch.
9. Productionspace zůstává read-only, pokud konkrétní owner repo nemá explicitní
   policy pro worktree akce.
10. Root práce a Organization práce se nemíchají do jedné Git/access hranice.
    Shared změnu vlastní `CAC-XXXX`; Organization rollout má vlastní plán a
    prefix.
11. Sidecar nese minimální lokální conversation provenance a recovery handoff.
    Thread ID pomáhá otevřít původní kontext na stejné mašině, ale cleanup i
    publish rozhodnutí vždy vycházejí z živé Git/PR/runtime/MC evidence.

## Tři podporované typy environmentu

### Standalone top-level repo environment

Agenti mohou začít přímo v top-level repozitářích HumanAndMachines,
Conglomerate nebo Dashboard. Každý z nich drží vlastní Git/access hranici a
vlastní primary checkout. Pro změnu uvnitř jediného takového repa je kanonická
cesta:

```text
<repo>/.worktrees/root/<canonical-plan-basename>/
<repo>/.worktrees/root/<canonical-plan-basename>.worktree.json
```

Agent nesmí založit sibling složku `<repo>-worktrees`, worktree v home,
`~/.hermes/worktrees`, `/tmp` ani worktree jednoho repa uvnitř `.worktrees`
jiného repa. Jeden cross-repo plán smí vlastnit po jednom environmentu v každém
dotčeném repu, ale každý zůstává samostatná Git historie, branch a PR. Sidecar
v consumer repu odkazuje na authority-relative Mission Control plán; samotný
consumer repo nezačne držet jeho kopii.

Dokud CAC-0065 nedodá guarded Doctor create akci, agent smí pro top-level repo
použít ruční `git worktree add` jen na této cestě, se sidecarem a následnou
inventurou `bun run worktrees:status`. Informativní status nezakrývá existující
legacy stav; fail-closed `bun run worktrees:check` ověřuje umístění, metadata a
Git zachování, ale jeho PASS není cleanup autorizace bez živého
PR/runtime/writer gate. Toto je přechodový bootstrap, ne druhý
dlouhodobý action layer.

## Aktivní freshness gate před taskem a PR pushem

Před převzetím každého tasku agent spustí v primárním Conglomerate checkoutu:

```sh
bun run doctor:task
```

Lane provede `git fetch origin main --prune` s vypnutým interaktivním promptem
a fail-closed rozliší clean/up-to-date, clean/behind, dirty, ahead, diverged a
wrong-branch stav. Jen clean/behind má jednoduchou nápravu:

```sh
git pull --ff-only
bun run doctor:task
```

Na dirty primary se automaticky nepoužívá `git pull --rebase --autostash`.
Autostash by skryl cizí nebo nedokončenou práci a rebase primárního mainu by
maskoval porušení reference-checkout kontraktu. Agent zachová práci v
plan-owned worktree a primary opraví bez ztráty historie.

Bezprostředně před každým pushem PR branche agent spustí v edit worktree:

```sh
bun run pr:preflight
```

Gate vyžaduje clean feature branch a ověří, že fresh `origin/main` je předkem
exact `HEAD`. Pokud ne, agent udělá `git rebase origin/main`, zopakuje všechny
relevantní validace a preflight. Pro existující remote branch gate vypíše
exact `--force-with-lease=refs/heads/<branch>:<expected-remote-head>`; obecné
`--force` se nepoužívá. Po pushi se z live GitHub stavu ověří PR URL, base
`main`, exact head, mergeability a checks. Stejný gate se opakuje těsně před
merge, protože main i review evidence mohly mezitím zestárnout.

### Conglomerate root environment

Kanonická cesta:

```text
<Conglomerate>/.worktrees/root/<canonical-plan-basename>/
<Conglomerate>/.worktrees/root/<canonical-plan-basename>.worktree.json
```

Je to linked worktree repozitáře `HumanAndMachines/Conglomerate_GEN3`. Doctor z něj
umí přes Git common-dir bezpečně odvodit kanonický main root. Branch Launchpad
smí dostat **read-only Organization mount context** z kanonického rootu, aby
`bun run doctor` a Launchpad smoke nepadaly jen proto, že gitignored
`organizations/` nejsou součástí Git worktree. Tento context nesmí dát root
branchi právo Organization checkouty editovat.

Pokud shared změna potřebuje Organization pilot, založí se vedle ní samostatný
Organization environment s vlastním plánem/access hranicí.

### Organization environment

Kanonická cesta:

```text
organizations/<Org-mount>/.worktrees/root/<canonical-plan-basename>/
organizations/<Org-mount>/.worktrees/root/<canonical-plan-basename>.worktree.json
```

Příklad pro změnu Installations a jeho test/build dependencies:

```text
organizations/ExampleOrg_GEN3/.worktrees/root/DEV-6500-installations-history/
├── AGENTS.md                         # Organization root snapshot
├── company.gen3.json
├── modules.manifest.json
├── company/
├── manual/
├── workspace/
│   ├── installations/               # edit member, plan-code branch
│   ├── exports/                     # dependency, detached exact SHA
│   └── warehouse/                   # dependency, detached exact SHA
└── productionspace/                 # prázdné, pokud policy nic nepovolila

organizations/ExampleOrg_GEN3/.worktrees/root/
└── DEV-6500-installations-history.worktree.json
```

Outer Organization root je detached na exact `origin/main`, pokud jej plán
nemění. Když je Organization root edit target, dostane vlastní plan-code
branch a stejný PR lifecycle jako modul.

`ExampleOrg` a `ExampleOrg_GEN3` nejsou dvě identity. `ExampleOrg` je stabilní
Organization slug z `company.gen3.json` (`company.slug`) a GitHub Organization;
`ExampleOrg_GEN3` je lokální basename mountpointu. CLI přijímá objevený mount,
ale Doctor vždy rozliší a do sidecaru zapíše obě hodnoty: `organization` jako
stabilní identitu a `organization_path` jako Launchpad-root-relative lokální
mount. Přesun mountu tedy nemění Organization identitu.

## Členové environmentu

Každý member má jednu roli:

| Role | Git tvar | Smí se editovat | Potřebuje PR |
|---|---|---:|---:|
| `root_context` | detached exact SHA | ne | ne |
| `edit` | plan-code branch | ano | ano, pokud má změny |
| `dependency` | detached exact SHA | ne | ne |

Dependency, kterou je potřeba změnit, se nesmí tiše editovat. Builder použije
explicitní akci `add-edit`/`promote`; Doctor vytvoří branch, doplní member
metadata a od té chvíle ji kontroluje jako další edit target.

Default materializace je linked Git worktree ze stávajícího Doctor-managed
owner checkoutu. Když owner checkout na stroji není, Doctor může použít pouze
explicitní managed-clone fallback z manifestového remote. Fallback musí být v
environment sidecaru viditelný a podléhá stejným cleanup gates. Volný `git
clone` provedený agentem není podporovaný mechanismus.

## Dependency source of truth

Cross-repo dependency graf patří do root `modules.manifest.json`, protože je
dostupný před hydratací modulů. Cílový strojový tvar je:

```json
{
  "path": "workspace/installations",
  "development": {
    "dependencies": {
      "test": [
        { "path": "workspace/exports", "required": true }
      ],
      "build": [
        { "path": "workspace/warehouse", "required": true }
      ],
      "runtime": []
    }
  }
}
```

Pravidla validátoru:

- dependency cesta musí být existující manifest slot;
- self-reference a duplicity jsou chyba;
- cyklus je chyba, pokud schéma explicitně nepovolí daný read-only runtime
  pattern;
- chybějící access na `required: true` blokuje create;
- chybějící access na optional dependency je viditelný warning;
- productionspace dependency vyžaduje explicitní Organization/owner policy;
- dependency je read-only, dokud ji builder explicitně nepovýší na `edit`.

`--with <profile>` podporuje přesně `test`, `build` a `runtime` a může se
opakovat. Každý zvolený profil zahrne transitivní closure stejnojmenných hran:
`--with build` rekurzivně sleduje `development.dependencies.build`, stejně
fungují `test` a `runtime`. Více profilů se sjednotí a deduplikuje. Doctor mezi
profily nic tiše nedovozuje; pokud test potřebuje runtime dependency, manifest
ji musí deklarovat také v `test`, nebo caller výslovně přidá `--with runtime`.
Bez `--with` Doctor vytvoří jen explicitní edit targety a root context.

## Plánované CLI

### Preview bez mutace

```sh
bun run doctor -- worktrees plan \
  --organization ExampleOrg_GEN3 \
  --plan DEV-6500 \
  --edit workspace/installations \
  --with test \
  --with build
```

Preview musí ukázat:

- exact cílovou cestu;
- root base SHA;
- edit members a jejich branch names;
- dependency members, profily a důvod jejich zahrnutí;
- linked versus managed-clone materializaci;
- access/missing repo blokátory;
- odhad diskového dopadu;
- všechny side effects budoucího `create`.

### Create

```sh
bun run doctor -- worktrees create \
  --organization ExampleOrg_GEN3 \
  --plan DEV-6500 \
  --edit workspace/installations \
  --with test \
  --with build
```

Conglomerate varianta:

```sh
bun run doctor -- worktrees create \
  --scope conglomerate \
  --plan CAC-0065
```

Create vrátí jednu canonical `workdir`, sidecar path, member tabulku a přesné
next actions. Opakovaný shodný příkaz je idempotentní. Konfliktní branch/path
nebo partial environment není přepsaný; Doctor vysvětlí repair/rollback.

### Přidání dalšího edit targetu

```sh
bun run doctor -- worktrees add-edit \
  --environment DEV-6500-installations-history \
  --repo workspace/warehouse
```

Akce je povolená jen pokud plan scope dovoluje další repo a member není dirty
dependency. Změna sidecaru je transakční.

### Status a PR refresh

```sh
bun run doctor -- worktrees status
bun run doctor -- worktrees status --json
bun run doctor -- worktrees status --refresh-prs
```

Local-only status nesmí čekat na síť. `--refresh-prs` je explicitní network
akce přes GitHub/`gh`, cacheuje URL, exact head, state a checked-at. Když síť
nebo GitHub access chybí, cleanup state je `needs_attention`, nikdy
`ready_to_delete`.

### Cleanup

```sh
bun run doctor -- worktrees cleanup --eligible
bun run doctor -- worktrees cleanup --apply DEV-6500-installations-history
```

První příkaz je vždy dry-run. Druhý aplikuje cleanup jen na přesně zadaný
environment a znovu přepočítá všechny guardy těsně před mutací.

### Prune a legacy adoption

```sh
bun run doctor -- worktrees prune --dry-run
bun run doctor -- worktrees prune --apply
bun run doctor -- worktrees adopt \
  --path <legacy-or-temp-path> \
  --plan DEV-6500
```

`prune` řeší pouze Git registrace ukazující na neexistující cesty. `adopt`
nevytváří falešnou bezpečnost: nejdřív identifikuje owner repo, dirty/unpushed
stav a plan; nejasný standalone clone zůstává `needs_attention`.

## Environment sidecar

Sidecar nové verze je jeden deklarativní dokument vedle Organization root
environmentu. Finální `schema_version` namespace je gate CAC-0065 (evidence
v privátním issue ledgeru); implementace nesmí zavést další legacy prefix.

Minimální obsah:

```json
{
  "schema_version": "<new-worktree-environment-version>",
  "environment_id": "DEV-6500-installations-history",
  "scope": "organization",
  "organization": "ExampleOrg",
  "organization_path": "organizations/ExampleOrg_GEN3",
  "plan": {
    "code": "DEV-6500",
    "authority": "organization",
    "path": "mission-control/db/data/mission-control/plans/...yaml"
  },
  "root_path": ".worktrees/root/DEV-6500-installations-history",
  "created_at": "2026-07-11T00:00:00Z",
  "created_by": "builder-id",
  "conversation_origin": {
    "surface": "codex",
    "agent_label": "Codex",
    "thread_id": "<opaque-local-thread-id>",
    "thread_locator_status": "captured",
    "local_only": true,
    "captured_at": "2026-07-11T00:00:00Z"
  },
  "recovery_handoff": {
    "state": "in_progress",
    "summary": "Implementace environment inventáře pokračuje.",
    "blocker": null,
    "next_action": "Spustit contract test a zkontrolovat diff.",
    "updated_at": "2026-07-11T00:00:00Z"
  },
  "members": [
    {
      "repo_path": ".",
      "role": "root_context",
      "base_ref": "origin/main",
      "base_sha": "<sha>",
      "branch": null,
      "materialization": "linked_worktree"
    },
    {
      "repo_path": "workspace/installations",
      "role": "edit",
      "base_ref": "origin/main",
      "base_sha": "<sha>",
      "branch": "codex/DEV-6500-installations-history",
      "materialization": "linked_worktree",
      "pr_url": null,
      "disposition": "active"
    },
    {
      "repo_path": "workspace/exports",
      "role": "dependency",
      "base_ref": "origin/main",
      "base_sha": "<sha>",
      "branch": null,
      "materialization": "linked_worktree"
    }
  ]
}
```

`plan.path` je vždy relativní k rootu vybranému přes `plan.authority`, nikdy k
aktuálnímu process cwd a nikdy absolutní host cesta:

- `authority: organization` → Organization root; repository-db v3 cesta je
  `mission-control/db/data/mission-control/plans/...`;
- `authority: humanandmachines_root` → canonical HumanAndMachines root; cesta
  je opět `mission-control/db/data/mission-control/plans/...`.

Odkaz v hlavičce tohoto manuálu obsahuje prefix `HumanAndMachines/`, protože
je to lidský locator psaný z Conglomerate/root-parent kontextu; není to hodnota
sidecar `plan.path`. Legacy v1 sidecary s `mission-control/plans/...` ukazují na
dřívější in-tree Mission Control. Phase 0 musí tuto formu přes compatibility
bridge jednoznačně převést na repository-db locator; nejednoznačný nebo
nedostupný target zůstane `needs_attention`.

Do sidecaru nepatří autoritativní `dirty`, `ahead`, `behind`, `pr_state`,
`runtime_state` ani `ready_to_delete`. Tyto hodnoty zastarávají a Doctor je
odvozuje při každém status/cleanup běhu. Sidecar smí držet timestampovaný PR
cache/readback, ale report musí jasně ukázat jeho stáří.

`conversation_origin` je vždy lokální minimum: agentní surface, čitelný label
agenta a opaque thread/session locator nebo výslovný stav `unavailable` či
`not_applicable`. Kde runtime poskytuje stabilní ID (například
`CODEX_THREAD_ID`), writer ho zachytí automaticky. Do sidecaru ani sdíleného
Gitu se nekopíruje raw transcript, reasoning, secrets, citlivý obsah jiné
Organizace ani absolutní transcript path. `recovery_handoff` se aktualizuje při
pauze, blockeru, předání a před koncem běhu; stručné summary a next action musí
umožnit převzetí i bez dostupné historie. Legacy v1 sidecar bez těchto polí je
migration advisory, ne invalid nebo cleanup autorizace.

Create transakce navíc používá lokální journal. Sidecar se označí jako active
až po úspěšném root + member vytvoření a validaci. Při pádu Doctor pokračuje z
journalu nebo provede reverse-order rollback; nesmí zanechat neviditelný child
worktree.

## Jednotný inventář

Doctor sestaví UNION následujících zdrojů:

1. Conglomerate a Organization environment sidecary;
2. `git worktree list --porcelain` Conglomerate rootu, všech Organization
   rootů a všech fyzicky dostupných manifest owner repos;
3. kanonické `.worktrees/root/` filesystem cesty;
4. známé legacy cesty (`.worktrees/workspace`, `.worktrees/productionspace`,
   `.worktrees/modules`, `.claude/worktrees`, `.codex-tmp`, `.pr-worktrees`);
5. bounded temp/tool locations;
6. `git worktree prune --dry-run --verbose` missing-path registrace.

Linked worktree v `/tmp` se najde přes Git owner registry i bez scanování
celého disku. Libovolný standalone clone mimo bounded místa nelze spolehlivě
najít; Doctor musí coverage limit přiznat a nesmí hlásit „vše čisté“ jako
absolutní důkaz.

Report per environment obsahuje:

- plan, owner a canonical path;
- members a jejich role;
- Git registration/common-dir;
- base/head/branch/upstream/ahead/behind;
- dirty a untracked stav;
- PR URL/state/exact head/checked-at;
- Mission Control status;
- runtime procesy používající member path;
- dependency a package readiness;
- disk usage;
- cleanup classification a konkrétní blokátory;
- doporučenou další akci.

## Lifecycle a cleanup state

Jednotná cleanup taxonomie:

| Stav | Význam |
|---|---|
| `active` | Práce nebo review pokračuje. |
| `handoff` | Branch je pushnutá a čeká na převzetí jiným ownerem. |
| `needs_attention` | Nejasný owner/PR, dirty dependency, orphan, missing path nebo jiný blocker. |
| `ready_to_delete` | Všechny níže uvedené guardy právě prošly. |
| `missing_path` | Sidecar nebo Git registrace ukazuje na neexistující cestu; kandidát na repair/prune, ne běžný cleanup. |
| `invalid` | Kontrakt nebo containment je porušený; žádná runtime/destruktivní akce. |

PR state (`OPEN`, `MERGED`, `CLOSED`) je samostatná evidence, ne cleanup stav.

### Povinné cleanup guardy

Environment je `ready_to_delete`, jen když současně platí:

1. sidecar/schema/plan ownership je validní;
2. každý existující member je správně registrovaný u owner Git repa;
3. root i všichni members jsou clean včetně untracked souborů;
4. žádný edit member nemá local-only/outgoing commit;
5. exact HEAD každého edit memberu je zachovaný na remote refu nebo v explicitním
   recovery bundle;
6. žádný runtime proces nepoužívá environment path;
7. žádný active/handoff writer environment stále nevlastní;
8. Mission Control plán je terminální (`done` nebo explicitně `archived` /
   abandoned podle kontraktu);
9. každý edit member splní právě jednu PR větev: (a) vůbec nevytvořil změnu —
   `HEAD == base_sha`, strom je clean a nemá outgoing commit — takže PR není
   potřeba; (b) jeho exact-head PR je `MERGED`; nebo (c) je `CLOSED` bez merge
   a současně má explicitní `abandoned` disposition plus ověřený
   remote/bundle snapshot;
10. dependency members jsou detached a clean;
11. PR evidence je čerstvá a exact-head, nikoli stale cache;
12. reverse-order teardown dry-run je bez containment nebo access chyby.

`CLOSED` samo o sobě není důkaz bezpečí. `MERGED` také nestačí, pokud po merge
vznikl lokální nepushnutý commit.

### Pořadí apply

1. znovu načíst live status a získat environment lock;
2. zastavit jen runtime procesy explicitně vlastněné environmentem;
3. odstranit dependency child worktrees;
4. odstranit edit child worktrees;
5. provést owner-repo `git worktree prune` pouze pro potvrzené registrace;
6. odstranit outer Organization/Conglomerate root worktree;
7. archivovat nebo odstranit sidecar podle finálního audit kontraktu;
8. vypsat ponechané branch refs a případný samostatný branch-cleanup návrh;
9. ověřit readbackem, že cesta, registrace a runtime zmizely.

Partial failure se nesmí maskovat. Journal zůstane `needs_attention` s přesným
completed/remaining krokem; opakovaný příkaz bezpečně naváže.

## Launchpad kontrakt

Launchpad nevytváří druhou Git logiku. Používá stejnou Doctor library pro:

- environment index;
- create preview a guarded create;
- plan/owner/member detail;
- runtime source mapping na konkrétní edit member;
- dependency/dirty/PR/cleanup blokátory;
- disk usage a cleanup dry-run;
- explicitní cleanup apply potvrzení.

V UI je primární jednotka Organization environment, ne sada nahých module
worktrees. Detail ukáže každý member a jeho roli. Orphan/invalid environment
nejde spustit. Dependency member nejde publikovat. Main a worktree runtime jsou
pořád viditelně odlišené a používají nezávislé porty.

## Cross-platform kontrakt

Git/path/status/sidecar/cleanup logika žije v Bun/JavaScript knihovně v
Conglomerate. Shell a PowerShell implementace nesmějí mít vlastní rozdílný
worktree algoritmus:

- root `bun run doctor -- worktrees ...` je canonical engine;
- Organization `company/scripts/doctor.sh worktrees ...` je proxy;
- Organization `company/scripts/doctor.ps1 worktrees ...` je proxy;
- CLI a Launchpad API vracejí stejný versionovaný JSON model;
- cesty se testují na macOS, Linux a Windows včetně spaces a separatorů.

## Legacy migrace

CAC-0065 nesmaže stávající v1 worktrees automaticky. Nejprve je klasifikuje:

| Nález | Default akce |
|---|---|
| validní v1 worktree, práce pokračuje | ponechat, nabídnout `adopt` |
| worktree bez sidecaru | `needs_attention`, dohledat owner/plan |
| sidecar bez cesty | `missing_path`, ověřit Git registry a prune |
| linked worktree mimo canonical path | ukázat owner repo a nabídnout adopt/migrate |
| standalone clone v bounded temp cestě | reportovat, nikdy automaticky mazat |
| prunable Git registrace | `prune --dry-run`, apply zvlášť |
| legacy direct module path | dokončit bezpečně nebo převést do environmentu; nevytvářet další |
| v1 `mission-control/plans/...` locator | přes compatibility bridge převést na repository-db authority/path; při nejednoznačnosti blokovat |

Migrace musí zachovat branch, HEAD, remote a PR URL. Přesun worktree se nedělá
obyčejným filesystem `mv`; použije se Git-aware repair nebo nový environment a
ověřený handoff.

## Implementační řezy

### 0. Autority a schema

- revidovat decision 0049;
- sjednotit Doctor contract a status taxonomy;
- definovat environment schema a v1 migration map;
- zahrnout do migration mapy Organization identity versus mount path a převod
  v1 `mission-control/plans/...` locatorů;
- aktualizovat worktree skill, root/Organization AGENTS a otevřené migrační PRs;
- držet plán `shaping`, dokud tyto kontrakty neprojdou review.

### 1. Cross-platform read model

- canonical main/common-dir resolver;
- root + Organization + member Git inventory;
- sidecar/schema reader;
- bounded legacy/temp scan a prunable registrations;
- human/JSON status, disk usage a deterministic cleanup classifier;
- přidat injektovatelný clock nebo sdílený fresh/stale fixture helper a
  odstranit zbývající fixní `created_at` z runtime/server worktree fixtures;
- žádné mutace v prvním code slice.

### 2. Dependency schema a preview

- `modules.manifest.json` development dependency profily;
- schema/cross-file validation a cycle/access policy;
- `worktrees plan` preview;
- Installations fixture flagship Organizace: installations + exports + warehouse pouze.

### 3. Transakční create/hydrate

- lock + journal + idempotency;
- outer root snapshot;
- linked edit/dependency child worktrees;
- managed-clone fallback;
- reverse rollback a failure injection testy;
- Bash/PowerShell proxy parity.

### 4. Launchpad environment UX/runtime

- environment/member API;
- plan/owner/member detail a blockers;
- runtime source z edit memberu;
- create preview/apply affordance;
- canonical root mount context pro Conglomerate worktree smoke.

### 5. PR refresh a cleanup apply

- optional exact-head GitHub refresh;
- runtime ownership check/stop;
- nested-first cleanup s journalem;
- closed-unmerged abandoned flow;
- branch cleanup jako samostatný příkaz;
- legacy adopt/prune.

### 6. Dogfood a rollout

- pilot flagship Organizace v jejím Organization DEV plánu;
- macOS/Linux/Windows matrix;
- OrganizationTemplate_GEN3 propagation;
- OtherOrg_GEN3 jako další consumer;
- teprve potom zákaz ručních worktree instrukcí jako hard gate.

## Definition of done

Mechanismus není hotový jen proto, že jeden create příkaz funguje. Hotovo je,
když:

- všechny živé autority popisují jediný environment model;
- agent dokáže založit Conglomerate i Organization práci bez ručního Git
  příkazu a dostane jednu canonical workdir;
- dependency profil hydruje jen potřebné repozitáře;
- Launchpad environment správně zobrazí a spustí;
- Doctor najde canonical, legacy, orphan i missing-path worktrees;
- cleanup dry-run je vysvětlitelný a apply prokazatelně neztratí práci;
- po merged/abandoned práci se disk uvolní bez ručního hledání cest;
- macOS, Linux i Windows používají stejný engine;
- pilot flagship Organizace a následný Organization rollout mají create → práce → PR →
  cleanup evidence.

## Současné evidence, které plán řeší

- accepted decision 0049 stále předepisuje direct per-module worktrees;
- canonical CAC-0042 je hotový a nesmí se znovu otevřít;
- Conglomerate root Doctor neindexuje vlastní root worktrees a na disku jsou
  sidecary již odstraněných stromů i prunable registrace mimo canonical path;
- root/member Git registry flagship Organizace obsahuje worktrees, které dnešní sidecar
  scan nevidí, a `.worktrees` zabírá nezanedbatelné místo na disku;
- PowerShell Doctor flagship Organizace nemá worktree akce;
- root manifest nemá dependency profily; pilotní dependency profil drží
  privátní issue ledger;
- otevřené migrační PRs dokumentují současný direct model a potřebují
  koordinovaný follow-up po revizi decision 0049.
