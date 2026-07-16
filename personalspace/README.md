# Personalspace

Mountpoint pro privátní prostory lidí a AI kolegů podle
`launchpad.gen3.json` (`personalspace_mountpoint`) a CompaniesAsCode
decisions 0013 a 0021; strukturu definuje decision 0051
(HumanAndMachines/docs/decisions/).

`personalspace/` je mountpoint **více osobních prostorů**. Každý osobní
prostor je samostatné repo `<username>/<username>_GEN3` na osobním nebo
agentním GitHub účtu (generační marker per decision 0045), mimo firemní
GitHub organizace. Vlastník mašiny tu má svůj primární prostor a vedle něj
může mountovat prostory, které mu nasdíleli jiní Kolegové. Firemní pravda
sem nepatří a nikdy se odsud nepřenáší mezi Organizacemi.

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
│   ├── personal.gen3.json      # manifest (vlastník, Buddy binding, sloty)
│   ├── modules.manifest.json   # identický kontrakt jako v Organizaci
│   ├── workspace/              # plochá složka OSOBNÍCH modulů (nested private
│   │   └── <modul>/            #   repa <owner>/<modul> na osobním GitHubu)
│   ├── gbrain/                 # root vrstva: privátní know-how kolegy
│   │                           #   (Obsidian-compatible markdown vault; jeden
│   │                           #   gbrain sdílí pár Kolega ↔ jeho Buddy;
│   │                           #   agenti přes MCP; defaultně se NEsdílí)
│   ├── secrets/                # owner-scoped secret custody (viz níže)
│   └── README.md
└── othercolleague_GEN3/        # příklad: prostor nasdílený jiným Kolegou
```

Osobní moduly drží stejný kontrakt jako workspace moduly Organizací —
promotion do firemního workspace je přesun repa + úprava manifestů, vždy
přes fail-closed isolation gate (žádné secrets, osobní overlaye ani gbrain
reference). Gbrain je root vrstva prostoru (analogie `mission-control/`
v rootu Organizace), ne modul; v1 lidské rozhraní je Obsidian (deep link),
agenti pracují výhradně přes gbrain MCP server. Implementaci drží plán
CAC-0048.

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

Root/Buddy/operator secrets, které nepatří do žádné GitHub Organizace, mají
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
Detailní pravidla jsou v `manual/security/local-secret-custody.md`
(aktualizace cesty na owner-scoped tvar je součást CAC-0048).
