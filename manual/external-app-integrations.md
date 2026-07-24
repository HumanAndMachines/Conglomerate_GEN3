# Napojení na externí aplikace: lokální MCP a CLI standard

Tento manuál je kanonický standard HumanAndMachine GEN3 pro připojování
Worker Agentů a Kolegů na externí aplikace (Gmail, Slack, Jira, Canva…).
Definuje závazné defaultní chování, žebříček výběru integrace, kde žijí
definice a kde přihlašovací artefakty. Harness-specifické detaily drží
[codex-manual-mcp-integrations.md](codex-manual-mcp-integrations.md) pro
Codex; per-provider postupy drží runbooky v [integrations/](integrations/).

## Závazné pravidlo

Napojení Organizace na externí aplikaci se dělá **výhradně lokálně
definovaným MCP serverem nebo CLI nástrojem na konkrétní mašině**.

- **Nikdy** přes ChatGPT pluginy/konektory ani claude.ai konektory. Ty jsou
  vázané na cloudový účet a sdílejí se přes všechny mašiny přihlášené tím
  účtem — přesný opak per-machine custody.
- **Nikdy** přes sdílený cloudový integrační broker (Composio-like služba,
  Zapier/Pipedream remote MCP apod.), kde tokeny drží třetí strana.
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
ToS poskytovatele a riskují ban účtu Organizace; sdílené brokery; konektory
konfigurované v cloud UI účtu.

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
   krok (viz Human-action boundary v custody standardu).
3. Token cache zůstává lokální (keyring harnessu, případně custody cesta
   serveru). Tool-runtime cesty (`~/.google_workspace_mcp/…`,
   `~/.gmail-mcp/…`) nejsou custody source; runbook musí umět cache z
   custody obnovit a bezpečně rotovat.
4. Mezi mašinami se nikdy nepřenáší token cache, client secrety ani celé
   uživatelské configy harnessu. Každá mašina = vlastní OAuth grant,
   revokovatelný u poskytovatele samostatně.

### Aktivace v Claude Code

- Katalogové servery Organizace načte Claude Code automaticky z `.mcp.json`
  v rootu org repa, když agent pracuje v checkoutu té Organizace; první
  použití na mašině potvrzuje Principál v approval promptu.
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

Stav ekosystému v runboocích odpovídá ověření k 2026-07-24; před instalací
zkontroluj aktuální dokumentaci poskytovatele.

## Živý standard: zpětná vazba z instalací je povinná

Externí aplikace a jejich MCP/CLI ekosystém se mění rychleji, než je kdokoli
schopen průběžně přetestovávat. Tenhle manuál i runbooky jsou **komunitní
standard HumanAndMachine** a žijí z reálných instalací — nikdo je centrálně
denně neověřuje. Proto pro každého agenta platí:

1. Když se Kolega během napojování na čemkoli zasekne, nebo narazíš na
   chybu manuálu, zastaralý endpoint, změněnou verzi/scope či jiné chování
   poskytovatele, **nenech to jen v chatu**.
2. Znáš-li řešení nebo aktualizaci, oprav runbook/manuál a pošli PR na
   `HumanAndMachines/Conglomerate_GEN3` (platí worktree disciplína). Do PR
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
