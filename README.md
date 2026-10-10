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
testable with no keys. Going live changes one environment variable.
