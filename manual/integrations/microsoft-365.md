# Microsoft 365: Outlook mail a kalendář

Stav ověřen 2026-07-24.

## Možnosti

| Tvar | Co to je | Poznámka |
| --- | --- | --- |
| Oficiální remote MCP | „Work IQ" servery Agent 365 (`Mail`, `Calendar`…), remote HTTP + Entra ID OAuth ([přehled](https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview), katalog [microsoft/mcp](https://github.com/microsoft/mcp)) | **Preview, ne pro produkci**; vyžaduje M365 Copilot licenci per user a Entra app registraci tenant adminem |
| OSS MCP | [softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) (MIT, velmi aktivní) | Microsoft Graph, 300+ tools (mail, kalendář, OneDrive, Excel, Teams v `--org-mode`), device-code login, keychain token cache |
| OSS CLI | [CLI for Microsoft 365](https://pnp.github.io/cli-microsoft365/) (`m365`) | PnP komunita, Graph coverage, `m365 login` device code |

## Doporučená volba

**Default: `softeria/ms-365-mcp-server` s pinned verzí.** Oficiální Work IQ
je preview s tvrdými prerekvizitami (Copilot licence, tenant admin
ceremonie) — přejdi na něj, až bude GA a Organizace licence má; do té doby
je Graph přes softeria plnohodnotný a bez Copilot licence.

Multi-account je first-class: `--login` per účet, `--list-accounts`,
parametr `account` v každém tool callu při více přihlášených účtech,
pinning přes `MS365_MCP_EXPECTED_USERNAME`. Víc org účtů na jedné mašině
tedy zvládne jedna instance; přesto per Organizace preferuj oddělené
pojmenované servery kvůli čitelnosti approval promptů.

## Org-side kroky

1. Default flow používá sdílenou Softeria Entra app — tenant s přísnou
   consent policy ji může blokovat; pak Organizace registruje vlastní Entra
   app a předá `MS365_MCP_CLIENT_ID` (jméno proměnné do katalogu, hodnotu do
   custody env).
2. Preset volej podle workflow (`mail`, `calendar`…); scopes defaultně
   read i write, per-action ochranu write tools drží approval mode
   harnessu.

## Per-machine aktivace

Katalogový zápis v org `.mcp.json`:

```json
{
  "mcpServers": {
    "<org_slug>_m365": {
      "command": "npx",
      "args": ["-y", "@softeria/ms-365-mcp-server@<reviewed-version>", "--preset", "mail,calendar"],
      "env": {
        "MS365_MCP_EXPECTED_USERNAME": "${<ORG_SLUG>_M365_USERNAME}"
      }
    }
  }
}
```

Codex: `codex mcp add <org_slug>_m365 -- npx -y @softeria/ms-365-mcp-server@<reviewed-version> --preset mail,calendar`
plus `env_vars` v TOMLu dle Codex manuálu. Přihlášení: `--login` device
code flow dokončuje Principál; token cache jde do OS keychainu (keytar).

## Smoke test

Smoke začni čtením (výpis posledních hlaviček inboxu, kalendář na dnešek)
a pokračuj draftem (ne send) — write je od začátku povolený a potvrzuje ho
approval mode harnessu.

## Custody a rizika

- Device-code flow zobrazuje kód — kód ani token nikdy nepatří do chatu.
- `--org-mode` (Teams, SharePoint, shared mailboxy) rozšiřuje blast radius;
  zapínej až na konkrétní schválený workflow.
- Odebrání: `--logout`, revoke v Entra (My Apps / admin center), smazání
  lokální cache dle hlavního manuálu.
