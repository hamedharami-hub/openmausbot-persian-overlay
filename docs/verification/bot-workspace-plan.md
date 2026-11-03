# Bot workspace and evidence-led research plan

Status: approved scope; implementation is incremental. A checked item requires a named verification artifact, not a model's claim.

Delivered slices: milestone 1 request controls (`research-request.md`); milestone 2a request-linked lifecycle receipts and conservative URL evidence (`research-mission.md`); milestone 2b narrow browser DOM observations and answer references (`research-content.md`). Milestone 2 is not complete: neither a URL reference nor a content observation is a verified claim.

Milestone 3 first slice: `bot-identity-memory.md` (live Now card with real blockers/outcome labels, memory note date/source/expiry badges, journal source labels). Note-level editing, member-layer undo and a structured research-finding memory type remain open.

## Scope

1. Bot identity: responsibility, tools/access, active work, latest output, blockers.
2. Editable memory: user preferences, project decisions, dated research findings; provenance and explicit sharing boundaries.
3. Mission cards: objective, scope, actual state, steps, artifacts, blockers, stop/resume. No invented percentages or completion without evidence.
4. Collaboration: one owner per task, bounded specialist work, optional review, one user-facing synthesis. No automatic heavy parallel work on this VPS.
5. Research available to every bot via slash actions, with independent depth and response length, scoped to the current request rather than permanent bot instructions.
6. Evidence: opened pages distinguished from search snippets; original sources prioritized; publication/data/check dates separated; source-to-claim links and explicit uncertainty.
7. Adaptive investigation: cover questions and contradictions rather than promise a fixed page count. No new paid service or silent billing-route switch.

## Milestones and acceptance

### 0 — Inventory

Map existing bot identity, memory, tasks/goals, slash actions, message transport, turn instructions and peer coordination. Reuse existing controls before adding new stores.

Inventory (source inspection, not runtime verification):

- Identity: `src/components/bot-settings/IdentitySection.tsx` already edits profile fields.
- Memory: `src/components/bot-settings/MemorySection.tsx` and `server/routes/bot-memory.ts` already support topic edits, conflicts, history/revert and upkeep. Reuse these.
- Goals: `src/components/GoalRunCard.tsx`, `server/host/one-on-one-goals.ts` and `server/group-goal-run.ts` already expose actual goal receipts; request modes must not silently start goal loops.
- Collaboration: existing `coordinate_bots`, assignment tracking, cancellation and queues under `server/runtime/` should be reused.
- Evidence primitives: `server/browser-evidence.ts`, tool results and transcript citations exist; none alone proves a complete claim-to-source ledger.
- `server/research.ts` is an existing paid/credential-gated catalog service, not the new request mode; selecting a mode must not invoke it automatically.

### 1 — Request-scoped research controls

- `/research`, `/verify`, `/report` discoverable in the existing slash menu with Persian descriptions.
- Visible, removable selection; depth and response length independent.
- User request carries structured settings to the server; existing clients remain compatible.
- Server validates settings and supplies bounded, consistent turn instructions.
- No model switch, background job, web call or permanent profile edit merely from choosing a mode.
- Distinguish research guidance from enforced source verification: instructions alone cannot prove opened pages, dates, or citations.

### 2 — Mission and evidence foundation

Reuse task identity. Persist objective/scope and actual lifecycle events. Record tool-derived sources and access outcomes, distinguish found/opened/independent sources, attach claims to evidence. Display blocked/partial/unverified honestly.

### 3 — Editable memory and identity

Expose existing memory/profile records with provenance and scoped editing. Separate expiring findings from stable preferences. Share only explicitly selected content. Surface real active work and tools on the bot page.

### 4 — Coordinated research

Bound delegation, prevent duplicate ownership, preserve private scopes, independently verify important claims where feasible, and produce one synthesis. Same-model review is not independent corroboration.

### 5 — Acceptance scenarios

Job listings checked at employers; current laws/prices with dated primary sources; conflicting evidence; deep investigation with a short answer; correction of stale memory; stop/resume without repeating all work; bounded collaboration.

## Verification and operations

Use isolated fixtures for mutating checks. Run focused tests and keep frontend builds in CI. Never use private user conversations as test fixtures. Report each milestone as verified, changed-but-unverified, or not implemented. Preserve credentials outside git. Keep code sync paused during multi-file work and restore it after a verified release or an explicit handoff.
