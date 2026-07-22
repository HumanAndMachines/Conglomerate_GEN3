# Launchpad GEN3 redesign implementation spec

Status: implementation spec for RM-0006 step-005
Updated: 2026-07-02 (builder-first framing per decision 0047, worktree runtime per decision 0049)
Revised: 2026-07-05 (owner-approved IA revision) — **personalspace
moved out of the left rail into the main plane** as its own visually-distinct section
(above workspace apps); the left rail became a **scope selector** (Personalspace /
Organizations) and the right-hand panels collapse into a drawer so the grid holds 3
card columns. This supersedes the "Left rail: Personalspace" placement in sections 2
and 8 below. **Data isolation is unchanged** (separate `/api/personalspace` lane +
Private badge; never mixed into org discovery — decision 0051/0042); only the render
location changed. Note: decision 0051's wording "Personalspace **rail**" is superseded
by this UI revision — worth a formal decision-record note (founder).
Revised: 2026-07-08 (product-framing sweep) — personas renamed to the
`Organization *` canonical set (decision 0062); Enterprise hosting split into
two variants (decision 0048 Amendment 2026-07-07); distribution/update channel
added (decision 0059); BYOS agent placement and supervised/async model recorded
(decisions 0061/0063). Terminology, hosting modes and product framing only — no
change to technical contracts (ports, discovery, personalspace lane).
Revidováno: 2026-07-14 — výběr aktivního prostoru se přesunul z levého railu
do dropdownu v záhlaví. Dropdown ukazuje pouze Osobní a jednotlivé Organizace
na jednom řádku (lokální značka + název), bez počtů aplikací, modulů, runtime
stavů a cest. Levý rail byl odstraněn celý, včetně filtrů Surface a Tag;
hledání a stavové přepínače zůstávají v horním toolbaru a hlavní plocha využívá
celou šířku. Souhrnné statistické karty byly odstraněny. MAIN/WORKTREE identita
rootu zůstává viditelná vedle Doctora.
Upřesnění 2026-07-14: dropdown používá kompaktní GEN2 rozměry a lokální
čtvercové assety z `launchpad/app/v1/web/` příslušné Organizace
(`launchpad-icon.png`, `logo-square.png`, `favicon.svg`/`favicon.png`). Pokud
Organizace žádný z těchto assetů nemá, zůstává deterministický monogram.
Upřesnění 2026-07-14: otevřený dropdown začíná profilovým blokem Principála
(fotografie, jméno a e-mail). Jméno a GitHub username se čtou z primárního
Personalspace, e-mail z lokální Git identity a avatar z veřejného GitHub
profilu; osobní údaje se nezapisují do sdíleného root configu. Položka
**Nastavení** je zatím neaktivní a nemá žádný proklik. GitHub profil se otevírá
v nové kartě kliknutím na jméno Principála. Intent je správa zdrojového GitHub
profilu, precondition platný primární Personalspace, side effect v Launchpadu
není žádný, failure mode je nedostupný externí GitHub a ověření drží URL
i regresní UI test.
Upřesnění 2026-07-14: vizuální motiv sdíleného Launchpadu se vždy přepne podle
aktivní Organizace. Organizace dodává pouze sémantické design tokeny (barvy,
typografii, radiusy a stíny); layout, chování a bezpečnostní pravidla zůstávají
ve sdíleném core. Cílový adaptér je `design-system/launchpad.tokens.css`.
Migrované Organizace bez adaptéru používají svůj existující
`launchpad/app/v1/web/style.css` z GEN2 jako kompatibilní read-only fallback.
Launchpad z obou zdrojů propouští jen allowlist tokenů, odmítá aktivní CSS
hodnoty a symlink úniky a vyžaduje úplnou light i dark variantu. Firemní brand
v Organization scope uzamyká accent; osobní prostor používá výchozí motiv
Conglomerate a zachovává uživatelský accent preset.
Upřesnění 2026-07-18: Design System adaptér se aktivuje jen tehdy, když je
`design-system/design-system.config.json` bezpečně čitelný běžný soubor uvnitř
Organization rootu, má `mode: organization`, `content_status: approved`
a jeho `organization.slug` se case-sensitive shoduje s objevenou identitou
Organizace. Draft, chybějící či neplatný config a slug mismatch adaptér
neaktivují; Launchpad může dál použít legacy fallback. Schválený adaptér musí
v light i dark variantě dodat také neprůhlednou bezpečnou barvu `--on-accent`;
primární tlačítko ji používá pro čitelný foreground a dark gradient odvozuje
oba své konce z dark `--accent`.
Upřesnění 2026-07-15 (nahrazuje podobu stavového pásu z 2026-07-14): agregovaný
`Stav prostoru` je první kompaktní karta v pravém sloupci, ne pás přes celý
viewport. Zachovává titul, počet blokátorů nebo upozornění a CTA, ale používá
neutrální plochu; stavovou sémantiku nese indikátor, jemný okraj a CTA. Na úzké
obrazovce se karta přesune se sekundárními panely do spodního sheetu a tlačítko
panelů nese číselný badge i přístupný text aktuálního prostorového stavu. Akce
ze stavové karty nejprve sheet zavře a potom odhalí problémy nebo filtrované
aplikace.
Upřesnění 2026-07-14: v Organization scope je panel **Poslední změny** znovu
trvale viditelný v pravém sloupci po vzoru Launchpadu GEN2. Moduly řadí podle
času posledního commitu a každou položku lze rozkliknout do detailu commitů.
V Osobním prostoru se organizační panel nezobrazuje; na úzké obrazovce se
sloupec skládá pod hlavní plochu.
Implementation surface: `Conglomerate/launchpad/`
Source inputs:

- interní spike/wireframe podklady (přesunuté do privátního
  `Rozjedeme-ai/HumanAndMachines`)
- decisions 0047/0048/0049 (+0048 Amendment 2026-07-07), 0059/0060/0061/0062/0063
  (HumanAndMachines/docs/decisions/), plan CAC-0042
- live `GET /api/apps` smoke on local Launchpad port 4174

## 1. Product intent

Launchpad GEN3 is the builder surface of the platform (decision 0047): the shell
where Organization Builders (formerly Workspace Builder, decision 0062) — the
machine owner, kolegové and AI colleagues — build
and run workspace module apps, and secondarily see a read-only overview of
productionspace. It is not an admin dashboard: Admin Organizace (Organization Admin)
flows, organization governance, configuration, plans and billing live in Conglomerate
Dashboard GEN3. Dashboard is also the Organization User entrypoint into production
workspace applications and the deploy/server configuration surface for workspace
and personalspace applications. Launchpad is the Organization Builder surface, not
the source of company truth. It should let a Builder see which Organizations are
mounted, which workspace apps are ready or need attention, which module carries
worktree work in progress and under which Mission Control plan (decision 0049),
which production systems are risky, and what exact local action is safe next.
The local overview role for the machine owner remains.

