# Migrace existujícího Personalspace na custody v1

Tento postup je pro existující neversionovaný Personalspace GEN3. Launchpad jej
po přechodnou dobu dál načte, ale Doctor ukáže warning. Root příkaz
`personalspace:create --apply` záměrně nikdy nespouští kód z předem
existujícího owner repa.

## Preflight

1. Ověř, že owner repo je private a remote odpovídá
   `<login>/<login>_GEN3`.
2. Zkontroluj pracovní strom a vytvoř běžnou review branch; nemaž ani
   nepřepisuj historii.
3. Ověř, že repo ani parent Conglomerate neobsahují `.gitmodules` nebo
   gitlinky.
4. Zastav aktivní gbrain writery a nezkopíruj secrets, OAuth/session data,
   runtime databázi ani index.

## Změna `personal.gen3.json`

Doplň:

```json
{
  "schema_version": "humanandmachines.personal.gen3.v1",
  "repository": {
    "mount_strategy": "doctor-managed-nested-repo"
  },
  "gbrain": {
    "repository": {
      "github_repo": "<login>/<login>-gbrain",
      "visibility": "private",
      "mount_strategy": "doctor-managed-nested-repo"
    },
    "software": {
      "github_repo": "garrytan/gbrain",
      "install_source": "github:garrytan/gbrain"
    }
  }
}
```

Snippet je jen výčet nových polí; zachovej ostatní existující hodnoty. Gbrain
repo musí patřit stejnému loginu, ale nesmí být stejné repo jako owner
Personalspace.

## Materializace a ověření

1. Vytvoř nebo ověř samostatné private `<login>/<login>-gbrain`.
2. Naklonuj jej do gitignored `gbrain/`; nepřidávej submodule.
3. Ověř, že owner repo ignoruje `gbrain/` i `secrets/`.
4. Z kořene Conglomerate spusť:

   ```text
   bun run doctor
   ```

5. Warning o `legacy-gen3-unversioned` musí zmizet a gbrain custody se musí
   zobrazit jako deklarovaná private.
6. Publikuj review branch owner repa vědomě. Gbrain data mají vlastní commit a
   push; samotný přístup k owner repu gbrain nesdílí.

Chceš-li do staršího repa doplnit i nový bootstrap/Doctor tooling, porovnej
jej s aktuálním veřejným
`HumanAndMachines/PersonalspaceTemplate_GEN3` a přenes jej samostatným
reviewovaným PR. Nespouštěj neověřený lokální `package.json` jen podle názvu
repa.
