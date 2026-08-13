# ARCHITECTURE.md — Základy Lazuria

Tento dokument popisuje cílový základ systému, který dnes vzniká v repozitáři
`Conglomerate_GEN3` a bude přemigrován do `Lazurio/Lazurio`. Nejde o katalog
všech budoucích funkcí. Jde o malý počet pravidel, podle kterých se mají
posuzovat další rozhodnutí, implementace i názvosloví.

Dokument zaznamenává founder direction z 2026-08-04. Historické decision
records se nepřepisují; pokud s tímto cílem kolidují, musí být výslovně
novelizovány před odpovídající implementací. Současný provider stav se od cíle
může do dokončení migrace `CAC-0092` lišit.

## Autorita dokumentu

`ARCHITECTURE.md` je kanonický zdroj pro **cílový systémový model a
názvosloví** Lazuria. Neříká sám o sobě, co už je dnes nasazené, ani nenahrazuje
provozní instrukce pro Agenty.

Při čtení zdrojů pravdy rozlišuj tři různé otázky:

- **Co je formálně rozhodnuté:** decision records mají přednost před tímto
  dokumentem. Kolidující decision se musí před implementací cíle výslovně
  novelizovat.
- **Kam systém směřuje:** tento dokument určuje cílovou architekturu a
  význam základních pojmů a jejich vztahy. Schémata, configy a kód mohou během
  výslovně evidované migrace popisovat starší nasazený stav.
- **Jak Agent právě pracuje:** příslušný `AGENTS.md` určuje pracovní postup a
  oprávnění v daném scope. Nemůže ale zavést druhý význam pojmů, které zde
  definuje cílová architektura.

GLOSSARY, kontrakty, Guide a nové provozní texty se mají s tímto dokumentem
postupně srovnat v navazujících změnách. Tato hranice je zapsaná také v root
`AGENTS.md`, aby nevznikaly dvě konkurenční autority.

## Jádro v jedné větě

> **Owner vlastní Mašinu, na Mašině žije Resident, Agenti na ní vykonávají
> práci a Lazurio celý model distribuuje a koordinuje, aniž musí stát mezi
> Ownerem a jeho Residentem.**

## Čtyři základní pojmy

### Owner

Owner je člověk nebo Organizace, která drží Mašinu, její data, credentials a
poslední slovo nad jejím provozem.

- U Buddyho je Ownerem jeho Principál.
- U AI Kolegy je Ownerem Organizace.
- Lazurio není automaticky Ownerem cizí Mašiny jen proto, že dodalo software.

### Machine

Machine je jednotka provozu, custody a maximálního přijímaného blast radius.
Může to být fyzický počítač nebo dedikovaná VPS. Provider účet, tailnet a
recovery cesta musí mít známého vlastníka.

Pokud mají procesy uvnitř Mašiny root-equivalent autoritu, nejsou Unix user,
container ani aplikační profil skutečnou bezpečnostní hranicí. Slouží pořádku,
obnově a atribuci. Skutečnou hranicí je celá Machine.

Z toho plyne základní pravidlo:

> **Jedna Machine patří jedné trust doméně.**

Více Residentů může sdílet jednu Mašinu pouze tehdy, když Owner vědomě přijímá,
že kompromitace jednoho může kompromitovat všechny. Pokud mají mít oddělený
blast radius, potřebují oddělené Mašiny.

### Hosted Team Workspace jako Mašina

Builder-visible Hosted Team Workspace má právě jeden non-root pracovní
kontejner. Ve stejném user, `$HOME`, filesystem, PID a network namespace běží
T3 Code, Codex CLI, Launchpad, `~/Lazurio`, checkouty, worktrees a
Launchpadem spravované modulové child procesy. Uvnitř Team Workspace nejde o
bezpečnostní hranice mezi jednotlivými členy; tvrdá access hranice je mezi
Team Workspaces. Individuální izolaci poskytuje jednočlenný Team Workspace.

Vně pracovního kontejneru zůstává jen infrastrukturní obal, například
Tailscale sidecar a autentizovaný HTTPS ingress. Jejich control-plane sockety,
host mounts, Caddy admin, sudo, zbytečné capabilities a provider private keys
se do Workspace nemountují. Tenký init/supervisor obnovuje T3 a Launchpad;
Launchpad je jediný owner modulových procesů a z durable desired state obnoví
přesný main/worktree source. Per-module kontejnery, Docker-in-Docker ani další
runtime orchestrátor do tohoto modelu nepatří.

Dokud je Team Workspace zapnutý, T3 Code a Launchpad jsou
`desired-running` a tenký supervisor hlídá pouze tyto dva stabilní procesy.
Dashboard Development projektuje jen jejich vstupy; modulový dev proces
spouští, zastavuje a otevírá výhradně Launchpad. Produkční aplikace se v
Dashboardu objeví až z pozdějšího ověřeného deployment katalogu, nikdy z
Workspace service katalogu nebo dev desired state.

