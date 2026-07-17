# Workspace GEN2 → Organizace GEN3: bezpečný migrační runbook

Tento runbook převádí existující Workspace GEN2 super-repo na samostatnou
Organizaci GEN3 pod jedním HumanAndMachine GEN3 / Conglomerate rootem. Je
určený pro reálnou firmu s historií, nested repozitáři, lidmi, AI kolegy a
rozpracovaným provozem. Greenfield Organizace bez GEN2 historie vzniká z
`OrganizationTemplate_GEN3` podle `manual/first-client-organization-rollout.md`;
tento postup pro ni není potřeba.

Migrace je new-repo/fork-based a paralelní; při běžné same-owner topologii se
nové repo zakládá jako standalone history-copy, protože GitHub nedovolí druhý
fork ve stejném ownerovi jako source repository root. GEN2 se nepřepisuje na
místě, během přechodu zůstává čitelnou rollback/maintenance linkou a `_GEN3` je
trvalá součást názvu nového repozitáře a mountu. Interní identita firmy zůstává
čistá bez generačního suffixu.

## Autorita a závazné invarianty

Při konfliktu platí decision records před tímto manuálem. Runbook je
self-contained provedení těchto rozhodnutí z repozitáře HumanAndMachines:

| Rozhodnutí | Co tento runbook vynucuje |
|---|---|
| `HumanAndMachines/docs/decisions/0026-canonical-gen3-organization-layout.md` | Organizace nemá vlastní Launchpad runtime; má jednu root `mission-control/` vrstvu, `manual/`, `workspace/`, `productionspace/`, `infra/`, company vrstvu a appky deklarované v `package.json`. |
| `HumanAndMachines/docs/decisions/0033-fork-based-generational-migration.md` | Existující GEN2 firma se migruje přes nové repo a paralelní běh, ne in-place přepis. |
| `HumanAndMachines/docs/decisions/0036-mission-control-legacy-yaml-cutover-gates.md` | Legacy Mission Control pravda se nevypne bez parity, validace, rollbacku, credential authority, approvalu a monitoringu. |
| `HumanAndMachines/docs/decisions/0037-mission-control-v3-at-gen3-migration-boundary.md` | Mission Control v3 není GEN2 prerequisite; jeho app/data hranice se řeší až v cílové Organizaci GEN3. |
| `HumanAndMachines/docs/decisions/0041-flat-workspace-folder-and-manifest-grouping.md` | Workspace moduly fyzicky žijí v jedné `workspace/`; příslušnost ke Workspace určuje manifest, ne cesta. Productionspace je rezervovaná org-level hranice. |
| `HumanAndMachines/docs/decisions/0042-auto-discovery-first-launchpad.md` | Přítomná Organizace se objevuje skenem `organizations/*/company.gen3.json`; root registry není allowlist. |
| `HumanAndMachines/docs/decisions/0043-launchpad-invalid-manifest-isolation.md` | Vadný app manifest se izoluje, ale port kolize a bezpečnostní porušení zůstávají tvrdé chyby. |
| `HumanAndMachines/docs/decisions/0045-genn-permanent-generation-marker.md` | Repo a mount si `_GEN3` nechávají i po cutoveru; `company.slug`, brand a app company suffix nenesou. |
| `HumanAndMachines/docs/decisions/0049-worktree-runtime-contract.md` | Každá migrační změna vzniká v Mission-Control-owned worktree s kanonickou cestou a sidecarem; hlavní checkout zůstává na `main`. |

Z těchto rozhodnutí plynou nepřekročitelné hranice:

- žádné secrets, tokeny, OAuth session, private keys, zákaznické exporty ani
  lokální runtime stav se nekopírují do Gitu;
- žádný blind merge, pull, mirror push nebo hromadný copy GEN2 → GEN3;
- jeden source of truth pro module slots, jednu app deklaraci a jednu živou
  Mission Control data autoritu;
- žádné rutinní obousměrné zápisy mezi generacemi;
- žádný týmový archive/cutover, dokud nejsou přestěhovaní všichni lidé i AI
  kolegové v daném scope;
- productionspace repo se nespouští, nereleasuje ani nepřepíná tímto runbookem.

## Vztah k template flow a souvisejícím runbookům

Tento runbook řeší konverzi existující GEN2 firmy. Sousední runbooky drží
zbytek životního cyklu Organizace:

- **Greenfield hranice** — nová Organizace bez GEN2 historie nevzniká tímto
  postupem, ale z `OrganizationTemplate_GEN3` podle
  `manual/first-client-organization-rollout.md`.
- **Post-cutover content sync** — jak Organizace po cutoveru dostává platformní
  novinky z template a jak se org-born inovace promují zpět do template drží
  `manual/template-promotion-and-sync.md`.

Template hranice během migrace (decision 0033 a decision 0077 v
`HumanAndMachines/docs/decisions/`; 0077 formalizuje rename na
`OrganizationTemplate_GEN3` a template-first content sync):

- Během konverze je `OrganizationTemplate_GEN3` **jen reference/validation
  boundary**. Migrace vychází z forku vlastního GEN2 repa, ne z template;
  template a GEN2 fork nesdílejí git historii, takže žádný fork-merge, žádný
  `template` remote a žádný blind copy z template do migrovaného repa.
- Template remote se do Organizace **wiruje až po cutoveru**. Teprve pak se
  platformní/šablonovatelné změny (struktura `AGENTS.md`, generické skilly,
  slovník, worktree kultura) autorují v template a rozvážejí se **content
  syncem**: `managed` soubory verbatim a `managed` bloky uvnitř org souborů.
  Kanonický blok „Model spolupráce" v Organization `AGENTS.md` je právě takový
  managed blok — synchronizuje se verbatim a drift se hlídá md5 hashem bloku
  (od nadpisu `## Model spolupráce: Principál a Agenti` po další `## `), nikdy
  se nepřepisuje celý soubor. Detail mechanismu je v
  `manual/template-promotion-and-sync.md`. Časová výjimka: samotný **seed** tohoto
  managed bloku se dělá už při zakládání kanonického layoutu (Fáze 5) z template
  mountu jako **reference checkout**, ne až po wired remote — verbatim, ověřený
  md5. Po cutoveru přes wired remote pak běží jen průběžný **drift** sync bloku
  a managed **souborů** (Steward review). Detail seedu je ve Fázi 5.
- Přímá propagace Organizace → Organizace je zakázaná. Template-first je
  default pro platformní změny; promotion z Organizace je výjimka pro inovace
  zrozené v reálné práci.

## Výsledek migrace

Kanonický cílový tvar je:

```text
<Conglomerate root>/
  launchpad/                     # jeden shared builder Launchpad
  guide/                         # shared obecný onboarding
  organizations/
    <Org>_GEN3/                  # samostatné, gitignored nested repo
      .agents/skills/            # kanonická skill knihovna
      .claude/skills -> ../.agents/skills
      company.gen3.json
      modules.manifest.json      # jediný module-slot manifest
      company/
        colleagues/<os-user>/
        roles/
      manual/
        ORGANIZATION_MANUAL.md
      mission-control/           # jedna plánovací/UI vrstva Organizace
        db/                      # volitelný MCv3 data-repo mount po splnění gates
      workspace/<module>/        # ploché nested repo checkouty
      productionspace/<repo>/    # org-level production/release repa
      infra/                     # restricted org-level repo/layer
      design-system/             # Organization/Workspace brand pravda
```

