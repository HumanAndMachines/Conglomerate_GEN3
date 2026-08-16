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
  platformou, Hermes/GBrain/toolchain piny a hashi payloadu;
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

### Trust model Buddyho

Pro provoz se vždy rozlišují tři otázky:

1. Buddyho turn smí zadat právě jeden lidský Principál; to drží privátní
   komunikační surface a provider access.
2. Mašinu a Lazurio vlastní Principál. Smí je lokálně upravit; Doctor změnu
   popíše jako drift a lifecycle nabídne vratnou cestu, ale změnu nezakazuje.
3. Přístup běžícího Agenta k souborům a nástrojům drží Hermes sandbox. Lazurio
   vedle něj nevytváří druhý ACL ani paralelní sandbox.

Skutečnou vstupní hranicí Buddyho je jeho privátní komunikační surface.
Zulip realm, membership, credentials a síťový access plane musí být určené
právě jednomu lidskému Principálovi a technické identitě jeho Buddy botu. Turn
smí zadat pouze Principál; bot odpovídá a poskytovatel infrastruktury není další
Principál. Jiný autor konverzace znamená porušené nasazení, ne novou roli.

Principál vlastní svou Mašinu a systém předpokládá, že to se sebou myslí dobře.
Lazurio proti němu nestaví vlastní ACL, ownership gate ani permission zámek.
Agentní přístup k souborům a nástrojům omezuje existující sandbox runtime —
dnes Hermes Agent. Manifest, Doctor, service oddělení a rollback pouze
zviditelňují odchylky, omezují náhodnou self-mutaci procesu a umožňují obnovu;
nejsou druhou autorizační hranicí.

Jedna úzká provozní podmínka z toho neustupuje: runtime nesmí vlastnit ani umět
přepsat sandbox, který jej omezuje. Hermes checkout a Bun může vlastnit a měnit
Principál nebo jím řízená maintenance identita, která nespouští agentní relaci.
Účty `buddy` a `buddy-bridge` k nim musí mít pouze potřebné čtení/spuštění a
nesmí je nahradit ani přes parent adresář. Preflight kontroluje skutečná host
oprávnění a tracked Hermes bytes proti pinned commitu bez důvěry v Git index,
replacement refs či symlinkované předky. Jde o self-protection existujícího
Hermes sandboxu, ne o nový Lazurio ACL.

Veřejný Buddy runtime obsahuje komunikační bridge mezi privátním Zulipem a
agentním runtime. Bridge sám nevlastní identitu ani mandáty: před prvním
síťovým krokem ověří mount privátního profilu, vloží jeho ústavu a mandáty do
každého turnu a odmítne běh bez úplného kontraktu. Běží pod odděleným účtem,
nevystavuje příchozí port a trvanlivou frontu drží mimo immutable root.
Přechodová služba používá již existující host custody soubor; jeho secrets
nekopíruje ani nevypisuje. Cutover je vratný přes uchovanou původní systemd
unit a úspěch nového residenta dokazuje registrace polleru, nikoli jen stav
procesu. Unmanaged pre-resident unit se před migrací i po explicitním restore
ověřuje svým legacy enabled/active systemd kontraktem; nový `poller.json` po ní
se nedá vyžadovat.
Hermes dostává aktivní Lazurio Root jako `TERMINAL_CWD`, aby jeho context-file
discovery vložilo veřejný profilový `AGENTS.md` i do Zulip session. Ten se
vrství s privátní ústavou a mandáty; žádná z těchto vrstev nenahrazuje druhou.
Existující Personalspace se při migraci nekopíruje: updater ho adoptuje jako
explicitní updater-managed mutable mount kontrakt a service preflight ověří, že
deklarovaný Buddy profil skutečně leží uvnitř `active/personalspace`.
Produkční příkaz `buddy-rollout` skládá aktivaci rootu a service cutover do
jedné kompenzované operace. Selže-li service gate, novou aktivaci odstraní nebo
vrátí last-known-good a znovu zprovozní předchozí service vstupy.
Bun binárku pro unit volí Principál explicitně přes `--bun PATH`; preflight ji
resolveuje a ověří její spustitelnost runtime účtem, ale nevyžaduje root-owned
instalaci. Současně ověří, že ji ani Hermes checkout účty `buddy` a
`buddy-bridge` nevlastní a nemohou přepsat nebo nahradit přes zapisovatelný
parent.
Sanitizované privileged subprocessy chrání instalační krok před ambientním
`PATH` a Git hooky, ne Lazurio před Principálem.
Privátní Buddy profil zůstává mutable a služba jej čte přes běžná host
oprávnění. Další sandbox pro Personalspace tu nevzniká; přístup agentních
nástrojů omezuje existující Hermes sandbox.

