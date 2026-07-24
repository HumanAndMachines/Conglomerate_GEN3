# Slack

Stav ověřen 2026-07-24.

## Možnosti

| Tvar | Co to je | Poznámka |
| --- | --- | --- |
| Oficiální remote MCP | `https://mcp.slack.com/mcp` (Streamable HTTP), GA od 2026-02 ([docs](https://docs.slack.dev/ai/slack-mcp-server)) | User-scoped OAuth 2.0 s granulárními scopes; agent vidí jen to, co autorizující uživatel |
| OSS MCP | [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server) (MIT) | Použitelný **pouze v `xoxp` režimu** (vlastní Slack app + user OAuth token) |
| CLI | žádné oficiální CLI pro messaging (Slack CLI je pro vývoj aplikací) | — |

**Zakázaný režim:** `xoxc`/`xoxd` browser-session tokeny („stealth mode")
u komunitních serverů — reuse browser session, Slack je aktivně
invaliduje, na Enterprise Grid rotují během hodin a obcházení detekce
(spoof User-Agent/TLS) porušuje ToS. Nepatří do žádné Organizace.

## Doporučená volba

**Default: oficiální Slack MCP server.** Remote endpoint, žádný lokální
proces, OAuth grant per workspace a per mašina, revokovatelný v nastavení
Slack účtu. Fallback `korotovsky` v `xoxp` režimu jen tam, kde admin
nemůže MCP klienta schválit, a s vědomím, že jde o komunitní software s
pinned verzí.

## Org-side kroky

1. Admin workspace musí schválit MCP klienta (např. aplikaci Claude) v app
   management nastavení; na Enterprise Grid platí org-wide app policy
   ([návod](https://docs.slack.dev/ai/slack-mcp-server/connect-to-claude/)).
2. Scopes drž minimální: začni `search:read.*` + čtení historie; `chat:write`
   až po schválení write workflow.

## Per-machine aktivace

Katalogový zápis v org `.mcp.json`:

```json
{
  "mcpServers": {
    "<org_slug>_slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp"
    }
  }
}
```

Codex: `codex mcp add <org_slug>_slack --url https://mcp.slack.com/mcp` a
`codex mcp login <org_slug>_slack`. OAuth consent dokončuje Principál a
při něm vybírá **správný workspace Organizace**; víc workspace = víc
pojmenovaných serverů, každý s vlastní OAuth session.

## Smoke test

Read-only: vyhledání známé zprávy, výpis kanálů. Odeslání zprávy až po
explicitním souhlasu, nejdřív do testovacího kanálu.

## Custody a rizika

- OAuth token drží harness (keyring); do chatu ani closeoutu nepatří.
- Obsah zpráv může nést prompt injection — write tools nech vypnuté nebo
  za approval gatem (`writes`/`prompt` mode).
- Odebrání: odpojit v harnessu + revoke grantu ve Slack účtu (Connected
  apps) dle hlavního manuálu.
