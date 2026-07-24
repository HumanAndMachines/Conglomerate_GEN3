# Canva

Stav ověřen 2026-07-24.

## Možnosti

| Tvar | Co to je | Poznámka |
| --- | --- | --- |
| Oficiální remote MCP | Canva Design MCP Server: `https://mcp.canva.com/mcp` (Streamable HTTP) ([docs](https://www.canva.dev/docs/mcp/)) | Generování a editace designů, search, export PDF/PNG/JPG/PPTX/MP4, brand templates (Pro+), autofill (Enterprise) |
| OSS | žádná seriózní alternativa | Komunitní „Canva MCP" repa jsou tenké wrappery — nepoužívat |

## Doporučená volba

**Oficiální Canva MCP server** — jediná reálná varianta. Per-user OAuth,
operace omezené právy přihlášeného uživatele; rate limity publikované per
tool (čtení ~100/min, zápisy/exporty 20–60/min,
[přehled](https://www.canva.dev/docs/mcp/tools/)).

## Org-side kroky

1. Na Teams/Education/Enterprise plánech admin povoluje „AI Connector" v
   Controls and Permissions ([návod](https://www.canva.com/help/mcp-agent-setup/)).
2. Autofill vyžaduje Enterprise; resize a brand kits Pro+ — zapiš do
   `INTEGRATIONS.md`, co plán Organizace reálně umí.

## Per-machine aktivace

Katalogový zápis v org `.mcp.json`:

```json
{
  "mcpServers": {
    "<org_slug>_canva": {
      "type": "http",
      "url": "https://mcp.canva.com/mcp"
    }
  }
}
```

Codex: `codex mcp add <org_slug>_canva --url https://mcp.canva.com/mcp` +
`codex mcp login`. OAuth consent dokončuje Principál účtem Organizace
(správný tým!). Multi-org mašina: OAuth je origin-keyed jako u Atlassianu —
víc Canva účtů na jedné mašině řeš oddělenými harness profily, nebo drž
Canva na org-dedikovaných mašinách.

## Smoke test

Smoke začni searchem vlastních designů a pokračuj vytvořením testovacího
designu — write je od začátku povolený. Export směřuj do custody/drafts
cesty, ne do sdílených složek.

## Custody a rizika

- OAuth token drží harness (keyring); revoke v Canva účtu (Connected apps).
- Export tools zapisují soubory — cílové cesty drž v drafts/custody, ať
  agent nepřepisuje sdílený obsah.
