# Aktualizace už nainstalovaného Lazurio Residenta

Tento manuál řeší pouze Mašinu, na které už existuje zdravý Lazurio Resident
pod `/opt/lazurio`. Neinstaluje operační systém, uživatele, Hermes, GBrain,
Zulip, síť ani zálohovací custody. Tyto změny patří do reviewovaného operator
plane a mají jiný failure a recovery kontrakt.

Update je v první fázi vždy viditelný assisted krok. Není to background daemon,
fleet command ani automatická maintenance window.

## 1. Nejdřív zjisti stav

Z aktivního rootu spusť:

```sh
bun /opt/lazurio/active/resident/updater.mjs status \
  --install-root /opt/lazurio --profile buddy
```

Pokračuj pouze když výstup označí aktivní artefakt, profil `buddy` a health
`pass`. `fail`, nečitelný manifest, chybějící mount nebo lokální drift nejsou
důvodem vynutit update; jsou důvodem nejdřív určit, co se změnilo.

Do sdílené evidence zapisuj jen content-free fakta: artifact id, source commit,
čas, jméno checku a výsledek. Nezapisuj obsah Personalspace, konverzace,
credentials ani runtime logy se soukromým obsahem.

## 2. Lokální úprava je legitimní drift

Principál vlastní Mašinu a může aktivní root vědomě opravit. Doctor takovou
změnu zviditelní, ale nevydává ji za útok ani ji automaticky nevrací. Updater
ji nesmí potichu přepsat.

Před dalším update Principál nebo jeho operátor vědomě zvolí jednu možnost:

1. hotfix zatím zachovat a update odložit;
2. přenést opravu do odděleného Lazurio source checkoutu a vydat nový artefakt;
3. vrátit soubor na kanonickou release podobu a znovu spustit status.

## 3. Assisted update

Použij exact artefakt a jeho `.sha256` sidecar z jednoho reviewovaného release.
Produkční Buddy rollout spouštěj z exact operator kitu nebo přes reviewovaný
Ansible playbook. Samotný resident updater mění pouze verzovaný Lazurio Root;
`buddy-rollout` navíc skládá Hermes a bridge service gate do jedné kompenzované
operace.

Přímý servisní tvar je:

```sh
sudo bun /cesta/k/operator-kitu/runtime/buddy-rollout.mjs update \
  --archive /cesta/k/lazurio-resident-buddy-VERSION-linux-x64.tar \
  --checksum /cesta/k/lazurio-resident-buddy-VERSION-linux-x64.tar.sha256 \
  --install-root /opt/lazurio \
  --channel candidate \
  --mount-source personalspace=/existujici/personalspace \
  --environment-file /existujici/custody/buddy-bridge.env \
  --hermes-root /opt/buddy-runtime/hermes \
  --bun /absolutni/cesta/k/bun
```

Placeholdery nikdy nevyplňuj odhadem. Operator kit, Bun, Personalspace,
EnvironmentFile a Hermes checkout jsou vstupy konkrétní instalace; jejich
existenci a oprávnění musí preflight skutečně přečíst.

Úspěch znamená současně:

- digest, manifest, profil a kompatibilita prošly;
- nový root byl rozbalen vedle předchozího;
- Personalspace zůstal stejným mutable mountem;
- Resident Doctor prošel;
- Hermes health prošel;
- bridge se čerstvě zaregistroval;
- `active` ukazuje na očekávaný artifact id.

Samotný zelený příkaz, běžící systemd unit nebo existence nového adresáře není
postačující důkaz.

## 4. Rollback

Při selhání před přepnutím zůstává původní active verze beze změny. Selže-li
service gate po přepnutí, `buddy-rollout` se pokusí vrátit předchozí active root
i jeho service vstupy.

Explicitní návrat na last-known-good:

```sh
sudo bun /opt/lazurio/active/resident/updater.mjs rollback \
  --install-root /opt/lazurio --profile buddy
```

Potom znovu ověř status, Hermes health a čerstvou registraci bridge. Rollback
nikdy nemaže Personalspace, Organization checkouty ani starší verzované rooty.
Obnova secrets, dat nebo přístupů je jiná operace a vyžaduje přesný souhlas
Principála.

## 5. Kdy použít operator plane místo updateru

Vrať se k operator runbooku, když je problém v některé z těchto vrstev:

- chybějící nebo poškozený OS package, účet, filesystem či síť;
- změna pinu nebo materializace Hermesu či GBrainu;
- nefunkční systemd/launchd základ mimo resident service cutover;
- obnova celé Mašiny, custody souborů nebo zálohy;
- první instalace na blank host.

Updater není Ansible a Ansible není updater. Operator plane konverguje Mašinu;
updater atomicky spravuje jednu aktivní verzi Lazurio Rootu; Doctor pozoruje,
zda skutečnost odpovídá oběma kontraktům.