Launchpad runs in one of two placements depending on plan and hosting mode
(decision 0048 Amendment 2026-07-07, CAC-0043): on the builder's localhost for
the Free plan and Enterprise selfhosted, or on the per-Organization Workspace
Host VPS behind a login for Solo/Team hosted plans and hosted Enterprise.
Enterprise has two deployment variants — **selfhosted** on the customer's own
infrastructure for an implementation fee (localhost Launchpad on builders'
machines), or **hosted** with us on a Workspace Host VPS for a monthly
subscription (Launchpad behind a login, the same per-Organization pattern as
Solo/Team).

Remote/hosted builder work runs BYOS ("bring your own subscription", decisions
0061/0063). The officially supported Solo/Team mode is a **local Codex/Claude
agent on the builder's machine that works in the remote Workspace over SSH** —
the tree, runtime and dev servers live on the Workspace Host, while the agent and
its subscription stay on the builder's machine. Installing an agent harness
(T3 Code and similar) directly on a hosted Workspace is only an **optional
add-on**, and only with server-safe credentials (organization API key, corporate
Claude Team/Enterprise license), never a personal consumer login. Agents work
**under supervision**: a closed laptop means the agent is not working — by
design, not a limitation. Unattended, asynchronous work goes exclusively through
**AI Kolegové** (AI colleagues), who do it on their own seat, machine (Workspace
Host) and audit trail on the organization's LLM credentials; every agent-produced
draft is approved by a human (worktree → PR → merge). Session continuity for
Solo/Team therefore rests on worktree + Mission Control plan ownership
(decision 0049), not on a live agent session on the server.

The redesign must preserve the current root behavior:

- `launchpad.gen3.json` is metadata/override, not an exhaustive allowlist.
- Local `organizations/*/company.gen3.json` discovery keeps working.
- App package manifests remain the app source for local runtime metadata.
- Runtime state, logs and dependency checks stay outside Git in `launchpad/runtime/`
  and `launchpad/logs/`.
- Launchpad consumes Organization truth; it does not write business data or grant
  GitHub access.

### Distribution and updates (decision 0059)

Launchpad ships as a **compiled binary** — a standalone per-OS executable that
embeds its runtime. Daily builder work (overview, entering apps, updating) needs
**neither Bun nor `bun install`/`node_modules`**; this targets non-programmer
builders and corporate machines where IT typically allows only an agent
(Codex/Claude) and git. The source stays in the direct-pull repo, the binary is a
build of that same code (not a fork or a second truth), and **`bun run launchpad`
remains the dev mode** for machines that already have dev tools. The binary and
the root content update on two separate cadences: the root via `git pull`, the
binary via a separate release artifact that changes far less often.

- **"Aktualizovat"** updates the Conglomerate root via
  `git pull --rebase --autostash` (or equivalent). It must not fail on a trivial
  divergence, and it is **fail-closed**: on a conflict or unclean result the
  rebase/stash is cleanly rolled back and the state is shown to the builder
  legibly — no silent `reset --hard`, no lost draft. Mutating update
  (`doctor sync`, "Aktualizovat") is a separate guarded tool, not a Doctor
  check — Doctor stays read-only diagnostics.
- **"Vyřešit s Agentem"** fallback: when an update fails, Launchpad offers to
  start a local Codex/Claude session tasked with finishing the update. It is the
  builder's own BYOS session (decision 0061), not a platform agent.
- **On the Workspace Host** the Steward seat holds the update through a
  daily cron (e.g. 05:00) that updates the whole system including tests.

### Action contract: "Aktualizovat" (implemented v1 — git-context axis, CAC-0056)

Implementation note: v1 deliberately deviates from the `git pull --rebase
--autostash` sketch above and reuses the safer, already-proven per-repo
primitives — **ff-only merge to an explicit verified channel target**, with
autostash (stash → ff → exact restore) only as an explicit second action, never
as a silent default. Channels and client checkout policy are held by decision
draft 0080 (HumanAndMachines); the binary axis waits for the CI build+sign
pipeline and is reported as `binary: { state: "not_available" }`.

- **Intent:** bring the Conglomerate root to the current target of the
  machine's update channel (`stable` = highest `vX.Y.Z` tag, `nightly` =
  `origin/main`) without ever rewriting history or losing local work.
- **Source of truth:** channel in gitignored `launchpad.gen3.local.json`
  (`update_channel`, default `stable`); target resolved from origin tags /
  `origin/main` after `git fetch origin main --tags --prune`.
- **Preconditions:** root checkout is a standalone git root on branch `main`;
  clean tracked files for the default action (`mode: "ff_only"`); dirty
  tracked state requires the explicit `mode: "preserve_changes"` action and
  `can_update_with_autostash`; target must be strictly fast-forward.
- **Side effects:** `git merge --ff-only <verified target sha>` on the root;
  in preserve mode additionally stash push/apply/drop with exact-identity
  verification. Records `from_commit`/`to_commit` in the response for a
  future rollback action. No binary is touched in v1.
- **Failure mode:** explainable states (`ahead_of_channel_target`, `diverged`,
  `wrong_branch`, `dirty_worktree`, `no_release_tag`, `fetch_failed`) return
  HTTP 409 with a Czech message and never mutate; a failed autostash restore
  keeps the stash backup and says so ("Vyřešit s Agentem" is the recovery
  path). Never `reset --hard`, never rebase.
- **Access boundary:** builder control plane only — `POST /api/update` is a
  mutating API guarded by the trusted-local check (127.0.0.1, same-origin),
  serialized with background fetches via `withRemoteRefreshPaused`. The root
  lane is separate from the organization git inventory (`pull-all` never
  touches the root).
- **Verification:** `GET /api/update/status` before/after; post-update HEAD
  must equal the verified target sha (`update_verification_failed`
  otherwise); read-only Doctor check `update.channel` reports channel
  validity, branch, and ahead/behind against the last known target without
  fetching. Covered by `src/update-lib.test.mjs` and
  `src/diagnostics-lib.test.mjs`.

## 1b. Builder Bridge API — versioning, transport adapters, CORS/LNA, pairing token, headless mode [PROPOSAL — pending founder ratification of decision 0077]

