# First-client Organization rollout runbook

Tento runbook je obecný closeout postup pro první klientský **HumanAndMachine GEN3** rollout z prázdného nebo čerstvě migrovaného klienta do lokálního `Conglomerate/` rootu.

Cíl: nový klient má vlastní Organization repo, je lokálně namountovaný pod `organizations/<ClientOrg>_GEN3/`, Launchpad ho objeví bez hardcodovaných root portů a `bun run check` + `bun run doctor` v rootu projdou bez support-loop warningů.

## Boundary contract

| Vrstva | Patří sem | Nepatří sem |
|---|---|---|
| `HumanAndMachines/Conglomerate_GEN3` root | shared Launchpad, Guide, manuály, template/runbooky, registry metadata | klientská business pravda, klientská data, secrets |
| `organizations/<ClientOrg>_GEN3/` | klientská Organization pravda, workspace/productionspace, moduly, jejich manifesty | shared framework změny |
| `personalspace/` | osobní/Buddy overlay a root/operator secrets custody | Organization-owned klientská data |

Root repo má v `organizations/` trackovat pouze `organizations/README.md`. Konkrétní Organization checkouty jsou samostatná git repozitáře a lokální mounty; nejsou submoduly shared rootu.

## Vstupy před startem

Vyplň před tím, než vytvoříš nebo mountneš klientský checkout:

| Otázka | Příklad / požadavek |
|---|---|
| Client / GitHub Organization | `ClientX` nebo existující GitHub org |
| Lokální mount slug | `organizations/ClientX_GEN3/`; suffix `_GEN3` je filesystem marker, ne interní company identity |
| Canonická company identity | čistý název bez `_GEN3`, např. `ClientX` |
| Repo hranice | klientské super-repo ve vlastnictví klientské/GitHub organization hranice |
| Default workspace | právě jeden default workspace se slugem `workspace` |
| Role hranice | Admin Organizace, Builder Organizace, Uživatel Organizace; Steward Organizace (AI Kolega ve Steward seatu) na Workspace Hostu; kdo drží secrets a kdo smí měnit source |
| Počáteční moduly | Mission Control + Knowledgebase; ne big-bang rollout |
| Template baseline | Organization z `TemplatesRozjedeme-ai/OrganizationTemplate_GEN3`; Mission Control + Knowledgebase z vlastních `TemplatesRozjedeme-ai/*Template` fork-style upstreamů |
| Shared Guide | bere se ze sdíleného `HumanAndMachines/Conglomerate_GEN3/guide`, nekopíruje se ani neforkuje do klientské Organizace |
| Productionspace | co je release/produkční systém a nesmí být běžný workspace modul |

## Rollout fáze

### 0. Root preflight

V shared rootu:

```sh
cd /path/to/Conglomerate
git status --short --branch
git fetch origin main
git rev-parse HEAD
git rev-parse origin/main
bun run check
bun run doctor
```

Pokračuj jen pokud:

- root checkout je na aktuálním `main` nebo je změna v izolovaném worktree/PR;
- `bun run check` projde;
- `bun run doctor` je `ok - Conglomerate`;
- Doctor vidí required first-client template mounty: `OrganizationTemplate_GEN3`, `MissionControlTemplate`, `KnowledgebaseTemplate`;
- případná rozpracovaná Organization PR není zdroj nových root warningů.

Fail-fast: novou GEN3 Organizaci nezakládej ze starého `CompanyTemplate` / GEN2 workspace template. Výchozí Organization upstream je `TemplatesRozjedeme-ai/OrganizationTemplate_GEN3`.

### 1. Organization repo bootstrap

Klientská Organization pravda vzniká v klientském repo, ne v rootu. Repo vzniká fork-style z `TemplatesRozjedeme-ai/OrganizationTemplate_GEN3` a drží remote `template` na upstream template, aby byl budoucí template sync reviewovatelný.

Minimální tvar, který má klientské repo směřovat mít:

```text
<ClientOrg>_GEN3/
├── AGENTS.md
├── README.md
├── company.gen3.json
├── modules.manifest.json
├── TODO.tasks.json
├── DONE.tasks.json
├── ISSUES.open.json
├── manual/
│   └── README.md
├── company/
│   └── colleagues/
│       └── README.md
├── workspace/
│   ├── README.md
│   └── <modul>/            # plochá složka modulů; Workspaces jsou deklarace v manifestu, ne adresáře workspaces/<slug>/ (decision 0041)
└── productionspace/
    └── README.md
```

První klientský pilot má raději malé, čitelné moduly než kompletní migraci. Pokud importuješ existující GEN2 obsah, forward-portuj konkrétní source-of-truth části s evidencí; neprováděj slepý merge starého super-repa.

První reálný GEN3 klient začíná s:

