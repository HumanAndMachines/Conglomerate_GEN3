# Architektonická review čočka

Načti tuto čočku jen pro změnu, která mění autoritu, source of truth,
persistence, access, publikaci, sdílený framework, compatibility hranici nebo
více repozitářů. Není to povinný formulář ani skórování.

## Co musí review rozklíčovat

1. **Výsledek a invarianty** — Jaký lidský nebo systémový výsledek musí přežít
   výměnu konkrétní implementace? Které požadavky jsou skutečné invarianty a
   které jen současný mechanismus?
2. **Mapa autorit** — Kdo už vlastní data, access, identitu, lifecycle,
   validaci a publikaci? Nevzniká druhá autorita, která se bude muset
   synchronizovat nebo může legitimního uživatele zablokovat?
3. **Nativní cesta** — Umí potřebu pokrýt Git, GitHub, operační systém,
   provider nebo používaný framework běžným a známým postupem? Co Lazurio
   získává vlastní vrstvou navíc?
4. **Rozpočet komplexity** — Jaké nové stavy, fallbacky, konfigurace,
   credentials, background procesy a recovery větve vznikají? Který konkrétní
   incident nebo consumer každý z nich ospravedlňuje?
5. **Konvergence** — Co po změně zmizí, zamrzne jako historie nebo se sloučí?
   Pokud jen přibývá další cesta, proč je to lepší cílová architektura než
   oprava přirozeného ownera?
6. **Selhání a rollback** — Co se stane při chybějícím přístupu, souběhu,
   částečném rollout, starém consumeru a rollbacku? Zachová se pravdivý stav
   bez tiché degradace nebo přepsání historie?
7. **Důkaz** — Který negativní test by návrh vyvrátil? Který skutečný consumer
   dokazuje přenositelnost? Odpovídá review a PR popis exact HEADu?

## Jak vést nezávislý review

Reviewer dostane záměr, platné autority, exact diff a relevantní testy, ale ne
požadovaný verdikt. Hledá konkrétní proti-příklad, zbytečnou vrstvu nebo
nepravdivý předpoklad. Nález je platný teprve po reprodukci nebo doložení proti
kontraktu; jméno modelu ani sebejistota nejsou důkaz.

Když nezávislý reviewer není dostupný, autor po dokončení testů oddělí
implementační kontext, znovu přečte exact diff touto čočkou a sepíše zbývající
nejistotu. Nesmí předstírat nezávislost, ale nemusí čekat na konkrétní CLI,
model nebo osobu.
