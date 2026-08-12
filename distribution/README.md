# Lazurio resident distributions

Tato vrstva skládá celý non-Git Lazurio Root z exact commitu společného source.
Sdílený produkt zůstává v běžných adresářích rootu; nevzniká paralelní
`common/` strom. Pod `distribution/` žijí pouze build kontrakt, profilové
fragmenty, dependency piny, evaly a runtime lifecycle soubory.

Kurátorovaný přechod ze starších produktových repozitářů drží
`migrations/`. Inventář zapisuje exact source commit a disposition každé
skupiny; není to svolení ke kopii privátního repozitáře ani vstup buildu.

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

## Assisted install, update a rollback

Updater v1 je explicitní operátorský příkaz, ne daemon. Před prvním během se
spouští z exact reviewovaného source/release operator kitu; po instalaci je
stejný updater součástí immutable rootu pod `resident/`. Buddyho mašina proto
nepotřebuje Git checkout Lazuria.

```sh
bun distribution/runtime/updater.mjs install \
  --archive /staging/lazurio-resident-buddy-<version>-linux-x64.tar \
  --checksum /staging/lazurio-resident-buddy-<version>-linux-x64.tar.sha256 \
  --install-root /opt/lazurio --profile buddy --channel candidate

bun /opt/lazurio/active/resident/updater.mjs status \
  --install-root /opt/lazurio --profile buddy

bun /opt/lazurio/active/resident/updater.mjs rollback \
  --install-root /opt/lazurio --profile buddy
```

Lifecycle layout je záměrně malý:

```text
/opt/lazurio/
├── active -> versions/<artifact-id>
├── versions/<artifact-id>/       # immutable, non-Git Lazurio Root
└── state/
    ├── lifecycle.v1.json         # content-free active/LKG metadata
    ├── organizations/            # persistent mutable mount
    └── personalspace/            # persistent mutable mount
```

Updater nejdřív ověří externí SHA-256, bezpečně parsuje pouze regular-file a
directory USTAR entries, kontroluje manifest, profil, platformu, build a
rollback kompatibilitu a exact payload hashe. Kandidát se rozbalí do nové
staging cesty, dostane odkazy na existující mutable mounty a projde Resident
Doctorem. Teprve potom atomický relativní symlink přepne `active`. Selže-li
post-switch gate, původní pointer se obnoví; verzované rooty se automaticky
nemažou.

V1 používá POSIX atomic-symlink adapter pro Linux a macOS. Windows Kolegové
zůstávají na stávajícím Git checkoutu a Windows resident lifecycle se
nezapne, dokud nebude mít vlastní atomický pointer adapter a failure testy.

## Stav první fáze

Build contract v1 vydává pouze profil `buddy`. Schema, builder, integrity
engine a updater jsou profilově neutrální, ale runtime profil `ai-colleague`
ani Steward overlay se nepublikují před úspěšným Buddy cohort gatem. Build ani
updater sám neopravňuje přístup na živý host, Release nebo production cutover.