1. **Mission Control** — plánování a source-of-truth evidence Organizace; app/code fork-style z `TemplatesRozjedeme-ai/MissionControlTemplate`, klientská data zůstávají v klientské Organization hranici.
2. **Knowledgebase** — privátní Git-native knowledgebase ve default workspace; fork-style z `TemplatesRozjedeme-ai/KnowledgebaseTemplate`.
3. **Guide** — shared z `HumanAndMachines/Conglomerate_GEN3/guide`; nekopíruj ani neforkuj Guide do klientské Organizace. Pokud klient vzniká migrací z GEN2 a má vlastní top-level `guide/`, obecný Guide z Organization repozitáře smaž — nahrazuje ho shared root Guide. Organization-specific onboarding přesuň do `manual/`, knowledgebase nebo role docs.

### 2. Lokální mount

V rootu mountni klientské repo jako běžný nested Git checkout:

```sh
cd /path/to/Conglomerate
git clone <client-org-repo-url> organizations/<ClientOrg>_GEN3

git -C organizations/<ClientOrg>_GEN3 status --short --branch
test -d organizations/<ClientOrg>_GEN3/.git || test -f organizations/<ClientOrg>_GEN3/.git
```

Nesmí vzniknout:

- `.gitmodules` entry;
- tracked `organizations/<ClientOrg>_GEN3` pointer v rootu;
- symlink alias vedoucí k duplicitní discovery;
- klientská data v root `manual/`, `guide/` nebo `templates/`.

### 3. Manifest a port pravidla

Launchpad nesmí držet app porty jedné Organizace v rootu. Každá aplikace deklaruje svůj vlastní manifest ve svém app package souboru. Minimální copy-paste validní package tvar je:

```json
{
  "name": "clientx-example-v1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun server.mjs"
  },
  "companyascode": {
    "app": {
      "schema_version": "companyascode.launchpad_app.v1",
      "id": "clientx-example-v1",
      "title": "ClientX Example",
      "company": "ClientX",
      "module": "example",
      "surface": "internal",
      "port": 5500,
      "host": "127.0.0.1",
      "health_path": "/",
      "dev_script": "dev",
      "tags": ["first-client", "workspace"]
    }
  }
}
```

Kontrolní pravidla:

- `company` je čistá Organization identity, ne `workspace`, ne filesystem slug s `_GEN3`.
- `module` je modul/app surface identita; workspace příslušnost patří do `company.gen3.json` / `modules.manifest.json`, ne do app manifestu.
- Porty jsou unikátní napříč lokálním rootem. Pro prvního klienta začínej v klientském bloku okolo `5500+` a ověř kolize přes Launchpad `/api/apps`.
- Productionspace systémy nesmí získat hosted/public exposure jen tím, že existuje manifest. Sdílený Launchpad defaultně `productionspace/` app package discovery neprochází.

### 4. Discovery + support-loop gate

Po mountu nebo manifest změně spusť v shared rootu:

```sh
cd /path/to/Conglomerate
bun run check
bun run doctor
```

Povinný výsledek pro klientský handoff:

| Gate | Požadavek |
|---|---|
| Git root | čistý root checkout, žádné Organization submoduly |
| Mounts | Organization mountpoint je Git checkout |
| Discovery | klientská Organization je objevená nebo planned s jasným `missing_access` stavem |
| Runtime | žádné `invalid_manifest`, port collision nebo dependency warning bez next action |
| Support loop | Doctor/Launchpad hlášky jsou `ok` nebo explicitně akceptované planned/stopped stavy |

Template gate pro první instalaci:

| Template | Musí být |
|---|---|
| OrganizationTemplate_GEN3 | lokální Git checkout pod `organizations/OrganizationTemplate_GEN3` (decision 0077), clean, na `main` |
| MissionControlTemplate | lokální Git checkout pod `templates/TemplatesRozjedeme-ai/MissionControlTemplate`, clean, `bun run check && bun test` OK; klientský `mission-control/app/v1/package.json` vychází z `templates/launchpad-app/package.json.template` |
| KnowledgebaseTemplate | lokální Git checkout pod `templates/TemplatesRozjedeme-ai/KnowledgebaseTemplate`, clean, `app/v1/package.json` obsahuje `companyascode.app`; `dev`/`preview` runtime čte Launchpad `PORT`/`HOST` env; `cd app/v1 && bun run check && bun run build` OK |

Pokud Doctor hlásí warning, nejdřív ho zařaď podle boundary:

| Boundary | Příklad | Persistuj kde |
|---|---|---|
| local hygiene | helper worktree, scratch checkout, lokální template | `.git/info/exclude` nebo cleanup |
| Organization mount | špatný mount alias, symlink duplicate, stale checkout | lokální mount repair + Organization sync |
| nested module repo | app manifest, runtime konstanta, package deps | module repo commit/PR |
| Organization registry | `company.gen3.json`, `modules.manifest.json` | Organization root PR |
| shared root | Launchpad/Doctor/Guide obecný bug | `HumanAndMachines/Conglomerate_GEN3` PR |

### 5. Install/Repair smoke

Pro každou viditelnou aplikaci ověř:

