# Local secret custody in GEN3

GEN3 musí mít jedno standardní místo, kam patří lokální secret soubory pro člověka nebo AI kolegu, aby se neopakovalo ad-hoc hledání v `Downloads`, `Desktop`, tool cache složkách nebo chatových handoffech.

## Pravidlo

Secrets a OAuth client soubory se **nikdy necommitují**. Do Gitu patří jen:

- standardní cesta,
- no-secret runbook,
- pointer na lokální umístění,
- metadata-only ověření (`present`, `mode`, `mtime`, `account/domain`, `doctor=ok`),
- nikdy hodnota secretu, tokenu, refresh tokenu, hesla ani obsah JSONu.

## Root / Buddy / operator secrets

Pro secrets, které patří vlastníkovi Launchpad rootu, Buddymu nebo operátorovi stroje, je custody místo owner-scoped uvnitř jeho personalspace:

```text
personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>
```

Příklad pro Google OAuth Desktop client Organizace:

```text
personalspace/<owner>_GEN3/secrets/google-oauth/<domain>/client-desktop.json
```

`personalspace/<owner>_GEN3/secrets/` je gitignored v nested personalspace repu; tracked zůstávají jen manifesty/README. Secret adresáře mají mít mód `0700`, secret soubory `0600`.

## Organization / AI colleague secrets

Pro secrets, které patří konkrétnímu kolegovi uvnitř konkrétní Organizace, používej organization-local private overlay:

```text
organizations/<org>/company/colleagues/<os-user>/private/secrets/<provider>/<scope>/<purpose>
```

Příklad:

```text
organizations/<Org>_GEN3/company/colleagues/<agent-user>/private/secrets/google-oauth/<domain>/client-desktop.json
```

`private/` je lokální a ignorovaný Git pravidly dané Organizace. Pokud je secret potřeba z runtime cesty nástroje, runbook ho může lokálně zkopírovat nebo symlinknout do tool-specific path, ale custody source zůstává v `private/secrets/...` nebo `personalspace/<owner>_GEN3/secrets/...`.

## Tool runtime paths are not custody paths

Tool-specific cesty jako:

```text
~/.config/gogcli/client-desktop.json
~/.local/share/gog-oauth-setup/google-oauth-client-desktop.json
```

jsou runtime/cache/adaptér cesty. Nejsou zdroj pravdy pro držení secretů. Runbook musí umět z custody source připravit runtime path bez toho, aby secret tisknul nebo commitoval.

## Human-action boundary

Když je potřeba OAuth consent nebo zadání hesla:

1. Agent připraví lokální `.command` / wizard / aplikaci na cílovém Macu.
2. Člověk dokončí pouze lokální krok na cílové obrazovce.
3. Člověk neposílá heslo, kód, token, OAuth URL ani JSON do chatu.
4. Agent potom čte jen metadata-only výsledek a funkční smoke.

## Metadata-only verification

Minimální closeout pro OAuth/Gmail gate:

- expected account/domain match,
- `auth doctor --check` status `ok`,
- read-only functional smoke, například `gmail labels list` s `rc=0`,
- result file mode `0600`,
- keyring/env file mode `0600`,
- `no_secret_values_printed=true`,
- `result_contains_secret_values=false`.

## Anti-patterns

- Hledat secrets v `Downloads` během kritického unblocku.
- Posílat OAuth client JSON, token, heslo nebo URL do chatu.
- Commitovat reálné secret JSONy, `.env`, service-account keys nebo token stores.
- Nechat tool-specific runtime path být jediným místem, kde secret existuje.
- Plést OAuth Desktop client JSON s cílovým uživatelským účtem; účet se vybírá při consentu a musí odpovídat organizačnímu invariantnímu účtu.
