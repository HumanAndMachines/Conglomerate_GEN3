# Manuální Lumbio shadow pilot — provozní kontrakt v0.1

**Contract ID:** `PILOT-LUMBIO-SHADOW-0.2-R1`
**Stav:** návrh pouze k revizi; není spustitelný
**Pack baseline:** `michael-ceo-double-v0-2-r1` / commit `1b7d60590fe5e6d83f63032fd64fb647a2191296`

## Co tato brána řeší

Připravuje přesný obal pro jeden budoucí manuální shadow run nad jedním Lumbio objektem. Nezapíná runtime, konektor, účet, schedule, GBrain zápis ani externí akci.

Starší architektura doporučila jako kandidáta `EPC Hodonín`. Kandidát není schválený objekt. Před případným během musí Michael schválit stabilní interní object ID, právnickou osobu, odpovědnou osobu a konkrétní manifest ručně připravených snapshotů.

## Účel pilotu

Ověřit, zda jeden Worker Agent vytvoří z předem vybraných, neměnných a zdrojově doložených Lumbio snapshotů užitečný soukromý CEO draft, aniž cokoli změní nebo načte živě.

Pilot nemá dokazovat provozní spolehlivost runtime ani úplnost Lumbio dat. Jeden úspěšný run neopravňuje ke schedule, druhému runu, dalšímu objektu ani live přístupu.

## Přesný rozsah

- jedna Organizace: `lumbio`;
- jeden scope: `lumbio`;
- jedna přesně schválená právnická osoba;
- jeden přesně schválený obchodní/projektový objekt;
- jeden snapshot manifest s neměnným SHA-256;
- jeden manuální run;
- jeden lokální neveřejný JSON draft;
- jeden lidský review záznam;
- maximálně pět decision cards.

## Vstupy

Operátor před během vytvoří izolovaný lokální snapshot adresář a manifest podle `pilot/schemas/shadow-input-manifest.schema.json`. Každý soubor:

1. patří pouze schválenému objektu a Lumbiu;
2. má relativní cestu bez `..`, bez absolutní cesty a bez symlinku;
3. má SHA-256, velikost, formát, klasifikaci, `source_ref`, `observed_at` a lineage;
4. zůstává neměnným originálem; konverze je samostatný odvozený artefakt;
5. neobsahuje credentials, secrets ani raw Personalspace/jinou Organizaci.

Minimální evidence:

- identita objektu;
- schválený scope, právnická osoba a odpovědná osoba;
- aktuální provozní stav;
- schválený milestone baseline;
- acceptance evidence nebo explicitní gap;
- vazba na finanční evidenci objektu, nebo explicitní finance gap.

Bez schváleného ABRA exportu a reconciliation evidence se finanční stav nesmí tvářit jako úplný. ClickUp je provozní evidence, nikoli finanční autorita. Banka zůstává mimo pilot.

## Preflight před budoucím během

Run se nesmí zahájit, pokud chybí jediný bod:

- exact run approval se všemi poli uvedenými v machine-readable kontraktu;
- approval má unikátní `approval_id` a `run_id`, platí nejvýše 24 hodin a v okamžiku startu není expirovaný;
- `HEAD` odpovídá schválenému execution commitu, který obsahuje tento kontrakt;
- baseline pack commit, SHA-256 pilotního kontraktu a execution bundle SHA-256 celého packu odpovídají exact approval;
- object ID, scope a právnická osoba odpovídají manifestu;
- manifest hash odpovídá schválení;
- každý soubor existuje, je regular file, není symlink a sedí jeho hash i velikost;
- všechny source refs jsou `snapshot://lumbio/<object_id>/<artifact_id>`;
- nejsou detekovány secrets ani nepovolená boundary data;
- výstupní cesta je nový prázdný lokální adresář mimo GBrain a mimo zdrojový snapshot;
- consumption receipt cesta je přesně schválená, mimo snapshot/GBrain a zatím neexistuje;
- žádný callable tool, síť, konektor, schedule ani write capability není dostupná.

Preflight sám nezamyká filesystem. Budoucí jednorázový executor proto musí znovu ověřit všechny schválené hashe bezprostředně před prvním čtením a po terminálním stavu. Jakákoli změna snapshotu po preflightu zneplatní celý run; nesmí pokračovat z částečně přečtených dat.

