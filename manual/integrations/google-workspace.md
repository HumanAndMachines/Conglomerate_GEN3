# Google Workspace: Gmail, Drive, Docs, Sheets, Slides, Meet

Jeden provider pokrývá šest služeb. Stav ověřen 2026-07-24.

## Možnosti

| Tvar | Co to je | Poznámka |
| --- | --- | --- |
| Oficiální remote MCP | Per-služba endpointy `https://gmailmcp.googleapis.com/mcp/v1`, `drivemcp`, `docsmcp`, `sheetsmcp`, `slidesmcp`, `calendarmcp` (Streamable HTTP) | Developer Preview; vlastní GCP projekt + vlastní OAuth client; scopes per služba ([dokumentace](https://developers.google.com/workspace/guides/configure-mcp-servers)) |
| Oficiální CLI | [googleworkspace/cli](https://github.com/googleworkspace/cli) | Generované z Google Discovery Service |
| OSS MCP | [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) (MIT) | STDIO/HTTP, `uvx workspace-mcp`, multi-account per tool call (`user_google_email`), `--read-only`, `--tool-tier` |
| OSS CLI | [gog](https://github.com/steipete/gogcli) | `--account` multi-account, JSON výstup, brew instalace |
| Meet | **žádný MCP neexistuje** (oficiální ani udržovaný komunitní) | Meet linky vytvářej přes Calendar tools; zbytek browser fallback |

Vyřazené: `GongRzhe/Gmail-MCP-Server` (archivováno 2026-03), hosted
agregátory (broker drží tokeny — zakázáno standardem).

## Doporučená volba

- **Default pro Organizaci:** oficiální remote MCP endpointy s vlastním
  OAuth clientem Organizace. Jedna OAuth session = jeden Google účet, což na
  mašině vázané na jednu Organizaci přesně sedí.
- **Multi-org mašina nebo potřeba jemnějších tool tierů:** OSS
  `workspace-mcp` s pinned verzí — účet se volí per tool call, takže vedle
  sebe fungují účty více Organizací; per-org oddělení jmen serverů a
  credentials dirs zůstává povinné.
- **Shell-first práce a skripty:** `gog` nebo oficiální CLI; `gog auth add
  <ucet>` per Organizace.

## Org-side kroky (jednou per Organizace)

1. Organizace má vlastní GCP projekt; admin povolí potřebná API (+ u remote
   MCP příslušné `*mcp.googleapis.com` API) a nastaví OAuth consent screen.
2. Vytvoř OAuth client (Desktop pro lokální STDIO/CLI, Web pro remote MCP
   dle dokumentace); client JSON ulož do custody cesty Organizace, nikdy do
   repa.
3. Scopes uděluj defaultně read i write pro používané služby
   (`gmail.modify`/`gmail.send`, `drive`, `spreadsheets`… dle workflow);
   per-action ochranu write tools drží approval mode harnessu.

## Per-machine aktivace

Katalogový zápis v org `.mcp.json` (Claude Code), OSS varianta:

```json
{
  "mcpServers": {
    "<org_slug>_google_workspace": {
      "command": "uvx",
      "args": ["--from", "workspace-mcp==<reviewed-version>", "workspace-mcp", "--single-user", "--tool-tier", "core"],
      "env": {
        "GOOGLE_CLIENT_SECRET_PATH": "${<ORG_SLUG>_GOOGLE_CLIENT_SECRET_PATH}",
        "GOOGLE_MCP_CREDENTIALS_DIR": "${<ORG_SLUG>_GOOGLE_MCP_CREDENTIALS_DIR}"
      }
    }
  }
}
```

Codex ekvivalent viz příklad B v
[codex-manual-mcp-integrations.md](../codex-manual-mcp-integrations.md).
Env hodnoty patří do machine-local `integrations.env` v custody; OAuth
consent dokončuje Principál v prohlížeči a ověří správný org účet.

CLI aktivace: `gog auth credentials <cesta-k-client-json>` +
`gog auth add <ucet-organizace>`; credentials custody platí stejně.

## Smoke test

Smoke začni čtením (výpis Gmail labelů, `search_drive_files` na známý
soubor, čtení známé Sheet range) a pokračuj zápisem na neprodukčním obsahu
(draft e-mailu, testovací buňka) — write je od začátku povolený.

## Custody a rizika

- Token cache OSS serveru (`~/.google_workspace_mcp/credentials/`) je
  plaintext — drž módy `0600`, cache je runtime, ne custody source.
- Write tools (send mail, create file) jsou exfiltrační kanál při prompt
  injection — per-action je potvrzuje approval mode harnessu; u citlivých
  workflow zúžíš sadu přes `enabled_tools`.
- Odebrání/rotace: revoke grantu v Google Account / GCP, smazání lokální
  cache, viz kanonický postup v hlavním manuálu.
