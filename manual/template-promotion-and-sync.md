# Template: update Organizací z Template a update Template z Organizací

Tenhle manuál je operativní runbook pro agenty a Kolegy, kteří pracují
v Conglomerate rootu nebo v Organizaci a nemají nutně přístup do privátního
engine repa `Rozjedeme-ai/HumanAndMachines`. Kanonický kontrakt procesu drží
`HumanAndMachines/docs/template-promotion-workflow.md` (proč a přesné hranice);
tady je jak. Když si tenhle manuál a kanonický kontrakt protiřečí, platí
kontrakt a tenhle soubor se má opravit.

Upstream template: `TemplatesRozjedeme-ai/OrganizationTemplate` (rename na
`OrganizationTemplate_GEN3` je rozhodnutý — decisions 0044/0045).

## Základní fakta

- **Template a Organizace nesdílejí git historii.** Organizace vzniklé z GEN2
  forku ani flagship Organizace nemají s template společný
  merge-base. Veškerá propagace je proto obsahová (content sync), ne git
  fork-merge. Three-dot diff (`git diff base...HEAD`) na takové dvojici padá
  na `no merge base` — používej two-dot (`git diff base HEAD`) nebo per-file
  porovnání.
- **Obsah má vlastníka podle klasifikace**: `managed` (vlastní template,
  v Organizaci se nepřepisuje ručně — synchronizuje se verbatim a drift se
  kontroluje hashem), `override` (vlastní Organizace), `manual` (jednorázově
  seedne fork, dál žije v Organizaci). Managed může být **celý soubor**
  (typicky generický skill), nebo jen **blok uvnitř org souboru** — příklad:
  kanonický blok „Model spolupráce" v AGENTS.md (od nadpisu
  `## Model spolupráce: Principál a Agenti` po další `## `, md5 po
  `.rstrip()`). AGENTS.md jako celek je soubor Organizace — synchronizuje
  se jen ten blok, nikdy celý soubor.
- **Template-first je default** (founder 2026-07-12): když dopředu víš, že
  změna je platformní/šablonovatelná (struktura AGENTS.md, generický skill,
  slovník, worktree kultura), autoruj ji přímo v template a do Organizací ji
  rozvez syncem. Promotion z Organizace je výjimka pro inovace zrozené
  v reálné práci. Nikdy nepropaguj přímo Organizace → Organizace.

## Směr 1: update Organizace z Template (sync)

1. Ve své Organizaci si založ worktree (viz skill worktree-stewardship) —
   sync nikdy nedělej v primárním checkoutu.
2. Získej aktuální stav template: u greenfield forku přes git remote
   `template` (`git fetch template`); u Organizace bez template remote
   (GEN2 fork před cutoverem) stačí čistý checkout template repa vedle.
3. Porovnej obsah **content-diffem** (two-dot, nebo per-file diff proti
   checkoutu template). U `managed` souborů převezmi obsah verbatim a ověř
   hash; u **managed bloků** nahraď jen daný blok uvnitř org souboru (zbytek
   souboru nech beze změny) a ověř hash bloku; u `override`/`manual` nic
   nepřepisuj — jen si poznač, jestli template nepřinesl nový vzor, který
   stojí za ruční převzetí.
4. Otevři plnohodnotný PR do repa své Organizace s popisem, které managed
   soubory se synchronizovaly a odkud (commit/tag template). Merge patří
   Organization Stewardovi.
5. Hromadný rozvoz do více Organizací („Template Sync Sweep") běží stejně,
   jen paralelně: jeden agent per Organizace, per-org PR, merguje Steward
   dané Organizace.

## Směr 2: update Template z Organizace (promotion)

1. Změna se nejdřív osvědčí v reálné Organizaci (typicky flagship).
2. V template repu založ worktree a branch `template-proposal/<popis>`.
3. Přenášej **kurátorskou extrakci, ne 1:1 diff**: odstraň názvy firem,
   reálná data, secrets, person overlaye, absolutní cesty; nahraď
   placeholdery (`<Organization>`, example-company). Anonymizační brána:
   grep na jména reálných Organizací musí být čistý.
4. Otevři PR do template repa; v popisu uveď reálnou bolest, obecný pattern
   a dopad na sync (které soubory se stanou managed). Merge patří ownerovi
   template (Admin/Steward).
5. Do Organizací se změna dostane až ze zmergnutého template směrem 1 —
   nikdy ne přímým kopírováním mezi Organizacemi.

## Kdo co smí

- Agent: worktrees a plnohodnotné PRs v obou směrech bez ptaní; žádný merge.
- Organization Steward: merge sync PRs své Organizace.
- Owner template (Admin/Steward): merge promotion PRs do template.
- Nejistý kandidát na promotion nezakládá PR — zapiš ho do `ISSUES.open.json`
  / TODO s tagem `template-promotion` k rozhodnutí.

## Související

- Kanonický kontrakt: `HumanAndMachines/docs/template-promotion-workflow.md`
  (vyžaduje přístup do HnM; pro práci v Organizaci stačí tenhle manuál).
- Greenfield vznik nové Organizace z template:
  `manual/first-client-organization-rollout.md`.
- Konverze existující GEN2 firmy: fork vlastního GEN2 repa (decision 0033),
  template je jen reference/validation boundary; template remote se přepíná
  až po cutoveru.
- Template flow shrnutí přímo v template: `AGENTS.md` sekce „Template flow"
  v `TemplatesRozjedeme-ai/OrganizationTemplate`.
