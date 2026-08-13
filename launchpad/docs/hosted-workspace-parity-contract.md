# Hosted Workspace machine parity contract

Tento kontrakt je centrální acceptance vstup pro Iotor a další Hosted Team
Workspace lane. Nemění provider, Compose, DNS ani přístupy. Stejný verzovaný
runner pouze sbírá důkaz, že lokální a hosted profil používají tutéž
builder-visible filesystem/process topologii a Launchpad lifecycle.

## Cílová topologie

Jeden Team Workspace obsahuje právě jeden non-root pracovní kontejner se
společným userem, `$HOME`, filesystemem, PID a network namespace pro:

- T3 Code a Codex CLI;
- vždy dostupný Launchpad;
- `~/Lazurio`, Organization mounty a plan-owned worktrees;
- všechny povolené modulové aplikace jako child procesy Launchpadu.

Tenký init/supervisor smí obnovovat T3 a Launchpad. Nesmí obsahovat app id,
source selection, URL mapping ani reconcile logiku. Launchpad zůstává jediným
ownerem modulových procesů. Tailscale a autentizovaný HTTPS ingress jsou
infrastrukturní sidecary mimo pracovní kontejner.

## Runner

Runner žije v `launchpad/src/workspace-parity-runner.mjs` a z package rootu se
spouští stejným příkazem lokálně i hosted:

```bash
bun run parity:workspace -- \
  --profile hosted \
  --phase live \
  --organization IotorLazurio_GEN3 \
  --app-id <app-id> \
  --worktree-slug <t3-created-canonical-slug> \
  --expected-worktree-created-by <t3-creation-identity> \
  --launchpad-url http://127.0.0.1:4174 \
  --expected-origin https://<exact-team-origin>/ \
  --t3-pid <pid> \
  --codex-pid <pid> \
  --launchpad-pid <pid>
```

Lokální běh použije `--profile local` a nevyžaduje PID namespace evidence ani
external origin. Oba profily musí používat builder-visible `~/Lazurio`; jiný
root je fail, ne runner override.

Runner `live` ověří:

1. `$HOME`, non-root hosted UID, Organization mount a toolchain;
2. discovery, Doctor a `lazurio.module.v1`/`lazurio.runtime.v1` static lease;
3. že worktree je okamžitě viditelný přes Launchpad, má Mission Control
   ownership a jeho uložené `created_by` přesně odpovídá identitě z T3 creation
   receipt předané přes `--expected-worktree-created-by`;
4. `Open main → worktree → main → worktree` na stále stejném module portu;
5. local loopback nebo hosted exact HTTPS katalogový origin;
6. lokálně pozorovatelnou negativní security matrix.

Výchozí `live` běh nechá jako desired source worktree. `--stop-after` použij až
po dokončení continuity evidence.

## Restart a reboot sekvence

1. Ulož JSON evidence z `--phase live`.
2. Restartuj celý pracovní kontejner. T3 i Launchpad mohou být krátce
   nedostupné; init obnoví oba procesy.
3. Spusť stejný runner s `--phase post-restart`. Musí najít zdravou managed
   worktree instanci a exact active desired source bez volání `/open`.
4. Proveď host reboot a po návratu zopakuj `post-restart` beze změny argumentů.
5. Teprve potom spusť `post-restart --stop-after`; JSON evidence musí obsahovat
   check `runtime.explicit_stop` včetně skutečné Stop response s
   `desired.enabled=false`, `desired.status=disabled` a unmanaged runtime.
6. Restartuj pracovní kontejner ještě jednou a spusť `--phase expect-disabled`
   se stejnými argumenty bez `--stop-after`. Check `runtime.no_resurrection`
   musí potvrdit exact worktree desired source, `enabled=false`, `disabled` a
   `managed=false` současně se `status=stopped`, `owner=none`, nedosažitelným
   health probe, žádným aktuálním port ownerem a nezávisle odmítnutým raw TCP
   spojením na deklarovaný module listener přes deklarovaný host i aliasy
   `127.0.0.1` a `::1`; tato fáze nesmí volat `/open` ani tiše přepnout na main.

Chybějící, invalidní nebo již nevlastněný worktree je `degraded`. Jakýkoli
fallback na main je failure.

## Negative security matrix

Runner uvnitř pracovního kontejneru vyžaduje:

- žádný Docker socket ani Tailscale LocalAPI socket;
- žádný Caddy admin socket nebo dosažitelný loopback admin port;
- žádný GitHub App private key path ani odpovídající env name;
- žádný `/host`/`/mnt/host`, passwordless sudo ani efektivní Linux capability;
- shodný UID, HOME, PID namespace a network namespace T3, Codexu, Launchpadu,
  runneru a konkrétního managed modulového child PID vráceného po Open/health.
  V `expect-disabled` je naopak absence module child procesu součástí důkazu.

Následující důkazy vznikají výhradně v Iotor infra lane zvenku a runner je ve
výstupu uvádí v `external_assertions_required`:

- autentizovaný Team HTTPS/WSS ingress na 443;
- interní module port není přímo dosažitelný přes Tailnet/VPN;
- jiný Team Workspace nevidí filesystem, procesy ani ingress;
- server-side broker odmítá repo mimo vygenerovaný Team allowlist;
- host reboot skutečně předcházel post-restart evidence.

## Katalog a URL binding

Hosted proces musí mít `LAZURIO_WORKSPACE_PROFILE=hosted`, exact
`LAZURIO_TEAM_ID` a generovaný `LAZURIO_TEAM_SERVICE_CATALOG_JSON` podle
`lazurio.team_service_catalog.v1`. Katalogový `team_id`, `app_id` a
`module_lease_key` se porovnávají s Workspace/discovery. Clean HTTPS loopback
je stejně neplatný jako HTTP, credentials, cesta, query nebo fragment.
V1 external origin používá lowercase ASCII DNS jméno nebo kanonickou IPv4 adresu (včetně
schváleného CGNAT) a volitelný platný TCP port; alternativní číselné IPv4
zápisy, IPv6 literal a port mimo `1..65535` failují stejně ve schématu i parseru.

`LAUNCHPAD_HOSTED_APP_URLS_JSON` je pouze dočasný injected seam pro stacked
infra migraci. Pokud je současně přítomný canonical katalog, Launchpad odmítne
start. Full hosted lane jej nesmí vydávat za source of truth.

## Handoff pro Iotor infra lane

Infra lane připne exact centrální commit, nastaví Team/profile/catalog vstupy,
spustí výše uvedené fáze a přiloží jejich JSON spolu s vnějšími síťovými a
broker důkazy ke gate `workspace_machine_parity_live_apply`. Teprve úplný green
evidence set dovoluje změnit gate z `false`; tento centrální PR sám žádný live
apply neautorizuje.
