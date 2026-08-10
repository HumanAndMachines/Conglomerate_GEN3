# Lazurio CLI v0

Interní CLI je read-only adapter nad kanonickým Launchpad rootem. Nevytváří
další identity, IAM ani vlastní search engine. `context` bezpečně promítá
Principála/Mašinu/Personalspace, `doctor` znovu používá existující Doctor core a
`search` přidává první explicitně omezený Organization pilot.

## Search kontrakt

```sh
# živé fixed-string hledání; výchozí režim
bun run lazurio -- search "český dotaz"
bun run lazurio -- search "český dotaz" --json --limit 20

# diagnostika exact lane, QMD runtime a čerstvosti indexu
bun run lazurio -- search --status
bun run lazurio -- search --status --json

# lokální QMD index; --embed doplní vektory pro semantic/hybrid
bun run lazurio -- search --update
bun run lazurio -- search --update --embed
bun run lazurio -- search "záměr produktu" --mode lexical
bun run lazurio -- search "záměr produktu" --mode semantic
bun run lazurio -- search "záměr produktu" --mode hybrid
```

Strojové výsledky mají schema marker `lazurio.search.results.v1`, diagnostika
`lazurio.search.status.v1` a QMD adapter `lazurio.qmd.adapter.v1`. Každý hit
obsahuje relativní cestu a provenance: Organization, Principála, Team, scope,
source, repository a stav provider access. Absolutní lokální cesty se ve
výstupu nepublikují.

Akce jsou záměrně flagy `--status` a `--update`, ne rezervovaná slova v pozici
dotazu. `lazurio search status` i `lazurio search update` proto vždy provedou
živé exact hledání těchto slov; diagnostiku nebo lokální index mutation nelze
spustit nechtěnou kolizí s běžným dotazem.

Exact lane spouští `rg` samostatně v každém povoleném source. Používá
`--no-ignore-parent`, aby parent `.gitignore` Launchpad rootu neschoval
deklarovaný nested repo, ale nepoužívá `--no-ignore` ani plošný scan rootu.
Proto vidí čerstvou, dosud neindexovanou změnu a současně respektuje ignore
pravidla samotného source repa. `rg` je proto explicitní runtime závislost
exact lane; když chybí, status vrátí `not_evaluated` a QMD update nezapíše
falešný freshness fingerprint.

## Pilotní scope a hranice

Verzovaný registr [search-scopes.v1.json](search-scopes.v1.json) deklaruje
pilot `lazurio` pro Organization `HumanAndMachine-ai`, Team `lazurio` a
Principála `immakermatty`. Jediné zdroje jsou:

- repo `workspace/website-lazurio`;
- repo `workspace/design-system-lazurio`;
- explicitní subtree `workspace/knowledgebase/data/v2/lazurio-ai` uvnitř repo
  `workspace/knowledgebase`.

Každý source musí existovat v `modules.manifest.json`, patřit do Teamu
`lazurio`, být materializovaný Git repo nebo jeho explicitní subtree a projít
Launchpad containment kontrolami. Samotný název adresáře nic neautorizuje.

Personalspace, jiné Organizace, Organization templates, worktrees, `.git`,
`node_modules`, build/output/cache adresáře, `private/`, `secrets`, `.env`,
binární typy a symlinkované stromy se do pilotu nedostanou. Exact `rg` symlinky
nenásleduje. QMD standardně skenuje s `followSymbolicLinks: false`; adapter
navíc fail-closed odmítne rozbitý symlink nebo target mimo deklarovaný source.
Bezpečný interní symlink přeskočí, takže nevytvoří duplicitu kanonického obsahu.

`provider_access_status: not_evaluated` je záměrně pravdivý: lokální manifest a
mount nejsou živý GitHub provider readback. Pilot tedy prokazuje lokální scope,
nikoli obecný effective workspace nebo provider oprávnění.

## QMD adapter

QMD drží pro každou dvojici Organization/Principál samostatný pojmenovaný
config, SQLite index a Lazurio freshness state pod gitignored
`.cache/lazurio/qmd/`. Adapter nastavuje vlastní `QMD_CONFIG_DIR` a
`XDG_CACHE_HOME`; globální uživatelský QMD index nečte ani nemění.

Podporovaný kontrakt je QMD `>=2.5.3` a `<3.0.0`. Ověřuje se `qmd --version` a
`qmd status`; chybějící CLI, nepodporovaná verze, runtime chyba i známý Node
native ABI mismatch mají strukturovaný stav. Exact lane zůstává dostupná.
`search --update` zapisuje fingerprint povolených textových souborů, podle nějž
`search --status` rozliší `fresh`, `stale`, `absent` a `not_evaluated`.

Kontrakt byl 2026-08-10 porovnán s oficiální dokumentací QMD pro pojmenované
indexy, `QMD_CONFIG_DIR`, `XDG_CACHE_HOME`, config collections/ignore a příkazy
`search`, `vsearch`, `query`, `status`, `update`, `embed` a `doctor`:
[README](https://github.com/tobi/qmd/blob/main/README.md),
[CHANGELOG](https://github.com/tobi/qmd/blob/main/CHANGELOG.md). npm dist-tag
`latest` byl 2.5.3. Standardní macOS oprava nepodporované nebo ABI-rozbité
globální instalace je:

```sh
brew install sqlite
npm install -g @tobilu/qmd@latest
qmd --version
qmd doctor
```

QMD vyžaduje Node.js 22 nebo novější. Lazurio adapter globální instalaci sám
nemění; pouze ji diagnostikuje a exact režim nechává dostupný.

Launchpad pole „Hledat aplikaci“ zůstává filtrem karet. Search UI ani obecný
cross-Organization search nejsou součástí tohoto slice.
