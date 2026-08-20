# Doctory se skládají — společný surface a root-side lane

Status: **aktivní mechanismus v tomhle repu.** Root doctor podřízené doctory
najde, spustí a agreguje. Zdroj pravidla: decision **0118** v lokálním
`manual/decision-register.md` (founder ruling 2026-07-29), navazuje na 0018
(doctor per Organizace) a 0031 (org mounty jsou Doctor-managed vnořená repa).

## Pravidlo

Doctor není jeden program. **Root doctor** v kořeni Lazurio nese
*standardizované* kontroly, které platí pro každý checkout. Každé namountované
repo — Organizace, Personalspace — si nese **vlastní nezávislý doctor**, který
root najde a zavolá.

Důvod je vlastnický, ne technický: **pull sdíleného rootu nesmí rozbít
Organizaci, která má vlastní konfiguraci.** Kdyby standardizovaný kořen nesl i
kontroly konkrétní Organizace, každý upstream pull by je přepsal — a Organizace
by musela buď nepullovat, nebo o svoje kontroly přijít.

Z toho plyne druhá půlka pravidla: **podřízený doctor musí být plnohodnotný
samostatný program.** Nesmí předpokládat kořen nad sebou. Na Buddy VPS je
personalspace doctor *tím* doctorem, který běží; root tam neexistuje a nikdy
existovat nebude.

## Kontrakt

Surface je `launchpad/schemas/doctor-report.schema.json` (verze **v3**; v1 a v2
zůstávají čitelné). Jeho veřejnou autoritou je tento Lazurio source spolu s
`launchpad/src/doctor-surface-lib.mjs` a `launchpad/src/json-schema-mini.mjs`.
Změna vzniká přímo tady reviewovaným PR. Historický název
`launchpad/schemas/doctor-surface-vendor.json` dnes drží immutable adoption
baseline a otisky těchto tří souborů; není pointerem na jiný checkout. Co
potřebuje pouze root navíc, patří do `doctor-children-lib.mjs`, ne do sdíleného
surfacu.

### Slovník stavů

| status | význam | povinná pole |
| --- | --- | --- |
| `ok` / `warn` / `fail` | beze změny | — |
| `not_applicable` | strukturálně mimo scope tohohle doctora | `not_applicable_reason` (`owned_by_root` / `no_such_mount` / `not_declared`), `owner` |
| `blocked` | **mělo** to běžet, nešlo to pozorovat | `blocked_reason`, `remedy` |

`not_applicable` je **fakt** a zelenou nekazí. `blocked` je **nepozorování** a
kazí ji vždy. Souhrn se odvozuje jedinou funkcí: `fail>0 → fail; jinak blocked>0
→ incomplete; jinak warn>0 → warn; jinak ok`. Stav **`incomplete` nikdy nesplní
bránu**. Historické `skip` se čte jako `blocked` — tedy fail-closed směrem.

### Discovery: deklarací v manifestu

Root najde podřízené doctory podle bloku `doctor` v `company.gen3.json` /
`personal.gen3.json`. Konvenční cesta (`scripts/doctor.mjs`) by byla hádání:
nefungovala by pro mount, který není Node projekt, a z chybějícího doctora by
udělala ticho místo vady.

```json
{
  "doctor": {
    "schema_version": "humanandmachines.doctor.declaration.v1",
    "command": ["bun", "scripts/doctor.mjs", "--json"],
    "cwd": ".",
    "timeout_ms": 60000,
    "scope_type": "organization"
  }
}
```

`scope_type` se **asertuje** proti reportu dítěte (nesoulad = `scope_mismatch`),
nikdy se podle něj nic nevybírá (decision 0113). `cwd` nesmí vylézt z mountu —
kontroluje se na rozložené cestě, ne řetězcově.

### Invokační kontrakt

Podřízený doctor je proces: dostane argv a pracovní adresář, vrací **v3 report
na stdout** a exit kód `0` = ok|warn · `1` = fail · `2` = incomplete · `3` =
report vůbec nevznikl. Rozlišení `2` od `1` je to, co rodiči dovolí odlišit
„dítě řeklo ne" od „dítě neumělo říct".

Root doctor tenhle kontrakt sám dodržuje: `bun run doctor:json` píše na stdout
jen JSON a vrací exit kód podle vlastního souhrnu. Používá `process.exitCode`
místo `process.exit()` schválně — useknutý stdout by rodič klasifikoval jako
`unparseable`.

### Root nikdy nevěří tomu, co dítě řeklo o sobě