Lokální a hosted profil mají shodnou builder-visible strukturu a lifecycle
postupy. Liší se pouze bezpečnostním a síťovým obalem: lokální `Open` vrací
loopback, hosted `Open` exact autentizovaný HTTPS origin z Team service
katalogu. Interní module leases nejsou VPN allowlist; externí hranicí je Team
HTTPS/WSS ingress na 443.

Hosted Team Workspace je sdílená vývojová dílna, ne produkční deployment.
Zdroj modulu lze editovat i bez běžící aplikace; Launchpad spouští modulový dev
proces jen pro privátní UI/API/MCP preview, testování a debugging. Katalogový
HTTPS origin je dostupný pouze přes schválený Tailscale/VPN access plane a
nikdy nepředstavuje veřejný produkční povrch. `lazurio.runtime.v1` proto
popisuje jen runnable listenery a lifecycle pro Launchpad a Doctor, nikoli
úplný produkční deployment, ingress, identity nebo MCP kontrakt.

Produkční release je samostatná architektonická lane: chráněný source/tag se
mění na reprodukovatelný immutable artefakt a ten běží v izolovaném produkčním
runtime s explicitním `public | authenticated | internal` ingressem, app
authentication/authorization, secrets, daty, backupem, rollbackem,
observability a stateless remote MCP. Produkce neobsahuje T3, Codex, Launchpad,
dev checkouty ani worktrees. Tato hranice nezavádí per-module produkční
kontejnery do Hosted Workspace scope; konkrétní produkční topologie vyžaduje
samostatný follow-up kontrakt.

### Resident

Resident je dlouhodobá digitální identita, která na Mašině žije. Má jméno,
kontinuitu, paměť, vztah ke svému Ownerovi a dlouhodobý mandát.

Existují dva základní produktové profily Residenta:

- **Buddy** je osobní Resident jednoho Principála.
- **AI Kolega** je organizační Resident s pracovním mandátem od Organizace.

Buddy a AI Kolega nejsou dva různé runtime produkty. Jsou to dvě identity a dvě
custody konfigurace nad stejným technickým základem.

Kanonický pojem pro tuto dlouhodobou identitu je pouze **Resident**.

### Agent

Agent je výkonný pracovník spuštěný za konkrétním účelem. Dnešními příklady
jsou Codex nebo Claude Code. Označení **Agent** a **Worker Agent** znamenají
přesně tutéž roli; nejde o dvě persony, dva stupně autonomie ani dva runtime
profily. Founder zatím finální podobu názvu neuzavřel a aktuálně preferuje
kratší **Agent**, proto ho používá tento dokument a mohou ho preferovat nové
texty. `Worker Agent` zůstává plně srozumitelným synonymem, dokud samostatné
názvoslovné rozhodnutí neurčí jinak.

Agent:

- dostane úkol od Ownera nebo Residenta;
- pracuje v konkrétním scope a session;
- může mít na své Mašině plnou technickou autoritu;
- nemá automaticky Residentovu identitu, paměť ani kontinuitu;
- odevzdá výsledek jako atribuovanou práci.

Resident může práci Agentovi delegovat a Agent se může Residenta explicitně
poradit. Tím se jejich identity neslučují. Resident je dlouhodobý vztah a
mandát; Agent je vykonavatel práce.

## Jeden technický základ, dva Resident profily

| Vlastnost | Buddy | AI Kolega |
| --- | --- | --- |
| Owner | Principál | Organizace |
| Mandát | osobní | pracovní a organizační |
| Dlouhodobá paměť | osobní GBrain | organizačně svěřený GBrain |
| Síťová trust doména | tailnet Principála | tailnet Organizace |
| Provider přístup | delegace Principála | grant Organizace |
| Runtime | společný Resident runtime | společný Resident runtime |
| Chat | Zulip | Zulip |
| Vývoj a opravy | Agenti přes T3 Code nebo CLI | Agenti přes T3 Code nebo CLI |

Rozdíl mezi Buddym a AI Kolegou tedy nevzniká forkem runtime. Vzniká Ownerem,
mandátem, datovou custody a providerovými granty.

## Dvě konverzační roviny

Uživatelský model musí zůstat srozumitelný i bez znalosti implementace:

- **Zulip je chat s Residentem.** Nese jeho identitu, kontinuitu, paměť a
  mandát.
- **T3 Code nebo CLI je chat s Agenty na Mašině.** Slouží vývoji, diagnostice,
  opravám a jiné ohraničené práci.

Když je Zulip nebo Resident runtime rozbitý, opravuje jej Agent přímo na
Mašině. Kvůli tomu nevzniká druhý chat vydávající Agenta za Residenta.

