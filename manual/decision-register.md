# Registr rozhodnutí sdíleného frameworku

Dokumenty Conglomerate rootu odkazují na rozhodnutí číslem (`decision NNNN`).
Číslo je stabilní identifikátor; tento registr je **lokální projekce norem
uvnitř Conglomerate** — uživatel Conglomerate nepotřebuje žádný externí
repozitář. Plné decision records (kontext, founder verbatim, historie) drží
privátní strategické repo maintainerů frameworku; pro práci v Conglomerate
jsou závazné texty tohoto repa: `AGENTS.md`, manuály, skilly a tento registr.
Mezery v číselné řadě jsou normální (rozhodnutí mimo scope sdíleného
frameworku se sem nepřenášejí).

| # | Norma (shrnutí) |
| --- | --- |
| 0021 | Team je pojmenovaná skupina uvnitř Organizace; hosted vzor aplikací je `<modul>.<team>.<doména>`. |
| 0023 | Team může být tým lidí i značka/venture; příslušnost modulů deklaruje manifest. |
| 0024 | Historický CEO-first koncept Launchpadu; revidováno decision 0047 (builder-first). |
| 0026 | Kanonický layout Organizace GEN3 (company.gen3.json, plochý workspace, manifesty). |
| 0030 | Conglomerate root je direct-pull klon jediného sdíleného upstreamu; vylepšení jdou zpět PR-em, ne fork-syncem. |
| 0033 | Migrace GEN2 → GEN3 je fork-based a paralelní; stará generace zůstává rollback linkou. |
| 0034 | Mission Control ↔ template roadmap loop: plánovací vrstva se propaguje template cestou. |
| 0035 | Datové v3 aplikace: approval model draft → approve → publish nad repository-db. |
| 0037 | Mission Control v3 nastupuje na hranici GEN3 migrace Organizace. |
| 0039 | Systém se jmenuje HumanAndMachine GEN3; produkty jsou Conglomerate GEN3 (práce) a Buddy GEN3 (osobní). |
| 0040 | Pyramida přednosti source of truth: decision records > schémata/configy > GLOSSARY > AGENTS.md scope > kontrakty > Guide. |
| 0041 | Plochá složka `workspace/`; Team je deklarace v manifestu (N:M), productionspace bez univerzálních pravidel, doctor tam vynucuje jen bezpečné minimum. |
| 0042 | Launchpad je auto-discovery first: Organizace objevuje skenem mountů; root config není allowlist; bezpečnostní kontroly platí pro všechny mounty stejně. |
| 0044 | Noví klienti nastupují rovnou na GEN3 (žádný GEN2 onboarding). |
| 0045 | `_GENn` je trvalý generační marker názvu repa/mountu; interní brand identita zůstává čistá. |
| 0046 | Gbrain (paměť Buddyho) patří do personalspace, nikdy do firemní organizace. |
| 0047 | Dvě surfaces: Launchpad = builder-first lokální; Conglomerate Dashboard GEN3 = hosted admin/user vstup. |
| 0048 | Produktové plány Free/Solo/Team/Enterprise a hosting režimy (localhost/hosted/selfhosted). |
| 0049 | Worktree runtime kontrakt: plan-owned worktrees v `.worktrees/`, sidecar metadata, Launchpad spouští aplikace z worktrees. |
| 0077 | Template mount Organizace žije v `organizations/OrganizationTemplate_GEN3` s markerem `organization_kind: "template"`; validuje se stejně, ale stojí mimo runtime a přehledy. |
| 0079 | Personalspace self-service vzniká z veřejného `PersonalspaceTemplate_GEN3`; reálná instance je vždy privátní repo vlastníka. |
| 0080 | Buddy runtime běží výhradně na dedikované VPS vlastníka; localhost není instalační volba ani fallback. |
| 0089 | Buddy je důvěryhodný osobní Agent: morální kontrakt (`CONSTITUTION.md`) + trvalé, scoped, odvolatelné mandáty (`MANDATES.md`); transakčně specifické gates mandát nikdy nenahrazuje a Buddy si mandát sám nevydá. |
| 0090 | Slovník person: Worker Agent je kanonický pojem pro execution session bez pravomocí; „Agent" je hovorová zkratka. |
| 0091 | Security hranice: Personalspace patří výhradně jednomu Principálovi (+ volitelný Buddy); Principál plně ovládá svou mašinu; GitHub je jediná autorita Workspace source přístupů; repo modulu je nejmenší access hranice. |
| 0092 | AI Kolega má vlastní GitHub účet, dedikovanou Mašinu (GEN2/GEN3 = VPS), plný Conglomerate a owner-only Personalspace bez Buddyho; do Organizací smí jen to, co dovolí jeho vlastní GitHub identita. |
| 0093 | Infra repo Organizace je Admin-only: Steward ani Builder do něj grant nedostávají. |
| 0094 | Opatrovník: každý seat AI Kolegy má právě jednoho jmenovaného lidského custodiana s auditovaným, jmenovitým servisním vstupem — jiná osa než organizační role; soukromý Personalspace Kolegy se nečte. |
| 0095 | Admin smí mergovat i vlastní PR; Steward je běžná merge lane, ne výhradní autorita. |
| 0102 | Lokální Mission Control writer používá GitHub identitu přihlášeného Principála (žádný druhý IAM); datová lane se zamyká progresivně. |
| 0103 | Agentní PR disciplína: vždy worktree + PR, průběžný push, Draft PR → Ready, průvodcovský handoff, Publikace řízená živými GitHub právy, progresivní zamykání `main`. |
| 0104 | `.claude/skills` je Git-tracked byte-for-byte mirror `.agents/skills` (Windows-safe, žádné symlinky); paritu hlídá doctor a opravuje repair lane. |
| 0112 | Agentní instrukce jsou ústava: vysvětlují hodnoty, hranice a očekávání, nediktují postup; slovník pěti pojmů (Principál, Kolega, AI Kolega, Worker Agent, Buddy); jedno pravidlo = jeden kanonický domov; mechaniku nese skript/skill/doctor. |
