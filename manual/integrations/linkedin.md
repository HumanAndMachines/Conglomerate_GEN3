# LinkedIn

Stav ověřen 2026-07-24. LinkedIn je výjimka ze standardního žebříčku:
plnohodnotná compliant integrace neexistuje.

## Realita API

- **Žádný oficiální LinkedIn MCP server neexistuje.** Oficiální API je
  restriktivní: self-serve přístup dává jen Sign In (OIDC) a „Share on
  LinkedIn" (`w_member_social` — publikování jménem člena). Čtení cizích
  profilů, search, feed a messaging vyžadují partner program.
- Komunitní servery s bohatými funkcemi (profily, search, inbox) fungují
  přes **reuse přihlášené browser session** — LinkedIn User Agreement
  automatizovaný přístup zakazuje a účty za něj omezuje nebo banuje.

## Závazná policy

1. **Do katalogu Organizace patří jen post-only integrace přes oficiální
   API** (OAuth 2.0, scope `w_member_social`, tedy „Share on LinkedIn"):
   výhradně vytvoření příspěvku jménem člena. Komentáře, reakce ani žádné
   další operace do org výbavy nepatří, i když je nějaký server nabízí —
   přes `enabled_tools` povol jen vytvoření příspěvku. Vlastní LinkedIn app
   Organizace, tokeny v custody. Minimal OSS příklad:
   [souravdasbiswas/linkedin-mcp-server](https://github.com/souravdasbiswas/linkedin-mcp-server)
   (MIT, oficiální API only) — před nasazením reviewnout, pinnout a omezit
   na post tools, nebo napsat vlastní tenký wrapper.
2. **Čtení LinkedInu dělá agent výhradně browser fallbackem** (vestavěný
   browser povrch harnessu) **pod přímým dohledem Principála**, v běžné
   přihlášené session Principála. Session/cookies se nikdy nepředávají
   žádnému MCP procesu ani nástroji.
3. **Cookie/scraping MCP servery jsou zakázané** bez ohledu na popularitu
   (`stickerdaniel/linkedin-mcp-server` a podobné) — riziko banu účtu
   Organizace a porušení ToS.

## Org-side kroky

1. Organizace založí LinkedIn Developer app, projde review pro
   `w_member_social`; client credentials do custody.
2. Publikační workflow (kdo schvaluje drafty příspěvků) zapsat do
   `INTEGRATIONS.md` — publikace na LinkedIn je Publikace ve smyslu root
   pravidel: dělá ji Principál, nebo agent jen na explicitní pokyn.

## Per-machine aktivace

Post-only server jako lokální STDIO proces s pinned verzí; env jména
`<ORG_SLUG>_LINKEDIN_CLIENT_ID_PATH` apod. v katalogu, hodnoty a token
store (SQLite/JSON) v custody cestě s módem `0600`. OAuth consent
dokončuje Principál.

## Smoke test

Žádné API čtení — čtení LinkedInu patří výhradně do browser fallbacku.
Jednorázové zjištění member URN při OAuth consentu (userinfo) je aktivační
krok napojení, ne čtecí workflow; URN se uloží do custody a dál se
nedotazuje. Smoke je metadata-only: ověř, že token platí, a připrav draft
payload příspěvku **bez odeslání**. Skutečná publikace jen na explicitní
pokyn Principála v daném threadu, poprvé na testovacím obsahu.

## Custody a rizika

- Access token (60denní) rotovat a držet v custody; revoke v LinkedIn
  Settings → Permitted services.
- Rate limit dev tieru (~500 volání/den) — integrace je publikační, ne
  datová.
- Jakýkoli požadavek „stáhni data z LinkedInu přes MCP" eskaluj
  Principálovi s odkazem na tuto policy místo hledání obcházky.
