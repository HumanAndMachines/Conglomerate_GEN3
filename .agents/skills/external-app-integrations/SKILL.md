---
name: external-app-integrations
description: Závazný postup pro napojení externí aplikace (Gmail, Slack, Jira, Canva…) — vždy lokálně kurátorovaný MCP server nebo CLI na dané mašině, nikdy ChatGPT/claude.ai konektor ani cloudový broker. Použij při každém požadavku „napoj/připoj aplikaci X" nebo když úkol potřebuje data z externí služby bez existujícího napojení.
---

# External app integrations

## Kdy použít

Kolega chce připojit externí aplikaci, nebo úkol vyžaduje externí službu,
která na mašině není napojená. Platí pro všechny harnessy (Claude Code,
Codex, Desktop agenti). Kanonický standard:
`manual/external-app-integrations.md`; per-provider runbooky:
`manual/integrations/`.

## Postup

1. **Preferuj MCP/CLI; nový konektor nikdy neinstaluj.** ChatGPT/claude.ai
   konektory jsou vázané na cloudový účet, ne na mašinu; sdílené cloudové
   brokery třetích stran jsou zakázané vždy. Konektor, který už je
   nainstalovaný, klidně použij k práci — nové ale nezřizuj: když MCP/CLI
   cesta chybí, použij browser fallback a chybějící MCP zapiš jako issue/PR
   živého standardu (krok 8); zřízení nového konektoru je rozhodnutí
   Principála, ne automatický fallback agenta. Chtěný stav: každá mašina má
   vlastní, samostatně revokovatelná napojení pro svou Organizaci; identita
   a subscription harnessu se sdílet smí, přístupy k externím aplikacím ne.
2. **Urči scope.** Organizace → pokračuj katalogem té Organizace
   (`INTEGRATIONS.md`, `.mcp.json`, `.codex/config.toml` v jejím repu).
   Osobní → personalspace scope a user-level config; do org katalogu
   nepatří.
3. **Podívej se do katalogu dřív, než něco instaluješ.** Když integrace v
   katalogu je, jen ji per-machine aktivuj (env z custody, OAuth consent
   Principála, smoke test). Když není, vyber ji žebříčkem: oficiální MCP →
   oficiální CLI → reviewnutý pinned OSS MCP/CLI → browser fallback.
   Scraping/cookie-session servery nikdy (LinkedIn read-only viz
   `manual/integrations/linkedin.md`).
4. **Novou integraci naveď přes katalog, ne obejitím.** Přidání do
   `INTEGRATIONS.md` + `.mcp.json`/`.codex/config.toml` (jen jména env
   proměnných, žádné hodnoty) je PR ze worktree ke Stewardovi; org-side
   admin kroky (Slack app approval, Atlassian allowlist, Canva AI
   Connector, GCP OAuth client) vypiš do PR jako checklist.
5. **Aktivace per mašina:** jména `<org_slug>_<provider>`; secret hodnoty a
   env soubor do custody cest podle `manual/security/local-secret-custody.md`;
   OAuth consent a výběr účtu dokončuje Principál v prohlížeči. Před
   consentem mu ukaž přesný seznam scopes; defaultně žádej potřebné read i
   write scopes (LinkedIn zůstává post-only výjimka). Udělený OAuth grant je
   schopnost mašiny, ne souhlas s libovolnou konkrétní operací.
6. **Přihlášení musí přežít běžný restart.** U HTTP OAuth ověř persistentní
   credential store harnessu (preferovaně systémový keyring), u STDIO serveru
   jeho vlastní persistentní credentials directory. Dočasná cesta,
   memory-only/stateless backend ani pouhé zapamatování agentem nejsou
   persistence. Ověř restart serveru, harnessu nebo nový task; provider může
   refresh token přesto později legitimně zneplatnit. Provider-specifické
   limity, například sedmidenní Google OAuth `External / Testing`, patří do
   příslušného runbooku.
7. **Write je Draft, ne Publikace.** Co v externí aplikaci vytvoříš, musí
   být vratné a editovatelné Principálem — draft zprávy místo odeslání,
   nový soubor místo přepisu ostrého, testovací kanál místo ostrého.
   Nevratný krok (odeslat, zveřejnit, smazat, přepsat ostrý obsah, změnit
   oprávnění) udělej jen na explicitní pokyn Principála v daném threadu.
   Mechanický gate se liší podle cesty (Codex approval mode, Claude Code
   permission pravidla per `mcp__<server>__<tool>`, u CLI jen shell
   permissions — MCP approval mode se na CLI nevztahuje) a udělený OAuth
   grant je schopnost celé mašiny, ne jen agenta; procesní pravidlo je
   proto hlavní hranice, ne pojistka. Tabulky Draft/Publikace, gate per
   cesta a pravidlo vratného smoke cíle jsou v
   `manual/external-app-integrations.md`.
8. **Zaseknutí nebo zastaralý manuál = povinný upstream PR.** Runbooky jsou
   živý komunitní standard; nikdo je denně nepřetestovává. Když se Kolega
   při instalaci zasekne nebo realita poskytovatele neodpovídá runbooku,
   oprav manuál/runbook a pošli PR na `HumanAndMachines/Conglomerate_GEN3`;
   bez známého řešení zapiš aspoň issue do root `ISSUES.open.json` (také
   PR). Org-specifika patří do `INTEGRATIONS.md` dané Organizace; upstream
   jde jen generalizované, anonymizované poučení bez secrets.
9. **Closeout metadata-only:** název serveru, scope, owner, datum, výsledek
   smoke testu. Nikdy token, OAuth URL/kód ani obsah credential souboru.

## Ověření

- Server je vidět (`codex mcp list` / `/mcp` v Claude Code) a smoke prošel:
  čtení známého záznamu správného org účtu, zápis na **jednorázovém cíli**
  (testovací kanál, scratch složka, draft sobě) vratnou formou, bez
  nevratné publikace. Artefakt smíš po ověření uklidit jen když Principál
  výslovně schválil jmenovitý smoke cíl zapsaný v `INTEGRATIONS.md` a
  artefakt vytvořil tento konkrétní smoke. Jinak artefakt ponech a vyžádej
  si samostatný explicitní pokyn Principála.
- Write gate je nastavený podle cesty a zapsaný v `INTEGRATIONS.md`: v
  Claude Code write nástroje v `ask`/`deny` (nikdy plošné allow serveru),
  v Codexu `writes`/`prompt`, u CLI allowlist jen čtecích příkazů.
- Katalog Organizace obsahuje integraci včetně env jmen a admin kroků;
  žádný secret v Gitu (`git grep` na jméno env souboru a provider).
- Env soubor a token cache mají módy `0600`/`0700` v custody cestě.
- Přihlášení přežilo restart MCP procesu a nový task nebo restart harnessu;
  closeout rozlišuje okamžitě ověřený restart smoke od provider expirace,
  kterou lze prokázat až po uplynutí příslušného intervalu.
- V handoffu je PR URL katalogové změny, nebo důvod, proč nebyla potřeba.