V cílovém Organization repu není plný in-org `launchpad/` runtime a není v
něm obecná kopie shared Guidu. Dočasná kompatibilita nesmí být vydávána za
dokončený cutover.

## Role a evidence před prvním příkazem

Pojmenuj:

- Organization Admina, který schvaluje access, archive a rollback;
- Workspace/Organization Stewarda pro Doctor, Launchpad a app smoke;
- Productionspace Stewarda pro potvrzení, že se production runtime nemění;
- Builder ownera migračního Mission Control plánu;
- scope migrace: jedna mašina/jeden člověk, cohorta, nebo týmový cutover.

Veškerá evidence musí být metadata-only. Doporučené lokální custody cesty:

```bash
ROOT="${HOME}/Conglomerate"
OWNER_OS_USER="$(id -un)"                 # colleague overlay (Fáze 4D): company/colleagues/<os-user>
PS_HANDLE="$(gh api user --jq .login)"    # personalspace slug = GitHub handle, ne OS user
ORG="ExampleOrg"                         # proper-case interní identita
GITHUB_ORG="ExampleOrg"                  # může se od ORG lišit
GEN2="${HOME}/MyCompanies/${ORG}"
GEN3="${ROOT}/organizations/${ORG}_GEN3"
SOURCE_REPO="${GITHUB_ORG}/${ORG}"
TARGET_REPO="${GITHUB_ORG}/${ORG}_GEN3"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${HOME}/Backups/humanandmachine-gen3/${ORG}/${STAMP}"
EVIDENCE_DIR="${ROOT}/personalspace/${PS_HANDLE}_GEN3/migration-evidence/${ORG}/${STAMP}"
test -d "${ROOT}/personalspace/${PS_HANDLE}_GEN3" \
  || { echo "personalspace mount ${PS_HANDLE}_GEN3 chybí; ověř mount, neodhaduj ho" >&2; exit 1; }
mkdir -p "$BACKUP_ROOT" "$EVIDENCE_DIR"
chmod 700 "$BACKUP_ROOT" "$EVIDENCE_DIR"
```

Personalspace slug je **GitHub handle** mountu (`gh api user --jq .login`), ne
nutně OS username — na jedné mašině se běžně liší. Runbook drží dvě identity
odděleně: personalspace evidence používá GitHub handle, colleague overlay ve
Fázi 4D (`company/colleagues/<os-user>`) používá OS username. Nezaměňuj je a
personalspace mount neodhaduj z `$(id -un)`; ověř skutečnou složku.

Do PR/Mission Control handoffu patří SHA, výsledky a klasifikace. Absolutní
lokální cesty, bundle, credentials a raw klientská data zůstávají mimo Git.

## Fáze 0 — preflight a přesný source snapshot

1. Přečti `AGENTS.md` Conglomerate rootu, GEN2 repa a případných nested rep,
   kterých se migrace dotkne.
2. Ověř GitHub přístup, správnou Organizaci a otevřené PR:

   ```bash
   gh auth status
   gh repo view "$SOURCE_REPO" \
     --json nameWithOwner,visibility,defaultBranchRef,isFork,parent,viewerPermission,url
   gh pr list --repo "$SOURCE_REPO" --state open \
     --json number,title,headRefName,headRefOid,isDraft,reviewDecision,url
   ```

3. Zdroj musí být čistý `main` s přesně zaznamenaným remote SHA. Neřeš
   nesoulad ručním pullem; použij GEN2 Doctor/sync postup daného repa a kontrolu
   opakuj.

   ```bash
   test -d "$GEN2/.git" || test -f "$GEN2/.git"
   test "$(git -C "$GEN2" branch --show-current)" = "main"
   test -z "$(git -C "$GEN2" status --porcelain)"

   git -C "$GEN2" fetch origin main --prune
   SOURCE_SHA="$(git -C "$GEN2" rev-parse refs/remotes/origin/main)"
   LOCAL_SHA="$(git -C "$GEN2" rev-parse HEAD)"
   REMOTE_SHA="$(git -C "$GEN2" ls-remote origin refs/heads/main | awk '{print $1}')"
   test "$LOCAL_SHA" = "$SOURCE_SHA"
   test "$REMOTE_SHA" = "$SOURCE_SHA"
   ```

4. Založ krátké migration/freeze okno. Každý commit, který po `SOURCE_SHA`
   přistane do GEN2, musí mít vlastní forward-port registry row. Neznámá dirty
   práce, konflikt o source of truth nebo neviditelné privátní změny = stop.

   `git status --porcelain` z kroku 3 **neukáže** `git stash` entries ani
   local-only branche — přesně ty „neviditelné privátní změny“ mechanický check
   nevytáhne. Vytáhni je explicitně a nech ownera potvrdit; čistý working tree a
   SHA parita zůstávají tvrdé gates, ale stash/local-only branch je surface +
   owner ack, ne automatický stop:

   ```bash
   git -C "$GEN2" stash list
   git -C "$GEN2" for-each-ref --format='%(refname:short) %(upstream:short)' refs/heads
   ```

5. Zapiš ověřenou bundle zálohu a source metadata:

   ```bash
   umask 077
   printf '%s\n' "$SOURCE_REPO" > "$BACKUP_ROOT/source-repo.txt"
   printf '%s\n' "$SOURCE_SHA" > "$BACKUP_ROOT/source-sha.txt"
   git -C "$GEN2" status --short --branch > "$BACKUP_ROOT/source-status.txt"
   git -C "$GEN2" bundle create "$BACKUP_ROOT/${ORG}-GEN2-pre-GEN3.bundle" --all
   git -C "$GEN2" bundle verify "$BACKUP_ROOT/${ORG}-GEN2-pre-GEN3.bundle"
   git bundle list-heads "$BACKUP_ROOT/${ORG}-GEN2-pre-GEN3.bundle" \
     | grep -F "$SOURCE_SHA"
   ```

`git bundle create … --all` zabalí i agent/CLI runtime refs (typicky
`refs/*/turn-diffs/**`, `refs/stash` u repa provozovaného přes agentní CLI),
takže bundle bývá znatelně větší než holý pack a naivní velikostní odhad
podhodnotí. `--all` je záměrně bezpečnější volba
(víc historie); na skoro plném disku s tím počítej, ale kvůli velikosti scope
neredukuj.

Bez čistého source SHA a ověřeného bundle se nepokračuje. Bundle nenahrazuje
remote historii; je poslední lokální pojistka.

## Fáze 1 — standalone history-copy nebo cross-owner fork

Výchozí proměnné dávají `SOURCE_REPO` i `TARGET_REPO` do stejného
`$GITHUB_ORG`. V této same-owner topologii je standardem samostatné private repo
naplněné přesným source SHA; GitHub neumí vytvořit další fork vedle source
repository rootu ve stejném ownerovi.

```bash
gh repo create "$TARGET_REPO" --private \
  --description "${ORG} Organization GEN3"
git -C "$GEN2" push "git@github.com:${TARGET_REPO}.git" \
  "${SOURCE_SHA}:refs/heads/main"
gh repo edit "$TARGET_REPO" --default-branch main
```

Skutečný GitHub fork použij pouze tehdy, když je cílový owner odlišný od
source ownera a předem potvrzená fork policy ho dovoluje. V takovém případě
nastav jiný owner explicitně a přepočítej `TARGET_REPO` před vytvořením forku:

