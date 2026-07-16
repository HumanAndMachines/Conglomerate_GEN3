# Organizations

`organizations/` je lokální mountpoint pro **Organization GEN3** repozitáře, které se mají objevit v Launchpadu HumanAndMachine GEN3 / Conglomerate rootu.

## Git pravidlo

V root repozitáři `HumanAndMachines/Conglomerate_GEN3` je uvnitř této složky povolený a trackovaný pouze tento soubor:

```text
organizations/README.md
```

Všechno ostatní pod `organizations/*` musí být samostatný nested git checkout konkrétní Organizace a je v root repu gitignored. Nepřidávej sem submoduly ani cizí git historii.

## Co sem patří lokálně

Každá reálná Organizace má odpovídat GitHub Organization nebo podobné vlastnické/access hranici. Příklady lokálních mountů:

```text
organizations/ExampleOrg_GEN3/    # repo vlastněné ExampleOrg hranicí
organizations/OtherOrg_GEN3/      # repo vlastněné OtherOrg hranicí
organizations/ClientX_GEN3/       # repo konkrétního klienta
```

Každý takový adresář je vlastní git repozitář Organizace. HumanAndMachine GEN3 / Conglomerate root drží framework, registry, Launchpad, Guide, templates a manuály; klientská nebo firemní pravda patří do Organization repozitáře.

## Doporučený vnitřní tvar Organizace

```text
organizations/<org>/
├── workspace/              # plochá složka všech workspace modulů
│   └── <modul>/            # Workspace příslušnost deklaruje manifest
└── productionspace/        # org-level repa mimo workspace moduly
```

- Všechny workspace moduly Organizace žijí fyzicky v jedné ploché složce `workspace/`; složky `workspaces/<slug>/` se nezavádějí (decision 0041 v HumanAndMachines/docs/decisions/).
- Pojmenované Workspaces („Oddělení“/„Kanceláře“ — digitální kancelář jednoho týmu NEBO značky/venture) s vlastním doctorem, pravidly a access hranicí jsou logická deklarace v manifestu (`modules[].workspace` / `module_slots[].workspace`), ne adresář; deklarace je autorita a UI grupuje podle ní.
- Modul patří právě do jednoho Workspace; chybějící deklarace = default Workspace se slugem `workspace`. Hosted vzor `<modul>.<workspace>.<doména>` se generuje z deklarace.
- `productionspace/` drží org-level repozitáře, které nejsou workspace moduly (např. firmware, connect, monorepo). Každé takové repo si definuje vlastní pravidla (branch model, release proces); doctor u nich vynucuje jen bezpečné minimum, na rozdíl od jednotného kontraktu workspace modulů (decision 0041 body 6–7 v HumanAndMachines/docs/decisions/).

`personalspace/` je záměrně vedle `organizations/`, protože patří na osobní GitHub účet člověka nebo AI kolegy, ne do firemní GitHub organizace.

## Generační mount naming

Během paralelní migrace používá Conglomerate root fyzické mount cesty se suffixem, například `organizations/ExampleOrg_GEN3/` a `organizations/OtherOrg_GEN3/`. Suffix je viditelný filesystem/repo marker pro GEN3/GEN4 přechody; interní identita uvnitř Organizace zůstává čistý brand (`ExampleOrg`, `OtherOrg`) kvůli app manifestům, lidské značce a budoucímu cutoveru.

Mounty jsou Doctor-managed nested Git checkouty. Root commit drží `launchpad.gen3.json` a tento README, ne cizí Git historii ani submodule pointery.
