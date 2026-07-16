# ARCHITECTURE.md — Conglomerate Guide

`guide/` je sdílený onboardingový povrch pro HumanAndMachine GEN3 root. Funkční mechanismus vychází z GEN2 guide, ale obsah je obecný pro multi-organization Conglomerate model.

## Vrstvy

```text
guide/
├── content/         # autorství kurzu: lekce, kvízy, úkoly, achievementy
├── app/v1/          # Astro renderer + client-side progress
└── docs             # README, AGENTS, ARCHITECTURE, CHANGELOG
```

## Content vrstva

`guide/content/` je canonical source of truth pro vzdělávací cestu:

- `cesta.json` — sekce a pořadí lekcí;
- `lekce/<id>/lekce.md` — české vysvětlení;
- `lekce/<id>/kviz.json` — test pochopení;
- `lekce/<id>/ukol.md` — praktický úkol;
- `achievements/achievements.json` — odznaky za milníky.

Obsah nesmí obsahovat klientská data, secrets ani organization-specific realitu vydávanou za obecný systém.

## App vrstva

`guide/app/v1/` je Astro appka:

- čte `../content/` vůči `guide/app/v1/src/lib/content.ts`;
- renderuje mapu kurzu, lekce, kvízy a úkoly;
- používá localStorage pro běžný progres v browseru;
- zachovává SSR shell z GEN2 guide, aby šel později bezpečně rozšířit o root/agent profile integraci.

Port je `5281` a manifest žije v `guide/app/v1/package.json` pod `companyascode.app`.

## Vztah k Organizacím

Guide není součást Organization repozitáře. V GEN3 patří obecný Guide do `HumanAndMachines/Conglomerate_GEN3/guide`. Organization-local onboarding může existovat pouze jako organization-specific obsah v příslušné Organization vrstvě.

Při migraci z GEN2 se obecný Organization-local `guide/` odstraňuje, aby nevznikla duplicitní pedagogická pravda.

## Bezpečnost

- Guide smí číst vlastní content a veřejné/root manuály.
- Guide nesmí ukládat secrets.
- Guide nesmí implicitně kopírovat business data z jedné Organizace do jiné.
- Případný budoucí writer musí mít explicitní boundary a validace.
