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
- data config používá `local-principal-v1` bez provider rosteru nebo writer
  credentialu;
- app `main` používá stejný frictionless writer a nenese retired provider
  audit;
- `provider-enforced` zakazuje force push, delete a admin bypass, ale classic
  protection ani efektivní repo/org ruleset nepřidává lock větve, podpis,
  povinný PR, status check, workflow/deployment gate ani druhý push roster;
- `trusted-process` má nejvýše 10 lidských writerů a žádného bota nebo outside
  collaboratora.

Limit 10 je konzervativní auditní růstový trigger, ne přístupové pravidlo.
Jeho překročení nikomu GitHub právo neodebírá; znamená, že Organization Admin
musí před dalším rozšířením write okruhu aktivovat placený plán a
`provider-enforced` ochranu. Pokud je širší kruh stále záměrný, jeho governance
se nemá řešit zvýšením skrytého rosteru v Mission Controlu.

`STAGED` znamená, že privátní data repo už existuje, ale manifest ještě
neaktivoval writer. `planned` znamená, že repo není materializované. Ani jeden
stav nesmí předstírat aktivní publikaci. Live audit je záměrně oddělený od
offline `bun run check`; unit kontrakt smoke helperů je jeho součástí jako
`bun run mission-control:smoke:test`.
