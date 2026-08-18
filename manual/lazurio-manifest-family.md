# Proposal: Lazurio manifest family

Status: **architectural proposal; not an accepted decision; no runtime change**  
Decision owner: Lazurio maintainers
Tracking: `DEV-6488`

## Proposed target

Review and, after explicit decision-record amendments, adopt one visible
Lazurio-owned manifest family:

```text
lazurio.organization.json
lazurio.module.json
lazurio.personalspace.json
```

The filename identifies the resource. Schema versions live inside the file:

```text
lazurio.organization.v1
lazurio.module.v1
lazurio.personalspace.v1
```

`company.gen3.json` and `personal.gen3.json` become temporary compatibility
formats. This proposal does not rename either file.

## Why

- `company.gen3.json` carries the deprecated CompaniesAsCode name instead of
  identifying a Lazurio Organization root.
- `personal.gen3.json` carries historical HumanAndMachines/GEN3 and
  GitHub-specific terminology.
- `lazurio.module.json` already establishes the clearer pattern.
- A schema version should not require another repository-wide filename rename.

This is not a cosmetic rename. These files currently participate in discovery,
Doctor composition, Git inventory, update and worktree resolution. Readers must
become compatible before any repository migrates.

## Three resource contracts

| Manifest | Declares | Does not declare |
| --- | --- | --- |
| `lazurio.organization.json` | One Organization root, Organization identity, Organization-wide policy, optional root Forge binding and subordinate manifest pointers | Module runtime, provider grants or Dashboard account state |
| `lazurio.module.json` | One workspace Module, its explicit applications and module-owned local leases | Organization authority, production deployment or Forge ACL |
| `lazurio.personalspace.json` | One Principal-owned Personalspace, its privacy boundary, subordinate manifests and optional Resident bindings | Organization membership or another Principal's context |

`launchpad.gen3.json` remains Machine-root configuration. `modules.manifest.json`
remains the sole Organization inventory and Git materialization authority in
v1. The new Organization manifest points to it; it does not add another module
list.

## `lazurio.organization.v1`

The first schema must contain or preserve:

- `schema_version: lazurio.organization.v1`;
- `kind: organization | template` — the mapping from legacy
  `organization_kind` is mandatory because `template` excludes the mount from
  runtime, worktree and publication surfaces;
- `organization.slug` and `organization.display_name`;
- an optional local-first/remote-active root repository binding containing
  `forge`, readable `locator`, `default_branch` and `binding_state`;
- `binding_state: unverified` preserves locator and branch without inventing a
  provider ID; `repository_id` appears only after live Forge readback changes
  the state to `verified`;
- `manifests.modules: modules.manifest.json`;
- current Organization-owned governance, Team, task-source and Doctor sections
  without semantic loss.

The current `humanandmachines.doctor.declaration.v1` remains unchanged during
this migration. Renaming the Doctor declaration schema is a separate decision.

An opaque cross-Forge Organization ID is deliberately deferred. It has no
current minting authority or consumer. V1 uses the existing Organization slug
and, when connected, the provider-stable repository ID. Cross-Forge identity
that survives a provider migration needs its own consumer-driven decision.

Legacy `company.gen3.json#modules` is not copied into the new manifest. The
migrator must reconcile every entry into `modules.manifest.json` or stop on a
conflict. The new contract must not preserve two module inventories.

Provider-specific data stays inside the root repository binding. Installing a
Forge integration grants connectivity; it does not by itself create a Lazurio
Organization. Exact Forge activation and remote lookup are outside this
filename decision.

Local Core, CLI and Launchpad discovery never consult Dashboard state. A future
Dashboard registry may cache a verified root lookup for remote Dashboard
operations, but it cannot become local identity, access or runtime authority.

## Ownership

Lazurio Core owns:

- candidate filename resolution and one-resource-per-mount deduplication;
- schema validation;
- legacy/current normalization into one canonical read model;
- semantic parity and conflict detection;
- deterministic migration planning and legacy projection;
- machine-readable states, errors and receipts.

Consumers use that Core result:

- Lazurio CLI exposes Doctor and explicit migration commands and owns their
  Git/worktree preflight plus atomic filesystem execution;