Agregát se počítá z **vnořených reportů** v bloku `children[]`, ne z převzatého
souhrnu dítěte. Každý záznam nese `outcome` (`report` / `no_report` /
`unparseable` / `schema_invalid` / `timeout` / `spawn_failed` /
`scope_mismatch`), spuštěné argv, mount a konec stderru. Nevalidovaný payload se
ukládá jako **text** do `stdout_tail`, nikdy jako `report` — jinak by se jeho
kontroly započítaly do agregace a přesně tím by se z rozbitého potomka stala
tichá zelená.

## Konkrétní scénář

Organizace si do `company.gen3.json` napíše vlastní doctor, který hlídá její
datový repozitář. Za měsíc někdo skript přejmenuje a deklaraci zapomene.

Bez téhle lane by `bun run doctor` v rootu doběhl **zeleně** — root o té kontrole
nikdy nevěděl, takže by nemohl ani zmlknout. S ní vznikne v reportu
`doctor.child.0` se stavem `fail`, přesné argv, kterým to root zkusil, a konec
stderru dítěte. Souhrn rootu skončí `fail` a `bun run doctor` vrátí exit 1.

Druhý scénář, opačný: na mašině, kde žádný mount vlastního doctora nedeklaruje,
je `doctor.children` **`not_applicable`** s důvodem `not_declared` a vlastníkem
„namountovaná repa". Zelenou to nekazí — je to fakt o téhle topologii, ne
kontrola, kterou se nepodařilo změřit. Kdyby se ale lane vypnula
(`--skip-children`), stejná kontrola je `blocked`, souhrn `incomplete` a exit 2:
nespuštěný doctor není zelený doctor.

## Kde to je

| Soubor | Co drží |
| --- | --- |
| `launchpad/schemas/doctor-report.schema.json` | kanonický veřejný surface v3 |
| `launchpad/src/doctor-surface-lib.mjs` | kanonický slovník stavů, odvození souhrnu, exit kódy, validace, invokace a agregace |
| `launchpad/src/json-schema-mini.mjs` | lokální draft-07 subset validátor surfacu |
| `launchpad/src/doctor-children-lib.mjs` | root-side lane: discovery deklarací, spuštění, **svázání identity dítěte s mountem**, kontrola `doctor.children` |
| `launchpad/src/doctor-children-lib.test.mjs` | root-side test: rozbitý potomek shodí agregát |
| `launchpad/src/doctor-surface-conformance.test.mjs` | konformní test producenta: root doctor je sám na surfacu |
| `launchpad/schemas/doctor-surface-vendor.json` | adoption baseline veřejného Lazuria: repo/ref/commit, otisky a **pojmenované** odchylky |
| `launchpad/src/doctor-surface-vendor.test.mjs` | integrity test: tichá editace souboru i nepřiznaná odchylka od baseline spadnou |

## Jak se váže identita dítěte

Root nikdy nevěří tomu, co dítě řeklo o sobě — ani o tom, ČÍ zdraví hlásí.
Očekávaný druh scope určuje **lane, ve které mount leží** (`organizations/` →
`organization`, `personalspace/` → `personalspace`), nikdy dítě a nikdy jeho
vlastní manifest: deklarace smí očekávaný typ potvrdit, ne přepsat. K tomu musí
report nést **rozložený `scope.absolute_path`**, který sedí na adresář, ve kterém
ho root spustil. Report bez něj se do agregace nepočítá.

Scénář, kvůli kterému to tak je: Organizace si do `company.gen3.json` napíše
deklaraci s jediným polem `command`. Její doctor je omylem spuštěný přes wrapper,
který reportuje jiný checkout — dokud se identita nevázala povinně, obě porovnání
se přeskočila, root přijal cizí report jako svůj a pod tímhle mountem hlásil
zdraví úplně jiné mašiny. Dnes je to `scope_mismatch`, vlastní `doctor.child.N`
s `fail` a exit 1.

Kde ta vazba **žije**, je vlastnická otázka, ne stylová. Povinné svázání dělá
`launchpad/src/doctor-children-lib.mjs` (`runBoundChildDoctor`), ne sdílený
surface. Surface povinně porovnává jen to, co dítě samo nabídlo — a pro
samostatně běžícího doctora je to správně, protože na Buddy VPS nad ním žádný
rodič není a nemá koho přesvědčovat. Root si tu povinnost přidává, protože dítě
spustil kvůli konkrétnímu mountu; kdyby si ji přidal uvnitř sdíleného surfacu,
byl by to fork kontraktu v konzumentovi.

Stejnou logikou se soudí konec běhu: dítě ukončené signálem (OOM killer,
`kill -9`) **nedoběhlo**, i kdyby na stdout stihlo vypsat konformní JSON. Má
vlastní outcome `signalled`, klasifikovaný ještě před parsováním payloadu; co
stihlo vypsat, se uchová jako důkaz v `stdout_tail`, nikdy jako `report`.

