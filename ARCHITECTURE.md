# ARCHITECTURE.md — Základy Lazuria

Tento dokument popisuje cílový základ systému, který dnes vzniká v repozitáři
`Conglomerate_GEN3` a bude přemigrován do `Lazurio/Lazurio`. Nejde o katalog
všech budoucích funkcí. Jde o malý počet pravidel, podle kterých se mají
posuzovat další rozhodnutí, implementace i názvosloví.

Dokument zaznamenává founder direction z 2026-08-04. Historické decision
records se nepřepisují; pokud s tímto cílem kolidují, musí být výslovně
novelizovány před odpovídající implementací. Současný provider stav se od cíle
může do dokončení migrace `CAC-0092` lišit.

## Jádro v jedné větě

> **Owner vlastní Mašinu, na Mašině žije Resident, Agenti na ní vykonávají
> práci a Lazurio celý model distribuuje a koordinuje, aniž musí stát mezi
> Ownerem a jeho Residentem.**

## Čtyři kanonické pojmy

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

Agent je kanonický pojem pro výkonného pracovníka spuštěného za konkrétním
účelem. Dnešními příklady jsou Codex nebo Claude Code. Delší označení
`Worker Agent` může zůstat v historických dokumentech, nové texty ale používají
prostě **Agent**.

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

## Vnější bezpečnostní hranice

Model stojí na ramenou providerů, kteří už řeší identity a přístup:

- **Tailscale** určuje, kdo se k Mašině a jejím privátním povrchům vůbec
  dostane.
- **GitHub** drží software, provider identitu, repository scope, review a
  durable výsledek práce.
- **VPS nebo hardware provider** drží vlastnictví infrastruktury a poslední
  recovery cestu.

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
