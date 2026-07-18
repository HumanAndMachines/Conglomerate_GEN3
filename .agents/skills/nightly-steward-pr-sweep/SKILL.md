---
name: nightly-steward-pr-sweep
description: Use when an Organization Steward must run the daily 02:00 PR closeout for exactly one GitHub Organization assigned to that seat. Inventories the live queue, applies exact-head review and CI gates, actively fixes or routes bounded work, merges only within Steward authority, and writes one idempotent Mission Control Steward Report.
version: 1.0.3
author: HumanAndMachine GEN3
license: MIT
metadata:
  hermes:
    tags: [organization-steward, github, pull-requests, mission-control, nightly]
    related_skills: [github-pr-workflow, github-code-review, live-pr-review-gate]
---

# Nightly Steward PR Sweep

## Overview

The **Nightly Steward PR Sweep** is Organization Steward work. Run it once per Organization policy and seat at 02:00 Europe/Prague. The Steward is an AI Kolega with its own identity and authority; Codex/Claude/subagents used during the sweep are Agents whose output stays Draft until the Steward verifies and acts.

Load `references/organization-policy.yaml` and `references/live-run-contract.md` before every run. The policy is the hard scope boundary; the live-run contract defines the executable Mission Control writer/readback path. Never inspect or mutate another Organization merely because the GitHub account can see it.

## Kdy použít

Použij pro denní 02:00 closeout otevřených PR jedním skutečným Organization
Steward seatem v právě jedné Organizaci. Nepoužívej jako centrální
cross-Organization sweep Buddyho, jako náhradu aktivního reviewera ani pro
Release/deploy. Před instalací materializuj
`templates/organization-policy.yaml` do Organization-local
`references/organization-policy.yaml` a vyplň právě jednu autorizovanou
Organization hranici. Jedna policy nesmí obsahovat více Organizations,
rosterů ani report targets. Když founder governance přiřadí jednomu AI
Kolegovi více Organization seatů, vytvoř pro každou Organization samostatný
policy soubor a samostatný run/outcome. Jeden scheduler je smí spustit
sekvenčně, ale failure jedné policy nesmí zablokovat, zneplatnit ani
kontaminovat jinou.

## Completion contract

A run is complete only when all are true:

1. Every live open PR in the one configured GitHub Organization was inventoried after the run began. A repository that belongs to another owner lane is still inventoried and routed; it is not silently omitted.
2. Every non-draft PR has a live exact-head classification based on head SHA, base, reviews tied to that SHA, checks, mergeability and unresolved threads.
3. Every safe merge candidate was either merged and read back, or has a named policy/human blocker.
4. Every remaining change request has a durable owner/handoff; plain `DIRTY`, `BLOCKED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED` is not a final blocker class.
5. Drafts and explicit owner/no-touch items remained untouched.
6. One idempotent Organization Steward Report was published to that Organization's Mission Control and read back by report ID.
7. The final line is exactly one of:
   - `NIGHTLY_STEWARD_PR_SWEEP Status: PASS`
   - `NIGHTLY_STEWARD_PR_SWEEP Status: ATTENTION`
   - `NIGHTLY_STEWARD_PR_SWEEP Status: BLOCKED`
   - `NIGHTLY_STEWARD_PR_SWEEP Status: ERROR`

## Postup

## 1. Preflight gate

1. Read the nearest Organization `AGENTS.md`, source-of-truth guide, governance manifest and `references/organization-policy.yaml`.
2. Verify `hostname`, OS user, local timezone, `gh api user`, Git protocol, workspace paths, clean reference checkouts and Mission Control report target. Never print credentials.
3. Verify the current seat login equals `steward.github_login`. A mismatch or invalid GitHub auth is `BLOCKED`; do not borrow Admin credentials.
4. Require policy schema `humanandmachine.nightly_steward_pr_sweep.policy.v2`, exactly one `github_organizations[]` entry and exactly one matching `scope.organization_repository_rosters[]` entry with `github_organization`, a non-placeholder `source`, and a non-empty unique `required_repositories` list of canonical `owner/repo` identifiers belonging to that Organization. Reconcile the list against the authoritative Organization governance source named by `source`. Missing v2 metadata, zero or multiple configured Organizations/rosters, an empty list, unresolved placeholders, mismatched Organizations, or a governance repo absent from the list is `BLOCKED` **before any GitHub mutation**; legacy v1 policies must be migrated, never interpreted permissively.
5. Verify read visibility for every repository in the matching Organization roster. An inaccessible required repository is `BLOCKED` **before any GitHub mutation**. Never call an all-Organization inventory complete from only the repositories visible to the current credential.
6. Require exactly one `reporting.organization_reports[]` entry matching the one configured Organization, with `organization_slug`, `github_organization`, `steward_seat`, `target` and `repository_db_root`. Missing or multiple report entries are `BLOCKED`; never infer report identity or destination from a global fallback or another Organization policy. Require `reporting.one_append_only_report_per_organization: true` — a missing or `false` value is `BLOCKED` (the field is the machine-readable declaration of the append-only report invariant, not a comment).
7. Reconcile explicit owner/no-touch declarations from the policy file, PR body/comments/labels and current Mission Control tasks. A no-touch item is read-only inventory: no review, comment, reviewer request, rebase, push or merge.
8. If the same `report_date + steward seat + scope` already has a terminal Mission Control report, do not mutate GitHub. Read the report back and finish idempotently when it matches. If the live queue changed, stop as `BLOCKED` with `report_slot_closed`, preserve only a local redacted retry note and defer durable reporting to the next supported run slot. The v1 writer cannot reconcile different content into the same Organization/seat/date key; never rewrite or duplicate the report.

