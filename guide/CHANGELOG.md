# Guide GEN3 changelog

## 2026-07-02

- Revize meta-dokumentů podle interního auditu (2026-07-02) a draftu 0040 (Guide = odvozený povrch bez vlastní autority); lekce 04 opravena podle founder kánonu Digitální kancelář = Workspace (draft 0041; drafty v privátním repu, formální decision records vzniknou v HumanAndMachines/docs/decisions/):
  - `README.md` — sekce Účel opravena na realitu kurzu: 26 lekcí je netechnický onboarding do práce s digitální kanceláří a AI kolegy; technická cesta „mapa systému“ označena jako plánovaná budoucí část.
  - `AGENTS.md` — tabulka mapující root témata na lekce 01–07 neodpovídala skutečnému obsahu lekcí (např. 05 = „AI vata“, 07 = „Rozcestníky“); nahrazena poznámkou, že mapování vznikne s cestou „mapa systému“. Ve schématu lekce opraven odkaz na neexistující sekci `1-mapa-systemu` na reálnou `1-mindset`.
  - Lekce 04 (`co-je-digitalni-kancelar`) — opraven obrácený výklad: pracovní prostor (workspace) je digitální kancelář jednoho týmu/značky uvnitř firmy, ne „část digitální kanceláře“; firma může mít kanceláří víc.

## 2026-06-30

- Přenesen funkční mechanismus GEN2 guide do sdíleného Conglomerate Guide: Astro app shell, `content/` cesta, lekce, kvízy, úkoly a achievementy.
- Obsah přepsán na obecný HumanAndMachine GEN3 model bez firemních dat z předlohy.
- Zakotveno pravidlo GEN2 → GEN3: obecný `guide/` se z Organization repozitáře maže a nahrazuje ho shared `HumanAndMachines/Conglomerate_GEN3/guide`.