**Canonical term (founder 2026-07-12).** The **Builder Bridge** is the **headless daemon + versioned API layer of the Launchpad**. It lives HERE — inside the Launchpad app in the source-available Conglomerate core — not as a separate service. The local HTTP API is no longer an internal same-origin surface: it is the Bridge, one versioned API a browser served from another origin (the hosted Dashboard) can reach directly. The existing **agent-over-SSH remote work (decisions 0059/0060/0061) is ONE TRANSPORT under the Bridge umbrella**: remote builder agents keep using plain SSH into the Workspace Host, and the Launchpad/Bridge manages and exposes that access — it does not replace SSH. Canonical contract: `HumanAndMachines/docs/builder-bridge-contract.md`.

- **Foundation is the contract + shared Builder UI + transport/auth adapters — not routes on localhost.** Browser-to-loopback is one transport, not the architecture.
- **One contract, two deployments, two security profiles.** `/bridge/v1/...` on the builder's `127.0.0.1` daemon (pairing token over CORS + LNA), or on the Workspace Host VPS as **normal HTTPS behind organization login** (same-origin reverse proxy; platform session CAC-0055; real organization authorization and audit on every request). Identical routes/shapes; transport binding, auth adapter and security profile differ. Maps 1:1 to the localhost-vs-Workspace-Host placement in section 1.
- **Transport adapters (explicit, swappable):** (a) loopback fetch on Chromium via **Local Network Access (LNA, Chrome 142+; PNA is deprecated/replaced)**, Firefox ~149–151; (b) Workspace Host HTTPS; (c) **mandatory fallback** top-level deep-link 'Continue in local Builder' for Safari (WebKit blocks HTTPS→loopback) and denied/revoked LNA. Loopback is not identity — port 4174 does not establish authenticity or OS-user isolation.
- **Stable deep-link URL scheme (P1 deliverable, founder 2026-07-12).** Every major Launchpad screen — org, module, Doctor, worktrees — is reachable via a **stable hash route** (e.g. `<deep_link_base>/#/org/<org>/module/<module>`, `…/#/org/<org>/doctor`, `…/#/org/<org>/worktrees`) so the hosted Dashboard can carry **contextual 'Open in local Builder' buttons** that open the local Launchpad at the matching page. **The concrete `deep_link_base` and the versioned route patterns are discovered from `/bridge/meta` — clients never guess the port; `127.0.0.1:4174` here is only the default/example (in the spike: only the fixture default).** This is well-designed cross-navigation UX between Dashboard and Launchpad, and it is a **P1 deliverable independent of whether full embedding ever lands**. The scheme also backs the mandatory Safari / denied-LNA fallback deep-link. Hash routes are part of the compat contract (stable, not ad-hoc) so links from a hosted Dashboard don't break across binary releases.
- **Chat-first App entry (founder 2026-07-22; first route slice implemented).** A
  new direct human-Colleague chat with a Codex/ChatGPT App or Claude App Worker
  Agent is the primary product entry. Once it minimally identifies scope, the
  Agent opens the local Launchpad in the App-provided browser surface at
  `/#/org/<company.slug>` or local-only `/#/personalspace`. The Launchpad is the
  graphical view of the same local context the chat Agent can inspect and help
  with; a Dock shortcut and manual URL entry are conveniences, not the primary
  onboarding. This rule excludes Buddy, AI Colleagues, CLI/background/review
  runs and any App without an actual browser capability; no OS UI simulation or
  silent external-browser fallback is part of the contract. The local shell now
  parses these two routes, updates the URL when scope changes, rejects unavailable
  scopes safely and keeps Personalspace identity/content out of the URL. Module,
  Doctor and worktree routes remain the rest of the P1 deep-link deliverable.
- **Local UI is the first client.** `public/` is refactored to consume `/bridge/v1` with no privileged internal calls (already true for data access). Moving the interface into the Dashboard is a shell swap.
- **Freeze current routes as `/bridge/v1`.** The unprefixed `/api/*` aliases exist **only for the local shell during the transition** and inherit the **same auth/capability policy** as `/bridge/v1/*` **from P2 (pairing) onward — no unauthenticated alias survives past P2**. CORS is **not** an authorization boundary for local processes: it only blocks cross-origin browser reads, not a local process calling an alias directly, so the alias cannot be a softer, token-free path once pairing lands. Cross-origin clients must use `/bridge/v1` + token; aliases are removed at the local-UI deprecation gate.
- **CORS + LNA + request hygiene.** Add an `OPTIONS`/preflight branch; exact origin allow-list (prod/dev Dashboard + `localhost` dev), reject `null`, no wildcards/suffix/reflected origins; `Vary: Origin`; validate `Origin`/`Host`/method/content-type; custom header on mutations so they can't be submitted as HTML forms; reject unexpected `Host` (DNS rebinding). Attach CORS in `jsonResponse`. Parametrise the `127.0.0.1`-only host gate for headless/Workspace-Host binding, keeping `127.0.0.1` the default; never `0.0.0.0`.
- **Auth for reads too.** Only `/health` and `/bridge/meta` are unauthenticated. Pairing token bound to exact Dashboard origin + account + permitted organizations + OS-user + Bridge installation key + expiry; secrets in the OS keychain, never `localStorage`; TTL + rotation; unpair from the local shell. Reuse patterns in `<org>/launchpad/app/v1/core/security/request.ts` (`corsHeaders`, `createCorsPreflightResponse`, `requireSessionCapability`).
- **Bootstrap + granular capabilities.** `GET /bridge/meta` (unauthenticated) reports product/binary version, supported API majors, deployment mode, instance identity, auth schemes, `deep_link_base` + **versioned stable deep-link route patterns** (org / module / Doctor / worktrees), granular capabilities (`apps.read`, `runtime.start.v1`, `worktree.create.v1`, `git.publish.v2`, `git.publish.local_confirmation`, `operations.idempotency.v1`), action policies and schema ids. **Clients read `deep_link_base` + the route patterns from `/bridge/meta` and never guess the port** — `4174` is only the default/example (and in the spike: only the fixture default). Capabilities are NOT inferred from binary version.
- **Compatibility.** Additive-only within a major; clients ignore unknown fields/enums; mutations carry idempotency keys; long operations return operation IDs; publish OpenAPI/JSON Schema fixtures and run consumer-driven compat tests against old released binaries; explicit support window; when no compatible API exists, offer the still-functional local UI.
- **Tiers + org-scoping.** READ (status, P1) / MUTATE (local lifecycle + pairing, P2) / DANGER (`publish` = commit+push, P3: token + **per-operation local consent**; not self-approval, decision 0063). **P3 rescope (founder 2026-07-12): browser-initiated git publish from the hosted Dashboard is DROPPED from near-term scope** — the per-operation local-consent design STAYS in the contract as the guard IF it is ever revisited, but is not built now. Near-term, agents commit+push locally as part of creating PRs (worktree → PR); the hosted Dashboard surfaces open PRs and latest commits **read-only, sourced from the GitHub App** (not the Bridge), with links out to GitHub. The Bridge stays the source for LOCAL runtime state only. Every request is organization-scoped. **Personalspace/gbrain stay local-only** — excluded from the CORS allow-list, never cross-origin. API errors are stable codes + params, localized client-side (cs/en catalogs), not Czech prose.
- **Headless mode.** The compiled binary (decision 0059) runs the Bridge daemon with the static UI gated/optional; a **minimal local emergency UI persists permanently** at the end of the transition (it is also the Safari / denied-LNA / incompatible-API fallback).