**Preflight completion:** identity and scope match, report target is writable, and the exact inventory start time is recorded.

## 2. Live Organization inventory

For the one configured GitHub Organization, query all open PRs live. The pre-run list is only a hint. Collect at least:

- `repo`, PR number/title/URL, author, draft state;
- `headRefOid`, `baseRefName`, mergeability and merge-state status;
- checks with pending/failing/success state;
- raw reviews and each review's commit SHA;
- all review threads with `isResolved` and `isOutdated`;
- requested reviewers, labels and explicit ownership comments;
- linked plan/task when the Organization contract requires one.

Inventory is Organization-wide, not owner-lane-wide. Workspace, Productionspace,
domain-owner and explicit no-touch PRs all remain in the inventory; route them to
the named owner and preserve their no-mutation boundary. If the seat cannot read a
repository from its authoritative v2 roster, return `BLOCKED` instead of publishing a partial inventory.

Track review-thread counts separately:

- `active_unresolved_threads`: unresolved and not outdated — live feedback to fix;
- `all_unresolved_threads`: every unresolved thread, including outdated — merge/report closeout gate.

The strict v1 report field `unresolved_threads` means **all unresolved threads**.
Do not write the active-only count into that field.

Re-run the complete open-PR inventory before final reporting so late PRs are not missed.

**Draft rule:** never mutate GitHub draft PRs. List them as `draft_untouched`.

## 3. Exact-head review gate

A review verdict applies to one immutable head SHA only.

Before approving or merging, require:

- live head equals the reviewed head;
- no current-head `CHANGES_REQUESTED` verdict;
- required checks green; no pending/failing required check;
- zero active unresolved blocking threads;
- zero all unresolved threads before merge; an outdated but unresolved thread must be explicitly resolved after proving the current head addresses it;
- branch clean/mergeable against the current base;
- scope and linked plan/decision still match;
- no owner/no-touch hold.

A timeout, transport failure or reviewer self-report is not approval. Reproduce stale bot findings on the current head before repeating or dismissing them.

Independent review must come from an authorized reviewer distinct from the PR author and from every Steward/Kolega/Agent who authored or pushed a commit included in the reviewed head. If the Steward writes or pushes any fix, the Steward's own verdict is not independent for that head. Route it to another authorized reviewer; never manufacture self-review evidence.

## 4. Classify and act

Classify every non-draft PR:

- `merge_now`: all exact-head gates pass and the operation is within Steward authority.
- `fix_then_gate`: bounded mechanical fix, conflict/rebase, generated-state parity or verified review finding.
- `waiting_for_exact_head_review`: technically green but missing a distinct current-head verdict.
- `delegate_owner`: requires Organization-local domain/runtime judgment from another named Kolega.
- `human_blocker`: access, secret, account, product, legal, business-data ownership, production risk or explicit Organization Admin decision.
- `owner_no_touch`: externally reclaimed; read-only.

`DIRTY`, `BLOCKED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` and a red check describe queue state, not a final class. Make a bounded active attempt before escalating.

### Bounded active work

After first merging all safe candidates and routing all change requests, use at most three independent fix slices in one run:

1. create a dedicated worktree;
2. write a focused reproducer/test before code when behavior changes;
3. fix only the verified finding;
4. run native gates against the committed head;
5. push lease-safely when rewriting;
6. comment with evidence and request a fresh exact-head review;
7. clean the worktree only after durable remote state exists.

Do not spend the whole run on one PR. Do not edit a primary reference checkout.

## 5. Special PR topologies

### Stacked or chained PRs

Inspect `baseRefName` and merge bottom-up. A child merged into another feature branch is not on `main`. When deleting chain branches, retarget the next PR to `main` before deleting its base branch; GitHub can otherwise close the dependent PR. If the repository requires squash, rebase each dependent branch onto the new `main` before continuing. Re-run checks and exact-head review after every rewritten head.

### Business/data PRs

Syntax and CI are not enough. Compare semantic keys against the current base: task/issue IDs, document numbers, movement/order IDs, generated lineage and evidence refs. Stop on duplicate or conflicting business evidence and route to the data owner.

### Generated state

Regenerate from the authoritative source, not by hand-editing derived output. Include every generated cascade in the same exact-head gate.

### Unrelated required-check failure

A PR can be fixed and independently approved yet still not merge-ready. Name the failing job and suspected unrelated surface; never merge through a red required check.

## 6. Merge discipline

For each merge:

