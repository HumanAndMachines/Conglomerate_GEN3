# Surface selection

| Potřeba | Nejmenší vhodný surface | Nepoužívat jako náhradu |
| --- | --- | --- |
| Jednorázové omezení | prompt / task kontext | trvalý skill |
| Trvalá repo pravidla | `AGENTS.md` | dlouhý operativní postup |
| Opakovatelný postup | skill | nový runtime Agenta |
| Instalace pro další lidi | plugin se skilly | kopírování složek mezi repy |
| Živá data a řízené akce | MCP/CLI/API + skill | instrukce s credentialy |
| Stavový tool loop, handoffy, trace | Worker Agent runtime | neomezená autonomie |
| Organizační AI persona | AI Kolega / AI Architekt proposal | Worker Agent vydávající se za Kolegu |

Codex umí skills načítat repo-scoped z `.agents/skills`. Pro distribuci více
skillů nebo skillu s konektorem je vhodný plugin. OpenAI Agents SDK podporuje
nástroje, handoffy, guardrails a tracing; Codex může běžet jako MCP server pro
scoped implementační práci. Žádný z těchto surface sám nepřiděluje business
pravomoce.

Lazurio decision 0052 drží AI Architekta jako placenou admin službu,
která navrhuje Dashboard apply plány ke schválení. Není náhradou builder agentů
a nesmí zapisovat přímo do zákaznického Gitu.
