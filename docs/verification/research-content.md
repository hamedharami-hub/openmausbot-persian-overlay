# Browser content observations and answer references (milestone 2b)

This extends request receipts without promoting model prose into verified facts.

## Supported acquisition path

A successful supported `agent_browser_read` (without `url`) may be followed by a
bounded, independent visible-DOM observation in the same browser lane. It uses
the existing browser, not a new HTTP fetch path. The app records only a receipt:

- observed public URL;
- app observation time;
- character count and explicit truncation;
- SHA-256 of the captured, scrubbed DOM text;
- hash basis and acquisition source.

The page body and raw title are not retained in this receipt. The requested URL
is null because read operates on an already-open page. This is request/turn
ownership, not an exact provider tool-item receipt. The independent observation
is not necessarily the exact bytes supplied to the model by the original read.
It cannot prove that the model understood the text, that a document is complete,
or that an article supports a claim.

The runtime must respect the existing secret hold, takeover/closing state,
capability checks and deadline before/after awaited work. Text is scrubbed before
hashing and counting. Index admission checks exact active generation and turn,
unstopped request ownership and an originating research user message. Late
callbacks cannot attach to a newer request. Observation/persistence failure does
not retry or change the successful original read.

Chrome routing, native provider fetch tools, shell commands and arbitrary MCP
outputs do not automatically produce this receipt. Their evidence remains
unknown. URLs with credentials, secret-bearing query parameters or internal
addresses are not admitted as public-source observations. No DNS lookup or
network request is performed merely to admit or render a receipt.

## Dates

Observation time is not publication, update or underlying-data time. The UI
separates these fields. Absent dates stay unknown. Optional page-reported
publication/update values are explicitly unverified; no current date is filled
in as a substitute and no underlying-data date is inferred.

## Answer-to-source references

For attributed bot answers only, bounded excerpts surrounding a URL are attached
to that same normalized URL. This is a reference passage, not an independently
extracted proposition or a verified claim. Explicit content receipts and mere
URL mentions remain separate dimensions. Tracking parameters/fragments may be
removed for display deduplication; redirecting hosts or different routes are not
assumed equivalent. Captures, references and source lists are bounded.

## Checks

```sh
pnpm exec vitest run server/research-content.test.ts server/browser-tool-shape.test.ts src/lib/research-mission.test.ts src/components/ResearchMissionCard.test.ts shared/research-request.test.ts --maxWorkers=1
```

Runtime tests use a fake browser MCP daemon, not the user's browser or pages.
They validate the supported callback path, ownership/privacy guards and cleanup.
The frontend tests cover false receipts in model/tool text, wrong ownership,
malformed hashes/dates, content vs citation separation, bounded answer passages,
unverified dates and escaped rendering. Fake-browser tests prove plumbing, not
real-provider retrieval quality or factual truth.

The complete acceptance scope still includes independent claim assessment,
primary-source ranking, data-date extraction and broader provider/browser
coverage. This milestone does not claim those are complete.