```bash
FORK_OWNER="DifferentOwner"               # nesmí se rovnat "$GITHUB_ORG"
test "$FORK_OWNER" != "$GITHUB_ORG"
TARGET_REPO="${FORK_OWNER}/${ORG}_GEN3"
gh repo fork "$SOURCE_REPO" \
  --org "$FORK_OWNER" \
  --fork-name "${ORG}_GEN3" \
  --clone=false
```

Selhání kvůli přihlášení, síti nebo oprávnění není důvod změnit topologii ani
obejít gate; oprav preflight a příkaz opakuj.

Nepoužívej `git push --mirror`: mohl by publikovat nebo mazat nereviewované
branche a tagy. Další refs přenes jen z explicitního allowlistu.

Ověř identitu a přesnou shodu:

```bash
gh repo view "$TARGET_REPO" \
  --json nameWithOwner,visibility,defaultBranchRef,isFork,parent,url
TARGET_SHA="$(git -C "$GEN2" ls-remote "git@github.com:${TARGET_REPO}.git" refs/heads/main | awk '{print $1}')"
test "$TARGET_SHA" = "$SOURCE_SHA"
```

Do evidence zapiš `standalone-history-copy` nebo `fork`, source repo/SHA,
target repo/SHA a důvod zvolené topologie (same-owner vs cross-owner). Historie
stejného `main` je povinná i bez GitHub fork relationship.

Mount vytvoř jen pokud cílová cesta neexistuje:

```bash
test ! -e "$GEN3"
git clone "git@github.com:${TARGET_REPO}.git" "$GEN3"
test "$(git -C "$GEN3" rev-parse HEAD)" = "$SOURCE_SHA"
git -C "$ROOT" status --short --branch
```

`organizations/<Org>_GEN3` je gitignored nested repo, ne submodule. Root status
nesmí ukázat Organization gitlink ani její obsah.

## Fáze 2 — Mission Control plán a decision-0049 worktree

Nejdřív udělej census plánovacích kódů v GEN2 i GEN3. Zvol kód, který je
unikátní v obou linkách; detailní semantic remap je ve Fázi 7.

V cílovém Mission Control compatibility povrchu založ migrační plán s ownerem,
scope, acceptance criteria, rollbackem a odkazy na `SOURCE_SHA`/evidence.
Teprve potom vytvoř worktree:

```bash
PLAN_CODE="DEV-0000"                    # nahraď ověřeným unikátním kódem
AGENT_PREFIX="<agent-prefix>"           # jednající Buddy/Agent, ne fixní codex/
WT_SLUG="${PLAN_CODE}-gen2-gen3-migration"
WT_REL=".worktrees/root/${WT_SLUG}"
WT="${GEN3}/${WT_REL}"
SIDECAR="${GEN3}/.worktrees/root/${WT_SLUG}.worktree.json"
BRANCH="${AGENT_PREFIX}/${PLAN_CODE}-gen2-gen3-migration"

git -C "$GEN3" fetch origin main --prune
test "$(git -C "$GEN3" branch --show-current)" = "main"
# Fork zdědil GEN2 .gitignore, který nemusí ignorovat .worktrees/. Bez ignore
# rule by sidecar + worktree ušpinily primární checkout (?? .worktrees/…).
git -C "$GEN3" check-ignore -q .worktrees/ \
  || printf '%s\n' '.worktrees/' >> "$GEN3/.git/info/exclude"
test -z "$(git -C "$GEN3" status --porcelain)"
git -C "$GEN3" worktree add "$WT" -b "$BRANCH" origin/main
```

Sidecar je sibling worktree, ne soubor uvnitř něj. Musí projít aktuálním
`launchpad/schemas/worktree.schema.json`; minimální root příklad:

```json
{
  "schema_version": "companiesascode.worktree.v1",
  "organization": "ExampleOrg",
  "organization_path": "organizations/ExampleOrg_GEN3",
  "workspace": "workspace",
  "module": "root",
  "module_path": ".",
  "repo_kind": "organization_root",
  "base_branch": "main",
  "branch": "<agent-prefix>/DEV-0000-gen2-gen3-migration",
  "mission_control_plan_code": "DEV-0000",
  "mission_control_plan_path": "mission-control/db/data/mission-control/plans/YYYY/MM/DEV-0000-gen2-gen3-migration.yaml",
  "worktree_path": ".worktrees/root/DEV-0000-gen2-gen3-migration",
  "created_at": "<ISO-8601>",
  "created_by": "<builder-id>",
  "last_touched": "<ISO-8601>",
  "status": "active",
  "pr_url": null
}
```

Branch prefix (`AGENT_PREFIX`, jednající Buddy/Agent) a `created_by`
(colleague/Buddy identita v sidecaru) jsou dva různé stringy — prefix pojmenuje
větev, `created_by` autora. Nezaměňuj je a nehardcuduj `codex/`.

Kanonická GEN3 cesta plánu vede do Organization-local Mission Control data
repozitáře pod `mission-control/db/data/mission-control/plans/**`. Launchpad po
dobu migrace umí číst také legacy `mission-control/plans/**`, ale sidecar musí
držet přesnou Organization-relative cestu pod jedním z těchto dvou kořenů;
aliasy s `.`/`..`, backslashi a únik přes symlink se odmítají fail-closed. Při
bootstrapu, dokud `mission-control/db` mount neexistuje, je správná sidecar cesta
legacy `mission-control/plans/**`; kanonickou `db/**` cestu do sidecaru zapiš až
po zřízení MCv3 data mountu (decision-0036 gates, Fáze 6).

Workspace modulové worktrees patří do
`.worktrees/workspace/<module>/<PLAN-code>-<slug>/`; productionspace jen při
explicitní org policy do `.worktrees/productionspace/<repo>/...`. Jeden
worktree má jednoho aktivního writera. Handoff může být commit + push + změna
ownera v Mission Control; PR není podmínkou předávky. Worktree bez aktivity
sedm dní je warning `stale`, ne automatické oprávnění k mazání.

## Fáze 3 — read-only inventory a forward-port registry

Aktuální Conglomerate CLI používá explicitní cesty. Staré přepínače
`--pair` a `--limit` nejsou podporované.

```bash
cd "$ROOT"
bun run sync:gen2-gen3:inventory -- \
  --gen2 "$GEN2" \
  --gen3 "$GEN3" \
  --label "$ORG" \
  --json > "$EVIDENCE_DIR/inventory.json"

# Samostatný mechanism-extraction pass pro Launchpad, Guide a skills:
bun run sync:gen2-gen3:inventory -- \
  --gen2 "$GEN2" \
  --gen3 "$GEN3" \
  --label "$ORG" \
  --json \
  --include-shared-surfaces > "$EVIDENCE_DIR/inventory-shared-surfaces.json"
```

Inventory CLI **záměrně přeskakuje** řadu prefixů (`modules/`,
`productionspace/`, `company/team/`, `personalspace/`, `output/`, `tmp/`,
`drafts/`, `ClientCompanies/`) — tedy právě nested moduly, data mounty a overlaye,
kterým brief věnuje největší pozornost. U fork-based topologie (GEN3 ==
`SOURCE_SHA`) navíc CLI vrací skoro samé `same`, takže content-diff je očekávaně
prázdný. Registry proto nestavíš z CLI výstupu: je primárně **strukturální**
(GEN2 → cílový layout), ne GEN2↔GEN3 content drift. Doplň ho ručním
nested/overlay/data-mount passem mimo CLI — manifest read, per-module
remote/HEAD, `gh repo view` metadata externích org repo bez klonu a scan
`company/team/*`:

