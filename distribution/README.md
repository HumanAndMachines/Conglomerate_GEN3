# Lazurio resident distributions

Tato vrstva skládá celý non-Git Lazurio Root z exact commitu společného source.
Sdílený produkt zůstává v běžných adresářích rootu; nevzniká paralelní
`common/` strom. Pod `distribution/` žijí pouze build kontrakt, profilové
fragmenty, dependency piny, evaly a runtime lifecycle soubory.

Profilový fragment se záměrně jmenuje `root-instructions.md`, nikoli
`AGENTS.md`. V source checkoutu proto není aktivní instrukční scope. Builder z
něj vytvoří jediný root `AGENTS.md` až ve výsledném artefaktu.

## Build

Builder přijímá pouze čistý checkout a čte všechny vstupy jako Git blobs z
exact `HEAD`; ignored nebo necommitnutý obsah se do artefaktu nedostane.

```sh
bun run resident:build -- --profile buddy --target linux-x64 \
  --version 0.1.0-candidate.1 --channel candidate
```

Výstup pod `dist/resident/` obsahuje adresář, deterministický USTAR archiv a
jeho SHA-256 sidecar. Existující výstup se nikdy nepřepisuje. Pro stejné
source SHA, profil, target, verzi, channel a build contract vzniknou stejné
bytes.

Volitelné opakované `--forbid-term <text>` dovoluje rollout gate doplnit
jmenovité termy, které se nesmějí objevit v public artefaktu, aniž by je
ukládalo do source nebo manifestu.

## Hranice manifestu

`lazurio.resident.json` inventarizuje a hashuje každý immutable payload soubor.
Manifest sám není v cirkulárním file inventory; celý archiv včetně manifestu
kryje vnější `.tar.sha256` sidecar. Resident Doctor navíc odmítne chybějící,
změněný nebo neočekávaný immutable soubor, nesprávnou platformu, `.git`, jiný
profil a drift exact Hermes pinu.

`organizations/` a `personalspace/` nejsou payload. Installer je později
připojí jako explicitní perzistentní mutable mounty; Doctor jejich obsah
nečte ani nehashuje.

## Stav první fáze

Build contract v1 vydává pouze profil `buddy`. Schema a engine jsou
profilově neutrální, ale runtime profil `ai-colleague` ani Steward overlay se
nepublikují před úspěšným Buddy cohort gatem. Updater a atomický rollback jsou
navazující lifecycle řez; samotný build neopravňuje přístup na živý host ani
release.
