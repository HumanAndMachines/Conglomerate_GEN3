# Lazurio Core

Tato složka je jediná interní vlastnická hranice pro doménovou logiku, kterou
sdílí Lazurio CLI a Launchpad. Je záměrně součástí stejného repozitáře a zatím
není veřejným ani verzovaným API.

Core smí importovat Node/Bun standardní knihovny a jiné Core moduly. Nesmí
importovat Lazurio CLI, search adapter, Launchpad server, UI ani runtime
composition. Směr závislosti je vždy opačný: surfaces importují Core.

Core vlastní bezpečné Git procesy, lokální Git stav, materializaci checkoutů,
root update, Organization/app discovery, Git inventory a společná pravidla
cest a Organization repo slotů. Context a Doctor adapter se sem přesunují
v dalších mechanických řezech stejného plánu až nad zelenou parity baseline.

Search zůstává CLI-owned. QMD, `rg`, search cache, MCP, auth, Dashboard login,
nové příkazy a veřejné schema do Core v tomto refaktoru nepatří.
