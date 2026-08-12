# Buddy a AI Kolega v Lazuriu

Lazurio je pracovní prostředí, ve kterém lidé a stroje používají stejné
Organizace, nástroje a dohledatelné procesy. Buddy a AI Kolega nejsou dvě kopie
Lazuria ani dlouhodobé Git branche. Jsou to dva profily jednoho produktu,
postavené z jednoho přesného source commitu.

Tento manuál je veřejná a offline dostupná část kontraktu. Neobsahuje
konkrétní osobnosti, mandáty, paměť, jména instalací, incidentní logy ani
credentials.

## Jedna mapa pojmů

| Pojem | Co znamená |
| --- | --- |
| Principál | Ten, pro koho Agent pracuje a kdo má poslední slovo. |
| Kolega | Lidský Principál. Na své Mašině dnes zpravidla používá Lazurio jako source checkout. |
| Buddy | Osobní zástupce jednoho lidského Principála uvnitř jeho Personalspace. Jedná jen v mezích jeho práv a mandátů. |
| AI Kolega | AI Principál s vlastní identitou, Mašinou, Personalspace a pracovními právy. Není Buddy. |
| Worker Agent | Nástrojová pracovní relace, například Codex nebo Claude Code. Sama žádná práva nevlastní. |
| Steward | Organizační role AI Kolegy nebo Kolegy. Její název nic neautorizuje; rozhodují živá GitHub práva. |
| Mašina | Počítač nebo dedikovaný host jednoho Principála či jeho Buddyho. |
| Personalspace | Privátní prostor právě jednoho Principála a případného Buddyho. |
| Organizace | Jedna firma, jeden GitHub Organization scope a jedna access hranice. |

## Source checkout a rezidentní root nejsou totéž

Kanonický Lazurio source je Git repozitář, ve kterém se vyvíjí společný
Launchpad, Doctor, Guide, manuály a profilový build. Z něj vzniká
**rezidentní Lazurio Root**: celý instalovatelný strom pro jeden profil,
platformu a architekturu.

Rezidentní root:

- není Git repozitář a nemá personu ukrytou v branchi;
- má právě jeden vygenerovaný root `AGENTS.md`;
- nese manifest `lazurio.resident.json` s exact source SHA, profilem,
  platformou, Hermes pinem a hashi payloadu;
- neobsahuje Personalspace, Organization checkouty, secrets ani runtime data;
- může po instalaci připojit perzistentní `personalspace/` a `organizations/`
  jako oddělené mutable mounty.

V source není umělý adresář `common/`. Sdílený produkt zůstává běžným Lazurio
stromem a build k němu přidá pouze úzký profilový fragment. Zdrojové fragmenty
se nejmenují `AGENTS.md`, takže v development checkoutu omylem nepřebírají
řízení Agentů.

## Profil Buddy

Buddy patří jednomu člověku a zastupuje ho jeho právy. Veřejný profil určuje
hranice práce, soukromí a incidentního chování; neurčuje osobnost konkrétního
Buddyho. Ta spolu s ústavou, mandáty a pamětí zůstává v privátním
Personalspace.

Buddy není AI Kolega ani Steward. Běžný Worker Agent spuštěný na Buddyho
Mašině také není Buddy. Transakčně citlivé kroky — přístupy, secrets,
destruktivní operace, billing, ownership a publish/release mimo trvalý mandát
— vyžadují přesný souhlas lidského Principála.

Veřejný Buddy runtime obsahuje komunikační bridge mezi privátním Zulipem a
agentním runtime. Bridge sám nevlastní identitu ani mandáty: před prvním
síťovým krokem ověří mount privátního profilu, vloží jeho ústavu a mandáty do
každého turnu a odmítne běh bez úplného kontraktu. Běží pod odděleným účtem,
nevystavuje příchozí port a trvanlivou frontu drží mimo immutable root.

## Profil AI Kolega a Steward overlay