```bash
gh repo view "$GITHUB_ORG/<module-repo>" \
  --json nameWithOwner,defaultBranchRef,visibility,isArchived,diskUsage,pushedAt
git -C "$GEN3/workspace/<module>" remote -v      # u již dostupných checkoutů
git -C "$GEN3" ls-files company/team/            # overlaye
```

Inventory nic nekopíruje. Každý netriviální rozdíl získa registry row:

| GEN2 ref/path | Consumer/scope | Kind | Rozhodnutí | GEN3 target | Metoda | Validace | Rollback/evidence |
|---|---|---|---|---|---|---|---|
| `<sha>/<path>` | `<live consumer>` | `manual-review` | `apply/adapt/skip/defer` | `<path>` | `<scoped patch>` | `<command>` | `<PR/report>` |

Význam rozhodnutí:

- `apply`: pravda platí v GEN3 beze změny modelu;
- `adapt`: záměr platí, ale cesta, pojmy nebo authority se mění;
- `skip`: stale, runtime, secret-adjacent, historické nebo duplicitní;
- `defer`: potřebuje ownera, access, contracts migraci nebo productionspace QA.

`port-candidate` ani `manual-review` se nekopíruje automaticky. `gen3-only` se
nepřepisuje starší GEN2 verzí. Historický text může zůstat historicky přesný;
živý resolver, script nebo runbook musí mířit na GEN3.

## Fáze 4 — consumer census před layout změnami

Než smažeš nebo přesuneš jedinou cestu, najdi všechny živé konzumenty:

```bash
cd "$WT"
git grep -n -E \
  'company/scripts/modules\.manifest\.json|(^|/)modules/|launchpad/contracts|@workspace-contracts|(^|/)launchpad/|(^|/)guide/|company/team/|\.claude/skills'
```

Root Git nevidí gitignored nested repa. Proto stejný search spusť explicitně v
každém dostupném nested checkoutu z manifest/inventory seznamu, například:

```bash
git -C "$GEN3/workspace/<module>" grep -n -E \
  'modules/|launchpad/contracts|@workspace-contracts|company/team/|\.claude/skills' || true
```

Manifest a sdílené resolvery čte i **runtime kód a testy**, nejen `doctor.sh`
a skilly. Grepni je explicitně napříč in-tree app moduly (`src/**`, `tests/**`)
a každý hit klasifikuj live/fixture/doc:

```bash
git grep -nI 'modules\.manifest\.json' -- '*.ts' '*.tsx' '*.mjs' '*.js' '*.sh' '*.ps1'
```

Live runtime čtenář bez fallbacku po odstranění legacy kopie tiše vrátí prázdný
scope (regrese, ne crash) — přepni ho na root manifest s `existsSync` fallbackem.
Fixture čtenáře, které si manifest staví samy na legacy cestě, se nemigrují
destruktivně; stačí, aby je pokryl fallback.

Do census tabulky zapisuj: consumer repo/path, live vs historical, současný
owner, cílový import/path, nutná změna, test a PR. Pro každou odstraňovanou
cestu musí být počet nevyřešených live consumers nula. `rg`/`git grep` hit v
archivu nebo datovaném changelogu se nemaže jen kvůli slovu GEN2; označí se
jako historický.

### Gate 4A — in-org Launchpad a contracts

Decision 0026 vyžaduje, aby plný Organization-local `launchpad/` runtime v
hotovém GEN3 layoutu neexistoval. Odstranění ale nesmí rozbít appky, které z
GEN2 importují `launchpad/contracts` nebo root contracts alias.

Postup:

1. Odděl runtime/UI/server/buildMacApp/runbook závislosti od contracts.
2. Každého konzumenta `launchpad/contracts` převeď na versionovaný shared
   kontrakt (`@workspace-contracts/<version>` nebo jiný schválený canonical
   package). Launchpad runtime není vlastník sdíleného kontraktu.
3. Změnu contracts a všechny aktivní consumery doruč ve stejném PR stacku nebo
   s explicitním pořadím a compatibility testem.
4. Ověř Doctor, Launchpad MCP skilly, host runbooky, tsconfig aliases, buildy a
   test fixtures.
5. Teprve při nule nevyřešených consumers smaž in-org Launchpad runtime.

Pokud contracts migrace není hotová, `launchpad/` může dočasně zůstat jen jako
pojmenovaný compatibility blocker s ownerem a plánem. Organizace se pak nesmí
prohlásit za layout-complete. Nepřenášej celý legacy Launchpad do shared rootu;
promuj pouze anonymizovaný mechanismus.

Po odstranění musí Organization README/MAP/runbooky odkazovat na shared
`<Conglomerate root>/launchpad`, ne na lokální kopii.

### Gate 4B — shared Guide versus Organization onboarding

Obecný kurz o HumanAndMachine GEN3, Launchpadu, agentech, Doctorech a
source-of-truth routingu patří do shared `<Conglomerate root>/guide`.

Pro každý Organization `guide/` soubor rozhodni:

- obecný mechanismus/lekce → promovat anonymizovaně do shared Guide a z
  Organizace odstranit;
- organization-specific onboarding → `manual/`, knowledgebase, role/colleague
  docs nebo owner modul;
- skutečně organization-specific interaktivní Guide app → smí zůstat jen s
  jasným ownerem, neduplicitním obsahem a vlastním `companyascode.app`
  manifestem.

Samotná existence starého GEN2 `guide/` není důvod jej zachovat. README/MAP
Organizace musí ukázat shared Guide jako obecný vstup. Guide je odvozený
pedagogický povrch, ne vyšší autorita než decisions, schémata, glossary nebo
Organization pravidla.

### Gate 4C — skills flip

GEN3 kanonická knihovna je `.agents/skills/`; `.claude/skills` je kompatibilní
symlink na ni, ne druhá kopie a ne opačný směr.

Na Windows Codex-only stroji, kde se Claude nepoužívá, je autoritou přímo
`.agents/skills/`. Chybějící `.claude/skills` nebo textový placeholder
materializovaný Gitem není blocker; samostatný adresář `.claude/skills/` je
nadále zakázaný jako divergentní druhý source of truth. Unix a stroje, které
Claude kompatibilitu používají, zachovávají symlink kontrakt.

GEN2 s reverzním layoutem má `.agents/skills` jako **existující symlink** →
`../.claude/skills`; ten je nutné nejdřív odstranit. `git rm` symlinku smaže i
prázdný parent `.agents/`, takže ho před `git mv` obnov. Řetěz `&&`, aby selhání
nezanechalo half-flip (stray `.claude/skills/skills`):

```bash
cd "$WT"
test -L .agents/skills && git rm .agents/skills      # reverzní výchozí stav
mkdir -p .agents \
  && git mv .claude/skills .agents/skills \
  && ln -s ../.agents/skills .claude/skills \
  && git add .claude/skills .agents/skills
```

Před `git mv` klasifikuj případné existující obě složky a sluč je po jednom
skillu. Nevytvářej symlink přes neznámou dirty knihovnu. Pokud Organizace
`.agents/skills/manifest.json` má, přegeneruj/validuj ho podle Organization
tooling; pokud ho nemá a žádné tooling ho negeneruje, flip ho nezakládá —
založení manifestu je samostatný krok/post-cutover.

