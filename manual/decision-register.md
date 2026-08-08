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
| 0013 | Launchpad root je workstation/control-plane pattern: právě jeden root na mašinu; Organizace dynamicky načítá a spouští, ale nedrží jejich business pravdu. |
| 0018 | Každá Organizace má vlastní doctor; diagnostika je per-Organizace, ne globální. |
| 0021 | Team je pojmenovaná skupina uvnitř Organizace; hosted vzor aplikací je `<modul>.<team>.<doména>`. |
| 0023 | Team může být tým lidí i značka/venture; příslušnost modulů deklaruje manifest. |
| 0024 | Historický CEO-first koncept Launchpadu; revidováno decision 0047 (builder-first). |
| 0026 | Kanonický layout Organizace GEN3 (company.gen3.json, plochý workspace, manifesty). |
| 0030 | Conglomerate root je direct-pull klon jediného sdíleného upstreamu; vylepšení jdou zpět PR-em, ne fork-syncem. |
| 0031 | Org mounty `organizations/<org>/` jsou gitignored Doctor-managed vnořená repa, ne git submoduly; root config je folder-driven. |
| 0033 | Migrace GEN2 → GEN3 je fork-based a paralelní; stará generace zůstává rollback linkou. |
| 0034 | Mission Control ↔ template roadmap loop: plánovací vrstva se propaguje template cestou. |
| 0035 | Datové v3 aplikace rozlišují Draft a Publikaci dat nad repository-db; chráněné cesty jdou flow draft → approve → publish. Rozsah approval sleduje progresivní zamykání (viz 0102). |
| 0036 | Mission Control cutover z legacy YAML má explicitní gates; historické záznamy se nepřepisují. |
| 0037 | Mission Control v3 nastupuje na hranici GEN3 migrace Organizace. |
| 0039 | Systém se jmenuje HumanAndMachine GEN3; produkty jsou Conglomerate GEN3 (práce) a Buddy GEN3 (osobní). |
| 0040 | Pyramida přednosti source of truth: decision records > schémata/configy > GLOSSARY > AGENTS.md scope > kontrakty > Guide. |
| 0041 | (1) `workspace/` je plochá složka všech modulů; (2–5) Team je manifestová N:M deklarace, ne adresář — chybějící deklarace = default Team `workspace`; (6) `productionspace` je rezervovaný org-level slug mimo Teamy; (7) každé productionspace repo má vlastní branch/release pravidla a doctor vynucuje jen bezpečné minimum. |
| 0042 | Launchpad je auto-discovery first: Organizace objevuje skenem mountů; root config není allowlist; bezpečnostní kontroly platí pro všechny mounty stejně. |
| 0043 | Neplatný manifest Organizaci izoluje: Launchpad vadný mount bezpečně odstaví, nikdy kvůli němu nepadá celé UI. |
| 0044 | Noví klienti nastupují rovnou na GEN3 (žádný GEN2 onboarding). |
| 0045 | `_GENn` je trvalý generační marker názvu repa/mountu; interní brand identita zůstává čistá. |
| 0046 | Gbrain (paměť Buddyho) patří do personalspace, nikdy do firemní organizace. |
| 0047 | Dvě surfaces: Launchpad = builder-first lokální; Conglomerate Dashboard GEN3 = hosted admin/user vstup. |
| 0048 | Produktové plány Free/Solo/Team/Enterprise a hosting režimy (localhost/hosted/selfhosted). |
| 0049 | Worktree runtime kontrakt: plan-owned worktrees v `.worktrees/`, sidecar metadata, Launchpad spouští aplikace z worktrees. |
| 0051 | Struktura Personalspace: privátní repo `<login>/<login>_GEN3` mimo firemní organizace, `personal.gen3.json`, plochá `workspace/`, gbrain jako root vrstva. |
| 0052 | AI Architekt je placená platformní služba admin vrstvy: navrhuje změny výhradně přes Dashboard apply plány se schválením Organization Admin, nikdy nezapisuje přímo do zákaznického Gitu a nenahrazuje BYOS builder agenty. |
| 0059 | Distribuce má dvě oddělené osy: root checkout se bezpečně fast-forwarduje na cíl kanálu Nightly (`origin/main`) nebo Stable (nejvyšší tag); aktualizace Launchpad binárky je samostatný mechanismus. Stable Release smí vytvořit jen identita s odpovídajícími GitHub právy. |
| 0060 | Role určuje footprint na mašině: Organization User je zero-install (žádný lokální root, přístup přes produkční aplikace a MCP). |
| 0061 | BYOS: agentní runtime a subscription zůstávají na stroji buildera; platforma nedodává LLM účet ani skrytou autonomii. |
| 0062 | Kanonická čtveřice person: Organization Admin / Steward / Builder / User (nesklonné anglické pojmy). |
| 0063 | Worker Agent pracuje jen v explicitně autorizovaném tasku pod dozorem; drafty schvaluje persona s pravomocí (Kolega nebo AI Kolega — gate je pravomoc, ne rozdíl člověk vs. AI). |
| 0077 | Template mount Organizace žije v `organizations/OrganizationTemplate_GEN3` s markerem `organization_kind: "template"`; validuje se stejně, ale stojí mimo runtime a přehledy. |
| 0079 | Personalspace self-service vzniká z veřejného `PersonalspaceTemplate_GEN3`; reálná instance je vždy privátní repo vlastníka. |
| 0080 | Buddy runtime běží výhradně na dedikované VPS vlastníka; localhost není instalační volba ani fallback. |
| 0089 | Buddy je důvěryhodný osobní zástupce lidského Principála: morální kontrakt (`CONSTITUTION.md`) + trvalé, scoped, odvolatelné mandáty (`MANDATES.md`); transakčně specifické gates mandát nikdy nenahrazuje a Buddy si mandát sám nevydá. |
| 0090 | Slovník person: Worker Agent je kanonický pojem pro execution session bez pravomocí; „Agent" je hovorová zkratka. |
| 0091 | Security hranice: Personalspace patří výhradně jednomu Principálovi (+ volitelný Buddy); Principál plně ovládá svou mašinu; GitHub je jediná autorita Workspace source přístupů; repo modulu je nejmenší access hranice. |
| 0092 | AI Kolega má vlastní GitHub účet, dedikovanou Mašinu (GEN2/GEN3 = VPS), vlastní kompletní lokální instalaci Conglomerate a owner-only Personalspace bez Buddyho; do každé Organizace smí jen to, co dovolí jeho vlastní GitHub identita. |
| 0093 | Infra repo Organizace je Admin-only: Steward ani Builder do něj grant nedostávají. |
| 0094 | Opatrovník: každý seat AI Kolegy má právě jednoho jmenovaného lidského custodiana s auditovaným, jmenovitým servisním vstupem — jiná osa než organizační role; soukromý Personalspace Kolegy se nečte. |
| 0095 | Admin smí mergovat i vlastní PR; Steward je běžná merge lane, ne výhradní autorita. |
| 0102 | Lokální Mission Control writer používá GitHub identitu přihlášeného Principála (žádný druhý IAM); datová lane se zamyká progresivně. |
| 0103 | Agentní PR disciplína: vždy worktree + PR, průběžný push, Draft PR → Ready, průvodcovský handoff, Publikace řízená živými GitHub právy, progresivní zamykání `main`. |
| 0104 | `.claude/skills` je Git-tracked byte-for-byte mirror `.agents/skills` (Windows-safe, žádné symlinky); paritu hlídá doctor a opravuje repair lane. |
| 0112 | Agentní instrukce jsou ústava: vysvětlují hodnoty, hranice a očekávání, nediktují postup; slovník pěti pojmů (Principál, Kolega, AI Kolega, Worker Agent, Buddy); jedno pravidlo = jeden kanonický domov; mechaniku nese skript/skill/doctor. |
| 0113 | Přejmenovatelné jméno (slug, label, deklarace) není autorizační ani join klíč: vazby a výběr drží stabilní identita a ověřený stav, nikdy samotné jméno. |
| 0118 | Composable doctor surface: root doctor svolává vlastní doctory namountovaných rep podle deklarace v manifestu, agreguje vnořené reporty a rozbitého potomka hlásí nahlas; slovník stavů `not_applicable` / `blocked` / `incomplete`. |
