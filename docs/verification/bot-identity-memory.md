# Bot identity, live state and memory provenance (milestone 3)

This slice exposes what the app already records; it adds no memory store and no
progress model.

## Now card (bot settings → Overview)

`BotNowCard` reads the live client state of the task in view, merged by
`currentTaskBot`:

- state from the recorded activity (`working`, `waiting-on-you`, `parked`,
  `no-signal`, `idle`); busy without another signal reads as working;
- explicit blockers: a pending approval card (with its tool name) or an
  unanswered durable question card;
- queued request count from the real queue;
- the task title only while that task is live;
- the last recorded bot answer with its time and one of three outcome labels:
  a successful turn was recorded, a failed turn was recorded, or **outcome not
  established**. A reply is never labelled completed/verified research.

`startedAt` is shown only when it is a plausible timestamp (not stale, not in the
future beyond clock skew). Answers older than 24 hours, webhook-written lines and
undated rows are ignored. The card carries a permanent note that silence or a
reply is not proof that work finished, and shows no percentage.

## Memory note provenance

Memory bullets already carry the server's entry grammar
(`- YYYY-MM-DD · from <source> · text[ · until DATE]`, struck when superseded).
The panel now reads that grammar and shows a second line per note:

- the recorded date, when there is one;
- the recorded source kind (chat, group chat, another conversation, dream,
  noticed during a task, other) or **no source recorded** for a hand-typed line;
- the recorded expiry, an expired marker when the date has passed (or the file
  marks it expired), and a struck/superseded marker.

Nothing is inferred: a line a person typed shows no invented source or date, and
a note is never labelled verified. Expired/superseded notes are still listed so
the person can remove them deliberately.

The journal source label now also names dream and Cloud-move changes instead of
leaving them blank, and the panel edit source says "in the memory panel" rather
than "in Settings", since both surfaces write through the same route.

## Checks

```sh
pnpm exec vitest run src/lib/bot-now.test.ts src/components/bot-settings/BotNowCard.test.ts src/components/bot-panel/memory-notes.test.ts src/components/bot-panel/MemoryPage.team.test.ts src/lib/memory.test.ts src/components/bot-settings/MemorySection.test.ts src/components/BotSettingsDialog.simple.test.ts src/components/bot-panel/MemoryPage.undo.test.ts --maxWorkers=1
```

Unit tests cover absent evidence, blockers, outcome labelling, stale and
future-dated rows, live-only mission titles, the grammar parser, and that a
hand-typed note gains no source. The undo DOM test drives the real panel on the desktop route: forget a note, see
the Undo row, click it, and assert the revert request and the restored note. The
Team Cloud test asserts no undo button is shown there and that the reason line
appears instead. The MemoryPage DOM test drives the real panel
with a stubbed memory route and asserts the badges rendered, the no-source case,
and that no verified/completion wording appears. The dialog test keeps the
Advanced memory panel and the overview behaviour intact.

## Undo after removing a note

Removing a note from the panel (Advanced settings or the bot panel) now offers a
single **Undo** row that reverts that journaled change by id and reloads the
file. It is offered only where the revert route can serve it: the desktop/base
bot layer, when the journal entry says it can be reverted. On a Team Cloud
member's own layer there is still no journal read route, so the panel says the
change cannot be undone here rather than showing a button that would fail. When
the journal says a change cannot be restored (too large, or text that had to be
redacted), the recorded reason is shown instead. The offer is cleared by the
next write, so a later edit cannot be silently overwritten by a stale undo.

## Not covered

Team Cloud member-layer journals still have no read route (own-layer edits cannot
be undone yet), note-level editing and undo inside the panel are not added here,
and a structured "research finding" memory type with source URL and access date
does not exist. Real-browser and mobile smoke tests were not run for this slice.
