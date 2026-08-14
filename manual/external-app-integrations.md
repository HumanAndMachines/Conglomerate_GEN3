# Napojení na externí aplikace: lokální MCP a CLI standard

Tento manuál je kanonický standard HumanAndMachine GEN3 pro připojování
Worker Agentů a Kolegů na externí aplikace (Gmail, Slack, Jira, Canva…).
Definuje závazné defaultní chování, žebříček výběru integrace, kde žijí
definice a kde přihlašovací artefakty. Harness-specifické detaily drží
[codex-manual-mcp-integrations.md](codex-manual-mcp-integrations.md) pro
Codex; per-provider postupy drží runbooky v [integrations/](integrations/).

## Závazné pravidlo

Napojení Organizace na externí aplikaci se dělá **primárně lokálně
definovaným MCP serverem nebo CLI nástrojem na konkrétní mašině**.

- **Nové napojení nikdy nezřizuj** přes ChatGPT pluginy/konektory ani
  claude.ai konektory. Jsou vázané na cloudový účet a sdílejí se přes
  všechny mašiny přihlášené tím účtem — přesný opak per-machine custody.
- **Už nainstalovaný konektor se používat smí.** Když na účtu/mašině
  funkční konektor existuje, agent s ním normálně pracuje — je to ale
  dočasný, ne cílový stav: preferovaná cesta je MCP/CLI z katalogu a při
  příležitosti navrhni Principálovi řízený přechod (postup v sekci
  „Přechod ze sdíleného integračního brokeru" Codex runbooku platí
  obdobně).
- **Nikdy** přes sdílený cloudový integrační broker — tedy jakoukoli službu
  nebo hostovaný agregátorový MCP, kde OAuth granty a tokeny drží třetí
  strana místo dané mašiny.
- Vzdálený MCP endpoint provozovaný **přímo poskytovatelem služby**
  (například Slack, Atlassian, Canva, Google) je v pořádku — pokud je
  definovaný v lokálním configu harnessu na dané mašině a OAuth grant vzniká
  a je revokovatelný per mašina. Rozhoduje místo konfigurace a custody
  tokenu, ne to, kde běží proces serveru.

Motivace: jeden Principál smí sdílet svůj ChatGPT/Claude účet a subscription
napříč svými mašinami, ale **přístupy k externím aplikacím zůstávají per
mašina**. Default deployment je „jedna mašina = jedna Organizace"; každá
mašina je samostatný, jednotlivě revokovatelný přístup. Multi-org mašina
(typicky root Principála) je povolená — separaci tam drží pojmenování
`<org_slug>_<provider>` a oddělené OAuth sessions.

## Žebříček výběru integrace

Při požadavku „napoj aplikaci X" postupuj v tomto pořadí a první funkční
úroveň vyhrává:

1. **Oficiální MCP server poskytovatele** — remote endpoint nebo oficiální
   self-hosted server.
2. **Oficiální CLI poskytovatele** (`gh`, `acli`, Google Workspace CLI…) —
   pro agenty se shell přístupem rovnocenná a často jednodušší cesta;
   credentials drží CLI lokálně stejně jako MCP server.
3. **Reviewnutý open-source MCP server nebo CLI** — jen s ukotvenou verzí
   (release/commit pin), ověřeným publisherem a licencí; komunitní server
   není „oficiální integrace" jen proto, že obsluhuje známou službu.
4. **Browser fallback** — čtení/obsluha webu agentem v browseru pod přímým
   dohledem Principála, když MCP/CLI cesta neexistuje.

**Zakázané v každém kroku:** servery postavené na scraping/cookie-session
přístupu (reuse browser session tokenů, obcházení bot detekce) — porušují
ToS poskytovatele a riskují ban účtu Organizace; sdílené brokery; zřizování
nových konektorů v cloud UI účtu.

**Když žádná MCP/CLI cesta neexistuje:** použij browser fallback, případně
existující už nainstalovaný konektor, a chybějící MCP zapiš jako issue/PR
živého standardu — nový konektor sám neinstaluj; jeho zřízení je vědomé
rozhodnutí Principála, ne automatický fallback agenta.