AI Kolega je samostatný Principál. Má vlastní účet, seat, Mašinu,
Personalspace a přístupy do Organizací. Budoucí profil `ai-colleague` použije
stejný build, manifest, Doctor a updater jako Buddy, ale jiné root instrukce.

Steward není třetí profil. Je to role overlay nad AI Kolegou, který může
zpřesnit workflow a health checks. Overlay však nevytvoří žádné oprávnění:
merge, release a administrativní operace dál povoluje jen přihlášená GitHub
identita, její Teamy a branch rules.

## Instalace, aktualizace a rollback

Release je svázaný s přesným artefaktem. Bezpečný lifecycle má tento tvar:

1. ověřit digest, manifest, profil a kompatibilitu s platformou;
2. rozbalit do nové verzované cesty, nikoli přes aktivní instalaci;
3. připojit existující mutable mounty bez kopírování jejich obsahu;
4. spustit integrity a profilový health gate;
5. teprve při PASS atomicky přepnout aktivní verzi;
6. ponechat poslední zdravou verzi jako explicitní rollback cíl.

První rollout je úmyslně asistovaný a viditelný. Background daemon,
nepozorovaná fleet aktualizace a autonomní maintenance window nejsou součástí
základního kontraktu. Přesný stav aktuálního artefaktu ověří
`bun run resident:doctor`.

Updater v1 drží immutable verze pod `versions/`, content-free lifecycle stav a
mutable `organizations/` a `personalspace/` pod odděleným `state/`. `active`
je atomicky měněný odkaz na jednu zdravou verzi. Po prvním assisted bootstrapu
se update, status a rollback spouští z `active/resident/updater.mjs`; živý root
se kvůli tomu nestává source checkoutem.

První lifecycle adapter je záměrně pouze POSIX (Linux a macOS). Windows
rezidentní instalace se nezapne, dokud nebude mít vlastní atomický pointer
adapter a stejné failure testy. To neomezuje dnešní Windows Kolegy: jejich
Lazurio zůstává Git checkout, ve kterém mohou připravit platformní opravu přes
branch a PR.

## Když je potřeba vlastní oprava Launchpadu

Nainstalovaný root se ručně nepatchuje. Běžná oprava vznikne v odděleném
Lazurio source checkoutu, projde PR a vytvoří nový artefakt. Urgentní chyba
jedné platformy může dostat exact-SHA candidate build jen na vybranou Mašinu,
ale stále se známým digestem, health gatem a návratem na last-known-good.

Tím zůstává nouzová oprava rychlá a zároveň dohledatelná. Lokální změna, kterou
další update potichu přepíše, není podporovaný hotfix.

## Když něco nefunguje

- Nejdřív zastav další mutace a spusť resident Doctor.
- Rozliš veřejný artefakt, privátní Personalspace, Organization checkout,
  externí službu a agentní runtime. Jedna porucha neopravňuje procházet jiný
  scope.
- Aktivní verzi nepřepisuj poškozenou kandidátní verzí. Selhání před health
  gatem nechává active beze změny; post-switch selhání se vrací na poslední
  zdravou verzi.
- Do sdílené evidence patří verze, check, čas a content-free výsledek. Obsah
  paměti, konverzací, secrets ani osobní data tam nepatří.
- Neprokázaný přístup znamená „nemám přístup“. Nevytvářej náhradní token,
  účet, veřejný port ani druhou neauditovanou cestu.

## Kde žijí další informace

- Produktový source, build kontrakt a tento public manuál: Lazurio source.
- Obecné interní know-how a anonymizované learnings: Knowledgebase příslušné
  Organizace.
- Aktivní plán, rollout a blokery: její Mission Control.
- Osobnost, mandáty a paměť: privátní Personalspace.
- Jmenovitá evidence, credentials, zálohy a runtime logy: scoped privátní
  custody dané instalace.

Žádná z těchto vrstev se nestává druhou autoritou jen proto, že je lokálně
dostupná.