## 1c. Runtime stages

**Provenance.** Founder ratification 2026-07-15/16. Canonical wording also lands
in the Dashboard spike SPEC §1 — this section is the Launchpad-side mirror;
cross-reference, do not diverge. Builds on the worktree runtime (§12, decision
0049) and the app card layout (§6), and constrains the surface split with the
Dashboard (§1).

**The model.** A module has **four runs**, and they are all runs of the **one**
module — one module = one card everywhere; surfaces differ only in **which runs
they offer**. The canonical names are the vocabulary (users never see git jargon
like "worktree" or "branch"):

| Run | What it is | Where it lives | Who opens it |
| --- | --- | --- | --- |
| **PROD** | The deployed stable instance | A **public domain** (e.g. `deals.exampleorg.com`) | Dashboard ("Open app") **and** Launchpad. Users' agents reach it **only** through the app's hosted MCP server. |
| **MAIN** | The live state of the `main` branch | The org's **Workspace Host**, over the **tailnet** — **never** a public domain | Launchpad only (tailnet, or a Launchpad-managed SSH tunnel — transport **[OPEN]**). |
| **DEV remote** | A branch checkout on its own branch | The Workspace Host, over the **tailnet** | Launchpad only. |
| **DEV local** | A local checkout on its branch | The **builder's own machine**, `localhost` | Launchpad only. This is the existing one-click local run. |

**The six rules.**

1. **One card everywhere.** The same module is a single card on every surface;
   the surface only decides which of the four runs it offers.
2. **The Dashboard opens only PROD.** Its single "Open app" affordance is the
   PROD run. It never offers MAIN or either DEV run.
3. **The Launchpad opens all four.** The builder card carries a compact stage row
   (PROD / MAIN / DEV remote / DEV local) under the tile — an options row, not a
   new panel.
4. **MAIN and DEV remote are never public.** They are reached over the tailnet;
   access is derived from GitHub Teams exactly like SSH (the same authorization
   the workspace-connection recipe uses). The retiring `*.launchpad.<org>.com`
   public vhosts are **not** how MAIN/DEV are exposed.
5. **Canonical naming, no git jargon.** PROD / MAIN / DEV remote / DEV local are
   the user-facing names. A user never sees "branch", "worktree" or "checkout" in
   the run labels.
6. **Governance sees, it does not open.** Governance roles read the run state
   (what is deployed, what is live on the Host, incident trail) but opening a run
   is a builder/steward action, not a governance one.

**MCP as an authorization boundary.** Users' agents reach **PROD only** through
the app's **hosted MCP server** — the repository-db capability layer. MCP is the
**authorization boundary**: users never receive raw files, only the capabilities
the MCP server exposes. Builders' agents on **MAIN / DEV** work directly on the
filesystem and git (SSH per the workspace-connection recipe) — **no MCP needed
for the work**; the MCP server still **runs** on MAIN/DEV as a tested artifact so
it is exercised before it ships to PROD.

**Incident-duty split.** PROD incidents belong to the **productionspace-steward**
seat (SSH over the tailnet, with an audit/report trail). The workspace **Steward**
owns the PR Sweep on MAIN/DEV. The **Admin** is the escalation for both.

**Migration note.** Public per-workspace vhosts (`*.launchpad.<org>.com`) are
being **retired**: MAIN and DEV remote move to tailnet-only access derived from
GitHub Teams. PROD stays on its stable public domain; it is the only run that is
ever public.

**Launchpad implementation (this slice).** The pure model
`runtimeStagesForApp(app, { openable, worktreeCount })`
(`public/app-state.js`) returns the four ordered runs; the card renders them via
`renderRuntimeStages` (`public/app.js`) as a stage row under the tile. PROD is a
real new-tab link when the module declares `production_url` (optional,
warning-first manifest field, `schemas/launchpad-app.schema.json`), otherwise an
honest disabled stub. MAIN and DEV remote are honest **"via tailnet — not wired
yet"** affordances (transport is [OPEN]); disabled runs always state **why** in
plain language. DEV local **reuses** the existing one-click open
(`openAppChain`) — it is not a second run path. Launchpad does not know an
Organization's hosting mode (plan/hosting lives in the Dashboard), so MAIN is
presented uniformly as the not-yet-wired tailnet run rather than guessing a
localhost-only degradation.

