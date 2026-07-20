# First-client Organization rollout runbook

Tento runbook je obecný closeout postup pro první klientský **HumanAndMachine GEN3** rollout z prázdného nebo čerstvě migrovaného klienta do lokálního `Conglomerate/` rootu. Podporuje dvě explicitní cesty: **GitHub-first**, kdy už klient schválil cílovou GitHub Organization a repo, a **local-first**, kdy se Organization připraví a ověří lokálně bez remote `origin` a GitHub hranice se připojí až později za účasti klienta.

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
| Klient / kanonická Organization identity | `ClientX`; čistý název bez `_GEN3` |
| Režim rollout | `github-first` nebo `local-first`; u local-first není GitHub Organization ani `origin` vstupní podmínkou |
| Cílová GitHub Organization / repo | U github-first klientem schválená hranice; u local-first zatím `not configured` |
| Lokální mount slug | `organizations/ClientX_GEN3/`; suffix `_GEN3` je filesystem marker, ne interní company identity |
| Repo hranice | klientské super-repo ve vlastnictví klientské/GitHub organization hranice |
| Default Team | právě jeden default Team se slugem `workspace`; Team je logická deklarace, ne adresář |
| Role hranice | Admin Organizace, Builder Organizace, Uživatel Organizace; Steward Organizace (AI Kolega ve Steward seatu) na Workspace Hostu; kdo drží secrets a kdo smí měnit source |
| Počáteční baseline | Mission Control app + data, Knowledgebase, Design System a Infra; ostatní workspace moduly až podle business potřeby, ne big-bang rollout |
| Design System scope | `active`, pokud je vytvoření objednané; jinak manifestový `planned_slot` bez repa a bez vymyšlených brandových dat |
| Template baseline | Organization z `TemplatesRozjedeme-ai/OrganizationTemplate_GEN3`; Mission Control, Knowledgebase a Design System z vlastních `TemplatesRozjedeme-ai/*Template` upstreamů |
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

for path in \
  organizations/OrganizationTemplate_GEN3 \
  templates/TemplatesRozjedeme-ai/MissionControlTemplate \
  templates/TemplatesRozjedeme-ai/KnowledgebaseTemplate \
  templates/TemplatesRozjedeme-ai/DesignSystemTemplate
do
  test -d "$path/.git" || test -f "$path/.git" || {
    echo "Chybí required template Git checkout: $path" >&2
    exit 1
  }
  git -C "$path" status --short --branch
done
```

Pokračuj jen pokud:

- root checkout je na aktuálním `main` nebo je změna v izolovaném worktree/PR;
- `bun run check` projde;
- `bun run doctor` je `ok - Conglomerate`;
- explicitní preflight výše potvrdí existenci a Git stav všech čtyř required
  template checkoutů; Doctor pouze discovery-reportuje ty přítomné a nemá
  hardcodovaný allowlist, kterým by jejich absenci vynucoval;
- GitHub API potvrzuje `is_template: true` pro
  `TemplatesRozjedeme-ai/OrganizationTemplate_GEN3`,
  `TemplatesRozjedeme-ai/MissionControlTemplate`,
  `TemplatesRozjedeme-ai/KnowledgebaseTemplate` a
  `TemplatesRozjedeme-ai/DesignSystemTemplate`;
- případná rozpracovaná Organization PR není zdroj nových root warningů.

Fail-fast: novou GEN3 Organizaci nezakládej ze starého `CompanyTemplate` / GEN2 workspace template. Výchozí Organization upstream je `TemplatesRozjedeme-ai/OrganizationTemplate_GEN3`.

Stav template flagů ověř read-only, ne podle názvu repozitáře:

```sh
for repo in OrganizationTemplate_GEN3 MissionControlTemplate KnowledgebaseTemplate DesignSystemTemplate; do
  gh api "repos/TemplatesRozjedeme-ai/$repo" --jq '"\(.full_name) is_template=\(.is_template) default_branch=\(.default_branch)"'
done
```

Každý řádek musí uvést `is_template=true` a `default_branch=main`.

### 1. Organization repo bootstrap

Klientská Organization pravda vzniká v samostatném klientském repo, ne v rootu. Baseline vždy pochází z `TemplatesRozjedeme-ai/OrganizationTemplate_GEN3` a checkout drží remote `template` jako fetch-only upstream, aby byl budoucí template sync reviewovatelný. Push na `template` musí být explicitně zakázaný.

Zvol právě jeden bootstrap režim:

- **GitHub-first:** klient schválil GitHub Organization, název a vlastnictví repa. Cílové repo vznikne fork-style z OrganizationTemplate, klientský remote se jmenuje `origin` a upstream `template` je fetch-only.
- **Local-first:** GitHub Organization/repo se dnes nezakládá. Lokální checkout se klonuje přímo z OrganizationTemplate s názvem remote `template`, nemá remote `origin` a jeho vytvoření ani push se nesmí vydávat za hotový GitHub bootstrap. Aktivace `origin` má samostatný klientem schválený gate ve fázi 2.

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
├── mission-control/        # samostatný root nested app/code checkout
│   └── db/                 # samostatný Organization-owned data checkout
├── design-system/          # samostatný root nested checkout, nebo zatím planned_slot
├── infra/                  # samostatný restricted root nested checkout
├── workspace/
│   ├── README.md
│   └── knowledgebase/      # první plochý workspace/<modul>; Teamy jsou v manifestu, ne v adresářích workspaces/<slug>/ (decision 0041)
└── productionspace/
    └── README.md
```

