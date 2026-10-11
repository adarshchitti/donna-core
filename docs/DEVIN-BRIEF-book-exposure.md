# Devin brief A — book exposure, the whole book instead of one deal

You are adding **one pure function and two store reads** to `donna-core`.
Scope is hard-bounded: **records in, one rollup object out.** You add no
collector, no fetch, no screen, and you store nothing.

Donna today computes exposure per deal and surfaces it per company. Nobody can
see what the whole book carries. This is that number — except it is not a
number, and understanding why is the whole job.

---

## 1. The contract, already landed

`bookExposureSchema` / `BookExposure` in `packages/contracts/src/schemas.ts`
(commit `204c204`). **Do not change it.** It is already exported and already
tested; `packages/contracts/src/bookExposure.test.ts` shows a full valid value.

Signature to build:

```ts
bookExposure(
  companies: Company[],
  deals: Deal[],
  clusters: Cluster[],
  today: string,          // ISO instant, injected — never call Date.now()
  rules?: Rules,          // loadRules() default, for notice_window_days
): BookExposure
```

New file: `packages/logic/src/exposure-book/rollup.ts`, exported from
`packages/logic/src/index.ts`. **Pure.** No I/O, no `@donna/store` import, no
Mongo. The caller passes records in.

---

## 2. THIS IS NOT A SCORE. Read this section twice.

Rule 1 of the whole system is that Donna reports observed change and **never
asserts health.** A single number for a book is a verdict, and a verdict is
exactly what the first tester told us they would not trust — their stated fear
was a briefing that says all is well, followed by the client leaving.

So every field is a sum of **dollars the user typed at intake**, a **count of
companies**, or a **tier that came out of the rules table.** Three rules:

**Rule A — nothing is blended.** There is no field that sums or averages
`exposure_weight`. A per-deal weight is explainable (value against a cap, share
against a cap, doubled when hard to replace, plus a notice bump); thirty added
together is a figure nobody can check by hand. If you find yourself reaching
for a weight, that is the signal you are building a score. **Add the dollars
instead.** A test already asserts no field name matches `score|rating|weight`;
do not work around it.

**Rule B — unknown aggregates as unknown.** `share_pct`, `substitutability` and
`notice_days` are optional at intake and each only ever *adds* to a weight, so
a sparsely described deal always understates. `exposureFor()` in
`packages/logic/src/validator/exposure.ts` already returns `exposure_known` for
exactly this reason — **reuse it, do not re-derive it.** `value_exposure_unknown`
is the contracted value whose exposure is a floor rather than a measurement. A
book that is mostly unknown must read as mostly unknown, never as mostly low.

**Rule C — coverage is money, not a percentage.** "94% source coverage" hides
which 6%. `value_behind_failed_source` maps a source id to the contracted value
sitting behind it, by name. For this build that is a permanent honest line
about `regulator` and `layoffs`, which are unreachable by policy and always
return `ok:false`.

---

## 3. How each field is computed

Read `company.coverage` (a `Coverage`) and `cluster.top_tier` as given; do not
recompute either.

| Field | Computation |
|---|---|
| `counterparties.total` | `companies.length` |
| `counterparties.monitored` | companies with `monitoring_since` set |
| `counterparties.lookup_only` | companies with `lookup` and no `monitoring_since` |
| `contracted_value_usd.*` | sum `deal.annual_value_usd`, grouped by `deal_class`. `tied` is its own line and never a weight |
| `value_by_top_tier.tierN` | for each company, find its cluster; sum the value of that company's linked deals under `cluster.top_tier`. Companies with no cluster, or a cluster whose `top_tier` is 0, go to `none` |
| `value_notice_window_closing` | deals whose `notice_days_remaining` from `exposureFor()` is **at most** `rules.exposure.notice_window_days` -- **INCLUDING a negative value, meaning the window has already shut.** A shut window is worse than a closing one, not better: the chance to exit on notice is gone, so excluding it would understate the book at exactly the moment it matters most. Reuse `exposureFor()`'s `notice_days_remaining` rather than redoing the date maths. Note this is deliberately a different test from the one `exposureFor()` uses for its own notice BUMP, which is a bounded `0 <= r < N` because a bonus for an already-shut window would make no sense; the rollup is reporting value at stake, not scoring a deal |
| `notice_window_days` | the threshold used, carried so the figure is self-describing on screen |
| `value_hard_to_replace` | deals with `substitutability: 'hard'` |
| `largest_counterparty` | the company with the largest summed linked-deal value. `share_of_book_pct` is its value over `contracted_value_usd.total`, 2dp. `share_pct` is the user's own field or null. **Null on an empty book** |
| `value_exposure_unknown` | value of deals whose `exposureFor()` gives `exposure_known: false` |
| `companies_exposure_unknown` | companies with at least one such deal |
| `value_behind_failed_source` | for each source in any company's `coverage.failed`, sum that company's linked deal value. Partial record — omit sources with nothing behind them |
| `not_covered` | `[...NOT_COVERED_CATEGORIES]` from `@donna/contracts`, verbatim |

