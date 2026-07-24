# Atlassian: Jira a Confluence

Stav ověřen 2026-07-24.

## Možnosti

| Tvar | Co to je | Poznámka |
| --- | --- | --- |
| Oficiální remote MCP | Atlassian Rovo MCP Server, GA od 2026-02: `https://mcp.atlassian.com/v1/mcp/authv2` (OAuth 2.1) / `…/v1/mcp` (API token) ([docs](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/), [repo](https://github.com/atlassian/atlassian-mcp-server)) | Jira + Confluence (+ JSM/Bitbucket přes API tokeny); legacy `…/v1/sse` je deprecated |
| OSS MCP | [sooperset/mcp-atlassian](https://github.com/sooperset/mcp-atlassian) (MIT) | Jediná seriózní volba pro Server/Data Center; credentials per instance přes env → čistá per-org separace |
| Oficiální CLI | [acli](https://developer.atlassian.com/cloud/acli/) | GA pro Jira, roste na Confluence |

## Doporučená volba

- **Cloud Organizace (default): oficiální Rovo MCP `authv2`.** OAuth 2.1,
  práva zrcadlí práva přihlášeného uživatele, žádný lokální proces.
- **Multi-org mašina:** oficiální endpoint má OAuth vázaný na origin URL a
  jednu site per připojení — víc Atlassian sites na jedné mašině se v
  některých klientech tluče. Tam nasaď `sooperset/mcp-atlassian`: jedna
  pojmenovaná instance per Organizace s vlastními env credentials.
- **Server/Data Center:** `sooperset/mcp-atlassian` s PAT.
- **Shell-first:** oficiální `acli`.

## Org-side kroky

1. Org admin spravuje Rovo MCP v Atlassian Administration: allowlist
   OAuth klientů (domén), toggle API-token auth, revokace Connected Apps,
   audit logy ([nastavení](https://support.atlassian.com/security-and-access-policies/docs/control-atlassian-rovo-mcp-server-settings/)).
2. Rate limity oficiálního serveru nejsou publikované a chovají se jako
   concurrency cap — masivní paralelní volání plánuj s retry/backoff.

## Per-machine aktivace

Katalogový zápis v org `.mcp.json`:

```json
{
  "mcpServers": {
    "<org_slug>_atlassian": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp/authv2"
    }
  }
}
```

Codex: `codex mcp add <org_slug>_atlassian --url https://mcp.atlassian.com/v1/mcp/authv2`
+ `codex mcp login`. OAuth consent dokončuje Principál a vybírá správnou
site Organizace.

Sooperset varianta (multi-org/DC): pinned Docker image nebo `uvx`, env
jména `<ORG_SLUG>_JIRA_URL`, `<ORG_SLUG>_ATLASSIAN_TOKEN` apod. v katalogu,
hodnoty v custody env souboru.

## Smoke test

Read-only: přečtení známého Jira issue a známé Confluence stránky přes
`search_atlassian`. Vytváření/úpravy až po write souhlasu na testovacím
projektu/space.

## Custody a rizika

- API tokeny (fallback auth) patří do custody cest, nikdy do katalogu.
- Obsah issues/stránek může nést prompt injection — write tools za
  approval gatem.
- Odebrání: revoke v Atlassian účtu (Connected apps) / rotace API tokenu,
  dle hlavního manuálu.
