# Michael CEO Double v0.2 R1 — neaktivní review pack

Tento adresář vznikl na základě explicitního schválení `ARCH-CEO-DOUBLE-0.2-R1` dne 2026-08-12. Povolen byl pouze neaktivní Agent Builder pack a anonymizované fixtures.

## Stav

- runtime: **neaktivní / nevytvořený**
- live konektory: **0**
- callable tools: **0**
- schedule: **0**
- GBrain write: **zakázán**
- externí akce: **zakázány**
- memory: **none**
- commit/push/PR: **neprovedeno a tímto schválením nepovoleno**

## Obsah

- `agent-pack.json` — governance kontrakt;
- `instructions.md` — fail-closed instrukce;
- `policy/` — boundary, source, retention, metriky a skill router;
- `schemas/` — návrh datových a výstupních kontraktů;
- `evals/` — anonymizované případy, fixtures a očekávané výstupy;
- `runbooks/` — incident, recovery a rollback návrh.

## Validace

Kanonický validační příkaz:

```bash
bun .agents/skills/agent-builder/scripts/validate_agent_pack.mjs .agents/packs/michael-ceo-double-v0.2-r1
```

Tento příkaz kontroluje strukturu packu; nepovoluje ani nespouští runtime.

## Offline eval runner

Runner je deterministický a statický: nevolá model, Hermes tools, síť, live konektory ani externí systémy. Vyhodnocuje vnitřní konzistenci všech 46 syntetických scenario kontraktů a jejich explicitních `eq` assertions, fixture-only provenance, fail-closed boundary/access/failure pravidla, nulovou aktivaci, decision limit a finanční aritmetiku. Případ bez spustitelných assertions končí `FAIL`, nikdy se nezapočítá jako PASS. Výsledek je důkaz statické konzistence kontraktů, nikoli behaviorální nebo runtime eval agenta.

```bash
bun test tests/offline-eval-runner.test.mjs
bun scripts/offline-eval-runner.mjs > evals/results/offline-eval-report.json
```

Výstup musí mít `dry_run_only: true`, prázdné `tool_calls_executed` a `external_actions_executed` a stav `PASS`. Výstupní report zůstává lokální a necommitnutý, dokud nebude samostatně schválen commit.

## Samostatné budoucí approval gates

Live shadow pilot, přesné source/object allowlisty, runtime storage, GBrain promotion, schedule, jakýkoli write/outbound, commit a publikace vyžadují samostatný přesný souhlas.