A company with no linked deals contributes 0 to every dollar line and still
counts in `counterparties`. A lookup-only company is exactly that case.

### `headline`

The honest replacement for a risk score, **assembled by code, never by the
narrator.** Four sentences, each **omitted when its figure is zero**:

1. `$4.2M contracted across 30 counterparties, watched on 6 of 8 sources.`
2. `$820K sits behind a tier-1 signal awaiting a human call.`
3. `$1.4M is incompletely described at intake, so its exposure is unknown rather than low.`
4. `Not covered for any counterparty: private financials, payment behaviour, relationship sentiment, related-entity monitoring.`

Money is abbreviated (`$4.2M`, `$820K`); put the formatter in the same module and
test it. Sentence 1's source count is sources appearing in any
`coverage.checked` over 8.

**The headline must pass `findForbidden()`** from
`packages/logic/src/narrator/forbidden.ts` — import it and assert it in a test.
No model writes this string, so the citation gate does not apply, but the
language rules still do: no *healthy*, *good standing*, *safe*, *low risk*, and
nothing that reads as advice.

---

## 4. The two store reads

`packages/store/src/store.ts` already has `listCompanies()`, `dealsForCompany()`
and `getCluster()`. Add the book-wide equivalents, same `book_id` scoping, same
zod boundary on read, same style as the methods beside them:

- `listDeals(): Promise<Deal[]>`
- `clustersForBook(): Promise<Cluster[]>` — the current cluster per company

Nothing else in the store changes. **The rollup is computed on read and never
stored**, so it cannot go stale behind the data. Do not add a collection, do not
add an index, do not cache it.

---

## 5. What done looks like

Tests in `packages/logic/src/exposure-book/rollup.test.ts`:

- A hand-built book of ~6 deals across 4 companies exercising **every** line in
  the table above, with the expected figures written as literals a reviewer can
  add up themselves.
- A book where every optional intake field is blank: `value_exposure_unknown`
  equals `contracted_value_usd.total`, and `companies_exposure_unknown` equals
  the company count. This is Rule B and it is the most important test here.
- A book with `regulator` in every company's `coverage.failed`:
  `value_behind_failed_source.regulator` equals the whole book.
- An empty book: `largest_counterparty` is null, every total is 0, the schema
  still validates, and the headline is still a non-empty sentence.
- A lookup-only company: counted in `counterparties.lookup_only`, contributes 0.
- The headline passes `findForbidden()` and omits zero-figure sentences.
- Every returned value `bookExposureSchema.parse()`s.

Plus: `npx vitest run` shows **no new failures**, and
`npx tsc -b packages/logic packages/store` is clean.

**Two things about this repo's checks that will otherwise waste your time.**
There is no root `tsconfig.json`, so a bare `npx tsc -b` fails on a missing
config and tells you nothing -- typecheck the packages you touched, by name.
And `packages/contracts/src/conformance.test.ts` reads
`/Users/adarshc/Desktop/donna-collectors` by ABSOLUTE PATH, so the cross-repo
drift tests only pass on a machine with that sibling checkout. On any other
machine they fail and the suite reads ~436 rather than ~466. **Those failures
are pre-existing and not yours** -- do not try to fix them and do not let them
stop you committing. Compare against the count you saw before your change, not
against a number in this brief.

---

## 6. What not to do

- Do not add a field to `bookExposureSchema`. If you believe one is missing, say
  so rather than adding it — the shape is a contract two other tracks compile
  against.
- Do not sum, average or normalise `exposure_weight` anywhere.
- Do not call `Date.now()`; `today` is injected so tests are deterministic.
- Do not import `@donna/store` from `logic`, or the rollup stops being pure.
- Do not touch the narrator, the validator's existing files, or any collector.