Ověření:

```bash
test -d .agents/skills
test -L .claude/skills
test "$(readlink .claude/skills)" = "../.agents/skills"
git ls-files -s .claude/skills | grep '^120000 '
find .agents/skills -name SKILL.md -print
```

Flip nezmění jen resolvery — přepni i všechny skills-flip **validace**
(`doctor.sh`/`doctor.ps1` sekce „Skills entrypointy", testy), které by jinak dál
asserovaly starý směr a na korektním GEN3 layoutu by `doctor check` false-failoval
(`.agents/skills není symlink`). Čtení skillů přes symlink funguje obousměrně,
validační assert ne. Po flipu spusť `doctor check` a potvrď, že sekce Skills
entrypointy je zelená.

Na platformě bez funkčního Git symlinku je stav setup gap, ne oprávnění držet
dva sources of truth. Zapiš ownera a Doctor/init opravu.

### Gate 4D — overlay mapping

GEN2 `company/team/<slug>` se nepřesouvá naslepo. Nejdřív schval mapu:

| GEN2 overlay | Typ | OS username per machine | GEN3 colleague | Role/persona | Private obsah | Consumer status |
|---|---|---|---|---|---|---|
| `company/team/<slug>` | human/AI | `<os-user>` | `company/colleagues/<os-user>` | `<role>` | skip/personalspace/secret custody | `<open/ready>` |

Kanonický Git-visible Organization overlay je
`company/colleagues/<os-user>/`. Role jsou oddělené od governance persony.
Osobní Buddy/gbrain nebo privátní osobní kontext patří do `personalspace/`,
secrets do schválené ignored custody cesty a samostatné AI profile/gbrain repo
se nenahrazuje firemním overlayem.

Přepiš všechny živé resolvery, Doctor person lookup, Guide odkazy, skilly,
CI a `.gitignore`. `company/team/` smaž až při nule nevyřešených consumers a
potvrzené mapě všech lidí i AI kolegů v migrované cohortě. Neznámé OS username
neodhaduj; ponech compatibility stav a otevřenou issue.

## Fáze 5 — kanonický tracked Organization layout

Tracked změny doruč po logických blocích; každý blok má vlastní validaci a
rollback. Doporučené pořadí:

1. `company.gen3.json` s čistou interní identitou, governance, workspaces a
   source-of-truth mapou;
2. root `modules.manifest.json` jako jediný module-slot manifest;
3. `.agents/skills` a colleague/role overlaye;
4. `manual/` včetně přejmenování GEN2 root zdroje
   `WORKSPACE_MANUAL.md` na kanonický GEN3 cíl
   `manual/ORGANIZATION_MANUAL.md`; Organization-wide manuál nesmí v GEN3
   dál nést Workspace filename;
5. `workspace/` a `productionspace/` shell/ignore/manifest cesty; sem patří i
   tracked `.gitignore` rule `.worktrees/*` (s `!.worktrees/README.md` a
   `!.worktrees/AGENTS.md` výjimkou), aby další worktrees nešpinily primární
   checkout a nahradil se přechodný local `.git/info/exclude` z Fáze 2;
6. Launchpad/contracts a Guide disposition;
7. Mission Control app/data boundary;
8. app package manifesty a dokumentace.

### Jediný module manifest

Slouč GEN2 `company/scripts/modules.manifest.json`, root manifest a další
registry do jediného root `modules.manifest.json`. Zachovej `git.url`,
`git.branch`, fork upstream, sync policy a datové mounty. Migruj všechny
čtenáře (Doctor shell/PowerShell, search, generátory, CI, skilly a fixtures) ve
stejném review stacku. Legacy kopii po consumer census odstraň.

Platí:

- workspace modul má cestu `workspace/<module>` a právě jednu logickou
  `module_slots[].workspace` deklaraci;
- chybějící deklarace znamená default Workspace `workspace`;
- productionspace repo má cestu `productionspace/<repo>` a nesmí deklarovat
  `workspace: "productionspace"`;
- root governance mounty (`infra`, `mission-control`) jsou explicitní, ale
  nejsou tím automaticky běžné workspace moduly;
- manifest deklaruje repo/materialization, ne druhou app/port autoritu.

### `package.json` je jediná app autorita

Každá spustitelná appka deklaruje `companyascode.app` ve svém vlastním
`package.json`. Port, id, title, host, health a scripts se neduplikují do
`company.gen3.json`, `modules.manifest.json` ani hardcoded Launchpad mapy.

```json
{
  "scripts": {
    "dev": "bun run src/server.ts"
  },
  "companyascode": {
    "app": {
      "schema_version": "companyascode.launchpad_app.v1",
      "id": "ExampleOrg-deals-v2",
      "title": "Deals",
      "company": "ExampleOrg",
      "module": "deals",
      "surface": "internal",
      "port": 5277,
      "host": "127.0.0.1",
      "health_path": "/health",
      "dev_script": "dev",
      "tags": ["sales"]
    }
  }
}
```

`companyascode.app.company` se musí rovnat čistému `company.slug`; app id a
main port jsou unikátní v celém Conglomerate rootu. `dev_script` musí existovat
v témže package souboru. Workspace grouping pochází z module deklarace,
nikoli z package cesty. Worktree DEV runtime dostává ephemeral `PORT` od
Launchpadu a nesmí obsadit main port. Productionspace app manifest se tímto
automaticky nestává spustitelným Launchpad lifecycle povrchem.

Pro každou zděděnou `app/vN` udělej census: `wire`, `defer` nebo `retire` s
ownerem a důvodem. Required daily app bez validního manifestu blokuje cohort
cutover.

### Managed blok Modelu spolupráce (verbatim seed)

Kanonický blok „Model spolupráce" v Organization `AGENTS.md` se **seeduje už
tady**, ne až post-cutover: vlož ho VERBATIM z template mountu (reference
checkout, ne wired remote) a ověř md5 bloku (od nadpisu
`## Model spolupráce: Principál a Agenti` po další `## `) proti template. Blok je
čistě managed (HTML komentář sám říká, že znění se navrhuje v HumanAndMachines),
Organizace ho nemá jak legitimně customizovat, takže seed je nedestruktivní a
odpovídá stavu sourozeneckých Organizací.

Rozliš „managed **blok** při zakládání layoutu" (tady, verbatim, hned) od
„průběžný managed content **sync** přes wired template remote" (post-cutover).
Managed **soubory** (generické skilly) zůstávají post-cutover — org-tuned drift
potřebuje Steward review — ale managed **blok** kolaborace se seedne hned.

### Doctor adaptation checklist

Fork zdědí GEN2 Doctor (`doctor.sh`/`doctor.ps1`), který zná starý layout. Po
layout změnách projdi a adaptuj minimálně:

- **deps discovery** (`list_app_dirs` a spol.) — hledá app adresáře na nových
  flat cestách `workspace/<module>`, ne na starých `modules/`;
- **`--module` filtry** — resolvují slug proti jedinému root manifestu a nové
  cestě;
- **`project_module_root` / dirty-guard** — module-root resolution i clean-tree
  guard míří na kanonický layout;
- **productionspace parita** — PS checky/discovery mají paritu s workspace,
  s productionspace jako rezervovanou org-level hranicí;
- **repository-db mount sémantika** — v push/publish flows fail-closed skip při
  nezmaterializovaném mountu; materializace přes publish-boundary guard
  (`git check-ignore` s **trailing slash** na adresáři); kolize s tracked
  scaffoldem na cílové cestě = prerekvizitní modulový PR, ne Doctor force;
- **skills/fixtures odkazující na manifest** — po Gate 4C a consumer censu
  (Fáze 4) míří na root manifest (nebo ho tolerují přes fallback);
- **init/onboarding gates** — Organization Doctor `init` může mít vlastní gates
  (např. disk-space gate) a zděděné GEN2-init kroky/texty; prověř je při migraci,
  aby init na GEN3 layoutu neodkazoval na starou strukturu ani neběžel proti
  neplatné prerekvizitě.

Po adaptaci spusť `doctor check`/`status` a potvrď, že sekce dotčené migrací
jsou zelené.

## Fáze 6 — Mission Control ownership a data boundary

Mission Control v3 se neinstaluje do GEN2 jako prerequisite. V GEN3 musí být
jedna Organization planning/UI vrstva pod root názvem `mission-control/`,
která plánuje workspace i productionspace. Nezakládej paralelní
`workspace-planning/` nebo `productionspace-planning/`.

Decision 0026 určuje Organization ownership a původní in-tree výchozí tvar;
decision 0037 mění vnitřní app/data boundary. Zapiš explicitně, který code
model cílová Organizace používá:

- default: app code je trackovaný v Organization `mission-control/`;
- schválený extracted model: forked app-code repo je namountované přesně v
  `mission-control/` a Organization repo už netrackuje duplicitní app copy.

Extracted model potřebuje org-local decision/MC plan, app repo/branch/SHA,
Doctor materialization contract a rollback. Nested checkout nesmí být root
gitlink. V obou modelech existuje právě jeden živý app-code source.

`mission-control/db/` je při bootstrapu pouze data-boundary kandidát. Legacy
plány, roadmaps a TODO/DONE/ISSUES zůstávají read-only fallback, dokud
Organization nesplní všechny decision-0036 gates:

1. parity report s každým přeneseným nebo vědomě vynechaným záznamem;
2. Organization MC validace a data-repo publish validace na current heads;
3. přesný rollback na legacy nebo poslední published data SHA;
4. rollback rehearsal/smoke, případně explicitně schválená výjimka;
5. credential authority, path allowlist, branch policy a audit metadata;
6. owner/steward approval;
7. post-cutover monitor se stále dostupným fallbackem.

Do splnění všech bodů nepiš „data repo je sole source“. Po cutoveru smaž nebo
demotuj duplicate live copies tak, aby search nevracel dvě autority. Data
write flow musí být jediný pending → approve → publish backend pro UI i agenty.

U DEFAULT in-tree modelu před splněním decision-0036 gates žádné samostatné data
repo neexistuje — „data validate" ve validační matici (Fáze 9) proto znamená
validaci legacy in-tree ledgerů, ne data-repo publish.

Mission Control plan/task closeout je součást migrace, ale rozliš dvě věci.
**Closeout konzistence** (plan status, TODO/DONE ledger, PR/SHA evidence
a carry-over issues si nesmí odporovat) běží průběžně od Fáze 6. **Flip
migračního execution plánu na `done`** je jednorázový a patří až do Fáze 10 po
local switch — migrační plán je hotový teprve, když je hotová celá migrace.
Migrační execution plán bez navázaných execution TODO tasků zavírá closeout přes
status + carry-over kontrolu, ne přes TODO→DONE přesun.

## Fáze 7 — paralelní write policy a semantic DEV remap

Před prvním souběžným dnem vyber a zapiš jeden režim pro každý scope:

- `GEN2-primary`: GEN2 je aktivní týmová linka, GEN3 přijímá pouze kurátorované
  forward-porty;
- `GEN3-primary`: vyjmenovaná cohorta/scope pracuje v GEN3, GEN2 přijímá pouze
  schválenou maintenance změnu s povinným GEN3 forward-portem.

Nikdy nezaváděj rutinní bidirectional sync. Každý maintenance commit po
`SOURCE_SHA` má registry row a target evidence. Business data se migrují přes
owner modulový plán, ne přes root file copy.

### DEV/plan code collision gate

Sestav census kódů z obou generací: plans, roadmaps, TODO/DONE/ISSUES, branche
a otevřené PR. Stejný kód se stejnou sémantikou může být propojen; stejný kód
s jiným tématem se musí remapovat.

Rozliš dvě topologie:

- **Divergentní linky** (cross-owner fork nebo dlouho běžící paralelní vývoj) —
  stejné kódy mají různou sémantiku → povinná remap tabulka níže.
- **Fresh standalone history-copy** (same-owner kopie GEN2 @ `SOURCE_SHA`) —
  100 % plan/ledger kódů je sdílených z konstrukce a byte-identických. Gate se
  pak neredukuje na remap, ale na (a) census, že žádný kód nemá **divergentní**
  sémantiku (same-plan carryover = benign link, ne remap), a (b) single-source
  allocation pravidlo (nové plány jen v GEN3, GEN2 už čísla nealokuje). Výstupem
  je census tabulka (carryover vs GEN3-only) + allocator pravidlo, ne remap
  tabulka. **Nula remapů je validní PASS**, pokud census prokáže absenci
  divergentní sémantiky a GEN2 nemá po `SOURCE_SHA` nový plán; prázdná remap
  tabulka pak neznamená, že fáze neproběhla.

Povinná mapa (divergentní topologie):

| Source generation | Původní kód | Source title/path | GEN3 kód | Důvod | Aktualizované reference | Validace |
|---|---|---|---|---|---|---|
| GEN2 | `DEV-1234` | `<path>` | `DEV-6501` | collision | plans/tasks/links/branches | `<commands>` |

Remap je sémantická migrace, ne globální string replace:

- nový GEN3 plán dostane nový unikátní kód;
- původní GEN2 kód a source SHA zůstanou v `legacy_sources`, odkazu nebo note;
- tasky, blockers, roadmap refs a GitHub vazby se přepíší atomicky v jednom
  reviewed changesetu/PR;
- closed historical artefakty se nepřepisují, pokud by se ztratila auditní
  čitelnost;
- allocator musí rezervovat kódy proti GEN2 i GEN3, nebo používat explicitně
  oddělený schválený rozsah.

Neimportuj bulk ledgery, dokud mapa není schválená a validátor nedokáže
duplicitní/cizí reference odhalit.

## Fáze 8 — bezpečný per-machine přesun nested checkoutů

Tracked PR nejdřív změní manifesty, čtenáře, `.gitignore` a docs. Nested
checkouty jsou gitignored, proto je po merge musí každý Builder/Host přesunout
lokálně. Přesun se neprovádí ve feature worktree a nikdy před consumer census.

Zvol variantu podle toho, co se děje s GEN2 checkoutem:

- **Move varianta** (níže) — GEN2 nested checkout se lokálně přesune na cílovou
  cestu; použij, když se mašina překlápí na GEN3 a starý checkout se už
  nepoužívá.
- **Fresh-checkout varianta** — když GEN2 checkout **zůstává týmu** (paralelní
  běh, jiná cohorta), mounty se do GEN3 **klonují** z jejich remote, ne
  přesouvají; GEN2 zůstane nedotčený. Preflight pak neověřuje `mv` source, ale
  cílovou cestu (`test ! -e`), remote/branch a po `git clone` HEAD/clean; move
  a rollback `mv` bloky se nepoužijí.

Move variantu použij jen pro checkouty, které se z GEN2 odstěhovávají.

Pro každou mašinu vytvoř reviewovaný TSV plán v lokálním evidence adresáři:

```text
modules/deals	workspace/deals
modules/monorepo	productionspace/monorepo
```

Všechny smyčky nad plánem drž ve tvaru `while … read` se vstupem přes
`< "$MOVE_PLAN"`. Nepiš je jako `for x in $(…)`: zsh (default shell na macOS)
neprovádí word-splitting nezakódované command substituce, takže `for` smyčka nad
výstupem příkazu se v zsh tiše zvrhne na no-op nebo jednu iteraci, kdežto stejný
zápis v bashi projde — a runbook běží na obojím.

Preflight všech řádků:

```bash
MOVE_PLAN="$EVIDENCE_DIR/move-plan.tsv"
while IFS=$'\t' read -r source target; do
  test -n "$source" && test -n "$target"
  test -d "$GEN3/$source"
  test ! -e "$GEN3/$target"
  test -z "$(git -C "$GEN3/$source" status --porcelain)"
  git -C "$GEN3/$source" rev-parse HEAD
  git -C "$GEN3/$source" remote -v
done < "$MOVE_PLAN"
```

Zastav se při dirty repu, chybějícím source, existujícím targetu, symlink
úniku nebo neznámém ownerovi. Potom proveď přesně reviewovaný plán:

```bash
while IFS=$'\t' read -r source target; do
  mkdir -p "$(dirname "$GEN3/$target")"
  mv "$GEN3/$source" "$GEN3/$target"
done < "$MOVE_PLAN"
rmdir "$GEN3/modules" 2>/dev/null || true
```

Po přesunu ověř každý target: remote, branch policy, čistotu a HEAD proti
preflight evidenci. Pak spusť Organization Doctor/status/search a root
Launchpad validaci. Machine cohort tabulka musí říct, kdo move aplikoval a na
jakém Organization main SHA.

Rollback lokálního přesunu nepoužívá `git reset` ani `git checkout`:

```bash
while IFS=$'\t' read -r source target; do
  test -d "$GEN3/$target"
  test ! -e "$GEN3/$source"
  mkdir -p "$(dirname "$GEN3/$source")"
  mv "$GEN3/$target" "$GEN3/$source"
done < "$MOVE_PLAN"
```

Tracked rollback je samostatný revert PR na poslední známý dobrý manifest a
čtenáře. Neprováděj jej smícháním s lokálním `mv`.

## Fáze 9 — validační matice

Použij nejmenší relevantní příkazy průběžně a celou matici před cohort nebo
týmovým cutoverem. Skutečný Organization Doctor může mít jiné entrypointy;
zapiš přesné příkazy, ne předpoklad.

| Gate | Povinné ověření | PASS evidence | Co blokuje |
|---|---|---|---|
| Source | clean GEN2 main, local/origin/remote SHA shoda, bundle verify | source SHA + bundle verify | dirty/behind/unknown source |
| Repo topology | `git status`, remotes, `git ls-files -s` | žádný Organization gitlink v Conglomerate ani nechtěný gitlink v Organization rootu | submodule pointer nebo cizí historie |
| Worktree | canonical path + schema-valid sidecar + plan owner | branch/path/sidecar/current head | orphan, wrong main branch, dva writeři |
| Inventory | oba CLI passy + registry | všechny high-risk rows classified | untriaged `manual-review`/`port-candidate` |
| Consumer census | root + každý nested repo | nula nevyřešených live consumers odstraňované cesty | unresolved `launchpad/contracts`, `modules/`, `company/team` apod. |
| Layout | schema/config checks + manifest reader tests | jeden manifest, flat paths, productionspace reserved | duplicate manifest, declaration/path conflict |
| Skills | symlink a manifest validace | `.agents` canonical, `.claude` symlink | dvě knihovny nebo opačný symlink |
| Colleagues | schválená identity mapa + person Doctor | každý cohort user rozpoznaný | neznámé OS username, private copy |
| Apps | schema, global id/port census, scripts/build/smoke | `/api/apps` přesně jedna app deklarace na package | invalid manifest, duplicate id/port, chybějící daily app |
| Mission Control | app validate/test/build + data validate + parity/rollback | current app/data SHAs a gate checklist | dvě živé pravdy nebo neověřený sole-source claim |
| Organization | vlastní check/Doctor/task/search | žádný `fail`; accepted warn registry | task-ledger fail, dirty mount, nejasný branch/access |
| Conglomerate | z rootu `bun run check` a `bun run doctor` | discovery/API summary | failure, security violation, workspace declaration warn |
| Runtime/UI | `/api/apps`, `/api/doctor`, start → healthy → stop, browser flow/console | URL, app id, SHA, screenshot/log summary | silent failure, stuck loader, required flow broken |
| Secrets | tracked-file scan + diff review | pouze metadata/pointery | secret/session/customer export v diffu |

Root příkazy po mountu nebo změně shared configu:

```bash
cd "$ROOT"
bun run check
bun run doctor

# Když Launchpad běží na canonical local portu:
curl -fsS http://127.0.0.1:4174/api/apps | python3 -m json.tool >/dev/null
curl -fsS http://127.0.0.1:4174/api/doctor | python3 -m json.tool >/dev/null
```

Organization minimum doplň podle jeho `AGENTS.md`, typicky:

```bash
git -C "$GEN3" status --short --branch
git -C "$GEN3" worktree list --porcelain
git -C "$GEN3" diff --check
(cd "$GEN3" && company/scripts/doctor.sh check)
```

Mission Control app/data validuj z jejich skutečných repo rootů, ne z
historické compatibility cesty.

Secrets/data-boundary scan (řádek Secrets) nesmí být jen grep na tokeny.
Export adresáře jako `output/` a `outputs/` můžou být **trackované** — fork ==
`SOURCE_SHA` je do GEN3 přenesl — a nést customer-adjacent obsah (NDA, nabídky,
exporty). Ověř `git ls-files output/ outputs/` a každý tracked business/customer
export dej k owner rozhodnutí (data-boundary gate), ne k automatickému skip jen
proto, že tyhle cesty bývají jinde gitignored.

## Accepted warnings versus cutover blockers

Accepted warning musí mít ownera, dopad, next action a očekávaný důkaz:

- `missing_access` u restricted/nemountovaného slotu, který cohorta nepotřebuje;
- `planned_slot` bez repa;
- `needs_install` u non-primary appky s jasným Install/Repair postupem;
- zastavená appka mimo vyjmenovaný daily set;
- optional QMD/search advisory při funkčním exact search;
- `stale` worktree s dohledatelným plánem/ownerem a cleanup rozhodnutím;
- productionspace repo na vlastní povolené release branchi.

Cutover blokuje:

- jakýkoli Doctor/check `fail`, nevalidní task/issue ledger nebo security
  violation;
- dirty/unknown repo, nečekaná větev mimo schválenou productionspace policy;
- duplicate/invalid app id, port collision nebo required app bez manifestu;
- orphan worktree, nejasný writer nebo neexistující Mission Control plan;
- nevyřešený live consumer mazané cesty, zejména `launchpad/contracts`;
- dvě skill knihovny, unmapped colleague overlay nebo secret/private data v
  tracked diffu;
- dvě živé Mission Control app/data pravdy, chybějící parity/rollback/approval;
- generický Organization Guide duplikující shared Guide;
- in-org Launchpad runtime vydávaný za hotový decision-0026 layout;
- neklasifikovaný high-risk inventory rozdíl;
- required user flow bez browser/API smoke a rollbacku.

„Warn bez příběhu“ je blocker.

## Fáze 10 — local switch, cohort rollout a týmový cutover

Local switch jednoho člověka není týmový cutover. Pro každého člověka/AI
kolegu eviduj OS user, Organization/role access, required moduly, porty,
Doctor výsledek, daily apps, rollback ownera a applied move SHA.

Po local readiness:

- denní vstup míří do Conglomerate rootu/shared Launchpadu a GEN3 Organizace;
- GEN2 checkout zůstává fyzicky čitelný a dostane ignored lokální marker
  `rollback/forward-port`, ne team-wide tvrzení;
- před přepnutím zinventarizuj app bundles, Dock/taskbar položky, aliasy a
  login/startup položky; zálohuj skutečný OS launcher stav a zapiš hash;
- po consumer censu GEN2 launcher nemaž: přesuň jej do datovaného lokálního
  archivu, z daily surface odeber jen přesně identifikovanou GEN2 položku a
  ověř, že shared GEN3 launcher zůstal přítomný;
- ignored marker ulož do Organization-local osobní archive/private cesty,
  pokud ji Organization už má; nevytvářej kvůli markeru tracked osobní data;
- marker obsahuje exact GEN2 SHA, datum, nový entrypoint, archivní a backup
  cesty, ověřený stav po změně a krokový rollback;
- opakuj runtime/browser smoke na každé platformě, kterou cohorta používá.

Na macOS není index Dock položky stabilní. Pokud není `dockutil`, nejdřív
exportuj a zazálohuj `com.apple.dock`, položku identifikuj současně podle
labelu i app URL/bundle id a po změně znovu přečti plist. Nikdy nekopíruj
číselný index z jiného stroje. Nejbezpečnější je ruční odebrání v Dock UI;
automatizace smí pokračovat jen s čerstvou zálohou a jednoznačnou shodou.

Týmový cutover smí Organization Admin schválit až když:

1. všichni lidé a AI kolegové v scope mají GEN3 access a ověřený daily flow;
2. GEN2 maintenance commits po `SOURCE_SHA` jsou všechny ported/skipped/deferred
   s evidencí;
3. MC code/data a DEV remap gates jsou uzavřené;
4. required apps/data/automations mají parity a rollback;
5. root i Organization validace jsou zelené nebo mají pouze accepted warnings;
6. Mission Control plan/tasky/issues odpovídají realitě a exact-head review je
   splněné;
7. archive a unarchive autorita je známá.

Potom GEN2 **archivuj, nemaž**:

```bash
gh repo archive "$SOURCE_REPO" --yes
```

GEN3 repo se nepřejmenovává; `${ORG}_GEN3` zůstává trvalý název. Volitelný
rename archivovaného GEN2 na `${ORG}_GEN2` je samostatná, explicitně schválená
ceremonie, ne podmínka cutoveru.

## Rollback podle fáze

| Stav | Rollback |
|---|---|
| Před vytvořením target repa | Žádná změna GEN2; použij bundle jen jako ověření. |
| Target repo existuje, bez cutoveru | Parkuj/zavři migrační PR a worktree; GEN2 zůstává primary. Repo nemaž bez explicitního rozhodnutí. |
| Tracked layout PR | Revert PR na známý dobrý target SHA; nemíchej s cizím diffem. |
| Per-machine flat move | Reverse `mv` podle stejného reviewed TSV, potom ověř HEAD/remote/status. |
| Skills/overlay/app změna | Revert vlastnický PR a vrať resolver na předchozí známou cestu; private data nekopíruj zpět do Gitu. |
| Per-machine daily launcher | Vrať archivovaný GEN2 app bundle/alias na původní cestu, obnov OS launcher/Dock ze zaznamenané zálohy, restartuj launcher surface a proveď GEN2 smoke. |
| MC data pilot | Přepni read path na legacy fallback nebo poslední published data SHA podle rehearsed plánu; žádný force push. |
| Po týmové archivaci GEN2 | Unarchive GEN2; případný rename archivu vrať. `_GEN3` target zůstává nedotčený. |

Nikdy nepoužívej `git reset --hard`, globální `rm -rf`, force push nebo
destruktivní DB obnovu jako implicitní krok tohoto manuálu.

## Handoff packet

Finální předávka musí být použitelná bez původního chatu:

```text
Status: PASS | FAIL | BLOCKED
Scope: machine / cohort / team; Organization a dotčená repa
Authority: použité decisions a org-local výjimky
Source: GEN2 repo + exact SHA + verified bundle marker
Target: GEN3 repo + current head + PR
Worktree: path + branch + sidecar + owner plan
Inventory: summary + forward-port registry
Consumer census: unresolved live consumers = N
Layout: manifest, Guide, Launchpad/contracts, skills, overlays
Mission Control: app repo/SHA, data repo/SHA, fallback a gate status
Validation: skutečně spuštěné příkazy a výsledky
Runtime/browser: app ids, URL, flows, console/API evidence
Accepted warnings: owner + next action + expected proof
Rollback: exact path/command + authority
Open risks/issues: durable source-of-truth odkazy
Next action: jeden konkrétní owner a krok
```

Před handoffem ověř exact current head, review/checks, active review threads,
root i Organization Git status a inventuru vlastních worktrees. Dokončený
Mission Control plán uzavři na `done`, přesun tasků do DONE a carry-over
ponech jako samostatné otevřené issues/tasks.

## Definition of done

Migrace Organizace je hotová teprve když:

- source SHA a ověřený bundle jsou dohledatelné mimo Git;
- target je samostatné `<Org>_GEN3` repo se zachovanou historií a čistou
  interní identitou;
- Organization mount je gitignored nested repo, ne root submodule;
- main checkouty zůstávají na `main`, změny proběhly v plan-owned worktrees a
  stale/orphan metadata jsou uklizená nebo předaná;
- existuje jediný root module manifest a všechny live consumers čtou jej;
- workspace checkouty jsou na každé migrované mašině pod `workspace/`,
  productionspace pod `productionspace/` a grouping pochází z deklarace;
- in-org Launchpad runtime je odstraněný a žádný aktivní consumer nezávisí na
  `launchpad/contracts`;
- obecný Guide je shared; organization-specific onboarding je v owner vrstvě;
- `.agents/skills` je canonical a `.claude/skills` správný symlink;
- všichni cohort colleagues mají schválené `company/colleagues/<os-user>`
  mapování bez privátních dat;
- každá required app má právě jednu autoritu v package `companyascode.app`,
  bez globální id/port kolize;
- Mission Control má jednu app-code a jednu data autoritu, legacy fallback je
  vypnutý pouze po decision-0036 gates;
- DEV kódy jsou unikátní nebo sémanticky remapované s provenance;
- inventory nemá neklasifikovaný high-risk rozdíl;
- Organization i Conglomerate validace, API a user-facing smoke jsou zelené
  nebo mají pouze explicitně accepted warnings;
- local switch každého člověka má rollback a týmový archive byl proveden jen
  po samostatném lidském schválení;
- žádný secret, klientský export ani cizí Organization pravda nebyla
  přenesena;
- Mission Control, task ledgery, changelog/handoff a skutečný Git/runtime stav
  si neodporují.
