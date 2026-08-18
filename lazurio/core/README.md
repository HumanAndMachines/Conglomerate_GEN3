# Lazurio Core

Tato složka je jediná interní vlastnická hranice pro doménovou logiku, kterou
sdílí Lazurio CLI a Launchpad. Je součástí stejného repozitáře a není veřejným
ani verzovaným API.

Core smí importovat jen Node/Bun standardní knihovny a jiné Core moduly. Nesmí
importovat Lazurio CLI, search adapter, Launchpad server, UI ani runtime
composition. Směr závislosti je vždy opačný: surfaces importují Core.

První behavior-preserving řezy vlastní klasifikaci Organization repository
slotů, jejich normalizovanou katalogovou prezentaci, kanonickou filesystem
containment hranici a čistý kontrakt runtime deklarace Modulové aplikace.
`ui_exposure` zůstává pouze prezentační policy; nevytváří identitu resource ani
access autoritu. Další doménové vrstvy se přesunují samostatnými PR až nad
zeleným parity baseline; fyzický přesun souboru sám nesmí měnit schéma ani
chování.

Search, QMD, auth, Dashboard login, nové příkazy, veřejná schémata a samostatný
runtime proces do Core nepatří.
