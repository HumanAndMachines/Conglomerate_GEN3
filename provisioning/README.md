# Lazurio Resident operator plane

`provisioning/` je source-only operator plane pro přípravu a obnovu Resident
Mašin. Není součástí non-Git Lazurio Rootu a běžící Resident z něj neprovádí
vlastní autonomní správu hostu.

První lane je úmyslně malá:

- podporuje Buddy profil na Debian-family Linuxu;
- konverguje společné host identity, custody adresáře a minimální balíčky;
- na už připraveném Hermes/GBrain/Zulip hostu umí přes exact operator runtime
  spustit oficiální `buddy-rollout` nad exact resident artefaktem;
- neobsahuje inventory konkrétní kohorty, secrets ani provider credentials;
- nevydává dnešní stav za kompletní greenfield instalaci.

Z `Buddy_GEN2` zatím zůstávají položkově nepřenesené Hermes a GBrain
materializace, tailnet/firewall lane, backup/restore instalace a lidské
Principal gates. Dokud jejich veřejně bezpečné role a regrese nepřejdou,
greenfield host se připravuje podle kurátorovaného cohort postupu a tento
playbook se používá až na doloženém runtime baseline.

## Proč Ansible není updater

Ansible vlastní desired state Mašiny: balíčky, účty, adresáře, runtime
závislosti a service wiring. Resident updater vlastní jedinou aktivní Lazurio
verzi, integrity gate a rollback. Ansible updater pouze explicitně zavolá;
nekopíruje jeho algoritmus do YAML tasků.

Exact Hermes/GBrain piny se smějí odvozovat jen z Lazurio release kontraktu.
Inventory nebo role si nesmějí založit konkurenční verzi „pro tento host“.

## První Buddy/Linux průchod

1. Připrav z `inventory.example.yml` vlastní privátní inventory mimo tento
   public repozitář. Hodnoty secrets do inventory nepatří.
2. Vyplň absolutní controller cesty k exact `.tar` a `.tar.sha256`, absolutní
   cestu k Bunu na hostu a existující host custody cesty.
3. Ze source rootu nejdřív spusť check mode. Podshell vstoupí do Ansible
   adresáře, aby Ansible automaticky načetl jeho `ansible.cfg` a našel
   lokální role:

   ```sh
   (
     cd provisioning/ansible
     ansible-playbook -i /privatni/inventory.yml \
       playbooks/buddy-linux.yml --check --diff
   )
   ```

4. Přečti celý diff. Zejména ověř owner účet, runtime identity, Personalspace
   source, bridge EnvironmentFile, Hermes root a cílový artifact id.
5. Konvergenci spusť až jako vědomý assisted krok. Playbook selže před
   rolloutem, pokud požadovaný privátní nebo runtime vstup nejde přečíst.
6. Readback proveď podle `manual/update-installed-resident.md`.

Playbook nespouštěj proti žádnému živému hostu jen proto, že jeho syntax nebo
testy prošly. Live host vyžaduje samostatný exact rollout gate, before-state a
rollback cíl.

## Budoucí AI Kolega

AI Kolega později použije stejné role jen tam, kde je kontrakt skutečně
společný. Linux systemd, macOS launchd, firewall a package manager se nesmějí
sloučit do jednoho playbooku plného podmínek. Steward nebude třetí host
playbook: je to role overlay AI Kolegy a práva dál určuje provider.
