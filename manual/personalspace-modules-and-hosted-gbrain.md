# Personalspace modules and hosted GBrain

Status: seed operating concept from the founder's 2026-07-04 product correction; not yet a formal decision record.

## Core correction

`personalspace/` is not just a private folder or secret custody mount. It is the private human/Buddy layer of HumanAndMachine GEN3 and needs a module model analogous to Organization `workspace/` modules, with stricter privacy and per-person ownership.

## Product implications

1. **Personalspace has private modules.**
   - A personalspace module is a private module owned by one human, Buddy, or AI colleague.
   - It can expose one or more applications, just like workspace modules do.
   - Those applications are per-user/per-colleague by default, not shared Organization apps.
   - Personalspace modules must never be auto-merged into Organization discovery or company source-of-truth.

2. **Conglomerate Dashboard is not only admin configuration.**
   - It is also the user-facing entrypoint into production workspace applications.
   - It owns Admin Organizace (Organization Admin) flows: Organization configuration, colleagues, AI colleagues, access, plans, billing, and policy.
   - It also needs deployment/server configuration flows: admins configure deploy targets for workspace applications; personalspace application deploys/settings may be controlled by the relevant admin, builder, or user depending on ownership and tier.

3. **Launchpad remains builder-first.**
   - Launchpad is the local/runtime builder surface for workspace and personalspace module apps.
   - It can show and run local personalspace apps for the current machine owner/Buddy, but it must visually and policy-wise separate them from Organization apps.
   - Production workspace user entry belongs in Dashboard, not in Launchpad.

4. **GBrain is a first-class personalspace module candidate.**
   - The markdown vault is Obsidian-compatible and should remain visible as files.
   - The gbrain index/API/MCP layer should be available to Buddy and allowed agents with scoped access.
   - Personalspace needs an interface for inspecting GBrain: at minimum a read/search/browse UI; later possibly graph/timeline/source views.

## Hosted GBrain / Obsidian direction

Obsidian works best with a local vault. Do not design the primary path as “open one live remote filesystem from multiple writers” unless a later test proves it safe; latency, conflicts, file locking and plugin behavior make direct remote mounts fragile.

Preferred architecture:

```text
personalspace/gbrain-module/
├── vault/                 # Obsidian-compatible markdown repo (Git source of truth)
├── gbrain-server/          # DB/index/API/MCP over the vault
├── dashboard-reader/       # private web UI for read/search/graph/timeline
└── sync-adapters/          # Git / LiveSync / backup adapters
```

- **Server side:** host the canonical private Git repo or mirror plus the gbrain DB/index/API/MCP. Expose only authenticated, scope-limited APIs to agents.
- **Human Obsidian side:** open a local clone/synced copy of the vault in Obsidian. Use a sync adapter rather than editing a remote network mount directly.
- **Agent side:** prefer GBrain MCP/API over scraping Obsidian files. Agents on the owner's machine can also read a local checkout when they have local permission.
- **Conflict policy:** markdown changes should flow through Git or an equivalent conflict-aware sync protocol; GBrain DB writes must materialize back to markdown before they are treated as durable Obsidian truth.

## Sync adapter options to evaluate

Current ecosystem options worth evaluating, based on 2026-07-04 quick verification:

- **Obsidian Git plugin** — Git integration inside Obsidian with scheduled commit/pull/push; good fit for desktop/local clones, but mobile support is marked unstable by the plugin.
- **Self-hosted LiveSync** — community plugin that syncs through CouchDB-compatible or object-storage backends and supports E2E encryption; explicitly not compatible with official Obsidian Sync.
- **Remotely Save** — community plugin for S3-compatible storage, WebDAV, Dropbox, OneDrive, Google Drive, etc.; it warns to back up before use.
- **Official Obsidian Sync** — useful if Obsidian-hosted sync is acceptable, but it is not the self-hosted HumanAndMachine server path.

For HumanAndMachine, the strategic path is probably: Git-backed vault as source of truth + hosted GBrain service for agents + optional Obsidian sync adapter for human editing convenience.

## Access and safety invariants

- Personalspace data is private by default and belongs outside Organization GitHub orgs.
- Grant agents least-privilege read/write scopes; do not expose the whole vault to every Organization agent.
- Separate private personal modules from Organization modules in UI, filesystem, API and audit logs.
- Never store secrets in GBrain markdown; use `personalspace/<owner>_GEN3/secrets/...` for custody.
- Hosted GBrain must have audit logs for agent reads/writes and a clear “what can this agent see?” surface.
- Personalspace modules may be useful to Buddy across companies, but company decisions still belong in the relevant Organization source of truth.

## Open design questions

- What is the canonical manifest shape for `personalspace` private modules?
- Should personalspace modules have the same lifecycle versioning as workspace modules, or a lighter per-user variant?
- How does a human approve a Buddy/agent write to hosted GBrain when the write changes durable self-knowledge?
- Which sync adapter is acceptable for the first hosted GBrain pilot: Git-only, Self-hosted LiveSync, or a custom gbrain write-through service?
- How should Dashboard present personalspace apps differently for Admin, Builder and User personas?