A obráceně, aby kontrakt nevystavoval falešné vady: očekávaný exit kód dítěte se
počítá z **celého plochého reportu včetně vnuků**. Dítě, které je samo rootem, má
vlastní kontroly `ok`, ale vnořený vnuk `blocked` — jeho agregát je `incomplete`
a správně končí dvojkou. Kdyby se očekávání počítalo jen z jeho vlastních checks,
rodič by mu za správné chování vystavil `doctor.child.N.exit_code` s `fail`.
Tenhle přepočet je taky root-side (`rebindChildExitExpectation`), ze stejného
důvodu: surface o vnucích nic netvrdí, rodič ano.

## Co se nesmí tvrdit

- Že zelený `bun run doctor` znamená „všechny doctory prošly". Znamená „root
  doctor je konformní a všichni **deklarovaní** potomci odpověděli".
- Že `not_applicable` je měkčí `skip`. Je to opak: `skip` mlčel o tom, proč
  neběžel, `not_applicable` musí říct, kdo tu kontrolu vlastní — a druhá půlka
  starého `skip` (`blocked`) nově bránu **nesplní**.
- Že `incomplete` je „skoro zelená". Je to stav, ve kterém jsme nepozorovali, co
  jsme pozorovat měli.

## Známý dluh

Invokace potomka je `spawnSync`, takže v HTTP lane (`/api/doctor`) blokuje event
loop po dobu jeho běhu. Je to stejný tvar, jaký tahle lane už dnes používá pro
`git` a `gh repo view` s bounded timeoutem, a náklad je nulový, dokud žádný mount
doctora nedeklaruje. Až první deklarace vznikne, patří do serverové lane
asynchronní varianta invokace — **ne** kratší timeout, protože rozdílný limit
v CLI a v UI by znamenal dvě různé odpovědi o téže mašině.

**`doctor.self_conformance` a app id — dluh zůstává otevřený, i když dnes
neměří.** Původní znění tohohle odstavce tvrdilo, že `self_conformance` na dnešní
mašině hlásí `fail`, protože dvacet kontrol `launchpad.runtime.<app id>` má id
s velkými písmeny. **Změřeno 2026-07-30** proti reálnému Lazurio rootu
(10 mountů, 8 Organizací, 62 kontrol `launchpad.runtime.*`): žádné z vydaných
`checks[].id` dnes pattern `^[a-z0-9]+([._-][a-z0-9]+)*$` neporušuje a
`self_conformance` je `ok`. Nic se tím ale neopravilo a nic se tu neuvolnilo:

- pattern v surfacu je nezměněný proti uložené adoption baseline, takže
  první app id s velkým písmenem znamená znovu hlasitý `fail`;
- `bun run doctor` proti tomu rootu je i tak `fail`, ale ze dvou úplně jiných,
  **předchozích** důvodů (`launchpad.workspace_declarations` s 27 blokátory a
  `launchpad.personalspace`). Oba padají stejně na `main` bez téhle větve.

Rozhodnutí, které se tím neudělalo, drží dál: kdyby se app id s velkými písmeny
vrátila, root je přejmenovat nemůže — jsou z manifestů Organizací, které leží
v gitignorovaném mountu `organizations/` a patří jiným repům. Druhá cesta —
párovat blokátory v UI přes odvozený slug — znamená tutéž funkci na dvou místech
(`launchpad/src/diagnostics-lib.mjs` produkuje id, `launchpad/public/app.js` je
páruje) a `checks[].id` má `additionalProperties: false`, takže se app id nedá
poslat vedle jako pole. Dokud o tom nerozhodne vlastník, je správný stav hlasitá
vada, ne uvolněný pattern.

**Adoption baseline je bajt na bajt.** Veřejné Lazurio převzalo surface na
`main` jako tři přesně otisknuté soubory bez lokální odchylky:
`doctor-report.schema.json`, `doctor-surface-lib.mjs` a
`json-schema-mini.mjs`. Dvě root-only povinnosti — svázání identity dítěte s
mountem a přepočet exit kódu z celého reportu — nejsou kontrakt všech doctorů,
proto zůstávají v `doctor-children-lib.mjs`. Hlídá to
`doctor-surface-vendor.test.mjs`: otisky, nulové odchylky a kontrolní test,
který záznam schválně rozbije. Další změna sdíleného surfacu se autoruje přímo
v Lazuriu a v témže PR aktualizuje baseline receipt.

Co ten test **neumí** a co je napsané i v samotném záznamu: nechodí na síť.
Pozná drift proti záznamu, ne to, zda je navržená změna kompatibilní. Aktuálnost
a kompatibilitu drží review a CI stejného Lazurio PR; žádná další živá autorita
vedle tohoto repa neexistuje.