## Kde co žije

| Vrstva | Místo | V Gitu |
| --- | --- | --- |
| Pravidlo chování agentů | root `AGENTS.md`, tento manuál, skill `.agents/skills/external-app-integrations/` | ano |
| Kurátorovaný katalog Organizace | `organizations/<org>/INTEGRATIONS.md` + `organizations/<org>/.mcp.json` + `organizations/<org>/.codex/config.toml` | ano (org repo, bez secretů) |
| Osobní integrace Principála | user-level config harnessu (`~/.codex/config.toml`, user scope Claude Code) | ne |
| Per-machine aktivace | env soubor v custody cestě, OAuth consent, token cache | ne (gitignored/lokální) |
| Secrets | custody dle [security/local-secret-custody.md](security/local-secret-custody.md) | nikdy |

### Kurátorovaný katalog Organizace

Katalog je trackovaný v repu Organizace a je to jediné místo, kde se
schvaluje, **co** se smí připojovat:

- `INTEGRATIONS.md` — lidský katalog: schválené integrace, owner, scope,
  jména env proměnných, org-side admin kroky, datum schválení.
- `.mcp.json` — strojová definice pro Claude Code (project scope). Smí
  obsahovat jen příkazy, URL, argumenty a **jména** env proměnných přes
  `${VAR}` expanzi — nikdy hodnoty.
- `.codex/config.toml` — totéž pro Codex (načítá se jen v trusted projektu);
  `env_vars` nese jen jména proměnných.

Přidání nebo změna integrace v katalogu = PR ze worktree ke Stewardovi.
Tím je „manuálně kurátorované" vynucené procesně, ne jen konvencí.

Pojmenování: server `<org_slug>_<provider>` (např. `spectoda_slack`),
env proměnné `<ORG_SLUG>_<PROVIDER>_<PURPOSE>` (např.
`SPECTODA_GOOGLE_CLIENT_SECRET_PATH`). Jeden provider = jeden server;
Google Workspace pokrývá Gmail/Drive/Docs/Sheets/Slides jedním serverem.

### Per-machine aktivace

Definice z katalogu se na mašině stává funkční až lokální aktivací:

1. Env proměnné pro danou Organizaci drž v machine-local env souboru v
   custody cestě, například
   `organizations/<org>/company/colleagues/<os-user>/private/secrets/env/integrations.env`
   (mód `0600`); launcher nebo shell profil ho načítá před startem harnessu.
2. OAuth consent dokončuje **Principál v prohlížeči na té mašině** — agent
   připraví konfiguraci a diagnostiku, ale výběr účtu a souhlas je lidský
   krok (viz Human-action boundary v custody standardu). Před consentem agent
   ukáže přesný účet, účel a seznam scopes. Souhlas s OAuth grantem zpřístupní
   schopnost mašině; není to blanketní souhlas s každou budoucí akcí agenta.
3. Scopes uděluj defaultně **read i write** pro služby, které workflow
   Organizace potřebuje. Read-only start je volitelné zpřísnění pro
   mimořádně citlivé zdroje, ne default; LinkedIn zůstává post-only výjimka
   dle svého runbooku. Primární ochranu drží stejný kontrakt jako u kódu:
   **write agenta je Draft, ne Publikace**. Mechanické gaty se liší podle
   harnessu a formy integrace — konkrétní nastavení a jejich meze drží
   sekce „Draft a Publikace ve write operacích" níže; nastav je při
   aktivaci a ověř je ve smoke testu.
4. Token cache zůstává lokální a persistentní: u HTTP OAuth ji drží
   credential store harnessu (preferovaně systémový keyring), u STDIO
   integrace vlastní credentials directory serveru v custody. Tool-runtime
   cesty (`~/.google_workspace_mcp/…`, `~/.gmail-mcp/…`) nejsou custody
   source; runbook musí umět cache z custody obnovit a bezpečně rotovat.
   Dočasná cesta, memory-only/stateless backend ani agentní „zapamatování"
   přihlášení nenahrazují. Správná aktivace přežije restart MCP procesu,
   harnessu i mašiny a krátkodobý access token obnovuje refresh tokenem;
   provider však může refresh token legitimně zneplatnit podle své policy.
