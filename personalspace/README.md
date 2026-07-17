# Personalspace

Mountpoint pro privátní prostory lidí a AI kolegů podle
`launchpad.gen3.json` (`personalspace_mountpoint`) a CompaniesAsCode
decisions 0013 a 0021; strukturu definuje decision 0051
(revidovaná pro self-service decision 0079 a VPS-only Buddy decision 0080,
HumanAndMachines/docs/decisions/).

`personalspace/` je integrální privátní vrstva Conglomerate GEN3 a mountpoint
**více osobních prostorů**. Není to Organizace ani externí doplněk. Každý osobní
prostor je samostatné repo `<username>/<username>_GEN3` na osobním nebo
agentním GitHub účtu (generační marker per decision 0045), mimo firemní
GitHub organizace. Vlastník mašiny tu má svůj primární prostor a vedle něj
může mountovat prostory, které mu nasdíleli jiní Kolegové. Firemní pravda
sem nepatří a nikdy se odsud nepřenáší mezi Organizacemi.

Personalspace může fungovat bez Buddyho. Jeho Principálem je vlastník; Buddy
binding a přístup ke gbrainu se přidávají jen tehdy, když vlastník Buddyho
skutečně onboarduje. Aktivní Buddy smí běžet pouze na dedikované per-owner
VPS; tento lokální mount drží jeho Git konfiguraci, ne Hermes/Buddy runtime.

Owner identifikátor je GitHub username vlastníka, například `exampleowner` — jeho prostor je
`personalspace/exampleowner_GEN3/` a repo `exampleowner/exampleowner_GEN3`.
Lokální OS účet není GEN3 owner identita.

## Pravidlo pro agenty

**Personalspace je privátní prostor.** Pokud hledáš pracovní záležitosti —
firmy, klienty, moduly, Mission Control plány — patří do
`../organizations/<Org>/`, ne sem. Osobní prostor vlastníka mašiny otevírej
jen pro jeho osobní kontext (osobní moduly, gbrain, secrets custody);
prostory nasdílené od jiných lidí čti jen s výslovným zadáním vlastníka
mašiny. Obsah personalspace se nikdy nesmí objevit ve sdílených výstupech,
org discovery, reportech ani šablonách.

## Struktura (decision 0051)

```text
personalspace/
├── exampleowner_GEN3/          # primární osobní prostor vlastníka mašiny
│   ├── personal.gen3.json      # manifest (vlastník, volitelný Buddy, sloty)
│   ├── modules.manifest.json   # identický kontrakt jako v Organizaci
│   ├── workspace/              # plochá složka OSOBNÍCH modulů (nested private
│   │   └── <modul>/            #   repa <owner>/<modul> na osobním GitHubu)
│   ├── gbrain/                 # mount private paměťového data repa vlastníka
│   │                           #   (Markdown system of record; Buddy access
│   │                           #   je volitelný; defaultně se NEsdílí)
│   ├── buddy/                  # volitelný mount private Hermes Profile
│   │                           #   Distribution; config pro VPS, ne localhost
│   ├── secrets/                # owner-scoped secret custody (viz níže)
│   └── README.md
└── othercolleague_GEN3/        # příklad: prostor nasdílený jiným Kolegou
```

Osobní moduly drží stejný kontrakt jako workspace moduly Organizací —
promotion do firemního workspace je přesun repa + úprava manifestů, vždy
přes fail-closed isolation gate (žádné secrets, osobní overlaye ani gbrain
reference). Gbrain je root vrstva prostoru (analogie `mission-control/`
v rootu Organizace), ne modul; v1 lidské rozhraní je Obsidian (deep link),
agenti pracují přes gbrain MCP server. Software pochází z veřejného
`garrytan/gbrain`; privátní Markdown data vlastníka žijí v samostatném repu,
doporučeně `<username>/<username>-gbrain`, mountovaném do `gbrain/`. Software
repo a data repo se nesmějí zaměnit.

## Vytvoření vlastního Personalspace

