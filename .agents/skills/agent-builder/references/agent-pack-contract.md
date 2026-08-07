# Agent pack contract

`agent-pack.json` používá schema `humanandmachines.agent_pack.v1` a obsahuje:

- `id`, `display_name`, `agent_kind`, `purpose`;
- `principal`, `owner`, `scope` (`in`, `out`);
- `inputs`, `outputs`, `tools`;
- `access`, `approvals`, `memory`;
- `evals`, `observability`, `cost_guardrails`, `release`.

Pole jsou záměrně povinná. Prázdné pole je přijatelné jen tam, kde znamená
vědomé „žádný nástroj / žádná paměť“, nikoli nehotové rozhodnutí. `agent_kind`
je `worker_agent` nebo `ai_colleague_proposal`; druhý typ nesmí mít
`release.activation` nastavené na `automatic`.

`evals/cases.json` používá schema `humanandmachines.agent_evals.v1`. Každý
případ má `id`, `category`, `input`, `expected`, `forbidden` a `evidence`.
Povinné kategorie jsou `happy_path`, `boundary`, `access_denied`,
`tool_failure` a `regression`.
