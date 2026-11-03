# Research request receipts (milestone 2a)

A research user message has a collapsed receipt in ChatView, independent of the
show-tool-calls preference. This is a projection of the loaded selected branch,
not a new mission scheduler. Original objectives are bounded for display.

## Evidence semantics

Only bot rows with an exact server-proven `requestMessageId` are attributable.
A neighboring answer, activity in a different request, and a model's claim of
completion are not ownership or lifecycle evidence.

Status uses explicit source `requestPending` / `requestCancelled` and owned
`turnSucceeded` metadata. A settled successful provider response is labeled
"Response recorded", not "research verified". Successful dependencies cannot
finish a still-pending originating request. Missing lifecycle evidence stays
unknown. No progress percentages, timers, source-independence counts or new
stop/resume controls are introduced.

The ledger independently labels:

- URL mentioned in a request-owned response;
- URL present in a successful tool's output text;
- URL in the input of a failed tool operation.

None proves content was read, source credibility, factual verification, or
independent corroboration. Empty evidence does not prove no search occurred.
Webhook prose and unowned activity are not counted. Tools/results are records,
not guaranteed unique search operations. Browser recording is not assumed.

URLs are public HTTP(S) only; credentials, known secret-bearing query keys,
loopback/private addresses and internal hosts are excluded. Tracking parameters
and fragments are removed for display deduplication, without fetching pages.
Source display is bounded to 30 URLs and scanning to 512 KB; truncation is
visible. Pagination is explicitly marked as partial history.

## Verification

```sh
pnpm exec vitest run src/lib/research-mission.test.ts src/components/ResearchMissionCard.test.ts server/research-request-api.test.ts --maxWorkers=1
pnpm exec vitest run src/components/ChatView.controls.test.ts -t 'research request receipts' --maxWorkers=1
```

The API fixture uses its own HOME/data and fake engine. It reads real persisted
thread messages after settling and feeds them through the receipt helper,
proving lifecycle metadata survives the server-to-client wire. It also retains
milestone-1 checks. The ChatView SSR integration asserts the card and attributable
URL remain visible with tool chips hidden and partial-history notice present.

The full `ChatView.controls.test.ts` was also run. Nine legacy expectations fail
on both the pre-change `d0ddd43` baseline and the working version (old built-in
call placement, layout, approval and header assertions). Those are not reported
as passing and are outside this receipt slice. A detached baseline worktree at
`/home/ubuntu/projects/omb-mission-baseline-check` was used; no live user data was
changed by verification.

## Remaining scope

A typed retrieval receipt with returned content, publication/data/check dates,
claim-to-source links and independent-source analysis is still missing. So are
mission editing and resume orchestration. No real-provider research quality,
mobile screenshots, or factual truth is proven by these fixture tests.
