---
name: agent-builder
description: Navrhne, sestaví nebo zreviduje bezpečný a přenositelný agentní kompetenční balíček se scoped instrukcemi, nástroji, access hranicemi, evaly, observabilitou a publikačními branami. Použij při požadavku postavit agenta, agent workflow, golden agenta, AI workflow nebo opakovatelnou agentní roli; nepoužívej pro pouhé sepsání jednoho promptu ani pro automatické založení autonomního AI Kolegy.
---

# Agent Builder

## Kdy použít

Použij pro návrh nebo realizaci opakovatelného Agenta, který má pracovat nad
reálnými repozitáři, aplikacemi nebo daty. Výsledkem je reviewovatelný balíček,
ne neomezená autonomie ani nová identita.

Nejdřív rozliš:

- **Skill** — opakovatelný postup bez vlastního runtime; preferovaný první krok.
- **Plugin** — distribuční balíček skillů a případných MCP nástrojů pro další lidi.
- **Worker Agent** — řízený runtime s nástroji, evaly a trace; nemá vlastní
  pravomoce a pracuje jménem Principála.
- **AI Kolega / AI Architekt** — organizační persona se seatem, vlastníkem,
  governance a recovery kontraktem. Tento skill smí vytvořit jen návrh; nesmí
  personu aktivovat, přidělit jí přístupy ani obejít schvalované apply plány.

Před návrhem načti `references/surface-selection.md`. Pro implementaci nebo
review balíčku načti také `references/quality-gates.md`.

## Postup

1. **Urči výsledek a vlastníka.** Zapiš jeden konkrétní cíl, Principála,
   provozního ownera, uživatele výstupu a měřitelný úspěch. Bez ownera nebo
   jasného cíle zůstaň u návrhu.
2. **Zvol nejmenší surface.** Pokud stačí skill, nestav runtime. Plugin použij
   až pro instalovatelnou distribuci nebo živé nástroje. Runtime Agenta přidej,
   až když workflow potřebuje stav, handoffy, paralelismus, plánovaný běh nebo
   auditovatelný tool loop.
3. **Vymez scope a autoritu.** Uveď povolené vstupy, výstupy, repozitáře,
   Organizace, tools a write operace. Explicitně vypiš zakázané scope,
   cross-organization přenosy, secrets, externí komunikaci a publikační akce.
   GitHub a lokální Organization pravidla zůstávají autoritou přístupů.
4. **Navrhni jeden Agent jako baseline.** Multi-agent architekturu přidej jen
   pokud má každá role odlišný kontext nebo nástroje a handoff má ověřitelnou
   bránu. Každý handoff musí nést očekávaný artefakt a kontrolu jeho existence.
5. **Vytvoř agent pack.** V cílové, uživatelem schválené cestě vytvoř:
   `agent-pack.json`, `instructions.md`, `evals/cases.json` a `README.md`.
   Kontrakt `agent-pack.json` popisuje `references/agent-pack-contract.md`.
6. **Nástroje a identita.** U každého nástroje uveď účel, read/write režim,
   access zdroj, timeout a fail-closed chování. Skill učí workflow; MCP/CLI/API
   drží živá data, autentizaci a řízené akce. Nikdy nevkládej credential hodnoty
   do packu, logu, promptu ani Gitu.
7. **Paměť a data.** Default je bez dlouhodobé paměti. Pokud je nutná, definuj
   ownera, retenci, datové třídy, mazání a hranici Personalspace/Organizace.
   Trace není business source of truth a osobní paměť se nesdílí mezi lidmi.
8. **Eval-first.** Připrav nejméně jeden běžný, hraniční, access-denied,
   tool-failure a regresní případ. Každý případ má deterministická očekávání,
   zakázané chování a evidenci. Citlivá data anonymizuj.
9. **Provozní brány.** Definuj bezpečnost, kvalitu, UX, latenci, cenu, retry,
   observabilitu, incident ownera a rollback. Draft, publish, deploy a release
   musí zůstat odlišné akce.
10. **Ověř a předej.** Spusť `scripts/validate_agent_pack.mjs <cesta-k-packu>`,
    relevantní repo testy a nejméně jeden suchý běh na anonymizovaných datech.
    Runtime, access grant, schedule, deploy nebo release proveď až po explicitní
    autorizaci podle aktuálního scope.

Pro OpenAI runtime preferuj Responses API nebo Agents SDK s trasováním; Codex
lze připojit jako MCP server pro auditovatelnou implementační lane. Zachovej
repo `AGENTS.md`, sandbox a approval policy. Nevkládej příklady s API klíčem do
trackovaných souborů.

## Ověření

Minimální Definition of Done:

- surface odpovídá potřebě a Agent není zbytečně zaměněný za skill;
- `agent-pack.json` projde validátorem;
- scope, access a publikační brány jsou fail-closed;
- eval sada pokrývá běžný běh, odmítnutí přístupu i selhání nástroje;
- jsou definované trace, latence, cena a incident/rollback owner;
- anonymizovaný dry run má uchovanou evidenci a žádná citlivá data;
- uživatel dostane jasný seznam toho, co je připravené, co není aktivované a
  jaký explicitní krok je potřeba pro publikaci nebo provoz.