### Lazurio CLI v0 je podklad Agenta, ne třetí identita

První Lazurio CLI řeší tři read-only potřeby Agenta: bezpečný strojový
`context`, přístup ke stávajícímu Doctoru a úzký manifest-scoped search pilot
pro první jmenovaný consumer. Je to projekce nad kanonickými manifesty a
runtime fakty, nikoli nový store, IAM nebo veřejné Core API.

- `context` vrací pouze výslovně povolená metadata Principála, Mašiny a
  Personalspace. S explicitním `--organization <slug>` přidá právě jednu
  lokálně objevenou Organization projekci: Teamy, moduly, aplikace, worktrees a
  základní vstupní body. Residentovu osobnost, paměť, chat, sessions, secrets
  ani mandáty nenačítá.
- Pozorování filesystemu a provider authority jsou dvě různé věci. Chybějící
  mount je `absent`; GitHub nebo aplikační access zůstává `not_evaluated` bez
  živého provider readbacku.
- `doctor` nevytváří další diagnostický model. V Launchpad rootu používá stejné
  strukturované jádro jako dnešní Doctor a na rootless Buddy VPS spouští doctor
  deklarovaný samotným Personalspace manifestem.
- Search nevytváří vlastní engine ani prohledávání celého rootu. Exact lane je
  živý adapter nad `rg`; lexical/semantic/hybrid lane je adapter nad lokálním
  QMD indexem. Scope vzniká průnikem Launchpad discovery, Organization manifestu
  a explicitního pilotního registru, indexy jsou oddělené per Organization a
  Principál a nefunkční QMD neblokuje exact lane.
- Efektivní provider-scoped workspace, členství, MCP, writes, distribuce a
  stabilní API vzniknou až z dalších ověřených consumerů; vybraná lokální
  Organization projekce je za ně nevydává a access drží `not_evaluated`.

Zulip proto zůstává chat s Residentem, T3 Code nebo CLI chat s Agenty a Lazurio
CLI jejich strojový podklad. Čistá Agent session se spuštěním CLI nestává
Buddym ani AI Kolegou a nedědí jejich kontinuitu.

## Vnější bezpečnostní hranice

Model stojí na ramenou providerů, kteří už řeší identity a přístup:

- **Tailscale** určuje, kdo se k Mašině a jejím privátním povrchům vůbec
  dostane.
- **GitHub** drží software, provider identitu, repository scope, review a
  durable výsledek práce.
- **VPS nebo hardware provider** drží vlastnictví infrastruktury a poslední
  recovery cestu.

### Trust model Buddyho

Model odpovídá na tři různé otázky; žádná z těchto hranic nenahrazuje jinou:

| Otázka | Odpověď | Kde se drží |
| --- | --- | --- |
| Kdo smí zadat Buddyho turn? | Právě jeden lidský Principál. | Privátní komunikační surface a jeho provider access. |
| Kdo smí měnit Mašinu a Lazurio? | Principál; lokální změna je legitimní a Doctor ji pouze zviditelní jako drift. | Vlastnictví Mašiny, manifest, Doctor a vratný lifecycle. |
| Co smí běžící Agent dělat? | Jen to, co dovolí sandbox agentního runtime. | Hermes Agent; Lazurio nestaví paralelní ACL ani sandbox. |

Buddyho komunikační surface patří právě jednomu lidskému Principálovi. Privátní
Zulip realm, jeho membership, credentials a síťový access plane musí zajistit,
že vstupní turn smí zadat pouze tento Principál; technická identita Buddy botu
jen odpovídá a poskytovatel komunikační infrastruktury není další Principál.
To je primární bezpečnostní hranice Buddyho.

Principál vlastní svou Mašinu a v tomto modelu není protivník. Lazurio mu proto
nebrání měnit lokální soubory ownership triky, vlastní ACL vrstvou ani
permission zámkem. Manifest, Doctor a verzovaný lifecycle slouží k tomu, aby
byla odchylka vidět, oprava byla přenositelná a návrat vratný.

Omezení souborů a nástrojů uvnitř agentní relace drží sandbox agentního
runtime — dnes Hermes Agent. Pokud je tato hranice nedostatečná, opravuje se
nebo konfiguruje tam; Lazurio kolem ní nestaví paralelní sandbox. Běžné
systemd oddělení procesu, sanitizované spouštění instalačních příkazů a
integrity kontroly jsou provozní a recovery pojistky, ne druhý autorizační
model proti Principálovi.

