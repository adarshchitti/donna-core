# donna-core

Tracks A (collectors), A2 (orchestration) and B (logic) for Donna.

Donna watches counterparties on commercial agreements and reports **observed
change**. It never asserts health. There is no score, no green badge, no "good
standing". The quiet state is a coverage statement, not a verdict.

## Rules the whole system obeys

1. Report observed change; never assert health.
2. Every claim carries its source, and the source carries a trust level.
3. One reported source is a lead, not a finding.
4. Coverage is shown, not implied. A collector that broke is a visible gap.
5. Tier 1 findings are flagged for a human call.
6. Raw evidence is kept, with its fetch time and the exact text a claim rests on.

## Packages

| Package | Track | Owns |
|---|---|---|
| `contracts` | — | The data contracts every other package compiles against |
| `fetch` | A | Bright Data client: live / record / replay, credit accounting |
| `collectors` | A | One collector per source. Envelope in, envelope out. Nothing else. |
| `store` | A2 | MongoDB access, `book_id` enforcement, index ownership |
| `orchestrator` | A2 | Entity resolution, the loop, schedules, credits, sandboxes |
| `logic` | B | Differ, rules table, validator, narrator, post-processor |

`collectors` imports only `contracts` and `fetch` — never `store` or
`orchestrator`. That is asserted by a test, so "no database or UI access" stays
a property of the build rather than a claim in a document.

## The contract is Track C's, not the PDF's

Track C (the Base44 surface) already renders these shapes from
`src/components/donna/contractFixtures.js`. Where that file and the architecture
PDF disagree, the fixture wins, because it is what the screens actually read.
`fixtures/trackc/` holds an extract of it, and `packages/contracts` is tested
against it in both directions. See `fixtures/trackc/README.md`.

## Running

```bash
npm install
npm test                     # everything, offline, no credentials needed
DONNA_FETCH_MODE=replay npm test
```

Every external dependency (Bright Data, Daytona, Claude, MongoDB) sits behind an
interface with an offline implementation, so the whole pipeline runs and is
testable with no keys.

### Going live

Three variables, not one -- `DONNA_FETCH_MODE` plus **both** zone names:

```bash
DONNA_FETCH_MODE=record      # live | record; replay is the default and spends nothing
BRIGHTDATA_API_KEY=...       # or BRIGHTDATA_API_KEYS for the rotation list
BRIGHTDATA_UNLOCKER_ZONE=web_unlocker1
BRIGHTDATA_SERP_ZONE=serp_api1
```

Both zones are required because six of the eight collectors unlock a page;
only `news`, `executives` and `jobs` begin with a SERP. A pass started without
`BRIGHTDATA_UNLOCKER_ZONE` used to fail those six with a config error that read
like a Bright Data outage, so `assertLiveEnv()` now refuses to start a live run
until all three are set, naming every missing one at once.

Two things worth knowing before reading a failed run:

- **Cassettes and the fetch cache are keyed by URL + UTC day.** At UTC midnight
  every entry stops matching: a replay-mode run starts failing on cassette
  misses and a live run refetches and rebills. "It worked an hour ago" is not
  evidence it still works.
- **`x-brd-error` is two different failures.** A government domain is blocked by
  policy forever; `expect_element` is Bright Data failing to render an allowed
  page, and it usually works on retry. Both arrive as HTTP 200 with
  `x-brd-status-code: 502`. `classifyBrdError()` sorts them -- policy refusals
  throw at once, render failures go through the bounded retry.
