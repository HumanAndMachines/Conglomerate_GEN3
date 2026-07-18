# Vytvoření vlastního Personalspace GEN3

Personalspace je integrální privátní vrstva Conglomerate GEN3. Conglomerate je
veřejný direct-pull framework a není GitHub template; pro osobní repo je
připravený `HumanAndMachines/PersonalspaceTemplate_GEN3`. Dokud jeho
public-readiness audit drží visibility `private`, root příkaz fail-closed nic
nevytvoří. Public použití začíná až explicitním publication gatem.

Výstupem jsou dva samostatné private repozitáře na osobním GitHub účtu:

```text
<login>/<login>_GEN3
<login>/<login>-gbrain
```

První je katalog a privacy kontrakt Personalspace, druhý drží pouze soukromou
Markdown paměť. Software se instaluje z veřejného `garrytan/gbrain`.

Schválený target-state pro pozdější Buddy onboarding přidává třetí private
repo:

```text
<login>/<login>-buddy
```

Je to secret-free Hermes Profile Distribution, nikoli runtime backup nebo
fork Hermes softwaru. Tato akční varianta je ale **PENDING `CAC-0072`** a
současný live příkaz ji nevytváří.

## Self-service

V kořeni Conglomerate spusť read-only preflight:

```text
gh auth status
bun run personalspace:create -- --display-name "<jméno>"
```

Preflight musí potvrdit `visibility=public` a `isTemplate=true`. Dnešní
nepublikovaný template proto očekávaně skončí chybou před jakýmkoli zápisem.

Po kontrole proveď vytvoření a instalaci:

```text
bun run personalspace:create -- --display-name "<jméno>" --apply --install-gbrain
```

Stejný příkaz funguje v macOS/Linux shellu i Windows PowerShellu; implementace
nepoužívá shell interpolation ani platformní path separátory.

Bootstrap živě ověří:

- přihlášený GitHub login;
- public + template stav upstreamu;
- private visibility owner a gbrain repa;
- přesný remote a mount `personalspace/<login>_GEN3`;
- rootový i lokální `.gitignore`;
- nepřítomnost `.gitmodules` a gitlinků;
- manifest bez povinného Buddyho;
- oddělení veřejného gbrain software od private Markdown dat;
- že nepublikovaný `--with-buddy` adapter je odmítnut jako neznámý argument.

`--install-gbrain` instaluje pouze CLI. Gbrain inicializace, API/embedding
provider a search režim mají privacy i nákladový dopad, proto zůstávají
vědomým rozhodnutím vlastníka. Navazující přesný postup je v
`personalspace/<login>_GEN3/manual/bootstrap-personalspace.md` a aktuálním
upstream
[`INSTALL_FOR_AGENTS.md`](https://github.com/garrytan/gbrain/blob/master/INSTALL_FOR_AGENTS.md).

Pro Personalspace bez Buddyho může být tato lokální aktivace záměrná. Buddy
varianta dnes není live: parser odmítá už samotný `--with-buddy`, nevytváří
třetí repo a negeneruje VPS handoff. Cílový `CAC-0072` kontrakt bude vyžadovat
`buddy.runtime.deployment_target: owner-dedicated-personalspace-vps` a
`buddy.runtime.local_execution: forbidden`; reálný cloud/DNS/access/provider
krok zůstane explicitním human-action gatem.

## Když owner repo už existuje

Root příkaz jej automaticky nebootstrapuje: kanonický název sám o sobě
nedokazuje původ repa a není oprávněním ke spuštění jeho kódu.

Nová instance musí mít marker `personalspace.template.json` s verzí
`humanandmachines.personalspace-template.v1`. Zkontroluj marker a bootstrap
skripty proti aktuálnímu template, spusť jeho `bun run check` a až potom
pokračuj uvnitř owner checkoutu podle jeho manuálu.

Repo bez markeru je legacy instance. Nematerializuj mu nové hodnoty tichým
defaultem; použij
[`manual/migrate-personalspace-custody-v1.md`](migrate-personalspace-custody-v1.md).

## Publikace

Bootstrap záměrně necommitne ani nepushne lokální konfiguraci za vlastníka.
Po kontrole následuj kroky vypsané v terminálu. Personalspace super-repo,
gbrain data repo a případný Buddy profile repo publikuj samostatně; každý má
vlastní historii a access.

## Ověření a recovery

Uvnitř owner checkoutu:

```text
bun run doctor
```

V rootu:

```text
bun run doctor
```

U Personalspace bez Buddyho po owner-gated lokální aktivaci gbrainu ověř také:

```text
gbrain doctor --json
```

`Personalspace Doctor PASS` používá přihlášené `gh` a živě ověřuje skutečnou
GitHub visibility owner, gbrain a volitelného Buddy repa. Nestačí deklarace
`private` v manifestu: public, internal, nedostupné nebo neověřitelné repo je
hard failure. Samotná dostupnost gbrain CLI ještě neznamená aktivovaný brain.

U Buddy-enabled Personalspace proveď `gbrain doctor`, Hermes config/Doctor,
MCP a gateway smoke výhradně na dedikované VPS podle
`personalspace/<login>_GEN3/manual/host-personalspace-with-buddy.md`.

Pokud gate selže, neopravuj ho přidáním submodulu ani zveřejněním repa. Oprav
remote/visibility/mount podle diagnostiky nebo smaž pouze necommitnutý lokální
checkout a zopakuj clone. Pokud vzdálené owner repo vzniklo, ale bootstrap se
nedokončil, další rootový apply se bezpečně zastaví; použij kontrolovaný resume
postup výše. GitHub private repo nemaž jako recovery krok bez výslovného
rozhodnutí vlastníka.
