# AGENTS.md — pravidla pro agenta v `guide/`

Tento scope je sdílený **HumanAndMachine GEN3 / Conglomerate root Guide**, ne Guide jedné Organizace.

## Co `guide/` vlastní

- `guide/content/` drží obecný onboarding kurz pro HumanAndMachine GEN3.
- `guide/app/v1/` je Astro renderer převzatý mechanismem z GEN2 guide.
- Root docs (`README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `CHANGELOG.md`) drží metadata a pravidla Guide vrstvy.

## Co `guide/` nevlastní

- Klientská business data.
- Organization-specific pravdu konkrétní firmy.
- Secrets, tokeny, OAuth údaje nebo privátní osobní poznámky.
- Autoritativní rozhodnutí, která patří do root manuálu, `launchpad.gen3.json` metadata nebo Organization manuálu.

## Zlaté pravidlo

Guide je pedagogická vrstva nad autoritami. Pokud lekce tvrdí něco, co není v autoritativní vrstvě, oprav nejdřív autoritativní vrstvu, nebo tvrzení z lekce odeber.

## Kdy Guide aktualizovat

Aktualizuj Guide, když se změní obecný model práce s digitální kanceláří — terminologie, způsob zadávání a kontroly práce, bezpečnostní návyky. Projdi `content/cesta.json` a dotčené lekce. Když se mění GEN2 → GEN3 migrační pravidlo nebo first-client rollout postup, aktualizuj zároveň root runbooky `manual/gen2-to-gen3-migration.md` a `manual/first-client-organization-rollout.md` — Guide na ně jen odkazuje, autorita jsou ony.

Revize 2026-07-02: současný kurz (26 lekcí, sekce `1-mindset` až `5-soucast-tymu` v `content/cesta.json`) je netechnický onboarding a nemapuje se na root témata jako doctor, source-of-truth routing, secret custody nebo rollout. Mapování root témat na konkrétní lekce vznikne až s plánovanou technickou cestou „mapa systému“. Do té doby tato témata drží autoritativní vrstvy (root `manual/`, `MAP.md`), ne Guide.

## Obsahová pravidla

- Piš česky, krátce a konkrétně.
- Cílovka je člověk, který nechce číst zdrojový kód.
- Nepřenášej firemní ani klientská data do root Guidu.
- Přenášej jen zobecněné mechanismy a ověřené patterny.
- Když použiješ technický pojem, hned vysvětli jeho praktický význam.

## Schéma lekce

Lekce žije v `guide/content/lekce/<NN-slug>/lekce.md` s frontmatter:

```yaml
---
id: 01-priklad
title: Český titulek
section: 1-mindset
order: 1
prerequisites: []
duration_min: 7
quiz: true
ukol: false
---
```

Kvíz je `kviz.json`, praktický úkol je `ukol.md`, achievementy jsou v `content/achievements/achievements.json`.

## Ověření

Po změně spusť:

```sh
cd guide/app/v1
bun install
bun run build
cd ../../..
bun run check
bun run doctor
```
