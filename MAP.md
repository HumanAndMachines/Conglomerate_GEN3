# HumanAndMachine GEN3 / Conglomerate root mapa

HumanAndMachine GEN3 je současný název systému dříve označovaného jako
Conglomerate GEN3. Tento repo root (`HumanAndMachines/Conglomerate_GEN3`) je sdílený
framework pro Launchpad, Guide, templates, manuály a dynamické načítání
Organizací; není to klientské Organization repo.

Launchpad root drží lokální Konglomerát: více Organizací pod jedním rootem na jedné
mašině. `launchpad.gen3.json` drží root registry/metadata, ale dostupné
Organizace Launchpad zároveň automaticky skenuje z lokálních mountů
`organizations/*/company.gen3.json`.

```text
Conglomerate/
├── launchpad.gen3.json
├── package.json
├── README.md
├── MAP.md
├── AGENTS.md
├── manual/
├── .agents/skills/             # základní postupy pro Buddy a AI kolegy
├── launchpad/
├── Launchpad.command
├── Launchpad.cmd
├── Launchpad.ps1
├── launchpad.sh
├── assets/launchpad.icns       # macOS ikona instalované Launchpad .app
├── scripts/install-macos-launchpad-app.mjs
├── guide/
├── personalspace/              # private/gitignored personal repo mount
│   └── secrets/                 # local ignored secret custody; see manual/security/local-secret-custody.md
├── organizations/
│   ├── README.md               # jediný soubor trackovaný v root repu
│   ├── ExampleOrg_GEN3/        # lokální gitignored Organization repo checkout
│   ├── OtherOrg_GEN3/          # lokální gitignored Organization repo checkout
│   └── <another-github-org>_GEN3/
│       ├── workspace/          # plochá složka všech workspace modulů
│       │   └── <modul>/        # Team příslušnost deklaruje manifest
│       └── productionspace/    # org-level repa mimo workspace moduly
├── templates/
└── drafts/
```

## Kam jít

- `launchpad.gen3.json` — root metadata a `planned` sloty Konglomerátu (rootu, šablon a lokálních povrchů), ne allowlist Organizací; dostupné Organizace se auto-discoverují z `organizations/*/company.gen3.json` (decision 0042 v HumanAndMachines/docs/decisions/)
- `launchpad/` — sdílený builder-first Launchpad GEN3 (decision 0047 v HumanAndMachines/docs/decisions/, reviduje CEO-first 0024): surface pro Buildery Organizace (Organization Builder) — spouštění aplikací z `main` i z worktrees podle Mission Control plánů (decision 0049) a read-only přehled productionspace; dynamicky načítá Organizace/Teamy/moduly a ukazuje stavy `available` / `missing_access` / `planned_slot`; Admin Organizace (Organization Admin), vstup Uživatelů Organizace (Organization User) do produkčních workspace aplikací a deploy/server konfigurace patří do Conglomerate Dashboardu GEN3
- `guide/` — sdílený netechnický onboarding kurz (26 lekcí) do práce s digitální kanceláří a AI kolegy; technická cesta „mapa systému“ (Launchpad root, Organizace, workspace, productionspace, personalspace) je plánovaná budoucí část, do té doby tato témata drží MAP.md a `manual/`
- Conglomerate Dashboard — v1 spike lokální mount (`dashboard/`) byl z rootu odstraněn i s launchery a Dock ikonou; aktuální Dashboard spike žije v privátním repu (v2 reference). Zůstává hostovaným surfacem pro Admin Organizace (billing, plány, přístupy, konfigurace, Buddy policies) a vstupem Uživatele Organizace (Organization User) do produkčních aplikací (decision 0047/0048 v HumanAndMachines/docs/decisions/)
- `manual/` — technický maintenance manuál Launchpad rootu
- `.agents/skills/` — základní opakovatelné postupy pro Buddy a AI kolegy
- `organizations/README.md` — vysvětlení mountpointu; jediný trackovaný soubor uvnitř `organizations/` v root repu
- `organizations/<org>/` — lokální gitignored Organization GEN3 checkout, ideálně podle GitHub organizace
- `organizations/` má dle decision 0077 (HumanAndMachines/docs/decisions/) hostit i mount šablony Organizace s markerem `company.gen3.json` `organization_kind: "template"` — discovery ho validuje stejnými gates jako firmu, ale drží mimo runtime, business přehledy i org počty (klasifikace podle strojového markeru, ne podle jména); mount žije v `organizations/OrganizationTemplate_GEN3` (přesun proveden 2026-07-12)
- `organizations/<org>/workspace/` — plochá složka všech workspace modulů Organizace; Team (digitální kancelář týmu lidí nebo značky/venture s vlastním doctorem, pravidly a access hranicí) deklaruje manifest (kanonicky `modules[].teams` / `module_slots[].teams`; ještě nemigrované Organizace nesou legacy alias `modules[].workspace` / `module_slots[].workspace`), deklarace je autorita a UI grupuje podle ní; modul smí patřit do více Teamů zároveň (N:M), chybějící deklarace = default Team se slugem `workspace`; hosted vzor `<modul>.<team>.<doména>` se generuje z deklarace (decision 0041 v HumanAndMachines/docs/decisions/)
- `organizations/<org>/productionspace/` — org-level repozitáře dané Organizace, které nejsou workspace moduly (např. firmware, connect, monorepo); každé repo si definuje vlastní pravidla a doctor u nich vynucuje jen bezpečné minimum (decision 0041 body 6–7 v HumanAndMachines/docs/decisions/)
- `personalspace/` — privátní osobní repo mimo GitHub organizace; cílově obsahuje privátní moduly a per-user/per-colleague aplikace včetně GBrain rozhraní
- `personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>` — lokální gitignored
  custody cesta pro root/Buddy/operator secrets; organization/AI-colleague
  secrets patří do organization-local `private/secrets/...`
- `templates/` — šablony
- `drafts/` — lokální netrackované návrhy bez dlouhodobé autority (sdílené drafty žijí v privátním Rozjedeme-ai/HumanAndMachines)
- **V jakém světě jsi (koexistence Human↔Machine):** začni sekcí
  `AGENTS.md → Model spolupráce → Koexistence Human and Machine`. Vysvětluje
  hierarchii, hranice a procesy, ve kterých tenhle root a všechny Organizace
  fungují — pro lidi i agenty.