Sandbox ale nesmí být vlastněný ani zapisovatelný procesem, který sám omezuje.
Hermes checkout a Bun binárku může vlastnit a měnit Principál nebo jím řízená
maintenance identita, která nespouští agentní relaci. Účty `buddy` a
`buddy-bridge` naopak nesmí tyto závislosti vlastnit, přepsat ani nahradit přes
svůj parent. Preflight proto porovnává tracked Hermes bytes přímo s pinned
commitem bez důvěry v Git index, replacement refs či symlinkované předky a ptá
se host kernelu na vlastnictví i zapisovatelnost obou runtime účtů. To chrání
integritu existujícího Hermes sandboxu před jeho vlastní relací; není to další
ACL proti Principálovi.

Uvnitř autorizované trust domény se nestaví druhý interní IAM jen proto, aby
napodoboval providerové granty. Nevznikají vlastní auth proxy, relaye, obecné
permission brokery ani softwarové zdi bez konkrétně změřeného problému.

Root uvnitř jedné Mašiny ale nikdy nerozšiřuje providerová práva mimo ni.
GitHub installation, repository grant a Tailscale membership zůstávají
vnějšími hranicemi mezi Ownery a Organizacemi.

## Úloha Lazuria

Lazurio je zpočátku distribuční a lifecycle vrstva společného systému. Má:

- vydávat verzovaný a reviewovaný software;
- držet instalační šablony, kontrakty a dokumentaci;
- koordinovat plán, rollout a releases;
- poskytovat Mission Control;
- případně přijímat pouze vědomě povolenou, obsahově bezpečnou health
  telemetrii.

Lazurio nemá být povinným prostředníkem každé zprávy, inference nebo lokální
operace. Nemá automaticky číst obsah Personalspace, GBrainu nebo organizační
paměti a nemá univerzální root vstup do všech Mašin.

### Test suverenity

Plný Buddy i plný AI Kolega musí po odpojení Lazuria dál:

- komunikovat se svým Ownerem;
- používat lokální paměť a nástroje;
- pracovat s již udělenými providerovými přístupy;
- vytvářet obnovitelnou a reviewovatelnou práci.

Pokud tento test některá budoucí hosted varianta nesplňuje, musí být popsána
jako jiný provozní a trust kontrakt, ne jako neviditelně zmenšená verze
suverénního Residenta.

## Kde žije která pravda

| Druh informace | Kanonický domov |
| --- | --- |
| Konverzace | Zulip |
| Dlouhodobá znalost Residenta | GBrain |
| Software, dokumentace a review | GitHub |
| Plán, stav a odpovědnost | Mission Control |
| Provozní a obnovitelný runtime stav | Machine |
| Důvod zásadního rozhodnutí | decision record |

Tyto vrstvy se nemají automaticky kopírovat jedna do druhé. GBrain není kopie
Mission Controlu, Zulip není task ledger a Lazurio není vzdálený sklad veškeré
paměti Residenta.

Aktuální dokumentace má popisovat současný cílový model jednou. Historické
decision records smějí být složité; běžný Owner ani Agent nesmí potřebovat
rekonstruovat dnešní pravidlo z řetězce deseti novelizací.

## Generace nejsou cílové produkty

- **GEN2** je kohorta, která model provozně ověřuje a sbírá měřenou zkušenost.
- **GEN3** je první veřejně opakovatelná distribuce vzniklá z tohoto ověření.
- Cílový produkt se dlouhodobě jmenuje **Lazurio**, **Buddy** nebo **AI Kolega**,
  nikoli „GEN3 systém“.

Generační názvy mohou zůstat v historii a migračních repozitářích, ale nesmějí
se stát trvalou vrstvou architektury.

## Pravidla proti zbytečné složitosti

1. Nový mechanismus vzniká až pro konkrétní, změřený problém.
2. Providerová identita a grant mají přednost před vlastním paralelním ACL.
3. Jedna technická schopnost má jeden kanonický domov a jednoho ownera.
4. Oddělení uvnitř root Mašiny se nepopisuje jako bezpečnostní hranice.
5. Resident a Agent mají vždy rozlišitelnou identitu a atribuci.
6. Lazurio nesmí být skrytá runtime závislost suverénního Residenta.
7. Buddy a AI Kolega sdílejí runtime; rozdíl drží Owner, mandát a custody.
8. Do základní architektury nepatří přesný návrh funkce, kterou první kohorta
   ještě nepotřebovala.

## Kontrolní otázky pro další rozhodnutí

Každý nový návrh musí umět stručně odpovědět:

1. Kdo je Owner?
2. Která Machine je blast radius?
3. Kdo je Resident a jaký má mandát?
4. Který Agent vykonává práci a komu ji připisujeme?
5. Který provider vynucuje přístup?
6. Kde bude durable výsledek a kde případná paměť?
7. Funguje Resident dál, když Lazurio není dostupné?
8. Řeší nový mechanismus změřený problém, nebo jen představitelnou budoucnost?

Pokud návrh na tyto otázky neodpoví jednoduše, není připravený stát se součástí
základů Lazuria.
