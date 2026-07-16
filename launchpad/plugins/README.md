# Launchpad pluginy

Plugin je kontrolovaný způsob, jak konkrétní firma nebo modul rozšiřuje
sdílený Launchpad GEN3 bez forkování jeho core runtime.

## Povolené role pluginu

Plugin API v1 je pouze deklarativní a read-only. Plugin může dodat:

- nadpis a stručné shrnutí pro detail aplikace
- metadata typu label/value
- extra odkazy na manuály, data, source-of-truth soubory nebo externí URL
- krátké read-only sekce pro kontext kolegy nebo agenta

Plugin nesmí:

- spouštět libovolný kód v Launchpad procesu
- definovat tlačítka, akce, commandy, writery nebo maintenance operace
- obcházet access governance firmy
- psát přímo do dat bez validovaného writeru
- ukládat secrets do Gitu
- měnit porty jiných aplikací
- vyžadovat runtime mimo Bun baseline

## Kanonické cesty

```text
organizations/<company>/company/launchpad/plugins/
organizations/<company>/modules/<module>/app/<version>/launchpad.plugin.json
```

V1 podporuje package-level `launchpad.plugin.json`, na který ukazuje pole
`companyascode.app.plugin` v aplikačním `package.json`. Cesta může mířit i
výš v rámci stejného Organization, ale nesmí utéct mimo jeho root.
Company-level plugin directory je připravený pro další generaci.

## Manifest v1

```json
{
  "schema_version": "companyascode.launchpad_plugin.v1",
  "title": "Deals v2 kontext",
  "summary": "Read-only kontext pro Deals aplikaci v Launchpadu.",
  "metadata": [
    {
      "label": "Source of truth",
      "value": "Git filesystem database"
    }
  ],
  "links": [
    {
      "label": "Manuál",
      "kind": "manual",
      "path": "modules/deals/app/v2/README.md"
    }
  ],
  "sections": [
    {
      "title": "Bezpečnost",
      "body": "Plugin pouze zobrazuje metadata. Zápisy patří do validovaného writeru."
    }
  ]
}
```

Kanonické schéma je v `launchpad/schemas/launchpad-plugin.schema.json`.
Doctor a `bun run check` validují, že plugin je JSON manifest v1, ne
spustitelný soubor.

## Review pravidlo

Plugin je company override. Template update nesmí plugin přepsat. Když se
mění plugin API, musí vzniknout reviewovatelný diff, který ukáže dopad na
všechny firemní pluginy.

Writer nebo action pluginy přijdou až po samostatném bezpečném writer
kontraktu. Do té doby je každé pole typu `actions`, `command`, `script` nebo
runtime hook mimo v1 API a Doctor ho musí odmítnout jako neznámé pole.