1. dependency state je `ready`, `needs_install`, `stale_lockfile`, `missing_package_json`, `unknown_package_manager` nebo jiný vysvětlitelný stav;
2. `Install`/`Repair` akce běží jen v app cwd a loguje command, cwd, exit code a excerpt;
3. `Start` nikdy neselže tiše — musí dát runtime status nebo log/next action.

Po změně `package.json` metadat v klientském modulu může Launchpad oprávněně hlásit `stale_lockfile`, i když dependency tree zůstává stejný. Standardní krok je `Repair` / `bun install` v app cwd, zkontrolovat lockfile diff a teprve potom `Start`.

U Knowledgebase ověř, že manifest port a skutečný Astro port nemohou driftovat: `companyascode.app.port` je autorita pro Launchpad a template runtime musí respektovat `PORT`/`HOST` env. Pokud appka běží na jiném portu než manifest, je to template/module bug, ne Launchpad workaround.

Adopted-port runtime jde ovládat stejně jako proces spuštěný aktuálním
Launchpadem: manifestový app port je lifecycle autorita a UI/API nabídne `Stop`
i `Restart`, pokud Launchpad umí zjistit PID listeneru. Backend PID znovu ověří
před `SIGTERM` i případným `SIGKILL`; neznámý nebo mezitím změněný vlastník se
fail-closed nezabíjí a akce vrátí vysvětlitelný konflikt.

Minimální API smoke proti běžícímu Launchpadu:

```sh
curl -fsS http://127.0.0.1:<launchpad-port>/api/apps | python3 -m json.tool >/tmp/apps.json
curl -fsS -X POST http://127.0.0.1:<launchpad-port>/api/apps/<app-id>/repair | python3 -m json.tool
```

Neprováděj Install/Repair na Productionspace systémech bez explicitního scoped souhlasu a role guardrail.

### 6. Guide / human handoff smoke

Před předáním prvnímu klientovi musí člověk umět odpovědět na tři otázky bez čtení zdrojového kódu:

1. Co je tento lokální Conglomerate/Launchpad root?
2. Která Organization je klient a kde je její source of truth?
3. Která appka/modul je první bezpečný pilot a jak poznám, že je připravená?

Pokud na to root Guide nebo Organization README neodpovídá, doplň navigační text dřív než app feature.

### 7. Secrets a access / secret custody

Secrets nikdy nepatří do Gitu ani do chatu.

- Root/operator secrets: `personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>`.
- Organization/AI-colleague secrets: `organizations/<ClientOrg>_GEN3/company/colleagues/<os-user>/private/secrets/...`.
- Tool runtime cesty typu `~/.config/...` jsou cache/adaptér, ne custody source of truth.

Closeout smí reportovat metadata-only ověření, například „soubor existuje, mode 0600, runtime smoke prošel“, ale nikdy obsah tokenu, OAuth URL/kód, heslo ani JSON credential.

### 8. Rollback

Pokud první klientský mount rozbije root:

1. Zastav Launchpad/runtime procesy, které patří klientské appce.
2. Odstraň nebo přejmenuj lokální mount `organizations/<ClientOrg>_GEN3/`.
3. V rootu spusť `bun run check` a `bun run doctor`.
4. Source změny vracej v příslušném repo: module repo, Organization root nebo shared root — ne plošným revertováním cizí hranice.

Lokální odmountování klientského checkoutu není destruktivní vůči remote repo; mazání klientského remote repo nebo klientských dat je mimo tento runbook.

## Handoff evidence template

Použij pro první klientský closeout:

```md
## HumanAndMachine GEN3 first-client rollout evidence

- Root: `<path>`
- Root HEAD: `<sha>`; `HEAD == origin/main`: yes/no
- Client mount: `organizations/<ClientOrg>_GEN3`
- Client repo HEAD: `<sha>`
- Apps discovered: `<n>`; client apps: `<ids>`
- `bun run check`: pass/fail + excerpt
- `bun run doctor`: ok/warn/fail + excerpt
- Runtime smoke: `<app-id>` ready/start/repair result
- Secrets: metadata-only custody check, no values printed
- Known accepted warnings: `<none>` or explicit list
- Rollback path tested/available: yes/no
```

## Definition of ready for first client

GEN3 je ready pro prvního klienta, když:

- shared root je zelený na `bun run check` a `bun run doctor`;
- klientský Organization checkout je samostatný Git repo mount, ne submodule;
- první klientský pilot modul má validní manifest, nekolidující port a vysvětlitelný dependency/runtime stav;
- člověk i agent najdou source-of-truth hranice v README/Guide/manuálu;
- Organization baseline je z `OrganizationTemplate_GEN3`, Mission Control a Knowledgebase z vlastních template forků, Guide ze shared Conglomerate rootu;
- secrets custody je metadata-only ověřená, bez úniku hodnot;
- existuje jasný rollback bez mazání klientských dat;
- jakákoli zbývající práce je zapsaná v klientské Organization Mission Control / TODO ledgeru, ne jen v chatu.
