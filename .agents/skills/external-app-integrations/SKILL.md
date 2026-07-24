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

1. **Nikdy nevol cloudový konektor.** ChatGPT pluginy/konektory, claude.ai
   konektory a sdílené brokery (Composio-like) jsou zakázané pro org
   napojení — jsou vázané na cloudový účet, ne na mašinu. Chtěný stav:
   každá mašina má vlastní, samostatně revokovatelná napojení pro svou
   Organizaci; identita a subscription harnessu se sdílet smí, přístupy k
   externím aplikacím ne.
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
   OAuth consent a výběr účtu dokončuje Principál v prohlížeči; začni
   read-only a nejmenšími scopes; write až po samostatném souhlasu.
6. **Closeout metadata-only:** název serveru, scope, owner, datum, výsledek
   smoke testu. Nikdy token, OAuth URL/kód ani obsah credential souboru.

## Ověření

- Server je vidět (`codex mcp list` / `/mcp` v Claude Code) a read-only
  smoke prošel na známém záznamu správného org účtu.
- Katalog Organizace obsahuje integraci včetně env jmen a admin kroků;
  žádný secret v Gitu (`git grep` na jméno env souboru a provider).
- Env soubor a token cache mají módy `0600`/`0700` v custody cestě.
- V handoffu je PR URL katalogové změny, nebo důvod, proč nebyla potřeba.
