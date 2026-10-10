# Track C acceptance fixtures

`allContracts.sample.json` is a trimmed extract of Track C's own
`src/components/donna/contractFixtures.js` -> `allContracts()`, generated inside
the Base44 app sandbox. It is the authoritative output contract: Track C's
screens already render these exact shapes.

Two deliberate differences from what Tracks A2/B write, encoded in the test:

1. **No `book_id`.** Track C's fixtures predate tenancy. Our stored documents
   MUST carry it; the fixture is validated against a `book_id`-less variant.
2. **Profiles lack `citations` and `narration_status`.** Track C's own profile
   fixture omits both, which would make `BriefingBody` throw a TypeError on
   `citations.why_it_matters.some(...)`. Our schema requires them on every
   briefing, profile included -- strictly safer than the fixture.

Also note `collector_runs` carries a fixture-only `demo: true` flag we ignore,
and that `signal.title` does not exist in the fixture at all (Track C looks it
up via `signalTitle(signal_id)`), which is why our Signal contract adds it.

Regenerate with the command recorded in `scripts/refresh-trackc-fixture.md`.