`HumanAndMachines/Conglomerate_GEN3` je direct-pull repo a není GitHub
template. Pro self-service založení prostoru vlastníka bude po public-readiness
gate `CAC-0071` sloužit veřejný
`HumanAndMachines/PersonalspaceTemplate_GEN3`; do té doby zůstává template
private. Vygenerovaná instance musí být vždy private a pojmenovaná přesně:

```text
<github-login>/<github-login>_GEN3
```

Mount je `personalspace/<github-login>_GEN3/`. Bootstrap ověřuje shodu
GitHub loginu, remote repa a mount path, private visibility owner i gbrain
repa, vlastní `.gitignore` pro secrets a nepřítomnost `.gitmodules`/gitlinků.
Doctor pak přes přihlášené `gh` živě ověřuje skutečnou GitHub visibility;
manifestová deklarace `private` sama nestačí a neověřitelný remote je hard
failure. Všechny checkouty jsou Doctor-managed gitignored nested repa.
Cross-platform automatizaci drží root příkaz:

```text
bun run personalspace:create -- --display-name "<jméno>" --apply --install-gbrain
```

Detail a recovery jsou v `manual/create-personalspace.md`; pilot Matouše
a cross-platform evidence drží `CAC-0071`.

Vlastník s Buddym použije `--with-buddy`. Tím vznikne třetí private repo
`<username>/<username>-buddy` a kanonický hosted handoff vygenerovaného
Personalspace drží `manual/host-personalspace-with-buddy.md`. Sdílený runtime
zůstává v `HumanAndMachines/Buddy`, Hermes software v
`NousResearch/hermes-agent`.

Pro hosted variantu spusť:

```text
bun run personalspace:create -- --display-name "<jméno>" --with-buddy --apply
```

Manifest fail-closed vyžaduje
`deployment_target: owner-dedicated-personalspace-vps` a
`local_execution: forbidden`. Launchpad může zobrazit hosted stav/odkaz, ale
nesmí Buddyho lokálně instalovat, spouštět, zastavovat ani restartovat a nemá
localhost fallback.

Existující neversionované manifesty zůstávají přechodně čitelné s Doctor
warningem a migrují se podle
[`manual/migrate-personalspace-custody-v1.md`](../manual/migrate-personalspace-custody-v1.md);
částečný nebo neplatný upgrade se nedoplňuje tichým defaultem.

## Sdílení mezi Kolegy

Sdílení = GitHub repo access, granulární per repo. Super-repo osobního
prostoru je katalog (manifesty) — jeho nasdílením druhý člověk vidí
strukturu; obsah (moduly, gbrain) jsou nested repa s vlastním přístupem,
takže se mu materializuje jen to, kam vlastník dal access — zbytek vidí
jako `missing_access` (stejná mechanika jako u Organizací). Dva lidé tak
sdílí vybrané privátní věci jen mezi sebou, bez firemní organizace.
Gbrain se defaultně nesdílí.

Obsah tohoto mountpointu je lokální (gitignored kromě tohoto README);
konkrétní checkouty si sem mountuje vlastník stroje.

## Lokální secrets

Root a lokální owner secrets, které nepatří do žádné GitHub Organizace, mají
owner-scoped custody cestu v primárním prostoru vlastníka mašiny:

```text
personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>
```

Příklad Google OAuth Desktop client souboru:

```text
personalspace/<owner>_GEN3/secrets/google-oauth/<domain>/client-desktop.json
```

Adresáře se drží lokálně s módem `0700`, secret soubory s módem `0600`.
Do Gitu patří jen tento standard a no-secret runbooky, nikdy skutečné secret
hodnoty ani obsah JSON souborů; nasdílení prostoru secrets nepřenáší.
Buddy/Hermes provider auth, sessions a runtime secrets patří pouze do
oddělené custody na dedikované VPS, ne do této lokální cesty.
Detailní pravidla jsou v `manual/security/local-secret-custody.md`
(aktualizace cesty na owner-scoped tvar je součást CAC-0048).