- Launchpad displays state and recovery actions but has no second parser and
  never migrates during Synchronize;
- a future Dashboard consumer may consume a versioned normalized JSON contract
  for authorized remote operations without becoming local authority;
- OrganizationTemplate and PersonalspaceTemplate distribute scaffolds,
  pointers and compatibility tests — never copies of the Core resolver,
  schemas, migrator or a real Organization/Personalspace manifest.

Core owns migration planning, validation and deterministic projection. The CLI
adapter executes the explicit write after its Git/worktree gates. It is not a
Launchpad Server action. Launchpad Server continues to own only its long-running
runtime/process state, consistent with DEV-6439.

## Compatibility states

| Files present | State | Behavior |
| --- | --- | --- |
| only legacy | `legacy` | supported; Doctor offers migration |
| both, normalized semantics and canonical projection hash match | `transition` | supported; Lazurio file is canonical and legacy is a generated projection |
| semantics match but canonical projection hash drifts | `projection_drift` | canonical Lazurio read remains available; mutations block until projection regeneration |
| normalized semantics differ | `conflict` | fail closed for mutation; never choose silently |
| only Lazurio | `current` | supported after the finalization gate |
| neither | `missing` | not a Lazurio resource; fail only when the mount is expected |

One mount always produces at most one resource and at most one child Doctor.
Two filenames never create two Organizations or two Personalspaces.

An active authoring or Machine-activation receipt takes precedence over the six
stable content states and returns the orthogonal operation status
`migration_in_progress`. Core must not misclassify a partially applied
transaction as `projection_drift` or `conflict`.

The legacy projection is required during the compatibility window because old
supported Machines have hardcoded legacy structural gates and there is no
complete reader-version evidence today. It is not a second authority:

- edits target only the Lazurio manifest;
- one command regenerates the legacy projection;
- Core compares normalized semantics to prove lossless mapping and the
  canonical-JSON projection hash to prove exact equivalence to the
  deterministic generator output;
- canonical JSON uses deterministic serialization independent of indentation,
  LF/CRLF and host platform, so formatting-only drift is not a semantic error;
- a manual legacy edit that changes the canonical projection becomes
  `projection_drift` or `conflict`, never a second authority;
- extensions are preserved losslessly; only an unknown field that cannot be
  preserved or mapped blocks migration.

## Doctor and migrator

Doctor remains read-only and returns the next safe command:

```text
lazurio migrate organization-manifest
lazurio migrate organization-manifest --write
lazurio migrate organization-manifest --finalize --write

lazurio migrate personalspace-manifest
lazurio migrate personalspace-manifest --write
lazurio migrate personalspace-manifest --finalize --write

lazurio migrate <resource>-manifest --recover --write
lazurio migrate <resource>-manifest --rollback --write
```

Contract:

- without `--write`, print a plan and machine-readable diff summary;
- Organization `--write` operates only in a clean plan-owned worktree on its
  expected branch; it never edits a primary checkout;
- Personalspace `--write` uses an owner-private task/worktree contract and
  never depends on an Organization Mission Control;
- execute the Lazurio manifest and legacy projection change through the
  recoverable cross-file transaction below; never claim filesystem-level
  multi-file atomicity;
- validate schemas, normalized parity, root Git provenance, template kind and
  subordinate manifest references;
- never commit, push, merge or mutate Forge/Dashboard state;
- emit tool version, before/after semantic hashes, deterministic projection
  hash, changed files and rollback;
- preserve supported extension fields; refuse ambiguous roots, dirty
  worktrees, unpreservable fields, binding mismatch, path traversal and partial
  writes;
- keep `--finalize` blocked until a separate accepted mechanism proves the
  minimum reader version for every supported Machine cohort.

### Authoring cross-file write protocol

The CLI owns a recoverable transaction, because common filesystems cannot
atomically replace two paths at once:

1. Acquire an exclusive resource-scoped write lock. Create a worktree-local,
   ignored transaction directory under
   `.lazurio/transactions/<resource>/<transaction-id>/` containing a durable
   receipt, both before-images, both complete staged after-images and their
   semantic and canonical projection hashes.
