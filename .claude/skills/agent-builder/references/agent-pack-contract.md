# Agent pack contract

`agent-pack.json` používá schema `humanandmachines.agent_pack.v1` a obsahuje:

- `id`, `display_name`, `agent_kind`, `purpose`;
- `principal`, `owner`, `scope` (`in`, `out`);
- `inputs`, `outputs`, `tools`;
- `access`, `approvals`, `memory`;
- `evals`, `observability`, `cost_guardrails`, `release`.

Pole jsou záměrně povinná. `display_name` a `purpose` jsou neprázdné řetězce;
`principal` a `owner` jsou neprázdný řetězec nebo objekt identity. `scope` je
objekt s poli `in` a `out`, která obsahují jen neprázdné řetězce; `inputs`,
`outputs` a `tools` jsou pole. Prázdné
`tools` nebo `memory` smí znamenat vědomé „žádný nástroj / žádná paměť“,
nikoli nehotové rozhodnutí.

`access`, `approvals`, `evals`, `observability`, `cost_guardrails` a `release`
jsou neprázdné JSON objekty: `null`, primitivní hodnota ani `{}` není platná
governance definice. `agent_kind` je `worker_agent` nebo
`ai_colleague_proposal`; druhý typ nesmí mít `release.activation` nastavené na
`automatic`.

`evals/cases.json` používá schema `humanandmachines.agent_evals.v1`. Každý
případ je JSON objekt a má `id`, `category`, `input`, `expected`, `forbidden`
a `evidence`; žádné z těchto polí nesmí být `null` a ID případu je unikátní.
Povinné kategorie jsou `happy_path`, `boundary`, `access_denied`,
`tool_failure` a `regression`.