**Progressive disclosure (founder 2026-07-16).** The row appears **only when the
module offers more than the local default** — first-time users see zero extra
buttons. DEV local is the implicit default (the tile's one-click open), so a
module whose only run is DEV local renders **no** stage row at all. Once the
module offers anything beyond it — a declared `production_url`, or (later) a
known Workspace-Host MAIN/DEV-remote run — the **full** four-run row shows,
with unavailable runs dimmed and stating why, exactly as before. The pure
predicate is `offersMoreThanLocalRun(app)` (`public/app-state.js`).

## 2. IA / shell regions

The UI should move from one engineering table to a persistent shell with these
regions.

| Region | Purpose | Source of truth | Notes |
| --- | --- | --- | --- |
| Top bar | Výběr aktivního prostoru, identita MAIN/WORKTREE rootu a globální health | Launchpad process + root config + Doctor summary | Dropdown ukazuje jen lokální značku a název prostoru; root badge rozlišuje main a vývojový worktree. |
| Main plane: Personalspace (~~left rail~~, revised 2026-07-05) | Private Buddy/user space and private modules, as a distinct section above workspace apps | `personalspace` mount when present via separate `/api/personalspace` lane | Own visually-distinct private treatment (tint + lock) + Private badge; header dropdown selects it; private modules/apps are per-user/per-colleague and never mixed into shared Organization discovery. |
| Main: Workspace apps | Daily work surfaces | app package manifests + runtime/dependency model | Plná šířka; vyhledávání a stavové přepínače all, running, attention a stopped zůstávají nad kartami. |
| Main: Productionspace systems | Production/runtime engineering surfaces | future `productionspace` manifest + explicit policy | Visually distinct risk treatment; write/destructive actions disabled until policy exists. |
| Detail panel | Selected app/system facts and next action | `/api/apps/:id/health`, logs, plugin metadata | Shows package path, cwd, dependency state, last failure, last install, runtime owner and log link. |
| Doctor/support loop | Root health and explainability | `doctor` report + discovery/runtime checks | Read-only verdict with exact next actions. Doctor remains the authority for broad sync/install. |
| Console/log drawer | Operator action evidence | app logs and Launchpad action responses | Shows command, cwd, exit code, excerpts, timestamps. |

## 3. Data model contract

Every visible app card must be derived from one app object with these groups:

- identity: `id`, `title`, `company`, `module`, `surface`, `tags`
- navigation: `url`, `host`, `port`, `health_url`, `package_path`, `cwd`
- runtime: `runtime_status`, `runtime.source` (`main` / `worktree` / `hosted` /
  `external` / `stale`; worktree runs carry plan code + branch), `runtime.owner`,
  `runtime.pid`, `runtime.log_path`, `runtime.failure_kind`, `runtime.last_install`
- dependencies: `dependencies.state`, `package_manager`, `install_command_display`,
  `cwd`, `package_path`, `node_modules_present`, `lockfile`, `can_install`,
  `can_start`, `checked_at`
- policy: `is_productionspace`, `action_policy`, `risk_level`

The current implementation already ships identity/navigation/runtime/dependency
fields. The redesign adds the policy group and layout-specific grouping, not a
second app registry.

## 4. Status vocabulary

Use one vocabulary across cards, detail panel and Doctor.

| Label | Meaning | User action | Start allowed? | Visual treatment |
| --- | --- | --- | --- | --- |
| `running` | app health probe is OK | Open / Logs / Stop / Restart | n/a | green live badge |
| `ready` | dependencies and package are usable; app can start | Start / Open / Repair | yes | neutral/ready |
| `needs_install` | app is visible but `node_modules` or install artifacts are missing | Install | no | amber attention |
| `stale_lockfile` | app has packages and can start, but package/lockfile timestamps suggest drift | Repair / Start | yes | amber repair warning |
| `missing_package` | manifest points to missing/unreadable package | Doctor sync / fix manifest | no | red blocked |
| `unknown_package_manager` | safe install command cannot be inferred | Doctor / terminal | no | red blocked |
| `missing_access` | Organization/module exists in plan but local machine lacks checkout/access | request/access/sync | no | lock/access badge |
| `restricted` | code exists but current profile/role may not act | request approval | depends on policy | lock/risk badge |
| `planned_slot` | planned app/space not locally installed yet | follow roadmap/Doctor | no | ghost/planned |
| `runtime_failed` | last start/install exited or health is failing | read logs, install/repair/fix script | no until resolved | red log-linked badge |

## 5. Action policy

Actions are local and scoped. Buttons must be disabled with explanation when the
precondition is false.

| Action | Workspace app policy | Productionspace policy | Response must show |
| --- | --- | --- | --- |
| Open | Allowed when `url` exists; never starts anything | Allowed as read-only | target URL |
| Install | Allowed only when `dependencies.can_install=true`; app-cwd scoped | Disabled until explicit production policy exists | action, command, cwd, exit_code, log_path, log_excerpt |
| Repair | Same mechanism as Install for `ready`/`stale_lockfile` states | Disabled until explicit production policy exists | action, command, cwd, exit_code, log_path, log_excerpt |
| Start | Allowed only when `dependencies.can_start=true` and no runtime conflict | Disabled or confirmation-gated until policy exists | runtime, pid, health, failure_kind on error |
| Stop | Allowed only for app-owned/adopted local process | confirmation-gated | pid/owner/result |
| Restart | Stop + Start; never bypasses dependency/policy guards | confirmation-gated | both action results |
| Logs | Always allowed for visible app | Always allowed | log_path and tail |
| Pull | Organization root or Workspace module; clean expected branch; fresh remote check; `--ff-only` | Read-only / disabled | before/after status, new head |
| Pull + autostash | Explicit confirmation; incoming > 0, outgoing = 0; stash tracked + untracked; restore staged state; preserve stash on conflict | Disabled | before/after, conflict or preserved-stash state |
| Pull all | All mounted Organization roots + Workspace modules; clean pull or guarded autostash per repo; isolated result | Productionspace skipped | per-repo outcome + aggregate counts |

For main Workspace runtimes, the manifest-owned port is only a discovery key,
not proof of process ownership. A listener is `adopted-port` only when Launchpad
resolves its PID and positively verifies that its canonical CWD matches the
manifested app CWD. An explicit mismatch is `foreign-port`; an unavailable or
inconclusive CWD lookup is `unknown-port`. Neither untrusted state may expose
Stop/Restart or receive a signal. Stop re-resolves both PID and the positive CWD
match immediately before `SIGTERM` and again before any bounded-timeout
`SIGKILL`; an unknown, changed, or mismatched result fails closed.

Productionspace systems must not look like normal office apps. The first
productionspace release should ship with read-only Open/Logs/Doctor and explicit
`action_policy=disabled_pending_policy` for Install/Start/Stop/Restart.

## 6. App card layout

Each card should show, in order:

1. Organization badge + app title.
2. Surface badge: Workspace / Productionspace / Manual / Public preview.
3. Primary status badge: Running / Ready / Attention / Blocked / Planned.
4. Dependency badge: `ready`, `needs install`, `stale lockfile`, etc.
5. Git/worktree chip: main checkout state (`Git aktuální` / `Pull N` / `Draft` /
   `Push N` / `Diverged`) and active worktree count with Mission Control plan
   ownership (see section 12).
6. Runtime owner line: managed, adopted-port, none, or conflict.
7. Local endpoint: `host:port` and health path.
8. Primary next action:
   - `Open` when running or URL is useful;
   - `Install` for `needs_install`;
   - `Repair` for `stale_lockfile`;
   - `Start` for ready/stopped;
   - `Logs` for failed/blocked.
9. Secondary actions behind a kebab/more menu to reduce accidental clicks.

The current table can remain as a debug mode, but the default shell should be card
or grouped list based; the header dropdown determines the active Organization.

## 7. Detail panel

The detail panel is the explainability surface. It must include:

- package path and cwd
- package manager and install command
- dependency state and message
- runtime status, owner, pid and health URL
- last install action/exit/log excerpt
- last failure kind and last error message
- discovery warnings tied to this app
- source links: package manifest, logs, Doctor check, Organization manifest

For `runtime_failed` or `app_start_failed`, the panel should show the exact
`failure_kind` and a next action. Examples:

- `missing_dependencies` → Install/Repair
- `missing_script` → fix `dev_script` or package scripts
- `bad_cwd` → Doctor sync / fix package path
- `port_conflict` → Stop conflicting owner or free port
- `unknown_early_exit` → open Logs and inspect app error

## 8. Přepínač prostorů v záhlaví

> Revidováno 2026-07-14: scope selector už není v levém railu. Personalspace
> zůstává samostatnou sekcí v hlavní ploše, ale aktivuje se dropdownem v záhlaví.

Pořadí dropdownu:

1. Osobní (privátní ikona; vybírá personalspace-only pohled).
2. Organizace v discovery pořadí.

Každý řádek smí obsahovat pouze:

- lokální značku/logotyp prostoru,
- display name.

Řádek nesmí zobrazovat mounted path, Private tag, počty aplikací či modulů,
attention/running stav ani productionspace statistiky. Logotypy se nesmí
načítat z externí služby; bez deklarovaného lokálního assetu se použije
deterministická lokální monogramová značka.

Clicking an Organization filters the main panel to its workspace apps and systems.

## 9. Live data validation snapshot

Historický lokální smoke snapshot (reálné počty organizací/aplikací a
dependency stavy) byl přesunut do privátního `Rozjedeme-ai/HumanAndMachines`;
public spec drží jen mechanismus, ne provozní čísla konkrétní mašiny.

## 10. Implementation phases

### Phase A — shell structure without changing discovery

- Keep `/api/apps` contract.
- Add grouping helpers client-side: Organization, surface, attention state.
- Add left rail with Personalspace placeholder and Organization rows.
- Add detail panel fed by the selected app object.
- Preserve the current table as `Debug table` or a compact mode.

### Phase B — policy metadata

- Add `action_policy` to app objects using current `surface` and future
  productionspace metadata.
- Disable productionspace destructive actions until explicit policy is committed.
- Add copy explaining why a disabled action is safe/blocked.

### Phase C — Doctor/support integration

- Surface Doctor summary in the shell.
- Link app-specific warnings and runtime checks into detail panel.
- Add refresh/invalidation button that re-fetches discovery and runtime state.

### Phase D — productionspace and personalspace real mounts

Personalspace part **implemented by CAC-0048** (decision 0051):

- [x] Optional `personalspace` mount support via a **separate discovery lane**
      (`launchpad/src/personalspace-lib.mjs`) that scans
      `personalspace/*/personal.gen3.json` and NEVER mixes into `organizations/*`
      auto-discovery. Own schema copy `launchpad/schemas/personal.gen3.schema.json`
      (identical to HnM upstream). Identity invariant is fail-closed
      (`owner.github_username` ↔ mount ↔ repo).
- [x] Personalspace private-module discovery: Principálovy apps carry
      `personal: true` / `surface_scope: "private"`, prefixed runtime ids
      (`personal--…`), a **Private badge** and the same runtime actions as
      Organization apps, over a separate runtime lane
      (`POST /api/personalspace/apps/:id/:action`). Cizí Personalspace se
      nematerializuje (decision 0091). `missing_access`/`planned_slot` slots
      popisují jen stav Principálových modulových rep.
- [x] GBrain reader/search surface: Obsidian `obsidian://open` deep link +
      read-only tree/note/fulltext over `GET /api/personalspace/:space/gbrain/*`,
      **bounded to the vault** (no path escape), local-only (127.0.0.1), no note
      content in logs or shared outputs. Agents still use the gbrain MCP server;
      this is only the human read-only surface.
- [x] Doctor `launchpad.personalspace` check is **metadata-only** (counts,
      validity, gbrain mount state) — never note content.

Still open in Phase D (not CAC-0048 scope):

- Productionspace manifest discovery is already read-only; keep it that way.
- Require separate policy before enabling productionspace lifecycle actions.
- v2 gbrain: semantic search via the gbrain server API (follow-up).
- Physical migration of the live gbrain under `personalspace/<owner>_GEN3/gbrain/`
  and secrets to the owner-scoped custody path (coordinated follow-up; the
  Launchpad already reads the transitional mount).

### Bridge phases (P1–P3) [PROPOSAL — decision 0077]

These layer on Phases A–D and reuse the 'keep the `/api/apps` contract' framing of Phase A (now: freeze it as `/bridge/v1`).

- **P1 — read-only status in the Dashboard.** `/bridge/meta` + read-tier routes; exact CORS allow-list + **LNA** preflight handling + pairing (read scope, auth for reads too); three transport adapters (loopback LNA / Workspace Host HTTPS / **mandatory fallback deep-link**); **stable deep-link hash routes** (org / module / Doctor / worktrees) so the Dashboard can open the local Launchpad at the matching page via contextual 'Open in local Builder' buttons (founder 2026-07-12; independent of embedding); local UI refactored to consume `/bridge/v1` as first client. Exit: capability negotiation works old-daemon × current-Dashboard; **browser-matrix passes incl. Safari via fallback, Firefox, managed Chrome/Edge, VPN/proxy, denied/revoked LNA, port squatting**; deep-link from a hosted Dashboard opens the correct local Launchpad screen; local data never transits the platform; local UI still functional.
- **P2 — safe mutations (start/stop, pairing).** Mutate-tier behind token + scope + org-scope; runtime lifecycle as operations with idempotency keys + operation IDs; local grant + unpair. Exit: no danger-tier; User never reaches the Bridge; personalspace stays local-only; lost response never causes unsafe retry.
- **P3 — git ops (worktree create, publish). [RESCOPED near-term — founder 2026-07-12.]** Browser-initiated git publish from the hosted Dashboard is **DROPPED from near-term scope**. Danger-tier `publish` with **per-operation local consent** (immutable intent → top-level local confirmation with real diff → fresh gesture → one-use authorization → revalidate hash + Git preconditions → local audit; not self-approval) **stays in the contract as the design guard IF this is ever revisited**, but is not built now. Near-term substitute: agents commit+push locally as part of creating PRs (worktree → PR); the hosted Dashboard shows open PRs + latest commits **read-only from the GitHub App**, linking out to GitHub. An **open PR is a Draft, not Publikace**; **Publikace dat** = commit+push to a data repository, which an Agent executes **only on its Principal's explicit in-thread instruction**; a **Release** is a GitHub Release performed by a GitHub user holding the required authority (Organization **Steward/Admin**) — an **authority category, NOT a human-vs-AI distinction** (an AI Colleague holding that seat may release). An **Agent never owns approval/authority**; it may execute an explicitly authorized publication on behalf of its Principal. Exit (when/if built): Agent never self-publishes; branch-push-only; TOCTOU/repo-lock/recovery covered.
- **Local-UI deprecation gate (founder-gated, after P3).** Rich local shell converges into the Dashboard; the minimal emergency UI and `/bridge/v1` remain permanently.

## 11. Acceptance checklist

- [x] Personalspace is visually private and cannot merge into Organization app discovery (CAC-0048; separate lane + isolation tests).
- [x] Header space dropdown is derived from live discovery, not hardcoded copy.
- [ ] Workspace and Productionspace have different action policies and visuals.
- [ ] Cards/detail use the same dependency labels as Doctor.
- [ ] `needs_install`, `stale_lockfile`, `runtime_failed`, `missing_access`,
      `restricted`, `planned_slot` and `invalid_manifest` are represented in UI copy.
- [ ] Productionspace Install/Start/Restart is disabled or confirmation-gated.
- [ ] Runtime source (`main` vs `worktree` + plan code/branch) is visible on cards,
      detail and status API; orphan worktrees cannot start a runtime.
- [ ] Live data smoke still shows all mounted organizations' apps.
- [ ] `bun run check` remains green.
- [ ] **[PROPOSAL — decision 0077]** Foundation is contract + shared Builder UI package + transport/auth adapters; no `if(dashboard)`/`if(localhost)` branches in components (differences live behind transport, policy, shell interfaces; rendering is capability-driven).
- [ ] Exact CORS allow-list restricts Origin to Dashboard (prod/dev) + `localhost` dev; rejects `null`/wildcards/suffix/reflected; `Vary: Origin`; `OPTIONS` handled; **LNA** preflight handling (not PNA as foundation); custom header required on mutations; unexpected `Host` rejected (DNS rebinding).
- [ ] Three transport adapters implemented; **mandatory fallback deep-link 'Continue in local Builder'** works for Safari and denied/revoked LNA.
- [ ] **[founder 2026-07-12]** Every major Launchpad screen (org, module, Doctor, worktrees) has a **stable deep-link hash route**; the hosted Dashboard can open the local Launchpad at the matching page via contextual 'Open in local Builder' buttons, and the routes stay stable across binary releases (works independently of whether embedding lands).
- [x] **[founder 2026-07-22; first route slice]** Local shell resolves stable
      Organization (`/#/org/<company.slug>`) and local-only Personalspace
      (`/#/personalspace`) routes, mirrors scope changes back into the URL and
      fails safely for invalid or unavailable scopes. Remaining module, Doctor
      and worktree routes keep the full P1 item above open.
- [ ] Auth required for reads too — only `/health` + `/bridge/meta` unauthenticated; pairing token bound to origin+account+orgs+OS-user+expiry, stored in OS keychain (not localStorage), TTL + rotation, unpair from local shell.
- [ ] `GET /bridge/meta` negotiates api majors/deployment/capabilities; capabilities granular and not inferred from binary version; older daemon degrades gracefully; when no compatible API, Dashboard offers the local UI.
- [ ] Mutations carry idempotency keys; long operations return operation IDs; consumer-driven compat tests run against old released binaries; explicit support window documented.
- [ ] Every request organization-scoped (builder for Org A never receives Org B inventory on the same machine).
- [ ] `publish` requires token **and** per-operation local consent (real diff, fresh gesture, one-use intent-bound authorization, revalidation, local audit); XSS can request but not silently approve. **(Design guard only — near-term browser-initiated publish is rescoped out per founder 2026-07-12; hosted Dashboard surfaces PRs/commits read-only from the GitHub App instead.)**
- [ ] Local Bridge data never transits the platform (network trace: responses from `localhost`/Workspace Host, not Cloud Run).
- [ ] Personalspace/gbrain excluded from the cross-origin Bridge (blocked cross-origin, tested); API errors are stable codes + params, not Czech prose.
- [ ] Local Launchpad UI still functional as the first client; minimal emergency UI retained.

## 12. Worktree runtime (decision 0049, plan CAC-0042)

Builders launch module apps not only from the `main` checkout but also from
Mission Control plan worktrees. Contract summary (canonical text: decision 0049
in HumanAndMachines/docs/decisions/; the dated implementation blueprint
lives in the private `Rozjedeme-ai/HumanAndMachines` repo):

- Local module tree stays on `main`; every code change happens in a worktree at
  `organizations/<Org>/.worktrees/workspace/<module>/<PLAN-code>-<slug>/` with a
  `companiesascode.worktree.v1` sidecar. A worktree without an owning Mission
  Control plan is an orphan: shown loudly, never startable.
- The app card/detail offers a runtime source selector: `main` or an eligible
  worktree (owned by a plan, dependencies ready). A worktree run carries a
  prominent `WORKTREE · <PLAN-code> · <branch>` badge.
- DEV instances get their port from Launchpad via the `PORT` env contract; an
  app manifest declares support. A DEV instance never takes the main runtime's
  port — collision is a blocking state.
- Main i worktree runtime dostává absolutní
  `COMPANYASCODE_ORGANIZATION_ROOT`. Appka používá tento kontrakt pro
  Organization-level manifesty, `infra/`, shared compatibility soubory a
  cesty do jiných modulů; nesmí Organization root odvozovat z worktree `cwd`
  ani zaměnit za Conglomerate-level `COMPANIES_WORKSPACE_ROOT`. Stejný env je
  dostupný i dependency install procesu.
- Launchpad may create a worktree from a planned Mission Control plan (guarded:
  valid plan, clean-enough main, canonical path, sidecar metadata).
- `Publikovat` means: commit the local draft and push the branch to GitHub.
  Opening a PR is a separate follow-up action.

## 13. Builder UX z GEN2 (RM-0009 / plan CAC-0044)

Launchpad je **builder surface** a builder je **neprogramátor** (decision 0047):
primární UI nesmí vyžadovat git žargon. Denní flow musí projít člověk, který
Git nezná — otevřít appku, stáhnout novější verzi, poznat rozdělanou práci —
bez pomoci. Port builder UX GEN2 Launchpadu do
sdíleného GEN3, **bez org-specific hardcodů**.

### 13.1 Manifest builder metadata (org-agnostic invariant)

GEN2 UX stál na hardcodech jedné firmy (`APP_COPY`, `APP_ICON_STYLES`,
`APP_GROUPS`, `QUICK_APP_IDS`). Sdílený Launchpad je nesmí obsahovat — žádná
org-specific pravda v shared kódu (decisions 0040/0042). Builder metadata proto
patří do **app manifestu** (`companyascode.app`), ne do shared kódu:

| Pole | Typ | Význam | Fallback když chybí |
| --- | --- | --- | --- |
| `icon` | optional string | Klíč ikony karty. Známé klíče pokrývají funkce modulů (`deal`, `warehouse`, `product`, `datasheet`, `pricebook`, `invoice`, `installation`, `dashboard`, `profitability`, `marketing`, `website`, `examples`, `control`, `book`, `pen`, `palette`, `database`, `system`, `app`). | Sémantická taxonomie podle celých slov v modulu/id/tagu. Konkrétní funkce má přednost před technickým tagem; například `datasheets + filesystem-db-v2` je balíček, ne paleta ani databáze. |
| `description` | optional string (≤240) | Lidský český jednořádkový popis pro buildery. | Surface + Organizace · modul. |
| `group` | optional string (≤80) | Builder sekce karty. | Default workspace grouping (decision 0041). |

Ikona musí vyjadřovat účel modulu, ne jeho implementační technologii. Paleta je
vyhrazená pro design, brand a témata; `system` uvnitř slova `filesystem` ji
nesmí aktivovat. Stejný resolver používají karty, „Poslední změny“ i
„Nejčastější“, aby měl modul všude jednu vizuální identitu. Manifestový `icon`
zůstává autoritou a dovoluje Organizaci fallback přepsat bez hardcodu ve
sdíleném Launchpadu.

Validace je **warning-first**: vadná hodnota volitelného pole appku
nezneplatní — jen se zaloguje varování (`… (builder metadata)`) a karta spadne
na fallback. Schema: `schemas/launchpad-app.schema.json`; validace +
normalizace: `src/discovery-lib.mjs` (`validateBuilderMetadata`,
`builderMetadataString`). Pole se propisují na app objekt jako `string|null`,
ať UI nemusí řešit prázdné hodnoty.

### 13.2 Karty a ⋯ menu

Celá karta je klikatelná a spouští **one-click open** (install → start → otevřít
URL) s guardem na vnitřní ovládací prvky (`shouldOpenFromCardSurface`). Ikona,
popis a git chip jdou z modelu, ne z hardcode copy. ⋯ menu nese vysvětlující
note (co spouští hlavní akce) a položky variant „Otevřít &lt;varianta&gt; — port ·
popis · stav"; každá varianta se otevře stejným jedním klikem. Productionspace
a blokující dependency stavy zůstávají read-only (jen selekce do detailu).

### 13.3 One-click open chain (idempotentní, bez tichého fallbacku)

`POST /api/apps/:id/open` (`src/runtime-lib.mjs` → `open`) je idempotentní řetěz:
ensure install (jen když dependency stav vyžaduje a jde bezpečně) → ensure start
(běžící appka se reuse-ne, nespouští znovu) → vrátit URL. Každý krok je
idempotentní a přerušitelný; **port kolize je blokující stav** (decision 0049),
žádný tichý fallback — konflikt propadne do srozumitelné chyby. UI rezervuje tab
před akcí (aby ho prohlížeč nezablokoval), ukazuje průběh „Otevírám…", toasty a
klasifikaci chyb do lidského jazyka (`classifyOpenError`).

### 13.4 Pravé panely

- **Poslední změny** (`src/recent-changes-lib.mjs`, `/api/recent-changes`):
  per-modul poslední commity (datum, počet, rozklik detailu) z bounded,
  read-only `git log` v neinteraktivním git prostředí. Standalone, ať rebase na
  git read model z CAC-0042 bolí minimálně — kontrakt `recent_modules`
  zůstane stejný, i když se implementace přepíše nad git-inventory-lib.
- **Nejčastější** (`src/usage-lib.mjs`, `/api/most-used`): lokální usage
  tracking otevření aplikací v `launchpad/runtime/usage.json` — **mimo Git**
  (runtime/ je gitignored), per mašina, **žádná PII** (jen app id + agregát
  count/last_opened_at). Řadí podle skutečného použití; cold start (nic zatím
  neotevřeno) má fallback na připravené aplikace. Nahrazuje GEN2 fixní
  `QUICK_APP_IDS`.

### 13.5 Integrovaná kontrola (žádný samostatný tab)

Tab „Kontrola" se v GEN3 nezavádí — git stavy modulu jsou **per-modul přímo na
kartě** jako chip s lidským textem (port GEN2 copy tabulky 1:1,
`public/git-status-copy.js`): „Někdo mezitím poslal novější verzi. Můžeš ji
bezpečně stáhnout." apod. Diverged / jiný režim vedou na pomocníka, ne na
automatický pull (nesmí zamlčet riziko). Filtr „Ke kontrole" zahrne git
attention stavy přes anotaci `git_attention` (`app-state.js` `isAttentionState`).

Git data dodává git read model z CAC-0042 (`/api/git/repos`). Do jeho mergnutí
se git chip chová **graceful**: bez dat se nevykreslí a `git_attention` je
vždy `false`, takže se stávající chování nemění. Rozšíření `isAttentionState`
o git stavy je připravené a aktivuje se automaticky, jakmile endpoint začne
vracet data — viz handoff CAC-0044.

Organization root repo je first-class položka Organization UI, ne skrytý API
detail: panel **Git Organizace** ukazuje jeho status, incoming počet a freshness.
Ve stejném panelu je jediná globální akce **Pullnout vše**, která projde všechny
namountované Organizace včetně jejich root repozitářů a Workspace modulů.
Bezpečné čisté checkouty fast-forwardne; draft s incoming a bez outgoing commitů
projde explicitním autostash flow. Productionspace a rizikové stavy přeskočí,
jeden konflikt nezastaví ostatní repozitáře a výsledný souhrn musí pojmenovat
každý skipped/conflict/failed checkout. Background fetch je během Git mutací
pozastavený a mutace z různých karet jsou serializované.

**Freshness kontrakt (owner 2026-07-14).** Tichý browser refresh běží každých
15 sekund jen tehdy, když je karta viditelná a okno fokusované. Hidden/blur jej
zastaví; návrat spustí jeden okamžitý refresh. `/api/apps` smí používat pouze
krátce cachovanou lokální Git kontrolu a nesmí zahajovat remote fetch. Pouze
Organization-scoped `/api/git/repos?company=<slug>` z aktivního klienta smí
request-driven naplánovat vzdálenou kontrolu. Server sdílí cache mezi kartami,
deduplikuje in-flight fetch per repo, omezuje remote concurrency na 2 a po
úspěchu další fetch odloží o 5 minut plus stabilní jitter do 60 sekund. Neexistuje
nezávislý serverový polling timer. Selhání zachová poslední známý stav, označí
freshness jako error a retry odloží přibližně o minutu; explicitní pull nesmí
pokračovat, pokud předchozí fetch remote spolehlivě neověřil. UI i API ukazují
čas posledního úspěšného remote ověření a nesmí vydávat stale refs za právě
ověřený stav.
