# Immutable Lazurio runtime a mutable working root

Launchpad a `lazurio update` mají jednu závaznou runtime hranici. Běžící kód
nesmí pocházet z Git checkoutu, který má update změnit.

## Dvě fyzicky oddělené cesty

- `LAZURIO_RUNTIME_ROOT` je read-only, non-Git obsah exact-digest Lazurio
  artefaktu. Hosted doporučená cesta je `/opt/lazurio-runtime`.
- `WORKSPACE_ROOT` je mutable pracovní Lazurio checkout. Hosted doporučená
  cesta je `/home/builder/Lazurio`; na běžné mašině je to lokální Lazurio Root.

Runtime verze se odvozuje z `lazurio.resident.json` a identity instalovaného
artefaktu. Stav working rootu se odvozuje samostatně z Gitu. Checkout HEAD se
nikdy nevydává za verzi běžícího Launchpadu.

## Exact artefakt

Z clean reviewovaného Lazurio source commitu se sestaví existujícím
deterministickým builderem:

```sh
bun distribution/build.mjs \
  --profile workspace \
  --target linux-x64 \
  --version <release-version> \
  --channel stable
```

Výstupem je `lazurio-resident-workspace-*.tar`, `.sha256` sidecar a rozbalený
artifact root. Manifest uvnitř nese exact source commit, target, profil
`workspace` a digest každého payload souboru. Build odmítne dirty source,
secrets, `.git`, worktrees, Personalspace, Organization data i `node_modules`.

Image/release pipeline před instalací ověří sidecar i manifest a zkopíruje
obsah artifact rootu do nové immutable vrstvy. Iotor může tuto vrstvu připnout
exact image digestem a namountovat ji read-only jako `/opt/lazurio-runtime`.
Runtime nemá self-update službu a nevytváří druhý kontejner ani druhou službu.

## Launchpad process interface

Supervisor ve stejném workspace kontejneru nastaví:

```sh
export LAZURIO_RUNTIME_ROOT=/opt/lazurio-runtime
export WORKSPACE_ROOT=/home/builder/Lazurio
exec bun "$LAZURIO_RUNTIME_ROOT/launchpad/src/server.mjs" \
  --root "$WORKSPACE_ROOT"
```

`--root` má přednost před `WORKSPACE_ROOT`. Server při startu ověří, že
`LAZURIO_RUNTIME_ROOT` přesně odpovídá cestě, ze které byl načten. Update před
první Git mutací ověří, že runtime neleží uvnitř working rootu. Překryv vrátí
`blocked/runtime_not_isolated`; detached working checkout se proto nesmí
odpinovat, dokud není tento runtime artefakt skutečně nasazený.

Lokální krátký příkaz `lazurio update` si pro jeden běh vytvoří úplný dočasný
bundle enginu mimo working root a po skončení jej odstraní. Dlouho běžící
Launchpad tuto výjimku nepoužívá: musí vždy běžet z instalovaného runtime.

## Update a rollout

Explicitní Launchpad `Synchronizovat`, `/api/update`, legacy pull adaptéry i
CLI volají stejný sekvenční engine. První render používá jen GET lokálního
snapshotu bez fetch/mutace. Runtime release a working checkout update jsou dvě
oddělené operace:

1. image/release pipeline instaluje nový immutable runtime artefakt;
2. `lazurio update` fast-forwarduje mutable Lazurio Root → Organization Rooty
   → Workspace Moduly;
3. Productionspace, Personalspace, worktrees a root-space repository-db
   zůstávají mimo obecný update engine.

Odstranění hosted checkout pinu je bezpečné až po nasazení a health ověření
immutable runtime vrstvy. Rollback runtime přepne image/artifact digest;
nevrací ani nemaže pracovní Git checkouty a jejich recovery stashe.