1. Re-query live head SHA immediately before the operation.
2. Use repository policy and an exact-head guard such as `--match-head-commit`.
3. Never merge an Agent Draft merely because an Agent says it is done.
4. After merge, read back `state=MERGED`, `mergedAt`, merge commit and resulting base state.
5. Check linked root/module pointers or plan metadata for follow-up drift.

Release and deployment are separate operations. The sweep does not create a GitHub Release or deploy unless a separate explicit authority says so.

## 7. Second sweep

After merges, pushes and handoffs:

1. reload every open PR in scope;
2. merge newly eligible PRs whose complete exact-head gate now passes, including a verdict from a reviewer who did not author or push any commit included in that head;
3. keep newly pushed heads in `waiting_for_exact_head_review` until a distinct current-head verdict exists;
4. confirm drafts and no-touch items were not mutated;
5. derive report counts from this one final data object.

## 8. Mission Control Steward Report

Write exactly one append-only report per Organization seat and run slot through the configured Mission Control Steward Reporting writer. Use the report date in Europe/Prague and an idempotency key shaped like:

`<organization_slug>:<steward_seat>:<YYYY-MM-DD>`

Read `steward_seat` from that Organization's
`reporting.organization_reports[]` entry — always, including single-Organization
setups; the global `steward.seat` is never a source of report identity
(preflight Step 6 and live-run contract Step 3 are the gate). Never reuse one
seat ID across two Organization reports.

The report contains no secrets, raw logs, tokens or copied business payloads. It must match the strict v1 schema (`additionalProperties: false`) exactly:

- `schema_version`, `id`, `organization`, `steward_seat`, `report_date`, `run_slot`, `idempotency_key`, `status`, `summary` and `created_at`;
- `inventory.open_pull_requests` plus schema-valid `inventory.pull_requests` entries;
- every `inventory.pull_requests[].unresolved_threads` value is the all-unresolved count, including outdated threads;
- `actions` using only `reviewed`, `commented`, `pushed_fix`, `requested_review` or `no_action`;
- schema-valid `blockers` and `evidence` entries.

Do not invent top-level fields or action kinds such as `merged` or `rebased`. Represent a merge through the PR inventory state, exact-head gate evidence and redacted summary; the GitHub merge commit remains durable GitHub evidence.

Publication success requires a concrete report ID plus a read-back whose ID and idempotency key match. Scheduler `ok`, a local markdown file or an Agent self-report is not publication proof. If publication fails, return `ERROR` even when GitHub work succeeded; keep a local retry artifact and do not duplicate it.

## 9. Night-time escalation

Do not wake the Organization Admin for ordinary review queues. Escalate only a real human blocker, security incident, data conflict or policy decision. Keep details in Mission Control; the notification is only a short pointer to the report and smallest needed decision.

## Dry-run and rollout test

Before enabling the 02:00 job:

1. run on 3–5 PRs with `dry_run=true`;
2. allow only read-only inventory/classification and a local non-published report preview;
3. verify no GitHub mutations and no Mission Control publication;
4. ask the Steward, in a separate Hermes session, to explain five scenarios: stale approval, authored-by-self PR, chained PR base deletion, business-key collision and failed report publication;
5. run one manual full job only after the comprehension answers pass and credentials/report writer are proven.

## Common pitfalls

- Treating GitHub aggregate `reviewDecision` as exact-head evidence.
- Approving or merging a changed head without fresh review.
- Leaving a PR open merely because the first inventory said `REVIEW_REQUIRED` after approval arrived later.
- Deleting a chained base branch before retargeting the child.
- Calling a data PR safe from JSON/YAML validation without semantic-key checks.
- Interrupting an already active reviewer with repeated handoffs.
- Writing the report only to chat, ClickUp or local disk.
- Counting a Mission Control write as delivered without read-back.
- Expanding scope to another Organization visible to the GitHub account.
- Treating another owner lane (for example Productionspace) as permission to omit the PR instead of inventorying and routing it read-only.
- Treating a missing/empty legacy repository list as successful preflight instead of requiring a v2 Organization roster.
- Calling a partial visible-repository list complete when an authoritative roster repository is inaccessible.
- Reusing one global Steward seat ID for two Organization-local reports.
- Recording only active unresolved threads while outdated unresolved threads still exist.

## Ověření

- [ ] Seat identity equals policy.
- [ ] Policy is v2 and every Organization has one non-empty, governance-reconciled repository roster.
- [ ] Every roster repository is readable, or the run stopped `BLOCKED` before mutation.
- [ ] Every configured Organization has one distinct report entry and Steward seat.
- [ ] Full live inventory was loaded twice.
- [ ] Every non-draft PR has exact-head evidence.
- [ ] Owner-lane/no-touch PRs are inventoried and routed rather than omitted.
- [ ] Active and all unresolved thread counts were kept separate; report counts mean all unresolved.
- [ ] Drafts and no-touch items were untouched.
- [ ] At most three bounded fix slices ran.
- [ ] Every merge was read back with commit evidence.
- [ ] Remaining blockers name a real owner and next action.
- [ ] One idempotent Mission Control report was published and read back.
- [ ] Final terminal marker matches the report status.
