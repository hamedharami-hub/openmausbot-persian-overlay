# Request-scoped research controls (milestone 1)

In a direct bot chat, choose `/research`, `/verify`, or `/report`. The composer
shows separate depth and answer-length controls. A typed command followed by a
question works too. Removing the bar returns to ordinary chat; successful send
clears the selection. Drafts are isolated per conversation. Failed sends restore
settings and retries preserve send identity. Editing a research message retains
that message's settings, not another request's settings.

The request metadata is persisted on the original user message and rendered as a
label. User-visible text stays unchanged (except removing a typed slash prefix).
Server-generated guidance is added only to the provider's current-turn input,
not standing bot instructions. It does not select a new model, grant permissions,
start goal orchestration, invoke a paid research service, or guarantee source
verification. Group, goal, app/widget and reaction combinations reject these
options explicitly. Direct-chat queued work retains options through durable
restore and exposes them when returned to the draft for editing.

## Checks

```sh
pnpm exec vitest run shared/research-request.test.ts src/lib/research-commands.test.ts src/lib/research-draft.test.ts src/lib/drafts.test.ts src/lib/composer-commands.test.ts src/components/ResearchRequestBar.test.ts src/components/Composer.simple.test.ts src/components/Composer.phone.test.ts server/routes/bot-messages.test.ts server/send-idempotency.test.ts server/chat-followups.test.ts server/research-request-api.test.ts --maxWorkers=1
```

The API recipe launches `launchVerificationServer()` with an isolated temporary
HOME/data and the fake engine. It proves injection in the captured provider
prompt, absence from the standing system prompt, original transcript text,
changed-options idempotency conflicts, ordinary-next-request isolation, and
editing/retry semantics. The recipe writes bounded evidence beside the printed
fixture log as `.research.json` and shuts down its own fixture.

The component tests drive a real composer render to send a typed research request
and a deep/short request, then assert selection reset. Draft tests cover recovery
and late failure without overwriting newer options. Queue tests cover durable
metadata and prompt replay.

## Not implemented by this milestone

This is guidance, not an enforced research engine or factual-quality proof.
No guaranteed page counts, independent-source counters, claim-to-source ledger,
verified badges, new mission board, or new memory sharing are claimed. Native
providers may remember prior conversation context; the current-turn instruction
is explicitly scoped but cannot prove a model forgot earlier instructions.
Real-provider retrieval quality and mobile usability require separate checks.
See `bot-workspace-plan.md` for remaining milestones.
