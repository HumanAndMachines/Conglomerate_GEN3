# Quality gates

## Bezpečnost a access

- explicitní Principál a owner;
- allowlist scope a nástrojů, deny-by-default mimo něj;
- žádné secrets v repu, promptu, trace ani fixture datech;
- write, external communication, deploy a release mají samostatné approval;
- cross-organization a Personalspace hranice mají negativní eval.

## Produkt a UX

- jeden jasný job-to-be-done a popsaný uživatel;
- očekávaný výstup má schema nebo rubriku;
- chybový stav je srozumitelný a další krok je konkrétní;
- člověk pozná draft, autoritu dat a stav publikace.

## AI kvalita

- evaly mají anonymizované vstupy a očekávané výsledky;
- měří se přesnost/užitečnost, tool success, latence, cena a regrese;
- tool timeout, neúplný kontext a missing access nesmí vést k halucinaci;
- změna modelu, promptu nebo nástroje spouští regresní sadu.

## Provoz

- trace nese korelační ID, ne secrets nebo raw osobní obsah;
- definované retry a maximální náklady běhu;
- incident owner, disable/rollback postup a audit poslední publikované verze;
- dev/test/prod a secret custody jsou oddělené, pokud Agent běží mimo lokální
  vývojový stroj.
