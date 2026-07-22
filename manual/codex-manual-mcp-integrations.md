# Ruční MCP integrace pro Codex

Tento runbook je volitelná alternativa k ChatGPT pluginům a ke sdílenému
integračnímu brokeru, například Composiu. Popisuje, jak Kolega na své mašině
přidá MCP server přímo do Codexu a drží přihlašovací artefakty lokálně. Přímý
lokální STDIO server ani vzdálený HTTP MCP server Docker nepotřebují.

Codex CLI, desktop aplikace a IDE extension používají stejnou lokální
konfiguraci. ChatGPT na webu tuto konfiguraci nečte; pro web a telefon je
potřeba zvlášť spravovaný plugin/connector. Aktuální syntaxe a podporované
volby jsou v [oficiálním Codex MCP manuálu](https://learn.chatgpt.com/docs/extend/mcp).

## Volba integračního tvaru

| Potřeba | Doporučený tvar | Kde jsou credentials | Docker |
| --- | --- | --- | --- |
| Jedna mašina, lokální proces a lokální OAuth cache | STDIO MCP | Na dané mašině | Ne |
| Poskytovatel provozuje svůj MCP endpoint | Streamable HTTP + OAuth | Lokální OAuth úložiště Codexu; token se používá vůči poskytovateli | Ne |
| Stejné napojení ve webovém nebo mobilním ChatGPT | ChatGPT plugin/connector | Podle workspace a poskytovatele | Neřeší tento runbook |

Lokální uložení omezuje cloudového prostředníka, ale neodstraňuje důvěru v MCP
server, poskytovatele služby ani model. MCP nástroj může číst data, která mu
udělené OAuth scopes a lokální filesystem dovolí, a obsah e-mailu nebo dokumentu
může nést prompt injection. Připojuj jen zdroj, jehož kód a datovou hranici
Principál přijímá.

## Bezpečnostní gate před instalací

1. Urči scope: osobní, root/operator, nebo právě jedna Organizace. Pro různé
   Organizace používej oddělené názvy serverů i OAuth sessions, například
   `<org_slug>_clickup`; nepřenášej token jedné Organizace do druhé.
2. Ověř publishera, zdrojový repozitář, licenci, release/tag nebo přesný commit
   a seznam závislostí. Komunitní MCP není „oficiální integrace“ jen proto, že
   obsluhuje známou službu. Pro trvalý runtime nepoužívej neukotvené `latest`.
3. Začni read-only a nejmenší sadou služeb/tools. Rozšiř scopes až po
   funkčním smoke testu a vědomém souhlasu Principála.
4. Secret hodnoty, OAuth kódy, tokeny ani obsah client JSONu neposílej chatem a
   necommituj. Řiď se [lokálním secret custody standardem](security/local-secret-custody.md):
   root/operator secrets patří do
   `personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>`, secrets
   Kolegy v Organizaci do
   `organizations/<org>/company/colleagues/<os-user>/private/secrets/<provider>/<scope>/<purpose>`.
   Adresáře mají mód `0700`, soubory `0600`.
5. Do trackované projektové `.codex/config.toml` nikdy nevkládej secret hodnotu.
   Projektovou konfiguraci Codex načte jen v trusted projektu, přesto ji reviewuj
   jako spustitelnou konfiguraci. Osobní integrace patří raději do
   `~/.codex/config.toml`.
6. Lokální STDIO proces běží s právy přihlášeného uživatele. Nepovoluj mu širší
   filesystem cesty, než potřebuje. Vzdálený HTTP server naopak přijímá data
   přes síť; ověř doménu a TLS endpoint přímo v dokumentaci poskytovatele.

## Základní práce s Codex MCP

Nejdřív zkontroluj aktuální CLI kontrakt:

```sh
codex mcp --help
codex mcp add --help
```

Codex umí server přidat přes CLI nebo přímo v `config.toml`:

```sh
# Lokální STDIO proces. Všechno za -- je příkaz serveru.
codex mcp add <server_name> -- /absolutni/cesta/k/serveru --argument

# Vzdálený Streamable HTTP endpoint.
codex mcp add <server_name> --url https://provider.example/mcp

codex mcp list
codex mcp get <server_name>
```

Po změně restartuj desktop/IDE Codex nebo otevři nový task. V tasku zkontroluj
MCP stav přes `/mcp` a proveď nejdřív neškodný read-only dotaz. Výpis ani
closeout nesmí obsahovat secret nebo OAuth callback data.

### Doporučené globální nastavení OAuth

Na platformě s dostupným systémovým keyringem preferuj jeho použití:

```toml
# ~/.codex/config.toml
mcp_oauth_credentials_store = "keyring"
```

`file` úložiště používej jen tehdy, když keyring není dostupný a lokální
filesystem je odpovídajícím způsobem chráněný. OAuth client secret nebo bearer
token nevkládej do TOMLu. Pro statický bearer token použij
`bearer_token_env_var`, tedy jméno lokální environment proměnné, ne její
hodnotu.

## Per-machine onboarding Organizace

Každý Kolega nastavuje integrace ve svém uživatelském profilu Codexu. Agent smí
instalaci připravit a diagnostikovat, ale výběr účtu a OAuth souhlas dokončuje
Principál v prohlížeči. Sdílej pouze dokumentovaný postup a metadata; nepřenášej
mezi lidmi hotové token cache, client secrety ani celý uživatelský
`~/.codex/config.toml`.

### Výchozí model: jeden Principál, více mašin

Conglomerate GEN3 počítá s tím, že jeden Principál může používat svůj vlastní
OpenAI účet a subscription na více svých mašinách. Identita a subscription
mohou být stejné, ale přístupy k ostatním službám zůstávají na každé mašině
oddělené: každá má vlastní `~/.codex/config.toml`, MCP servery, OAuth granty,
token cache a povolený filesystem scope. Pracovní počítač tak může mít jiné
integrace a oprávnění než domácí počítač nebo dedikovaný host.

MCP credentials ani token cache mezi mašinami nekopíruj. Každou mašinu
autorizuj samostatně, uděluj jí jen potřebné scopes a veď ji jako samostatný
revokovatelný přístup. Ztracené nebo kompromitované zařízení pak lze odpojit
u jednotlivých poskytovatelů bez přenášení jeho přístupů na ostatní stroje.

Tento model neznamená sdílení jednoho OpenAI loginu mezi více lidmi. Podle
[OpenAI Account Sharing Policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy)
je účet určen člověku, který jej vytvořil; tento člověk jej může používat na
více zařízeních, ale další Kolega potřebuje vlastní účet nebo přidělený seat.

Pro onboarding call použij tento pořádek:

1. Sepiš požadované aplikace, cílový Organization workspace, ownera a nejmenší
   nutné scopes. Každý server pojmenuj `<org_slug>_<provider>`, například
   `example_org_clickup` nebo `example_org_google_workspace`.
2. V `~/.codex/config.toml` nastav systémový keyring a pro nový server ponech
   `default_tools_approval_mode = "writes"` nebo přísnější `prompt`.
3. Přidej právě jeden server, přihlas správný Organization účet a ověř
   `codex mcp list` a `codex mcp get <server_name>`.
4. Restartuj Codex nebo otevři nový task, zkontroluj `/mcp` a proveď známý
   read-only dotaz. Zápis testuj až samostatně, na neprodukčním záznamu a po
   výslovném souhlasu Principála.
5. Teprve po úspěšném smoke testu přidej další službu. Do closeoutu zapiš jen
   název serveru, účel, ownera, scope, datum a výsledek.

### Přechod ze sdíleného integračního brokeru

Přechod z Composia nebo jiného brokeru nedělej pouhým smazáním jeho konfigurace
v Codexu. Bezpečný cutover je po jednotlivých integracích:

1. inventarizuj poskytovatele, použitý Organization účet, schválené scopes a
   workflow, které na integraci spoléhají; tokeny nekopíruj;
2. zprovozni lokální nebo poskytovatelem provozovaný MCP pod novým názvem vedle
   dosavadního napojení a ověř read-only paritu;
3. pokud je zápis potřeba, ověř jej odděleně s approval gatem a vratným testem;
4. po přijetí nového napojení odpoj staré, zruš jeho OAuth grant přímo u
   poskytovatele a ověř, že broker už k účtu nemá přístup;
5. otevři nový Codex task a potvrď, že je aktivní jen zamýšlený server.

Lokální MCP konfigurace funguje jen na dané mašině. Codex desktop, CLI a IDE ji
na téže mašině sdílejí, ale ChatGPT web ani telefon ji nepřevezmou. To je
vědomý trade-off za per-machine custody, ne chyba instalace.

## Příklad A: oficiální vzdálený ClickUp MCP

ClickUp publikuje endpoint `https://mcp.clickup.com/mcp` ve své
[oficiální MCP dokumentaci](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server).
Pro každou Organizaci vytvoř samostatné pojmenování a přihlášení, například:

```sh
codex mcp add example_org_clickup --url https://mcp.clickup.com/mcp
codex mcp login example_org_clickup
codex mcp get example_org_clickup
```

OAuth souhlas dokončuje člověk v prohlížeči. Zkontroluj správný ClickUp
Workspace a oprávnění účtu; agent může dělat pouze operace, které tento účet
smí. První smoke má být čtení známého tasku nebo seznamu, ne zápis.

Pro explicitní approval policy lze server upravit v `~/.codex/config.toml`:

```toml
[mcp_servers.example_org_clickup]
url = "https://mcp.clickup.com/mcp"
default_tools_approval_mode = "writes"
startup_timeout_sec = 20
tool_timeout_sec = 60
required = false
```

`writes` nechává čtení automatické a zápisy potvrzované. Pro citlivější data
použij `prompt`, případně přes `enabled_tools` povol jen reviewovanou podmnožinu.

## Příklad B: lokální Google Workspace MCP přes STDIO

Google Workspace příklad níže používá komunitní MIT projekt
[`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp),
nikoli produkt vydaný Googlem nebo OpenAI. Před instalací zkontroluj aktuální
security dokumentaci a ukotvi instalaci na reviewovaný release nebo commit.
Server vyžaduje Python a lokální runtime (například izolovaný `venv`); Docker
není potřeba.

1. V Google Cloud vytvoř OAuth client pro desktop aplikaci a povol jen potřebná
   API. Stažený client JSON ulož do custody cesty, nikoli do repozitáře serveru.
2. Server spouštěj z lokálního izolovaného prostředí a ukotvi ho na reviewovanou
   verzi. Aktuální upstream používá příkaz `workspace-mcp` a podporuje `uvx`;
   před nasazením nahraď `<reviewed-version>` konkrétní ověřenou verzí.
3. Začni například službami Gmail, Calendar, Drive a Sheets v read-only režimu.
   Cesty lze dodat přes lokální environment; jejich hodnoty necommituj do
   sdíleného repozitáře.

Příklad osobního `~/.codex/config.toml`:

```toml
[mcp_servers.example_org_google_workspace]
command = "/ABSOLUTNI/LOKALNI/CESTA/bin/uvx"
args = ["--from", "workspace-mcp==<reviewed-version>", "workspace-mcp", "--single-user", "--read-only", "--tool-tier", "core"]
env_vars = ["GOOGLE_CLIENT_SECRET_PATH", "GOOGLE_MCP_CREDENTIALS_DIR"]
default_tools_approval_mode = "writes"
startup_timeout_sec = 30
tool_timeout_sec = 90
required = false
```

Před spuštěním Codexu nastav v lokálním shellu nebo machine-local launcheru:

```sh
export GOOGLE_CLIENT_SECRET_PATH="/custody/cesta/google/client.json"
export GOOGLE_MCP_CREDENTIALS_DIR="/custody/cesta/google/tokens"
```

Tyto ukázkové cesty nahraď skutečnými absolutními cestami. Launcher se secret
hodnotami musí zůstat mimo Git a mít lokální custody oprávnění. Nepřebírej
vývojové nastavení `OAUTHLIB_INSECURE_TRANSPORT=1` do běžného provozu.

První browser consent dokonči ručně a pak v `/mcp` ověř pouze read-only nástroje.
Write scope povol až samostatnou vědomou změnou konfigurace a novým consentem.

## Odebrání, rotace a incident

```sh
codex mcp logout <server_name>
codex mcp remove <server_name>
```

Odebrání z Codexu samo nemusí zrušit grant u poskytovatele ani smazat cache
samotného MCP serveru. Při ukončení napojení:

1. odhlaš server v Codexu a odeber konfiguraci;
2. zruš OAuth grant/token u poskytovatele;
3. podle dokumentace serveru bezpečně odstraň nebo rotuj jeho lokální token
   cache a client secret;
4. ověř `codex mcp list` a nový task;
5. zapiš jen metadata: název integrace, scope, datum, owner a výsledek. Nikdy
   nezapisuj token, callback URL ani credential JSON.

Při podezření na kompromitaci nejdřív revoke u poskytovatele, potom rotuj
client credentials a lokální cache. Pouhé smazání lokálního souboru už vydaný
token na straně poskytovatele nemusí zneplatnit.

## Časté problémy

- **Server se po přidání nezobrazuje:** restartuj Codex/IDE, ověř
  `codex mcp get <name>` a zda projektová konfigurace leží v trusted projektu.
- **OAuth se opakuje:** ověř systémový keyring, lokální oprávnění cache a
  přesnou redirect/callback konfiguraci poskytovatele. Neloguj callback URL.
- **Server nenastartuje:** spusť executable mimo Codex jen s `--help`, ověř
  absolutní cestu, pin verze a názvy environment proměnných. Secret hodnoty
  nevypisuj.
- **Nástroj má příliš mnoho možností:** použij `enabled_tools`, read-only mód
  serveru a `default_tools_approval_mode = "prompt"`.
- **Integrace je potřeba na telefonu:** lokální Codex MCP konfigurace se do
  ChatGPT web/mobile nepřenáší. Jde o jiné trust rozhodnutí; použij samostatný
  workspace connector nebo poskytovatelem spravovaný endpoint.
