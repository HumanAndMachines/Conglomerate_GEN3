# Guide GEN3

`guide/` je sdílený interaktivní průvodce **HumanAndMachine GEN3 / Conglomerate** rootem.

Vychází z funkčně nejdál dotažené GEN2 guide předlohy: Astro aplikace, `content/` kurz, lekce, kvízy, úkoly a achievementy. Do Conglomerate se ale přenáší **mechanismus**, ne firemní obsah ani data předlohy.

## Účel

Guide je netechnický úvod pro nové kolegy: jak v prvních dnech pracovat s digitální kanceláří a AI kolegy. Současných 26 lekcí vysvětluje:

- co je digitální kancelář a jak poznat dobrý výstup od AI;
- kde hledat úkoly, znalosti a návody;
- jak zadávat práci AI kolegovi, diktovat česky a používat uložené postupy;
- jak se práce bezpečně uloží a co dělat, když se něco rozbije;
- jak přidávat vlastní poznatky a postupy a pomáhat kolegům.

Technická cesta „mapa systému“ (Conglomerate / Launchpad root, Organizace, Workspace, Productionspace, source of truth, klientský rollout) je plánovaná budoucí část kurzu; dnes tato témata drží root `MAP.md` a `manual/`.

## Spuštění

```sh
cd guide/app/v1
bun install
bun run dev
```

Aplikace běží na `http://127.0.0.1:5281`. Stejný manifest čte Launchpad z `guide/app/v1/package.json`.

## Struktura

```text
guide/
├── README.md
├── AGENTS.md
├── ARCHITECTURE.md
├── CHANGELOG.md
├── content/
│   ├── cesta.json
│   ├── achievements/achievements.json
│   └── lekce/<NN-slug>/
│       ├── lekce.md
│       ├── kviz.json
│       └── ukol.md
└── app/v1/
    ├── package.json
    ├── astro.config.mjs
    └── src/
```

## Source-of-truth hranice

Guide je pedagogická vrstva. Nepředepisuje novou pravdu bez opory v autoritativních vrstvách:

- root `AGENTS.md`, `MAP.md`, `manual/`, `launchpad.gen3.json`;
- Organization `company.gen3.json`, `modules.manifest.json`, `manual/`, `workspace/`, `productionspace/`;
- nested module repos pro app/data pravdu.

Pokud Guide učí pravidlo, které není v autoritativní vrstvě, nejdřív oprav autoritativní vrstvu nebo z Guidu tvrzení odeber.

## GEN2 → GEN3 pravidlo pro Guide

Při migraci Organization z GEN2 do GEN3 se obecný top-level `guide/` z Organization repozitáře **maže**. Nahrazuje ho sdílený `HumanAndMachines/Conglomerate_GEN3/guide`.

Organization může dál mít vlastní onboarding obsah, ale jen pokud je jasně organization-specific a žije ve správné Organization vrstvě (`manual/`, knowledgebase, role docs apod.).
