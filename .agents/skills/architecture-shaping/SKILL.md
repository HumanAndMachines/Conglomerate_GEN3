---
name: architecture-shaping
description: Povinný kritický architektonický průchod před každou tvorbou nebo změnou source kódu v Lazuriu. Převádí zadání Principála na nejmenší úplné řešení v souladu s kanonickými principy, s hloubkou úměrnou riziku; nepoužívej pro čistou business-data nebo copy změnu bez dopadu na code-owned kontrakt.
---

# Architecture shaping

## Kdy použít

Použij před každou tvorbou nebo změnou source kódu: executable kódu, buildu,
schématu, validátoru, automatizace, infrastruktury nebo code-owned runtime
kontraktu. Platí pro implementaci i návrh změny; hloubka práce roste s jejím
dosahem a trvanlivostí.

Zadání Principála určuje chtěný výsledek, priority a omezení. Není automaticky
hotovou architektonickou specifikací. Worker Agent odpovídá za to, že navržený
způsob provedení je v souladu s autoritami a principy Lazuria. Poslední slovo
Principála neznamená, že Agent potichu implementuje známý rozpor nebo rezignuje
na odborný úsudek.

Čistá business-data změna, běžná copy editace nebo mechanické použití již
rozhodnutého kontraktu hluboký shaping nepotřebuje. Pokud ale mění code-owned
chování, source of truth, hranici nebo dlouhodobý koncept, skill platí.

## Hodnoty Worker Agentů

- **Záměr před artefaktem.** Úspěchem je naplněný cíl, ne množství kódu,
  souborů, procesů nebo konfigurace.
- **Jednodušší celek před chytrým lokálním řešením.** Změna má snižovat
  dlouhodobou mentální, provozní a údržbovou zátěž celého systému.
- **Standard před vlastní mašinérií.** Nejdřív použij providerovou schopnost,
  existující kontrakt nebo běžnou best practice. Nový mechanismus potřebuje
  konkrétní prokázaný problém.
- **Mechanismus na skutečné hranici.** Co lze a má být technicky vynuceno,
  patří přirozenému ownerovi mechanismu. Uvnitř vědomé trust domény nevyráběj
  paralelní kontrolní systém pro hypotetickou nedůvěru.
- **Jedna pravda, jeden domov, jeden owner.** Nevytvářej druhý stav, ACL,
  lifecycle ani význam pojmu jen proto, že je lokálně pohodlný.
- **Důkaz před sebejistotou.** Ověř živý stav a rozliš fakt, inferenci a
  návrhový úsudek. Self-report není důkaz.
- **Transparentnost je součást kvality.** Další člověk nebo Agent musí
  pochopit motivaci, hranice, non-goals a důsledky bez rekonstrukce z diffu.
- **Principál má informované poslední slovo.** Agent nabídne čisté compliant
  varianty a poctivě popíše konflikt; nepřebírá business priority, přístupy
  ani Publikaci.

## Zvol hloubku

Použij rychlou cestu, pouze pokud změna současně:

- zachovává existující architekturu, ownership a source of truth;
- nepřidává trvalou abstrakci, závislost, stav, konfiguraci ani fallback;
- nemění access, security, data, lifecycle nebo cross-scope kontrakt;
- má malý blast radius a zřejmý rollback.

Rychlá cesta je krátká mentální kontrola, ne nový dokument. Ověř, že používáš
existující seam, nepřidáváš duplicitní koncept a relevantní test dokazuje
chtěné chování.

Proveď plný shaping, pokud se mění alespoň jedna dlouhodobá abstrakce,
persistentní stav, provider nebo externí závislost, source of truth, access či
trust hranice, template/distribuce, více scope nebo obtížně vratná migrace.

## Postup

1. **Ukotvi realitu.** Přečti relevantní decision records nebo jejich
   public-safe registr, cílovou `ARCHITECTURE.md`, aktuální schémata/config/kód
   a nejbližší `AGENTS.md`. Rozliš cílový model od právě nasazeného stavu.
2. **Odděl cíl od navrženého prostředku.** Jednou větou pojmenuj chtěný
   výsledek, chráněné invarianty a non-goals. Předpoklady zadání ověř; neber
   navrženou službu, flag, tabulku nebo workflow jako požadavek, pokud je jen
   jednou možnou implementací.
3. **Nejdřív ubírej a znovu používej.** Hledej existujícího přirozeného ownera
   schopnosti a standardní řešení. Výslovně zvaž, co lze smazat, sloučit,
   odvodit nebo ponechat procesnímu kontraktu místo nové vrstvy.
4. **Navrhni nejmenší úplný řez.** Každý nový dlouhodobý koncept musí mít
   konkrétní problém, kanonický domov, ownera, failure mode, ověření, rollout a
   vztah k tomu, co nahrazuje. Pokud to nelze vysvětlit jednoduše, návrh ještě
   není připravený.
5. **Oponuj bezpečně.** Když požadovaný prostředek odporuje vyšší autoritě nebo
   principům Lazuria, neimplementuj rozpor potichu. Ukaž konkrétní kolizi a
   doporuč nejbližší compliant cestu. Pokud má být změněn samotný princip,
   routuj ji k jeho kanonické autoritě; Agent jej nepřepisuje vedlejším diffem.
6. **Použij protiváhu úměrně riziku.** U důležité změny nech návrh nebo diff
   nezávisle zpochybnit dostupným člověkem, modelem či Agentem se zadáním hledat
   zbytečnou mašinérii, duplicitní pravdu a standardní jednodušší alternativu.
   Konkrétní reviewer, CLI, síť ani subagent nejsou závislost. Když nezávislá
   protiváha není dostupná, proveď solo inversion pass: zkus řešení s polovinou
   konceptů, bez nového mechanismu a s existujícím providerem jako defaultem;
   absenci nezávislého review pravdivě uveď, ale sama běžnou práci neblokuje.
7. **Implementuj a ověř celek.** Drž diff chirurgický, testuj chráněné
   chování a negativní cesty podle rizika a ověř exact výsledný HEAD. Review
   nález přijmi nebo odmítni podle důkazů, ne podle identity reviewera.
8. **Vysvětli rozhodnutí.** PR nebo handoff u podstatné změny stručně uvede
   problém, proč je řešení nejmenší úplné, co záměrně nepřibylo nebo bylo
   odstraněno, jaká protiváha proběhla a které skutečné riziko zůstává.
   Nevytvářej kvůli tomu nový ledger ani povinný report formát.

## Ověření

Před označením source změny za hotovou musí být odpověď přiměřeně jasná:

- Který cíl Principála změna skutečně naplňuje?
- Které autority a invarianty ji omezují?
- Proč nestačil menší zásah nebo existující standard?
- Přidává nový koncept, stav nebo ownera? Pokud ano, proč musí existovat?
- Co bylo odstraněno, sloučeno nebo záměrně nepřidáno?
- Jaké chování a failure mode dokazují testy nebo jiná živá evidence?
- Proběhla nezávislá protiváha, nebo pravdivě označený solo inversion pass?
- Pochopí další Agent řešení a jeho non-goals bez původního chatu?

Skill je neúspěšně použitý, pokud jen přidá ceremonii k předem zvolenému
řešení, použije „principy“ jako záminku k převzetí cíle Principála nebo vytvoří
další vlastní proces místo zjednodušení systému.