5. Mezi mašinami se nikdy nepřenáší token cache, client secrety ani celé
   uživatelské configy harnessu. Každá mašina = vlastní OAuth grant,
   revokovatelný u poskytovatele samostatně.

### Aktivace v Claude Code

- Katalogové servery Organizace načte Claude Code automaticky z `.mcp.json`
  v rootu org repa, když agent pracuje v checkoutu té Organizace; první
  použití na mašině potvrzuje Principál v approval promptu.
- **První approval serveru není per-action write gate.** Claude Code
  rozhoduje per tool přes permission pravidla `mcp__<server>__<tool>`.
  Write nástroje nikdy neschvaluj plošně („allow celý server"); zapiš je
  jmenovitě do `ask`, případně `deny`, a čtecí nástroje smíš dát do
  `allow`. Pravidla patří do settings toho scope, kterému integrace slouží
  (projektová `.claude/settings.json` Organizace, nebo user settings pro
  osobní integrace) — kontrakt harnessu ověř v jeho aktuální dokumentaci,
  názvy nástrojů vyčti z `/mcp`.
- Nastavení zapiš do `INTEGRATIONS.md` k dané integraci, ať je
  reprodukovatelné a ověřitelné i na další mašině.
- Osobní integrace přidávej do user scope
  (`claude mcp add --scope user <name> …`), ne do project scope
  Organizace.
- Konektory v claude.ai Settings → Connectors se pro org napojení
  **nepoužívají** — jsou vázané na claude.ai účet, ne na mašinu.

### Aktivace v Codexu

Postupuj podle [codex-manual-mcp-integrations.md](codex-manual-mcp-integrations.md):
`codex mcp add`, keyring OAuth store, approval mode `writes`/`prompt`,
per-machine onboarding a cutover ze sdíleného brokeru.

### CLI lane

CLI nástroje jsou rovnocenná forma integrace se stejnými pravidly custody
a stejným katalogem (zapisuj je do `INTEGRATIONS.md`):

- `gh` — GitHub (kanonický vzor),
- Google Workspace: oficiální [googleworkspace/cli](https://github.com/googleworkspace/cli)
  nebo komunitní [gog](https://github.com/steipete/gogcli) s nativním
  multi-account (`--account`),
- Atlassian: oficiální [acli](https://developer.atlassian.com/cloud/acli/),
- Microsoft 365: komunitní [CLI for Microsoft 365](https://pnp.github.io/cli-microsoft365/).

Agent CLI volá přes shell dané mašiny; přihlášení (`gh auth login`,
`gog auth add …`) dokončuje Principál. Výhoda: žádný další běžící proces,
credentials drží CLI ve vlastním lokálním úložišti, funguje ve všech
harnessech se shellem. Nevýhoda: bez typovaných tool schémat — pro
harness bez shellu použij MCP variantu.

**Pozor: MCP approval mode se na CLI nevztahuje.** Zápis provedený příkazem
v shellu není MCP tool call, takže ho `writes`/`prompt` ani permission
pravidla `mcp__…` nezachytí. Gate má tři úrovně a všechny platí:

1. **Shell permission pravidla harnessu** — write podpříkazy nikdy
   neallowlistuj plošně (`gog *`, `acli *`, `gh *`). Allowlistuj jen
   konkrétní čtecí příkazy; ostatní ať procházejí potvrzením.
2. **Draft forma výstupu** — CLI volej tak, aby výsledek byl vratný
   (draft místo odeslání, nový soubor místo přepisu, testovací cíl).
3. **Explicitní pokyn Principála** pro každou nevratnou operaci; u CLI je
   tohle procesní pravidlo hlavní gate, ne pojistka.

## Draft a Publikace ve write operacích

Write přístup není povolení publikovat. Platí stejný kontrakt jako u kódu
(root `AGENTS.md`, decisions 0090 a 0103): **co agent v externí aplikaci
vytvoří, je Draft — revertovatelný a editovatelný Principálem. Publikaci
dělá Principál, nebo agent, ale jen na jeho explicitní pokyn v daném
threadu.** Právě proto je write scope defaultní: proces, ne zúžený scope,
drží hranici.

Prakticky to znamená volit vratnou formu výstupu a nechat nevratný krok
Principálovi:

| Služba | Draft (agent smí sám) | Publikace (jen na explicitní pokyn) |
| --- | --- | --- |
| Gmail / Outlook | vytvořit draft zprávy, štítky, uspořádání | odeslat, smazat, hromadné operace |
| Slack | připravit znění, zapsat do testovacího kanálu | poslat do ostrého kanálu, DM, oznámení |
| Jira / Confluence | draft issue nebo stránky, komentář k review | přechod stavu, publikace stránky, mazání |
| Drive / Docs / Sheets | nový soubor nebo kopie k revizi, návrh úprav | přepis ostrého dokumentu, sdílení ven, mazání |
| Canva | nový design, export do drafts cesty | sdílení/zveřejnění, přepis týmového assetu |
| LinkedIn | draft příspěvku | publikace příspěvku |

Nevratné operace (odeslání, zveřejnění, mazání, přepis ostrého obsahu,
změna oprávnění) potvrzuje Principál per akci.

### Čím je write gate vynucený — a čím ne

Mechanická vrstva se liší podle harnessu a formy integrace. Nepředpokládej
jednotný „approval mode"; při aktivaci nastav to, co daná cesta skutečně
nabízí, a zapiš to k integraci do `INTEGRATIONS.md`:

| Cesta | Mechanický gate | Co gate nepokrývá |
| --- | --- | --- |
| MCP v Codexu | `default_tools_approval_mode = "writes"` / `"prompt"`, výběr `enabled_tools` | nic mimo MCP tool cally |
| MCP v Claude Code | permission pravidla per nástroj (`mcp__<server>__<tool>` v `ask`/`deny`), výběr povolených serverů | plošné „allow serveru" gate ruší |
| CLI přes shell | permission pravidla shellu daného harnessu (allowlist jen čtecích příkazů) | MCP approval mode se **neuplatní** |
| Browser fallback | přímý dohled Principála u obrazovky | nic automatického |

**Udělený OAuth grant je schopnost mašiny, ne agenta.** Token v lokálním
úložišti může použít kterýkoli proces, který na něj dosáhne — CLI, Buddy,
skript, jiný harness. Approval mode proto **není bezpečnostní hranice vůči
ostatním procesům na mašině**; je to gate uvnitř jednoho harnessu. Skutečné
hranice udělených scopes jsou: rozsah samotného grantu, custody souborů
(`0600`/`0700`), rychlá revokace u poskytovatele a procesní pravidlo
Draft → Publikace, kterým se řídí každý agent i Buddy (Buddy navíc v rámci
svých mandátů). U scopes, jejichž zneužití by bylo nevratné a drahé
(mazání, správa oprávnění, admin operace), scope neuděluj vůbec — to je
jediná spolehlivá ochrana.

### Smoke testy: vratný cíl a úklid

Write smoke nedělej na ostrém obsahu. Použij k tomu určený jednorázový cíl
— testovací kanál, scratch složku nebo drafts cestu, sandbox projekt/space,
vlastní draft. Cíl použitý pro smoke zapiš do `INTEGRATIONS.md`, ať ho další
mašina používá taky a nevzniká nepořádek ani zbytečné notifikace
v produkčních prostorech Organizace.

**Výjimka pro úklid určeného smoke artefaktu:** když Principál výslovně
schválil tento jmenovitý smoke cíl, patří do téže schválené operace i úklid
artefaktu, který agent v tomto konkrétním smoke sám vytvořil (draft, testovací
zpráva nebo testovací záznam). Agent jej smí po ověření odstranit; nejde o
samostatnou Publikaci ani o obecné oprávnění mazat. Výjimka se nikdy netýká
existujícího, ostrého nebo cizího obsahu. Není-li cíl jmenovitě určený v
`INTEGRATIONS.md`, původ artefaktu není prokazatelný nebo úklid zasahuje mimo
tento smoke, artefakt ponech a vyžádej si samostatný explicitní pokyn
Principála.

## Org-side admin kroky

Některé služby vyžadují jednorázové povolení na straně Organizace; patří do
onboarding checklistu Organizace, ne do per-machine kroků:

| Služba | Admin krok |
| --- | --- |
| Slack | Admin workspace schvaluje MCP klienta (aplikaci) v app managementu |
| Atlassian | Org admin spravuje MCP přístup (allowlist klientů, API-token toggle) v Atlassian Administration |
| Canva | Admin týmu povoluje „AI Connector" v Controls and Permissions |
| Microsoft 365 | Tenant consent policy může vyžadovat admin souhlas s app registrací |
| Google Workspace | Organizace vlastní GCP projekt s OAuth clientem; admin řídí povolená API a scopes |

## Osobní integrace (personalspace scope)

Integrace, které nepatří žádné Organizaci (osobní Gmail, osobní kalendář…),
patří do personalspace scope: definice v user-level configu harnessu,
secrets v `personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>`,
naming `personal_<provider>`. Do org katalogů se nezapisují a org agenti je
nepoužívají; personalspace izolace má přednost.

## Per-provider runbooky

| Runbook | Pokrývá |
| --- | --- |
| [integrations/google-workspace.md](integrations/google-workspace.md) | Gmail, Drive, Docs, Sheets, Slides, Meet |
| [integrations/microsoft-365.md](integrations/microsoft-365.md) | Outlook mail a kalendář, M365 |
| [integrations/slack.md](integrations/slack.md) | Slack |
| [integrations/atlassian.md](integrations/atlassian.md) | Jira, Confluence |
| [integrations/linkedin.md](integrations/linkedin.md) | LinkedIn (post-only + browser fallback) |
| [integrations/canva.md](integrations/canva.md) | Canva |

Stav každého runbooku odpovídá datu uvedenému v jeho úvodní hlavičce; před
instalací zkontroluj aktuální dokumentaci poskytovatele.

## Živý standard: zpětná vazba z instalací je povinná

Externí aplikace a jejich MCP/CLI ekosystém se mění rychleji, než je kdokoli
schopen průběžně přetestovávat. Tenhle manuál i runbooky jsou **komunitní
standard HumanAndMachine** a žijí z reálných instalací — nikdo je centrálně
denně neověřuje. Proto pro každého agenta platí:

1. Když se Kolega během napojování na čemkoli zasekne, nebo narazíš na
   chybu manuálu, zastaralý endpoint, změněnou verzi/scope či jiné chování
   poskytovatele, **nenech to jen v chatu**.
2. Znáš-li řešení nebo aktualizaci, oprav runbook/manuál a pošli PR na
   `HumanAndMachines/Lazurio` (platí worktree disciplína). Do PR
   popiš, co se stalo, na čem se Kolega zasekl, jak se to projevovalo a jak
   je oprava ověřená — metadata-only, žádné secrets, tokeny ani screenshoty
   s citlivým obsahem.
3. Neznáš-li řešení, zapiš aspoň issue do root `ISSUES.open.json` (také PR)
   s popisem zaseknutí a případným workaroundem.
4. Org-specifika (jiné admin kroky, plán, licence) patří do `INTEGRATIONS.md`
   katalogu dané Organizace; do root runbooků jde jen generalizované a
   anonymizované poučení — nikdy org data.

Oprava poslaná upstream se dostane ke všem uživatelům HumanAndMachine;
poznatek zamčený v jedné mašině nebo jednom chatu je ztracený.

## Odebrání, rotace, incident a closeout

Platí postup z [codex-manual-mcp-integrations.md](codex-manual-mcp-integrations.md)
(sekce „Odebrání, rotace a incident") pro všechny harnessy: odhlásit a
odebrat lokální konfiguraci, revokovat grant u poskytovatele, rotovat
lokální cache, ověřit nový task. Closeout je vždy metadata-only: název
serveru, scope, owner, datum, výsledek — nikdy token, callback URL ani
obsah credential souboru.
