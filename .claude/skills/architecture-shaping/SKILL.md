---
name: architecture-shaping
description: Povinně vytvaruje každou změnu source kódu nebo sdíleného technického kontraktu do jednoduchého, Lazurio-konformního řešení; oddělí záměr Principála od mechanismu a zesílí review u významných architektonických změn. Nepoužívej pro čistě obsahové nebo datové editace bez technického dopadu.
---

# Architecture shaping

## Kdy použít

Použij při každém tasku, který mění spustitelný source kód, schéma, workflow,
generátor, agentní nebo runtime tooling či sdílený technický kontrakt. Platí i
tehdy, když Principál žádá konkrétní implementaci: jeho záměr, priority a
publikační pravomoc zachovej, ale mechanismus posuď odborně proti aktuálním
autoritám a principům Lazuria.

Čistou opravu copy, business dat nebo dokumentu bez změny technického kontraktu
skill nevyžaduje. Jakmile dokument mění závaznou architekturu nebo pracovní
pravidlo, použij jej stejně jako u kódu.

## Postup

1. **Odděl záměr od návrhu.** Jednou větou pojmenuj, čeho má člověk nebo
   systém dosáhnout. Konkrétní knihovnu, službu, tabulku, workflow nebo
   komponentu ze zadání zatím ber jako hypotézu, ne jako automatickou autoritu.
2. **Najdi současný kontrakt.** Přečti nejbližší instrukce, architekturu,
   decision, manifesty, živé entrypointy a relevantní testy. Urči současnou
   autoritu dat, accessu, lifecycle a publikace a existující běžnou cestu.
3. **Zvol nejmenší koherentní změnu.** Nejdřív prověř přímé použití nativního
   primitive nebo best practice používané platformy. Preferuj rozšíření či
   sloučení kanonické cesty před paralelní cestou. Každý nový stav, fallback,
   mirror, synchronizaci, registry, wrapper nebo compatibility větev nech
   obhájit pojmenovaným invariantem a reálným consumerem.
4. **Vytvaruj systém, ne jen symptom.** Oprav příčinu v přirozeném ownerovi.
   Odstraň supersedovanou aktivní mašinérii, pokud už nemá consumera; auditní
   historii zachovej jako historii, ne jako druhý runtime. Nepřidávej obecný
   framework pro jediný neověřený případ.
5. **Pracuj kriticky a transparentně.** Když zadaný mechanismus odporuje
   autoritě, vytváří zbytečnou větev nebo přesouvá problém jinam, řekni to
   Principálovi včas a navrhni jednodušší konformní cestu. Rutinní technický
   úsudek neblokuj otázkou; rozhodnutí o změně cíle, rizikové výjimce nebo nové
   architektuře vrať Principálovi.
6. **Ověř podle rizika.** Malý lokální fix potřebuje úzký regresní důkaz.
   Změna autority, source of truth, persistence, accessu, publikace, sdíleného
   frameworku, více repozitářů nebo compatibility kontraktu spouští zesílený
   review: načti [architektonickou review čočku](references/architecture-review.md),
   projdi negativní scénáře a ověř alespoň jednoho skutečného nebo věrného
   consumera.
7. **Nech codebase konvergovat.** Před handoffem přečti exact diff jako nový
   Agent bez kontextu chatu. Zkontroluj, zda změna snižuje nebo alespoň
   vědomě ohraničuje počet konceptů, stavů a cest. Motivaci, non-goals,
   odstraněnou mašinérii, důkazy, rollout a zbylé riziko napiš do PR.

Nezávislý kompetentní review je silný zesilovač, ne závislost na značce.
Použij Fable, jiný model, Agenta nebo Kolegu, pokud je dostupný a přiměřený
dopadu. Když dostupný není, proveď oddělený read-only self-review nad exact
HEADem po testech a pravdivě uveď sílu důkazu. Chybějící Claude CLI nebo
konkrétní model samo o sobě práci neblokuje; repo-native review a publikační
pravidla zůstávají závazná.

## Ověření

Před tvrzením, že je source změna hotová, musí být doložitelné:

- záměr Principála a zvolený mechanismus jsou rozlišitelné;
- nevznikla druhá autorita ani paralelní běžná cesta bez doložené nutnosti;
- nové persistentní části mají pojmenovaný invariant, ownera a consumera;
- relevantní pozitivní i negativní scénář prošel na exact HEADu;
- u významné změny proběhl skutečný consumer/smoke a nezávislý nebo oddělený
  self-review;
- PR vysvětluje praktický dopad, non-goals, zjednodušení, rollout a zbylá
  rizika, ne pouze soubory a testy.

Když nelze najít Lazurio-konformní variantu bez nového rozhodnutí, výsledek
není odfláknutá implementace: zachovej vratný Draft, pojmenuj přesnou kolizi a
vrať rozhodnutí oprávněnému Principálovi.