2. Validate the staged pair before touching either target. The receipt records
   the expected sequence `prepared` → `canonical_applied` → `legacy_applied` →
   `verified` and is durably advanced before and after each replacement.
3. Replace each target from the same filesystem with a platform-proven
   per-file atomic rename. A finalization transaction represents legacy removal
   as an atomic move to its before-image, not an unrecorded deletion.
4. Core checks for an active receipt before opening either manifest. New
   cross-file readers return `migration_in_progress`, expose the exact recovery
   action and perform no mutation. Legacy-only readers see either the complete
   old or complete new legacy file; they never parse a partial file.
5. Remove the receipt and before-images only after both targets match the
   after-hashes, normalized parity passes and the transaction reaches
   `verified`. After interruption, the same CLI version resumes from the
   recorded phase or restores both before-images; it never guesses from file
   presence alone.

All cross-file and mutation-capable consumers must use the Core receipt check
before any resource enters `transition`. Transaction directories never enter a
commit, template or another resource boundary.

Windows atomic replacement, case-preserving repository names, separators and
rollback are hard gates alongside macOS and Linux.

### Machine activation protocol

A reviewed migration commit is only the transport for a verified pair. It does
not make an ordinary multi-path Git checkout an atomic activation. Every
supported Machine therefore activates a target revision through the updater:

1. Fetch the target revision without moving the active checkout. Inspect its
   tree and diff before writing. If a manifest pair changes, an updater without
   the required activation capability leaves the Machine on the previous
   revision and fails closed; plain `git pull` or direct checkout is not a
   supported activation path.
2. Acquire the same resource-scoped lock and create a durable local activation
   receipt with the previous and target revision, both pair hashes, staged
   target blobs and rollback data. Put Core readers behind the in-progress
   barrier and stop, drain or otherwise prove the absence of every legacy
   process that can mutate either manifest.
3. Update the checkout metadata and non-pair paths only while the resource is
   inactive. Apply the two staged target blobs with the platform-proven
   per-file atomic replacement from the authoring protocol. Legacy-only
   read-only consumers may observe a complete old or new legacy file, but no
   legacy mutation-capable process may run inside the activation window.
4. Verify the target revision, both after-hashes, normalized parity and
   projection hash before removing the receipt and restarting or exposing the
   resource. Interruption resumes the recorded phase or restores the complete
   previous revision; it never exposes a failed target as active.

Before the first migration PR may merge, the rollout gate must prove that every
supported updater entrypoint either implements this fetch-before-checkout
activation or is fenced from advancing the resource. An offline or returning
Machine upgrades the updater first; until then it remains on its last compatible
revision. This is a Machine-local activation guard, not a content authority or
tracked state store.

## Rollout

### 0. Accept the proposal

This PR changes no runtime behavior. Before implementation, amend decisions
0026, 0031, 0042 and 0051 where they pin legacy filenames or discovery
mechanics.

The proposal and later rollout use a new Mission Control plan and DEV code.
They are independent of DEV-6439 and PR #129: DEV-6439 keeps its current Iotor
Core/CLI/lifecycle scope and does not deprecate Organization or Personalspace
manifests. The new plan may consume its Core read-model patterns after they land
without becoming part of its implementation sequence.

### 1. Make readers compatible in small follow-up slices

1. Add a Core resolver with legacy-identical behavior.
2. Move Organization discovery to it.
3. Move Git inventory, update and worktrees to it.
4. Move Doctor composition to it and prove one child per mount.
5. Move CLI to the same normalized model.
6. Move root, Organization and Personalspace update entrypoints to the
   fetch-before-checkout Machine activation protocol.

No resource may enter `transition` until all mutation-capable consumers use the
Core resolver and every supported Machine is covered by the activation rollout
gate. Each slice keeps existing files canonical and carries golden parity,
real-Organization smoke and Windows CI.

### 2. Distribute migration capability

The Lazurio distribution delivers the versioned Organization schema, resolver,
migrator and Doctor integration. OrganizationTemplate Sync delivers only the
scaffold/pointers and compatibility tests needed by an Organization. The
Organization manifest is Organization-owned and is never copied from the
template.