Root nested checkouty jsou fyzické lokální mounty, ale parent Organization
repo jejich obsah ani gitlink netrackuje. Výpis tedy popisuje runtime tvar
checkoutu, ne parent commit tree.

První klientský pilot má raději malé, čitelné moduly než kompletní migraci. Pokud importuješ existující GEN2 obsah, forward-portuj konkrétní source-of-truth části s evidencí; neprováděj slepý merge starého super-repa.

První reálný GEN3 klient začíná s:

1. **Mission Control app + data** — plánování a source-of-truth evidence
   Organizace; app/code repo vzniká přes GitHub Template repository mechanismus
   z `TemplatesRozjedeme-ai/MissionControlTemplate` (`is_template: true`) a
   mountuje se jako `mission-control/`. Oddělené Organization-owned data repo
   se mountuje jako `mission-control/db/` na větvi `v3`; klientská živá data
   zůstávají v klientské Organization hranici a nikdy nepatří do app/code template.
2. **Knowledgebase** — privátní Git-native knowledgebase v default Teamu `workspace`; fork-style z `TemplatesRozjedeme-ai/KnowledgebaseTemplate`.
3. **Design System root boundary** — manifest slot existuje vždy. Při
   objednaném vytvoření vzniká repo přes GitHub Template repository mechanismus
   z `TemplatesRozjedeme-ai/DesignSystemTemplate` (`is_template: true`) a
   mountuje se jako `design-system/`. Bez objednaného vytvoření zůstává
   `status: "planned_slot"` bez `git`, bez repa a bez předstírání hotové
   vizuální identity; handoff uvádí, že klient může dodavatele kontaktovat pro
   vytvoření Design Systemu.
4. **Infra** — restricted Organization-owned repo jako aktivní root nested
   checkout `infra/`; manifest slot používá `space: "root"` a kanonické
   `git.url` / `git.branch`.
5. **Guide** — shared z `HumanAndMachines/Conglomerate_GEN3/guide`; nekopíruj ani neforkuj Guide do klientské Organizace. Pokud klient vzniká migrací z GEN2 a má vlastní top-level `guide/`, obecný Guide z Organization repozitáře smaž — nahrazuje ho shared root Guide. Organization-specific onboarding přesuň do `manual/`, knowledgebase nebo role docs.

Tento baseline není big-bang workspace rollout: v `workspace/` se na začátku
provisionuje Knowledgebase a další moduly přibývají až podle business potřeby.
Mission Control, Design System a Infra jsou Organization root boundaries, ne
Team moduly.

### 2. Lokální mount a remote hranice

#### GitHub-first mount

V rootu mountni klientem schválené repo jako běžný nested Git checkout a přidej fetch-only template upstream:

```sh
cd /path/to/Conglomerate
git clone <client-org-repo-url> organizations/<ClientOrg>_GEN3
git -C organizations/<ClientOrg>_GEN3 remote add template git@github.com:TemplatesRozjedeme-ai/OrganizationTemplate_GEN3.git
git -C organizations/<ClientOrg>_GEN3 config remote.template.pushurl DISABLED

git -C organizations/<ClientOrg>_GEN3 status --short --branch
git -C organizations/<ClientOrg>_GEN3 remote -v
test -d organizations/<ClientOrg>_GEN3/.git || test -f organizations/<ClientOrg>_GEN3/.git
```

#### Local-first mount bez `origin`

Pokud klient schválil lokální přípravu, ale GitHub hranici chce založit až společně později, naklonuj template rovnou do cílového mountu a pojmenuj jediný remote `template`:

```sh
cd /path/to/Conglomerate
git clone --origin template \
  git@github.com:TemplatesRozjedeme-ai/OrganizationTemplate_GEN3.git \
  organizations/<ClientOrg>_GEN3

git -C organizations/<ClientOrg>_GEN3 config remote.template.pushurl DISABLED
git -C organizations/<ClientOrg>_GEN3 config companyascode.templateBase \
  "$(git -C organizations/<ClientOrg>_GEN3 rev-parse template/main)"

test "$(git -C organizations/<ClientOrg>_GEN3 remote)" = template
test "$(git -C organizations/<ClientOrg>_GEN3 remote get-url --push template)" = DISABLED
git -C organizations/<ClientOrg>_GEN3 status --short --branch
test -d organizations/<ClientOrg>_GEN3/.git || test -f organizations/<ClientOrg>_GEN3/.git
```

