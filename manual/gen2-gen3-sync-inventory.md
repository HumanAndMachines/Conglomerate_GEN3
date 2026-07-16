# GEN2 → GEN3 organization sync inventory

This is the read-only inventory step for a **single Organization** moving from a
legacy GEN2 workspace shape into a GEN3 Organization checkout. It compares two
explicit paths supplied by the operator and reports which files need review,
porting, skipping, or mechanism extraction.

The script is intentionally generic: the shared `HumanAndMachines/Conglomerate_GEN3`
root must not embed one Organization's paths, people, ledgers, records, ports, or
business facts. Any local pair list belongs in an ignored/local file outside the
shared source-of-truth, or is passed explicitly at runtime.

## Command

From the shared root:

```bash
bun run sync:gen2-gen3:inventory -- \
  --gen2 /path/to/LegacyOrgGEN2 \
  --gen3 /path/to/Conglomerate/organizations/ExampleOrg_GEN3 \
  --label "Example Organization"

bun run sync:gen2-gen3:inventory -- \
  --gen2 /path/to/LegacyOrgGEN2 \
  --gen3 /path/to/Conglomerate/organizations/ExampleOrg_GEN3 \
  --label "Example Organization" \
  --json \
  --include-shared-surfaces
```

For local batch runs, pass an ignored JSON file:

```bash
bun run sync:gen2-gen3:inventory -- \
  --pairs-file /path/to/local-gen2-gen3-pairs.json \
  --json
```

Minimal pairs-file shape:

```json
{
  "pairs": [
    {
      "key": "example-org",
      "label": "Example Organization",
      "gen2": "/path/to/LegacyOrgGEN2",
      "gen3": "/path/to/Conglomerate/organizations/ExampleOrg_GEN3"
    }
  ]
}
```

Do not commit local pair files when they reveal private paths, client names, or
Organization-specific migration state.

## Classification

Basic diff kind:

- `port-candidate` — file exists in GEN2 source but not GEN3 target.
- `gen3-only` — file exists in GEN3 target but not GEN2 source; usually pilot-only
  or already migrated work.
- `manual-review` — file exists in both but content differs.
- `same` — omitted by default; use `--include-same` if needed.

Promotion owner hint:

- `shared-root` — possible cross-Organization mechanism for `launchpad/`, `guide/`,
  root manuals, migration tooling, discovery/runtime/doctor logic, or desktop
  packaging. Promote only mechanism, never Organization data.
- `template-baseline` — possible reusable Organization/template/agent/tooling
  baseline. Anonymize before putting it in templates.
- `organization-local` — ledgers, Mission Control plans, manifests, real business
  facts, operational state, or other Organization truth. Do not promote.
- `manual-review` — no safe automatic owner; classify by reading the diff.

Extraction mode:

- `mechanism-only` — rewrite as a generic shared mechanism with placeholder names.
- `anonymize-before-template` — convert to template language and remove all real
  names, paths, clients, ports, records, credentials and business facts.
- `schema-or-template-only` — only schema/contract ideas can move; concrete manifest
  rows stay with the Organization.
- `do-not-promote` — keep in the Organization unless an explicit import/remap plan
  exists.
- `classify-before-promoting` — human review required.

## Allowlist and skip policy

The default inventory focuses on source-of-truth and control-plane surfaces:

- root docs and ledgers (`README.md`, `AGENTS.md`, task/issue JSON files, etc.);
- `mission-control/**`;
- `manual/**`;
- `company/scripts/**`;
- `company/agents/**`;
- `company/archive/**`.

It intentionally skips broad or high-risk surfaces:

- `modules/**` and `productionspace/**` — port through module-specific PRs;
- `ClientCompanies/**`;
- `company/team/**` person/team overlays;
- `private/**`, `personalspace/**`, secrets, build output, node modules, caches.

Use `--include-shared-surfaces` to include `launchpad/**`, `guide/**` and
`.claude/skills/**` in a **mechanism extraction pass**. That mode is for finding
shared-root/template candidates, not for direct copy.

## Shared-root promotion rule

When a legacy Organization proves a useful mechanism, use this promotion path:

```text
legacy Organization proof
→ GEN3 Organization curated forward-port, if the Organization still needs it
→ shared-root mechanism or template baseline, with Organization data removed
→ other Organizations / clients consume the generic mechanism
```

Before writing to `HumanAndMachines/Conglomerate_GEN3`, ask:

1. Would this be true for another Organization with different people, domain,
   ports, data and access boundaries?
2. Can the mechanism be tested without real Organization records?
3. Does the shared root need this, or should it live in an OrganizationTemplate,
   MissionControlTemplate, KnowledgebaseTemplate, or a module template?
4. Does the diff contain names, customer data, business facts, real ledgers,
   private paths, credentials, production host state, or current tasks?

If the answer to #4 is yes, stop and anonymize or keep it local.

## Port allocation guardrail

Do **not** fix Launchpad port collisions by choosing ad-hoc local ports. GEN3
needs an Organization-wide and root-visible port allocation/validation path so
every builder and Workspace Host uses stable module ports. If discovery reports a
collision, treat it as a registry/manifest governance issue: find the canonical
module port, update docs/manifests, and only then change package metadata.

## Next stage before apply mode

Before any script writes into a GEN3 target, add:

1. explicit per-path allowlist;
2. conflict file output;
3. reviewed patch generation instead of direct overwrite;
4. post-apply validation per workspace;
5. rollback instructions;
6. source PR/handoff links back to the relevant plan;
7. fixed Organization/module port registry checks, not ad-hoc port choices;
8. a no-Organization-data audit for any shared-root or template promotion.
