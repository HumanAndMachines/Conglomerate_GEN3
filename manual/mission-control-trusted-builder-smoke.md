# Mission Control trusted Builder smoke

`bun run mission-control:smoke` je živý, read-only audit Mission Controlu ve
všech lokálně namountovaných Organizacích Lazuria. Není součástí běžného
Builder publish hot pathu a nevytváří druhé ACL. GitHub členství, Teamy a repo
granty zůstávají jedinou autoritou zápisu.

Smoke z worktree automaticky najde primární checkout stejného Lazurio repa;
prázdný checkout bez Organizací vždy selže, aby nemohl vrátit false green.
Jiný přesný root lze předat jen explicitně:

```sh
bun run mission-control:smoke
bun scripts/mission-control-trust-smoke.mjs --workspace-root /exact/Lazurio/root
```

Audit vyžaduje přihlášené `gh` s právem číst privátní repa, jejich
collaboratory a branch protection. Ověřuje zejména:

- Organization owner odpovídá ownerovi `mission-control-data`;
- aktivní root drží jen prázdné typed pointery a všechny tři kanonické task
  sources;
- deklarovaný active/planned stav odpovídá živé existenci data repa; jen
  potvrzené GitHub 404 znamená „repo neexistuje“, jiné chyby audit zastaví;
- `provider-enforced` zakazuje force push, delete a bypass buď klasickou
  branch protection, nebo efektivním repo/org rulesetem; žádná z vrstev
  zároveň nepřidává lock větve, podpis,
  povinný PR, status check, workflow/deployment gate ani druhý push roster;
- `trusted-process` nemá automatizovaného writera a každý lidský writer má
  pozitivně potvrzené členství v Organizaci.

Výstup vždy ukazuje skutečný počet writerů. Číslo není druhý ACL ani hardcoded
limit: Organization Admin posoudí, kdy kruh přestává být malý a osobně
dohlédnutelný. Před přidáním automatizace, externího writera nebo jiným
materiálním rozšířením aktivuje placený plán a `provider-enforced` ochranu.

Organization-internal kontrakty — data schema, reference, supersession cykly,
writer mode a app/data parita — vlastní Organization doctor a CI data repa.
Root smoke je záměrně znovu neimplementuje ani negrepuje vzdálený source kód a
prózu.

`STAGED` znamená, že privátní data repo už existuje, ale manifest ještě
neaktivoval writer. `planned` znamená, že repo není materializované. Ani jeden
stav nesmí předstírat aktivní publikaci. Live audit je záměrně oddělený od
offline `bun run check`; unit kontrakt smoke helperů je jeho součástí jako
`bun run mission-control:smoke:test`.