V tomhle stavu dnes žádný `origin` nepřidávej. Lokální commity zůstávají Draft v klientském checkoutu; `template` slouží jen pro fetch/sync review a nikdy není publish target.

#### Pozdější aktivace klientského `origin`

Remote `origin` připoj až v klientem schváleném kroku, po kontrole přesné GitHub Organization, repo URL a přístupů. Nejdřív ověř, že lokální historie skutečně navazuje na uložený template baseline. Potom přijmi jen prázdný cílový remote nebo stav, jehož `origin/main` je předkem lokálního `HEAD`; tím zůstane první push fast-forward:

```sh
set -euo pipefail

ORG=/path/to/Conglomerate/organizations/<ClientOrg>_GEN3
TEMPLATE_BASE="$(git -C "$ORG" config --get companyascode.templateBase)"

test -n "$TEMPLATE_BASE"
git -C "$ORG" merge-base --is-ancestor "$TEMPLATE_BASE" HEAD

git -C "$ORG" remote add origin <client-approved-repo-url>
if ! git -C "$ORG" fetch origin; then
  printf '%s\n' "origin fetch selhal; remote stav není ověřený, push je zakázaný" >&2
  exit 1
fi

if git -C "$ORG" show-ref --verify --quiet refs/remotes/origin/main; then
  git -C "$ORG" merge-base --is-ancestor origin/main HEAD
else
  if ! REMOTE_HEADS="$(git -C "$ORG" ls-remote --heads origin)"; then
    printf '%s\n' "origin ls-remote selhal; prázdný remote není prokázaný, push je zakázaný" >&2
    exit 1
  fi
  test -z "$REMOTE_HEADS"
fi

git -C "$ORG" push --dry-run origin HEAD:main
git -C "$ORG" push -u origin HEAD:main
```

Nepoužívej `--force` ani `--force-with-lease`. Pokud ancestry nebo prázdný-remote gate neprojde, zastav se: neřeš konflikt přepsáním historie, ale ověř, zda klient schválil správné repo a zda se GitHub repo nemá vytvořit znovu jako prázdné nebo jako skutečný fork stejného template baseline.

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
- `module` je modul/app surface identita; příslušnost k Teamům patří do `company.gen3.json` / `modules.manifest.json`, ne do app manifestu.
- Slot se stavem `planned` / `planned_slot` před skutečným založením repozitáře
  nemá `git`, `repo` ani `repository` URL. Deklarovaná URL znamená, že checkout
  už je očekávaný; jeho absence je proto `missing_access`, ne plán. URL doplň až
  po klientském založení repozitáře a ve stejném rollout kroku slot aktivuj a
  materializuj.
- `companyascode.app.port` patří konkrétní Launchpad app surface. Interní
  proces nebo služba modulu — například klientské Mission Control API — smí
  mít vlastní app-owned port ve své konfiguraci nebo env; tento API port se
  nekopíruje do Launchpad app manifestu a nemusí se rovnat UI portu.
- Porty jsou unikátní napříč lokálním rootem. Pro prvního klienta začínej v klientském bloku okolo `5500+` a ověř kolize přes Launchpad `/api/apps`.
- Launchpad `/api/apps` ověří manifestové app porty. Modul s dalším interním
  API portem odpovídá i za jeho collision/readiness kontrolu; root kvůli němu
  nezavádí druhý port registry.
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
| Discovery | klientská Organization je objevená; nezaložený modul je `planned_slot` bez repo URL, zatímco `missing_access` má vždy vlastní next action |
| Runtime | žádné `invalid_manifest`, port collision nebo dependency warning bez next action |
| Daily launcher na macOS | `platform.macos_launchpad_dock` je `ok`; `.app` má správnou ikonu, exact root a je připnutá v Docku |
| Support loop | Doctor/Launchpad hlášky jsou `ok` nebo explicitně akceptované planned/stopped stavy |

Template gate pro první instalaci:

