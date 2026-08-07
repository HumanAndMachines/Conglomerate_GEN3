# Google Workspace: Gmail, Drive, Docs, Sheets, Slides, Meet

Jeden provider pokrývá šest služeb. Stav ověřen 2026-08-07.

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
3. Před consentem ukaž Principálovi přesný účet, účel a seznam scopes. Pro
   používané služby žádej potřebnou read i write schopnost
   (`gmail.modify`/`gmail.send`, `drive.readonly` + `drive.file`,
   `spreadsheets`… dle workflow). Plný `drive` přidej jen když schválený
   workflow opravdu upravuje libovolný existující obsah, ne pouze čte
   existující a zapisuje app-created/user-selected soubory. Skutečný přesný
   seznam převezmi z reviewované implementace; vynech nepotřebné admin,
   permission-management a destructive scopes.
   Udělený OAuth grant je schopnost mašiny, ne souhlas s konkrétní write
   operací; per-action ochranu drží approval mode harnessu a kontrakt
   Draft → Publikace.

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
        "WORKSPACE_MCP_CREDENTIALS_DIR": "${<ORG_SLUG>_GOOGLE_MCP_CREDENTIALS_DIR}",
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
Současná [upstream reference](https://github.com/taylorwilsdon/google_workspace_mcp#credential-store-system)
dokumentuje `WORKSPACE_MCP_CREDENTIALS_DIR` i zpětně kompatibilní
`GOOGLE_MCP_CREDENTIALS_DIR`. Katalog předává obě jména na tutéž cestu,
protože připnutá reviewovaná verze může podporovat jen jedno z nich.
Machine-local custody jméno
`<ORG_SLUG>_GOOGLE_MCP_CREDENTIALS_DIR` zůstává stabilní, takže již aktivované
mašiny nepotřebují migraci `integrations.env` a server nespadne tiše do
výchozí runtime cesty. Ve sdíleném příkladu žádné z těchto jmen neodstraňuj;
na konkrétní mašině lze konfiguraci zjednodušit jen po kontrole zdroje a
readbacku připnuté verze.

CLI aktivace: `gog auth credentials <cesta-k-client-json>` +
`gog auth add <ucet-organizace>`; credentials custody platí stejně.

<a id="google-oauth-persistence"></a>

## Dlouhodobě obnovitelné přihlášení

Access token je krátkodobý; normální dlouhodobý provoz stojí na refresh tokenu
uloženém v persistentním credential store. „Nikdy se neodhlásí" proto není
správný acceptance slib. Správný slib je: běžný restart MCP procesu, harnessu
nebo mašiny nové přihlášení nevyžaduje a access token se obnovuje automaticky;
reautentizace nastane jen při provider policy, revokaci nebo incidentu.

Nejčastější opakovaný problém je Google OAuth projekt s audience `External`
a publishing statusem `Testing`. U scopes Gmailu, Drivu a dalších Workspace
API Google ukončí autorizaci test usera včetně refresh tokenu po sedmi dnech;
profilové OIDC scopes jsou úzká výjimka, která Workspace MCP nepokrývá. Stav
ověř v Google Auth Platform → Audience a zapisuj jen metadata, nikdy token ani
OAuth URL.

Pro integraci používanou pouze účty jedné Google Workspace Organizace:

1. preferuj GCP projekt vlastněný touto Organizací a audience `Internal`;
2. pokud `Internal` nejde použít, přepni externí aplikaci z `Testing` do
   `In production`; podle scopes může být nutná Google verification;
3. Workspace Admin může OAuth klienta po review označit jako `Trusted`, pokud
   to vyžaduje organizační app-access policy. `Trusted` ale samo nemění GCP
   publishing status a sedmidenní expiraci režimu `External / Testing`
   **neruší**.

Změna audience, publishing statusu, admin trustu nebo scopes je provider-side
admin operace. Agent ji neprovede jen proto, že diagnostikoval příčinu: ukáže
současný a cílový stav a vyžádá si explicitní souhlas oprávněného Principála.
Kanonické reference: [Google OAuth audience a sedmidenní limit](https://support.google.com/cloud/answer/15549945),
[Workspace Admin app-access policy](https://support.google.com/a/answer/7281227)
a [důvody zneplatnění refresh tokenu](https://developers.google.com/identity/protocols/oauth2#expiration).

### Persistence podle transportu

- **Oficiální remote MCP / Streamable HTTP:** OAuth token drží MCP klient;
  v Codexu preferuj systémový keyring a ověř `codex mcp get <server>` bez
  výpisu secretů.
- **Lokální STDIO `workspace-mcp`:** Google token drží server, ne Codex.
  Nastav explicitní `WORKSPACE_MCP_CREDENTIALS_DIR` do persistentní custody
  cesty, adresář `0700`, credential soubory `0600`. Nepoužívej `/tmp`,
  ephemeral container, stateless mode ani memory-only OAuth backend.
- **CLI:** ověř persistentní credential store konkrétního CLI a samostatný
  grant každé mašiny; token cache mezi mašinami nekopíruj.

Po aktivaci ukonči MCP proces, spusť jej znovu, otevři nový task nebo restartuj
harness a zopakuj metadata-only identitu + read smoke. Tento test prokazuje
lokální persistenci; odstranění sedmidenní provider expirace definitivně
potvrdí až kontrola po více než sedmi dnech. Pokud přihlášení selhává v jiném
rytmu, ověř persistentní cestu a oprávnění cache, změnu hesla u Gmail scopes,
revokaci, admin policy a počet živých refresh tokenů stejného OAuth klienta.

## Smoke test

Smoke začni čtením (výpis Gmail labelů, `search_drive_files` na známý
soubor, čtení známé Sheet range) a pokračuj zápisem **jen v k tomu určené
scratch složce Drive a draftu adresovaném sobě** — nikdy v ostrém dokumentu
a bez odeslání. Do `INTEGRATIONS.md` zapiš oba použité cíle: přesnou Drive
scratch cestu i jmenovitý Gmail draft cíl (org účet a roli příjemce). Draft i
testovací soubor smíš po ověření odstranit jen když Principál výslovně
schválil každý použitý jmenovitý smoke cíl zapsaný v `INTEGRATIONS.md` a
každý artefakt vytvořil tento konkrétní smoke. Jinak artefakt ponech a
vyžádej si samostatný explicitní pokyn Principála.

## Custody a rizika

- Token cache OSS serveru (`~/.google_workspace_mcp/credentials/`) je
  plaintext — drž adresář `0700` a soubory `0600`; cache je runtime, ne
  custody source.
- Write tools (send mail, create file) jsou exfiltrační kanál při prompt
  injection — per-action je potvrzuje approval mode harnessu; u citlivých
  workflow zúžíš sadu přes `enabled_tools`.
- Odebrání/rotace: revoke grantu v Google Account / GCP, smazání lokální
  cache, viz kanonický postup v hlavním manuálu.