Personalspace receives its capability separately through Lazurio and
PersonalspaceTemplate. OrganizationTemplate never reads or migrates it.

### 3. Canary, then per-resource PRs

Migrate one canary Organization in a plan-owned worktree. The PR contains the
new canonical manifest and verified legacy projection. Old and new readers must
produce the same normalized inventory. Then repeat with one reviewed PR per
Organization. Pull/sync never authors or regenerates a manifest; it may only
activate the already reviewed pair through the Machine activation protocol.

During `transition`, contributors edit the Lazurio file and regenerate the
legacy projection. Editing the legacy file directly always produces
`projection_drift` or `conflict`, and mutation remains blocked until repaired.

New bootstraps emit the Lazurio manifest plus a compatibility projection while
the supported window requires it. Template `kind: template` remains preserved
and cannot become an actionable Organization.

### 4. Finalize later

`--finalize` remains unavailable until a separate accepted design proves
reader readiness for online, offline and returning Machines. Finalization then
requires no conflicts, cross-platform finalization/rollback tests and an
owner-approved PR for the exact Organization or Personalspace.

Legacy reader removal is a later major compatibility change, never part of the
first migration PR.

## Required evidence

1. Golden normalization for remote-active, local-first and template
   Organizations.
2. Golden normalization for Personalspace variants without exporting private
   content.
3. All six states across Core and each consumer adapter.
4. One resource and one child Doctor when both files exist.
5. Old-reader compatibility against generated projections.
6. Unknown-field and lossy-mapping refusal.
7. Interruption after every transaction phase, deterministic resume, full
   rollback and proof that readers never classify mixed generations as stable.
8. Windows/macOS/Linux per-file atomic replacement, path, case and projection
   behavior.
9. Interruption after every Machine activation phase, rollback to the complete
   previous revision, and proof that an incapable/offline Machine cannot advance
   into the migration commit before its updater is compatible.
10. Read-only smoke over all available Organizations without cross-Organization
   output.
11. Template ownership: mechanisms managed; manifests resource-owned.

## Non-goals

- No file rename or runtime behavior change in this proposal PR.
- No Forge, Cursor Origin, GitLab or self-hosted Forge implementation.
- No new IAM, daemon, state store, Dashboard authority or Launchpad parser.
- No migration of `modules.manifest.json`, `launchpad.gen3.json` or Module
  runtime declarations.
- No business/legal profile decomposition hidden inside filename migration.
- No Personalspace rollout coupled to an Organization rollout.
- No broad rename PR; implementation follows as small, reversible plans.

## Review questions

Reviewers should answer explicitly:

1. Accept the three filenames and internal schema-version rule?
2. Accept Core ownership and consumer-only Launchpad/Dashboard adapters?
3. Accept the generated legacy projection and distinct repairable
   `projection_drift` state until reader readiness is provable?
4. Preserve current Organization-owned sections in v1, except eliminating the
   deprecated duplicate `modules[]` surface?
5. Keep `modules.manifest.json` as the only v1 inventory/materialization
   authority?
6. Keep local runtime fully independent of any Dashboard lookup index?
7. Keep `--finalize` blocked pending a separate Machine-readiness mechanism?
8. Accept Personalspace naming now but implement its migration separately?

## Independent review

Claude Fable 5 reviewed the proposal and current contracts on 2026-08-18. Its
initial verdict was **ACCEPT WITH CHANGES** and this revision incorporates its
blocking findings: Dashboard scope, unchanged Doctor schema, template-kind
preservation, plan-owned worktree writes, Core deduplication/consumer ordering,
canonical projection drift and the explicitly blocked finalization gate. Final
review evidence belongs to the PR, not to this proposal's own authority.

The active DEV-6439 architecture task independently reviewed the live import
graph and agreed with the direction while requiring a separate Mission Control
plan, independence from PR #129, verified/unverified Forge binding, canonical
projection drift, extension-safe migration, a Personalspace-private worktree
contract and Lazurio-owned executable tooling. This revision incorporates those
requirements.
