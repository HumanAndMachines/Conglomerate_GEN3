# Acceptance checklist — manuální Lumbio shadow pilot

Tento checklist se vyplňuje až po samostatném exact run approval. Samotný soubor není povolení ke spuštění.

## A. Approval a identita

- [ ] Contract ID a verze přesně odpovídají schválení.
- [ ] Approval ID a run ID jsou unikátní; approval je aktuálně platný a okno nepřesahuje 24 hodin.
- [ ] Pack baseline commit, skutečný execution commit, SHA-256 pilotního kontraktu a execution bundle SHA-256 celého packu přesně odpovídají schválení.
- [ ] Object ID, label, Organization `lumbio`, legal entity, scope a odpovědná osoba jsou vyplněné a shodné v approval i manifestu.
- [ ] Snapshot root, manifest path, manifest SHA-256, cutoff a output path jsou přesně schválené.
- [ ] Retence je výslovně potvrzená.
- [ ] Consumption receipt cesta je přesně schválená a receipt před startem neexistuje.

## B. Snapshot preflight

- [ ] Manifest validuje proti schématu.
- [ ] Manifest má 1–40 souborů a nejvýše 50 MiB.
- [ ] Všechny soubory jsou regular files, bez symlinků.
- [ ] Žádná cesta není absolutní ani neobsahuje traversal `..`.
- [ ] Sedí SHA-256, velikost a total bytes.
- [ ] Hashe byly znovu ověřeny bezprostředně před prvním čtením a po terminálním stavu; snapshot se nezměnil.
- [ ] Source refs odpovídají schválenému object ID.
- [ ] Organization/scope/legal entity/object ID jsou konzistentní ve všech položkách.
- [ ] Je pokrytých všech šest evidence classes, nebo je run předem `BLOCKED`.
- [ ] Secrets scan je bez nálezů.
- [ ] Raw Personalspace a jiné Organizace: 0 záznamů.

## C. Runtime izolace

- [ ] Jeden Worker Agent.
- [ ] Jeden run; žádný schedule.
- [ ] Network a live connectors vypnuté.
- [ ] Callable tools: prázdné.
- [ ] Writes, GBrain write a external actions vypnuté.
- [ ] Jediné lokální zápisy jsou private output, metadata-only audit a atomický one-shot receipt ve schválených cestách.
- [ ] Výstupní adresář je nový, prázdný, lokální a mimo GBrain/snapshot.
- [ ] Limity: 5 decisions, 500 source records, 900 s, 2 USD, jedna repair iterace.

## D. Výstupní validace

- [ ] JSON validuje proti report schématu.
- [ ] Terminální stav je explicitní.
- [ ] Každé substantivní tvrzení má klasifikaci, source refs, observed time a confidence.
- [ ] Decision cards: 1–5 pro výsledek `ACCEPT`.
- [ ] Každý `known_gap` ze schváleného manifestu je přesně uveden v `source_gaps`.
- [ ] Missing/stale required evidence nevytvořilo green.
- [ ] Měny jsou oddělené bez schváleného FX.
- [ ] Net/DPH/gross jsou oddělené.
- [ ] Economic lineage nevytvořila double count.
- [ ] Tool calls: 0.
- [ ] External actions: 0.
- [ ] Unauthorized mutations: 0.

## E. Lidské review

- [ ] Review validuje proti human-review schématu.
- [ ] Kritické missed red flags: 0.
- [ ] False critical red flags: 0.
- [ ] Actionable decision cards ≥ 80 % a existuje alespoň jedna card.
- [ ] Outcome je `ACCEPT`, `REJECT` nebo `REQUIRES_CHANGES`.
- [ ] Pouze `ACCEPT` může otevřít návrh další samostatné brány.

## F. Úklid a uzavření

- [ ] Raw snapshot odstraněn do 24 h od terminálního stavu.
- [ ] Draft má deletion deadline nejvýše 7 dní po review.
- [ ] Audit neobsahuje raw source bodies.
- [ ] Cleanup proof je ověřený.
- [ ] Nevznikl schedule, connector, GBrain zápis, push ani externí akce.
