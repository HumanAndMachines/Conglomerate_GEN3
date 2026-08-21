# Mapa Lazurio rootu

Lazurio je současný název systému a sdíleného frameworku. Tento repo root
(`HumanAndMachines/Lazurio`) je sdílený
framework pro Launchpad, Guide, templates, manuály a dynamické načítání
Organizací; není to klientské Organization repo.

Launchpad root drží lokální Konglomerát: více Organizací pod jedním rootem na jedné
mašině. `launchpad.gen3.json` drží root registry/metadata, ale dostupné
Organizace Launchpad zároveň automaticky skenuje z lokálních mountů
`organizations/*/company.gen3.json`.

```text
Lazurio/
├── launchpad.gen3.json
├── package.json
├── README.md
├── ARCHITECTURE.md             # cílové základy Lazuria, Residentů a Agentů
├── MAP.md
├── AGENTS.md
├── manual/
├── .agents/skills/             # základní postupy pro Buddy a AI kolegy
├── lazurio/                    # read-only Lazurio CLI v0: context, Doctor a scoped search
├── launchpad/
├── Launchpad.command
├── Launchpad.cmd
├── Launchpad.ps1
├── launchpad.sh
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

- `ARCHITECTURE.md` — cílové základy budoucího `Lazurio/Lazurio`: Owner,
  Machine, Resident, Agent, společný runtime Buddyho a AI Kolegy a suverenita
  vůči Lazuriu
- `lazurio/` — interní a nestabilní Lazurio CLI v0: bezpečný read-only context
  Principála/Mašiny/Personalspace a jedné explicitně vybrané lokální
  Organization, tenký adapter nad existujícími Doctory a první explicitně
  omezený Organization search pilot CAC-0093. Exact lane
  používá živé `rg`; lexical/semantic/hybrid lane používají fyzicky izolovaný
  lokální QMD index. Efektivní provider-scoped workspace zůstává navazující
  prací; CLI není MCP, write surface, distribuční package ani veřejné Core API.
- `launchpad.gen3.json` — root metadata a `planned` sloty Konglomerátu (rootu, šablon a lokálních povrchů), ne allowlist Organizací; dostupné Organizace se auto-discoverují z `organizations/*/company.gen3.json` (decision 0042 v manual/decision-register.md)
- `launchpad/` — sdílený builder-first Launchpad GEN3 (decision 0047 v manual/decision-register.md, reviduje CEO-first 0024): surface pro Buildery Organizace (Organization Builder) — spouštění aplikací z `main` i z worktrees podle Mission Control plánů (decision 0049) a read-only přehled productionspace; dynamicky načítá Organizace/Teamy/moduly a ukazuje stavy `available` / `missing_access` / `planned_slot`; Admin Organizace (Organization Admin), vstup Uživatelů Organizace (Organization User) do produkčních workspace aplikací a deploy/server konfigurace patří do Lazurio Dashboardu
- `guide/` — sdílený netechnický onboarding kurz (26 lekcí) do práce s digitální kanceláří a AI kolegy; technická cesta „mapa systému“ (Launchpad root, Organizace, workspace, productionspace, personalspace) je plánovaná budoucí část, do té doby tato témata drží MAP.md a `manual/`
- Lazurio Dashboard — v1 spike lokální mount (`dashboard/`) byl z rootu odstraněn i s launchery a Dock ikonou; aktuální Dashboard spike žije v privátním repu (v2 reference). Zůstává hostovaným surfacem pro Admin Organizace (billing, plány, přístupy, konfigurace, Buddy policies) a vstupem Uživatele Organizace (Organization User) do produkčních aplikací (decision 0047/0048 v manual/decision-register.md)
- `manual/` — technický maintenance manuál Launchpad rootu
- `manual/mission-control-trusted-builder-smoke.md` — živý cross-Lazurio audit GitHub-only writeru, root pointerů a progresivního `trusted-process` / `provider-enforced` režimu
- `distribution/` — source kontrakt, profilové fragmenty, manifest schema,
  evaly a deterministický build non-Git Lazurio Rootu; sdílený produkt se sem
  nekopíruje do druhého `common/` stromu.
- `provisioning/` — source-only operator plane pro přípravu Resident Mašiny;
  do výsledného Lazurio Rootu se nebalí a atomický install/update/rollback
  deleguje na verzovaný resident lifecycle.
- `.agents/skills/` — základní opakovatelné postupy pro Buddy a AI kolegy
- `organizations/README.md` — vysvětlení mountpointu; jediný trackovaný soubor uvnitř `organizations/` v root repu
- `organizations/<org>/` — lokální gitignored Organization GEN3 checkout, ideálně podle GitHub organizace
- Legacy top-level Organization template mount s markerem `company.gen3.json` `organization_kind: "template"` zůstává discovery-kompatibilní, ale nový se nezakládá. Current pracovní checkout podle decision 0127 žije v `organizations/<AdminOrganization>/productionspace/OrganizationTemplate_GEN3`; template nástroje dostávají explicitní cestu a ověřují Git provenienci.
- `organizations/<org>/workspace/` — plochá složka všech workspace modulů Organizace; Team (digitální kancelář týmu lidí nebo značky/venture s vlastním doctorem, pravidly a access hranicí) deklaruje manifest (kanonicky `modules[].teams` / `module_slots[].teams`; ještě nemigrované Organizace nesou legacy alias `modules[].workspace` / `module_slots[].workspace`), deklarace je autorita a UI grupuje podle ní; modul smí patřit do více Teamů zároveň (N:M), chybějící deklarace = default Team se slugem `workspace`; sdílený modul může použít čistě prezentační `launchpad_section: "organization"`, aby se jeho jedna dlaždice neopakovala v každém Teamu, zatímco fyzický mount, runtime a Git ownership zůstávají ve `workspace/`; hosted vzor `<modul>.<team>.<doména>` se generuje z deklarace (decision 0041 v manual/decision-register.md)
- `organizations/<org>/productionspace/` — org-level repozitáře dané Organizace, které nejsou workspace moduly (např. firmware, connect, platformní runtime nebo pracovní template checkout); každé repo si definuje vlastní pravidla a Doctor u nich vynucuje jen bezpečné minimum (decisions 0041 a 0127 v manual/decision-register.md)
- `personalspace/` — privátní osobní repo mimo GitHub organizace; cílově obsahuje privátní moduly a per-user/per-colleague aplikace včetně GBrain rozhraní
- **Hostovaný Buddy** — když si Principál Buddyho onboarduje, běží na dedikované per-owner VPS (decision 0080), ne lokálně; lokální mount `personalspace/<owner>_GEN3/buddy/` drží jen Git konfiguraci profilu. Na hostu platí vygenerované instrukce aktivního Buddy resident rootu spolu s privátním profilem Principála, ne pravidla source checkoutu — hranici a postup zjištění drží `manual/hosted-buddy-vps.md`
- `personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>` — lokální gitignored
  custody cesta pro root/Buddy/operator secrets; organization/AI-colleague
  secrets patří do organization-local `private/secrets/...`
- `templates/` — šablony
- `drafts/` — lokální netrackované návrhy bez dlouhodobé autority; sdílený draft patří do příslušné Organizace, plan-owned worktree nebo PR
- **V jakém světě jsi (koexistence Human↔Machine):** začni sekcí
  `AGENTS.md → Model spolupráce → Koexistence Human and Machine`. Vysvětluje
  hierarchii, hranice a procesy, ve kterých tenhle root a všechny Organizace
  fungují — pro lidi i agenty.