## Profil AI Kolega a Steward overlay

AI Kolega je samostatný Principál. Má vlastní účet, seat, Mašinu,
Personalspace a přístupy do Organizací. Budoucí profil `ai-colleague` použije
stejný build, manifest, Doctor a updater jako Buddy, ale jiné root instrukce.

Steward není třetí profil. Je to role overlay nad AI Kolegou, který může
zpřesnit workflow a health checks. Overlay však nevytvoří žádné oprávnění:
merge, release a administrativní operace dál povoluje jen přihlášená GitHub
identita, její Teamy a branch rules.

## Instalace, aktualizace a rollback

První nasazení celé Mašiny a aktualizace už nainstalovaného Lazurio Rootu jsou
dvě různé operace. Blank nebo obnovovanou Mašinu připravuje zvenku reviewovaný
operator plane; jeho public-safe vstup je `provisioning/README.md` ve source
checkoutu. Běžný update už aktivního Residenta provádí pouze jeho verzovaný
updater. Ansible může updater explicitně zavolat, ale nesmí znovu implementovat
kopírování, přepnutí active verze ani rollback.

Buddy/Linux operator lane v1 používá jen existující mechanismy: Ansible pro
host desired state, upstream install rozhraní Hermesu a GBrainu, Tailscale jako
access plane, UFW jako host firewall a provider snapshot jako recovery bod.
Nový osobní GBrain začíná na lokálním PGLite; nevzniká kvůli němu další
PostgreSQL service. Zulip je privátní externí transport prerequisite a Buddy
bridge jej polluje odchozím spojením, takže resident host nepotřebuje veřejný
Zulip ingress.

Síťový kontrakt Linux profilu v1 má nulový veřejný ingress. SSH, případný
privátní Zulip HTTPS a servisní UI se připouštějí pouze přes deklarované
tailnet rozhraní. Najde-li preflight staré veřejné nebo jinak cizí allow
pravidlo, nic nemaže ani nepřepisuje: zastaví se a nechá Principála rozhodnout,
co na jeho Mašině skutečně patří zachovat.

Release je svázaný s přesným artefaktem. Bezpečný lifecycle má tento tvar:

1. ověřit digest, manifest, profil a kompatibilitu s platformou;
2. rozbalit do nové verzované cesty, nikoli přes aktivní instalaci;
3. připojit existující mutable mounty bez kopírování jejich obsahu;
4. spustit integrity a profilový health gate;
5. teprve při PASS atomicky přepnout aktivní verzi;
6. ponechat poslední zdravou verzi jako explicitní rollback cíl.

Rollout v1 je úmyslně asistovaný a viditelný. Background daemon,
nepozorovaná fleet aktualizace a autonomní maintenance window nejsou součástí
základního kontraktu. Přesný stav aktuálního artefaktu ověří
`bun run resident:doctor`.

Updater v1 drží immutable verze pod `versions/`, content-free lifecycle stav a
mutable `organizations/` a `personalspace/` pod odděleným `state/`. `active`
je atomicky měněný odkaz na jednu zdravou verzi. Po assisted bootstrapu
se update, status a rollback spouští z `active/resident/updater.mjs`; živý root
se kvůli tomu nestává source checkoutem.

Lifecycle adapter v1 je záměrně pouze POSIX (Linux a macOS). Windows
rezidentní instalace se nezapne, dokud nebude mít vlastní atomický pointer
adapter a stejné failure testy. To neomezuje dnešní Windows Kolegy: jejich
Lazurio zůstává Git checkout, ve kterém mohou připravit platformní opravu přes
branch a PR.

Konkrétní offline postup pro status, update, rollback a zachování lokálního
hotfixu je v `manual/update-installed-resident.md` a je součástí resident
artefaktu.

## Když je potřeba vlastní oprava Launchpadu

Principál může nainstalovaný Lazurio Root na své Mašině upravit, například kvůli
urgentní platformní chybě. Resident mu v tom nestaví vlastnický ani permission
zámek. Taková oprava pouze přestává být kanonickým release: Doctor ji ukáže
jako lokální drift a updater se zastaví, aby ji další verzí potichu nepřepsal.

Má-li oprava zůstat, nejčistší další krok je přenést ji do odděleného Lazurio
source checkoutu, nechat projít PR a postavit nový artefakt. Do té doby může
lokální hotfix dál sloužit svému účelu; operátor jen vědomě rozhodne, zda jej
před příštím update zachová, přenese do release, nebo vrátí na kanonickou
verzi. Systém zde Principálovi pomáhá odchylku vidět, nepředpokládá proti němu
nepřátelský model.

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
