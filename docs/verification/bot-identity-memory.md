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

## Coordination in the Now card

The card also shows coordination only where the transcript records it: the
teammates named by hand-off rows (newest first, capped at five, with the time of
the latest row) and whether the server reports the task is waiting for a
teammate. When it is waiting and no hand-off row exists, it says exactly that
instead of listing a teammate. It never claims a teammate reviewed or verified
anything; the request guidance tells the model that a teammate's answer is not
independent verification unless it used separate evidence, and that one owner
per sub-task plus one synthesis is expected. That is guidance, not enforcement.

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
pnpm exec vitest run src/lib/bot-now.test.ts src/components/bot-settings/BotNowCard.test.ts src/components/bot-panel/memory-notes.test.ts src/components/bot-panel/MemoryPage.team.test.ts src/lib/memory.test.ts src/components/bot-settings/MemorySection.test.ts src/components/BotSettingsDialog.simple.test.ts src/components/bot-panel/MemoryPage.undo.test.ts shared/research-request.test.ts --maxWorkers=1
```

Unit tests cover absent evidence, blockers, outcome labelling, stale and
future-dated rows, live-only mission titles, the grammar parser, and that a
hand-typed note gains no source. The undo DOM test drives the real panel on the desktop route: forget a note, see
the Undo row, click it, and assert the revert request and the restored note. The
Team Cloud test performs the same undo through the own-layer route and asserts
the request path, plus that no layer means no journal route (404). The server
route test writes and reverts on a member layer and checks the team layer is
unchanged. The MemoryPage DOM test drives the real panel
with a stubbed memory route and asserts the badges rendered, the no-source case,
and that no verified/completion wording appears. The dialog test keeps the
Advanced memory panel and the overview behaviour intact.

## Undo after removing a note

Removing a note from the panel (Advanced settings or the bot panel) now offers a
single **Undo** row that reverts that journaled change by id and reloads the
file. It works for the base bot layer and for a Team Cloud member's own layer: the
own-layer journal is now readable and revertible through
`/memory/mine/journal`, with the same chat-device scope as its file route, while
the team layer stays untouched. The button appears only when the journal entry
says it can be reverted. When
the journal says a change cannot be restored (too large, or text that had to be
redacted), the recorded reason is shown instead. The offer is cleared by the
next write, so a later edit cannot be silently overwritten by a stale undo.

The coordination facts are covered by unit tests that invent no teammate from a
busy flag, keep the newest row per teammate, and render the waiting-with-none
sentence.

## Not covered

Note-level editing (changing a note's words in place) is not added here,
and a structured "research finding" memory type with source URL and access date
does not exist. Real-browser and mobile smoke tests were not run for this slice.
