# Windows Launchpad startup reliability — incidentní podklad pro architekta

**Adresát:** Matěj Suchánek, architekt Launchpadu GEN3

**Datum incidentu:** 9. srpna 2026

**Dopad:** uživatel opakovaně viděl nefunkční Launchpad a chybu spuštění aplikace Revize a kontroly, přestože samotná aplikace a její testy byly v pořádku.

## Stručný závěr

Nešlo o jednu chybu Revizí. Windows měl současně několik konkurenčních cest ke
spuštění Launchpadu a jedna z nich byla naplánovaná úloha připnutá k dočasnému
Git worktree uzavřeného PR. Dočasná vývojová cesta tak přežila svůj review
cyklus a chovala se jako produkční instalace. Když proces skončil, port 4174
zůstal bez řídicí vrstvy; prohlížeč přitom dál ukazoval starý shell a chybu
aplikace, takže incident vypadal jako porucha Revizí.

Bezprostřední lokální oprava obnovila kanonický root, znovu vytvořila Start Menu
a taskbar zástupce, vypnula starou naplánovanou úlohu a spustila Revize zdravě.
Tento follow-up mění samotný instalační kontrakt, aby stejná třída chyby
nevznikla znovu.

## Pozorovaná fakta

- Sdílený Launchpad na `127.0.0.1:4174` neběžel; otevřený prohlížeč držel starý
  stav UI.
- Naplánovaná úloha `HumanAndMachine Launchpad GEN3` mířila pod
  `<Conglomerate>/.worktrees/root/FIX-launchpad-gen3-reliability/...`.
- Worktree patřil uzavřenému, záměrně nemergnutému PR #62. Bezpečné části tohoto
  PR byly později selektivně přeneseny do PR #76 a #77.
- Windows úloha skončila výsledkem `0xC000013A`; neexistoval canonical owner,
  který by ji po ukončení obnovil nebo uživateli vysvětlil, že je mrtvá řídicí
  vrstva, nikoli cílová aplikace.
- Runtime a logy existovaly ve více checkoutových cestách. Stav proto nebyl
  jednoznačně svázaný s jedinou instalací.
- Primární root byl před opravou 44 commitů pozadu. Vestavěný stable update
  neměl použitelný release tag a nemohl zaručit aktuální verzi.
- Modul Revize a kontroly měl zároveň rozpracovaná provozní data a jednorázový
  uppercase app id. Po lokální opravě ID, dependencies a startu prošlo 11/11
  testů a odpovídalo HTTP 200; zákaznická data nebyla přepsána ani publikována.

## Kořenová příčina

Vývojový checkout plnil zároveň tři neslučitelné role:

1. zdroj kódu a review worktree;
2. trvalá Windows instalace/spouštěč;
3. vlastník runtime a logů.

K tomu existovalo více nezávislých startovacích mechanismů (zástupci,
naplánovaná úloha a přímé spuštění). Systém neuměl rozhodnout, který z nich je
kanonický, ani aktivně vyřadit ten, který mířil do dočasné review větve.

## Implementovaný preventivní slice

- Zástupce nově míří na stabilní bootstrap pod
  `%LOCALAPPDATA%\HumanAndMachine\Launchpad`, nikoli přímo na soubor v Git
  checkoutu.
- Bootstrap čte `install.json` s jediným kanonickým rootem, ověří
  `launchpad.gen3.json` a odmítne každou cestu obsahující `.worktrees`.
- Instalace ukládá pevný uživatelský origin `http://127.0.0.1:4174`; bootstrap
  předá port explicitně. Obsazený cizí port proto skončí čitelnou chybou místo
  tichého otevření jiné adresy.
- Reinstalace vyhledá Launchpad scheduled tasks, jejichž akce míří do
  `.worktrees`, a bezpečně je vypne. Úlohy nemaže a reportuje přesnou identitu,
  akci a výsledek pro rollback/audit.
- Instalace je idempotentní, zálohuje nahrazované zástupce a po zápisu ověřuje
  jejich target, argumenty, working directory a ikonu.
- Regresní test hlídá bootstrap, kanonický marker a scheduled-task quarantine.

## Co ještě doporučuji uzavřít architektonicky

### P1 — skutečný instalační release kanál

Stable kanál musí mít reálný podepsaný/verzovaný release target. `main` checkout
je vhodný pro Builder preview, ale nemá být implicitně vydáván za stabilní
desktopovou instalaci. Bootstrap je bezpečná hranice pro dnešní direct-pull
model; cílově by měl vybírat konkrétní instalovanou verzi a držet atomický
rollback na předchozí verzi.

### P1 — jedna autorita životního cyklu

Windows smí mít právě jeden kanonický launcher owner. Scheduled Task, Startup
folder a další legacy launchery mají být inventarizované jako konflikty. Nový
mechanismus je má buď vědomě převzít, nebo vypnout s auditní stopou; nesmějí
zůstat paralelní.

### P1 — oddělený runtime stav

Runtime identity, PID evidence a logy mají patřit instalaci pod LocalAppData,
ne zdrojovému checkoutu ani worktree. Identita má nést alespoň instalaci,
kanonický root, přesnou verzi/commit a startovací mechanismus. Stejný root s
jinou verzí nesmí být tiše považován za tutéž běžící instanci.

### P2 — dohled a pravdivá chyba

Lehký watchdog nebo on-demand repair má rozlišit:

- neběží řídicí Launchpad;
- Launchpad běží z jiné instalace/verze;
- app manifest je neplatný;
- chybí dependencies;
- cílová appka skutečně selhala.

UI nesmí poslední čtyři stavy slít do hlášky „aplikaci se nepodařilo spustit“.

### P2 — post-update smoke

Po změně verze spustit malý smoke: identita Launchpadu, discovery, Doctor a
start/health/stop jedné bezpečné fixture aplikace. Neprovádět automatický start
ani zápis do zákaznických aplikací.

## Ověřovací scénář pro další release

1. Nainstalovat zástupce z primárního `main` checkoutu.
2. Ověřit, že oba zástupci míří do LocalAppData bootstrapu a config míří na
   primární root a pevný port `4174`.
3. Vytvořit testovací scheduled task s Launchpad akcí pod `.worktrees`, znovu
   spustit instalátor a ověřit stav `Disabled` bez smazání úlohy.
4. Přesunout nebo zneplatnit konfigurovaný root a potvrdit čitelnou fail-closed
   chybu bez fallbacku na jiný checkout.
5. Spustit primární root a potvrdit identity endpoint, discovery a Doctor.
6. Ověřit, že starý worktree proces nemůže být převzat jako kanonická
   instalace a že zástupce otevře správný origin.

## Relevantní historie

- PR #15 — první Windows zástupce.
- PR #62 — původní široký reliability pokus; uzavřen jako superseded.
- PR #76 — generation-safe first paint a freshness.
- PR #77 — Windows runtime ownership proof po restartu.
- CAC-0083 — update routine and visibility; nejbližší existující
  architektonická kotva tohoto follow-upu.

Tento dokument neobsahuje zákaznická data, tokeny ani absolutní uživatelské
cesty. Popisuje pouze sdílený framework a redigovanou lokální diagnostiku.
