# Lazurio Resident operator plane

`provisioning/` je source-only operator plane pro přípravu a obnovu Resident
Mašin. Není součástí non-Git Lazurio Rootu a běžící Resident z něj neprovádí
vlastní autonomní správu hostu.

Buddy/Linux greenfield lane v1 je úmyslně malá:

- podporuje Buddy profil na Debian-family Linuxu;
- před první mutací vyžaduje content-free attestation už ověřeného provider
  recovery checkpointu a živý Tailscale access plane;
- konverguje společné host identity, custody adresáře, minimální balíčky a
  tailnet-only UFW hranici bez veřejného ingressu;
- materializuje exact Bun, uv, Hermes fork a GBrain fork z reviewovaných pinů;
- pro nový osobní GBrain používá upstreamem podporovaný lokální PGLite a přes
  Hermes upstream CLI registruje jeho stdio MCP;
- přes exact operator runtime spustí stávající `buddy-rollout` nad exact
  resident artefaktem;
- neobsahuje inventory konkrétního nasazení, secrets ani provider credentials;
- nevytváří vlastní updater, daemon, sandbox, ACL ani fleet control plane.

Zulip není instalovaný do Buddyho hostu tímto playbookem. Bridge long-polluje
privátní one-Principal realm odchozím spojením; membership, bot credential a
provider access jsou proto explicitní privátní prerequisites, ne důvod přidat
na host veřejný port nebo druhý orchestrátor. Stejně tak provider snapshot či
ekvivalentní recovery checkpoint vzniká přes existující provider mechanismus.
Playbook pouze odmítne první mutaci bez content-free dokladu, že checkpoint
existuje a restore cesta byla ověřena.

Playbook tím nezavádí vlastní dlouhodobý backup daemon. Aplikační encrypted
backup/restore je samostatná operator-owned capability; dokud pro konkrétní
nasazení není zvlášť ověřena, zůstává provider recovery checkpoint povinným
vstupem před každou změnou.

## Proč Ansible není updater

Ansible vlastní desired state Mašiny: balíčky, účty, adresáře, runtime
závislosti a service wiring. Resident updater vlastní jedinou aktivní Lazurio
verzi, integrity gate a rollback. Ansible updater pouze explicitně zavolá;
nekopíruje jeho algoritmus do YAML tasků.

Exact Hermes/GBrain piny se smějí odvozovat jen z Lazurio release kontraktu.
Inventory nebo role si nesmějí založit konkurenční verzi „pro tento host“.

## Privátní prerequisites

Mimo public repo připrav:

- privátní inventory;
- exact resident `.tar` a `.tar.sha256` z jednoho reviewed source HEADu;
- Tailscale node, který je už přihlášený do Principálova tailnetu;
- provider snapshot nebo ekvivalentní recovery checkpoint s úspěšně ověřenou
  restore cestou;
- existující Personalspace se složkou profilu, kterou deklaruje
  `BUDDY_PROFILE_DIR`;
- `/etc/buddy/hermes-gateway.env` a `/etc/buddy/buddy-bridge.env` s reálnými
  hodnotami a bez uložení secrets do inventory.

Hermes soubor musí zapnout jeho upstream loopback API přes
`API_SERVER_ENABLED=true` a držet neprázdný `API_SERVER_KEY`. Bridge soubor
musí mířit `AGENT_RUNTIME_URL` na privátní Hermes endpoint (výchozí upstream
tvar je `http://127.0.0.1:8642/v1/chat/completions`) a jeho
`AGENT_RUNTIME_KEY` musí být stejná hodnota jako `API_SERVER_KEY`. Playbook
porovná pouze přítomnost a shodu; secret hodnotu nevypisuje ani nekopíruje do
inventory. Hermes soubor navíc nese zvolený model/provider credential a bridge
soubor reálný `ZULIP_SITE`, `BUDDY_BOT_EMAIL`, `BUDDY_BOT_API_KEY`,
`BUDDY_PROFILE_DIR` a durable `BUDDY_BRIDGE_QUEUE_DIR`.

Content-free controller attestation může mít například tento tvar:

```json
{
  "schema_version": "lazurio.recovery-checkpoint.attestation.v1",
  "checkpoint_id": "provider-opaque-id",
  "created_at": "YYYY-MM-DDTHH:MM:SSZ",
  "restore_verified_at": "YYYY-MM-DDTHH:MM:SSZ",
  "scope": "whole-machine-before-change"
}
```

Preflight JSON skutečně parsuje a vyžaduje přesně těchto pět polí: exact v1
schema, neprázdné opaque `checkpoint_id`, UTC časy v chronologickém pořadí a
scope `whole-machine-before-change`. Neprázdný soubor s jiným obsahem nestačí;
extra pole se odmítají, aby se z attestation nestal druhý store host identity,
cest, credentials nebo privátních dat.

Není v něm hostname, jméno Principála, cesta k Personalspace, obsah, token ani
private key. Skutečný checkpoint a jeho custody zůstávají u providera a
Principála.

## Buddy/Linux greenfield průchod

1. Připrav z `inventory.example.yml` vlastní privátní inventory mimo tento
   public repozitář. Hodnoty secrets do inventory nepatří.
2. Vyplň absolutní controller cesty k exact `.tar`, `.tar.sha256` a recovery
   attestation. Bun na blank hostu materializuje role z exact toolchain pinu;
   explicitní `lazurio_bun_path` dál určuje, co použije service a updater.
3. Ze source rootu nejdřív spusť syntax check. Podshell vstoupí do Ansible
   adresáře, aby Ansible automaticky načetl jeho `ansible.cfg` a našel
   lokální role:

   ```sh
   (
     cd provisioning/ansible
     ansible-playbook -i /privatni/inventory.yml \
       playbooks/buddy-linux.yml --syntax-check
   )
   ```

4. Na už existujícím hostu můžeš navíc použít `--check --diff`; na blank hostu
   check mode z principu nemůže pozorovat binárky, účty a service, které ještě
   neexistují. Skutečný run proto drží read-only preflight jako první role a
   před jeho PASS neprovede žádnou host mutaci.
5. Konvergenci spusť až jako vědomý assisted krok. Zkontroluj owner účet,
   Personalspace, exact piny, privátní env soubory, recovery attestation,
   tailnet a cílový artifact id.
6. Po úspěšné konvergenci spusť stejný playbook znovu: musí být no-op nebo pouze
   transparentní readback. Potom ověř status podle
   `manual/update-installed-resident.md`.
7. Řízené selhání a rollback prováděj jen na disposable hostu nebo pod exact
   live-host oprávněním. Po rebootu musí být Hermes a bridge aktivní a Resident
   Doctor znovu `pass`.

Assisted migrace smí pro existující host explicitně nastavit
`lazurio_hermes_service_mode: existing` a `lazurio_gbrain_engine: existing`.
Tím se zachová už ověřená service a databázový backend; role dál kontroluje
exact checkouty a lifecycle. Greenfield výchozí hodnoty jsou `upstream` a
`pglite`.

Playbook nespouštěj proti žádnému živému hostu jen proto, že jeho syntax nebo
testy prošly. Live host vyžaduje samostatný exact rollout gate, before-state a
rollback cíl.

## Budoucí AI Kolega

AI Kolega později použije stejné role jen tam, kde je kontrakt skutečně
společný. Linux systemd, macOS launchd, firewall a package manager se nesmějí
sloučit do jednoho playbooku plného podmínek. Steward nebude třetí host
playbook: je to role overlay AI Kolegy a práva dál určuje provider.