| Template | Musí být |
|---|---|
| OrganizationTemplate_GEN3 | lokální Git checkout pod `organizations/OrganizationTemplate_GEN3` (decision 0077), clean, na `main` |
| MissionControlTemplate | GitHub `is_template=true`; lokální Git checkout pod `templates/TemplatesRozjedeme-ai/MissionControlTemplate`, clean, `bun run check && bun test` OK; klientský `mission-control/app/v1/package.json` vychází z `templates/launchpad-app/package.json.template` |
| KnowledgebaseTemplate | lokální Git checkout pod `templates/TemplatesRozjedeme-ai/KnowledgebaseTemplate`, clean, `app/v1/package.json` obsahuje `companyascode.app`; `dev`/`preview` runtime čte Launchpad `PORT`/`HOST` env; `cd app/v1 && bun run check && bun run build` OK |
| DesignSystemTemplate | GitHub `is_template=true`; lokální Git checkout pod `templates/TemplatesRozjedeme-ai/DesignSystemTemplate`, clean, na `main`; je required provisioning input i tehdy, když klientský Design System zůstává neobjednaný `planned_slot` |

Organization manifest gate:

| Boundary | Povinný počáteční stav |
|---|---|
| `mission-control` | aktivní root slot, `space: "root"`, `git.url` + `git.branch` |
| `mission-control/db` | aktivní root slot, `space: "root"`, `git.url` + `git.branch: "v3"` |
| `workspace/knowledgebase` | první workspace modul ve default Teamu `workspace` |
| `design-system` | aktivní root slot z template, nebo neobjednaný `planned_slot` bez `git` |
| `infra` | aktivní restricted root slot, `space: "root"`, `git.url` + `git.branch` |

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

Na macOS před handoffem spusť `bun run doctor -- --repair-launchpad-dock`.
Pokud není dostupný `dockutil`, repair otevře `.app` ve Finderu a skončí
nenulově: uživatel ji přetáhne do Docku a agent znovu spustí `bun run doctor`.
Instalace není dokončená, dokud check `platform.macos_launchpad_dock` není
`ok`. Kliknutím na Dock ikonu nakonec proveď runtime smoke Launchpadu.

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

Použij pro první klientský closeout. Pole označené `pokud ...` dokládej jen tehdy, když daný krok patřil do zvoleného rollout režimu; neprovedenou GitHub nebo runtime akci neprezentuj jako selhání ani jako hotovou práci.

```md
## HumanAndMachine GEN3 first-client rollout evidence

- Rollout mode: `github-first` / `local-first`
- Root: `<path>`
- Root HEAD: `<sha>`; `HEAD == origin/main`: yes/no
- Client mount: `organizations/<ClientOrg>_GEN3`
- Client repo HEAD: `<sha>`
- Template remote: `<url>`; push disabled: yes/no
- Client `origin`: `<url>` / `not configured (local-first)`
- Origin ancestry + push dry-run: pass/fail + excerpt (pokud se `origin` připojoval)
- Apps discovered: `<n>`; client apps: `<ids>` (pokud jsou app moduly materializované)
- `bun run check`: pass/fail + excerpt
- `bun run doctor`: ok/warn/fail + excerpt
- Daily launcher: app path + `platform.macos_launchpad_dock` status (macOS)
- Runtime smoke: `<app-id>` ready/start/repair result (pokud se app runtime předává)
- Secrets: metadata-only custody check, no values printed (pokud se secrets konfigurovaly)
- Known accepted warnings: `<none>` or explicit list
- Rollback path: tested/available/not applicable + proč
```

Vždy povinná je evidence zvoleného režimu, samostatného Git checkoutu, template původu a push guardu, root/Organization validace a známých warningů. GitHub evidence je povinná pouze pro github-first nebo dokončenou pozdější aktivaci `origin`; runtime evidence pouze pro skutečně materializovanou a předávanou appku.

## Definition of ready for first client

GEN3 je ready pro prvního klienta, když:

- shared root je zelený na `bun run check` a `bun run doctor`;
- klientský Organization checkout je samostatný Git repo mount, ne submodule;
- zvolený rollout režim odpovídá remote stavu: github-first má klientem schválený `origin`, local-first nemá `origin` a `template` má zakázaný push;
- první klientský pilot modul má validní manifest, nekolidující port a vysvětlitelný dependency/runtime stav;
- člověk i agent najdou source-of-truth hranice v README/Guide/manuálu;
- na macOS je klikací Launchpad `.app` se správnou ikonou ověřená v Docku;
- Organization baseline je z `OrganizationTemplate_GEN3`; Mission Control
  app + data, Knowledgebase, Design System boundary a Infra mají výše popsané
  nested repo/sloty, zatímco další workspace moduly se nezakládají big-bang;
- required template mounty zahrnují `OrganizationTemplate_GEN3`,
  `MissionControlTemplate`, `KnowledgebaseTemplate` a
  `DesignSystemTemplate`; Mission Control i Design System template mají
  ověřené GitHub `is_template=true`;
- Guide je ze shared Conglomerate rootu;
- secrets custody je metadata-only ověřená, bez úniku hodnot;
- existuje jasný rollback bez mazání klientských dat;
- jakákoli zbývající práce je zapsaná v klientské Organization Mission Control / TODO ledgeru, ne jen v chatu.