Nesplnění znamená `BLOCKED` bez pokusu o modelový/runtime běh.

## Zpracování a fail-closed pravidla

- Jeden Worker Agent, maximálně jeden run.
- Chybějící údaj není nula a neověřený údaj není fakt.
- Neúplný nebo stale required source nemůže vytvořit zelený výsledek.
- Měny zůstávají oddělené bez schváleného FX zdroje.
- Net, DPH a gross zůstávají oddělené.
- Deal, objednávka, milestone, faktura a platba se nesmí dvojitě započítat.
- Každé substantivní tvrzení musí mít klasifikaci, source refs, observed time a confidence.
- Limit je 5 decision cards, 500 source records, 900 sekund a 2 USD.
- Povolena je nejvýše jedna bounded schema repair iterace.
- Překročení limitu končí `PARTIAL`; boundary, secret, hash nebo write incident končí `BLOCKED/FAILED`.

## Zakázané akce

Pilot nesmí:

- číst živě Gmail, ClickUp, HubSpot, Drive, ABRA, banku ani web;
- vytvářet či měnit účet, OAuth grant, token nebo connector;
- měnit CRM, ClickUp, Drive, účetnictví, banku nebo jiný systém;
- připravovat nebo posílat e-mail či zprávu;
- zapisovat do GBrainu nebo dlouhodobé paměti;
- plánovat další běh;
- pushovat, otevírat PR, mergovat, deployovat, releasovat nebo publikovat;
- automaticky pokračovat na druhý objekt nebo druhý manifest.

Jediné povolené lokální zápisy budoucího runu jsou: jeden private output, metadata-only audit a jeden consumption receipt v přesně schválených cestách. Consumption receipt musí budoucí executor vytvořit atomicky (`create-if-absent`) před prvním čtením snapshotu a zachovat 24 měsíců; jeho existence blokuje replay stejného `approval_id`/`run_id`. Implementace takového executoru není součástí Brány 3 a bez samostatného review nesmí být run spuštěn.

## Výstup a lidská kontrola

Výstup je jeden neveřejný lokální JSON validovaný proti `pilot/schemas/shadow-output.schema.json`. Lidské review se zapisuje podle `pilot/schemas/shadow-human-review.schema.json`.

`manifest_sha256` je SHA-256 UTF-8 kanonického JSON payloadu manifestu po odstranění pole `manifest_sha256`, s rekurzivně abecedně seřazenými object keys, zachovaným pořadím array prvků a bez whitespace. Tím se hash nevztahuje sám na sebe a je reprodukovatelný.

Každý output `source_ref` musí přesně existovat ve schváleném manifestu. `observed_at` tvrzení nebo decision card je nejnovější `observed_at` ze všech jeho referencovaných manifest položek; nesmí být modelem zvolený libovolně.

Úspěch vyžaduje:

- 100 % rozhodovacích tvrzení s evidence a observed time;
- 0 neautorizovaných mutací, tool calls a externích akcí;
- 0 cross-boundary záznamů;
- 0 kritických aritmetických chyb a double countů;
- 0 green závěrů ze missing/stale evidence;
- 0 kritických missed red flags a false critical red flags;
- jedna až pět decision cards, z nich alespoň 80 % označených člověkem jako actionable;
- každý `known_gap` ze schváleného manifestu přesně reprezentovaný v output `source_gaps`;
- lidský výsledek `ACCEPT`.

Jakýkoli boundary/write/action incident nebo kritická faktická chyba znamená `REJECT` a nový run je zakázán do opravy a nové approval brány.

## Retence a úklid

- Raw snapshot: odstranit nejpozději 24 hodin po terminálním stavu.
- Vygenerovaný draft: odstranit nejpozději 7 dní po lidském review.
- Audit metadata bez raw bodies: 24 měsíců podle návrhové retention policy.
- GBrain auto-promotion: zakázána.
- Úklid musí mít ověřený cleanup proof; bez něj pilot není uzavřený.

## Co může následovat

Po úspěšném jednom runu lze pouze vyhodnotit další samostatnou bránu. Nejméně deset po sobě jdoucích shadow runů z původní architektury není tímto kontraktem schváleno. Schedule a write capabilities zůstávají samostatné projekty s novým threat modelem a exact approval.
