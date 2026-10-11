# Devin brief B — pre-deal lookup, and the bounded negotiation watch

You are adding **one orchestrator entry point, one promote step, one loop
branch and one CLI** to `donna-core`. You add no collector, no screen, and no
new source.

Today the pipeline can only be entered through a `deals` row with
`status: unresolved`. That means the product arrives **one signature too late**:
the moment a user most wants a counterparty profile is *before* they sign,
while there is still a choice. This brief closes that.

---

## 1. Most of this is already built. Do not rebuild it.

Three things are already true, verified in the code. Use them.

| Already there | Where |
|---|---|
| The narrator's `profile` mode already ends with a section titled **"What to ask before signing"** — pre-deal use was designed in from the start | `packages/logic/src/narrator/prompt.ts:10` (`PROFILE_SECTION_TITLES`) |
| The validator **already surfaces everything when exposure is unknown**: `exposureKnown = false` bypasses the tier-2 gate, because suppressing a lawsuit for want of a typed percentage is the same false reassurance the product refuses. A company with no deal is exposure-unknown *by definition*, so this path is already correct — **change nothing in the validator** | `packages/logic/src/validator/cluster.ts:57` (`surfaces()`) |
| `companies.monitoring_since` is optional, and `companies.lookup` now exists | `packages/contracts/src/schemas.ts` (commit `204c204`) |

Also already landed for you: `schedule.expires_at`, nullable with
`default(null)`. A schedule written before the field existed reads back as
null, so `dueSchedules()` needs no special case for old documents.

---

## 2. `runLookup` — new file `packages/orchestrator/src/lookup.ts`

```ts
runLookup(
  input: { name: string; country: string; requestedBy: string; watchUntil?: string | null },
  deps: LookupDeps,
): Promise<LookupOutcome>
```

In order:

1. **Resolve** through the existing resolution component (`resolution.ts`:
   `outcomeFor`, `Judge`, `CONFIDENCE_THRESHOLD`). Follow what
   `resolve-pending.ts` already does, including its two hard-won rules:
   - Below the confidence threshold, **park rather than guess.** A wrong match
     in diligence is worse than no answer: we would hand the user a profile of
     a different company at the exact moment they are deciding whether to sign.
   - **An unreachable registry is not an absent company.** A search that could
     not run reports *could not look*, naming the error — never `no_match`,
     which implies we looked.
2. **Upsert the company** by `registry_id` (the store's existing key), writing
   `lookup: {requested_at, requested_by, watch_until}` and **no
   `monitoring_since`**.
3. **Run one batch** through the existing
   `runBatch(companyId, sources, batch, deps)` in `run-batch.ts`. All eight
   sources, one pass. Nothing about collection changes.
4. **Write no schedules** unless `watchUntil` is set (see §3). Note `runBatch`
   calls `store.pushSchedule()` after each job; with no schedule document that
   returns false and is already a no-op — **verify that, do not assume it.**
5. The batch is a first run, so the differ emits nothing, the validator produces
   `status: 'baseline'` signals, and the narrator runs in **`profile`** mode.
   All existing paths. **Assert it loudly** rather than trusting it, the way
   `scripts/onboard-book.ts` already asserts its own baselines.

Returns the company id, the resolution outcome, the per-source run statuses,
the profile briefing id, coverage, and credits spent.

There is no exposure framing anywhere in the output, because there is no deal.
`why_it_matters` has nothing to be about; the value is in the four profile
sections, and the fourth is the one the user came for.

---

## 3. Watch while we negotiate

Default is **one shot**: a lookup is a single onboarding pass and writes no
schedules. This is a credit rule, not a product preference — thirty companies
glanced at once would otherwise cost credits every day forever, against a
300-credit budget for the whole event.

When `watchUntil` is given (a date-only string), write one schedule per source
with `expires_at` set to that day. Negotiation runs for weeks, and a tier-1
signal landing mid-negotiation is arguably the most valuable thing this product
can surface.

In `packages/orchestrator/src/loop.ts`:

- `dueSchedules()` must **not** return an expired schedule. Prefer filtering in
  the store query beside the existing due logic rather than in the loop.
- The **reap** step disables expired schedules, so an expired watch stops being
  scanned instead of being filtered forever. The loop already reaps crashed
  runs; this is the same step doing one more thing.

**Its own quota.** A lookup is 8 fetches. Add a ceiling for lookups separate
from `DONNA_CREDIT_CEILING`, because one curious judge clicking lookup five
times would otherwise end the demo. Same-day repeats are already free through
the URL + UTC-day fetch cache.

---

## 4. `promoteToDeal(companyId, dealId)`

The reason the feature is more than a lookup button. Companies upsert by
`registry_id`, so a signed deal reuses the same company record:

- link the deal (the store's existing `linkDealToCompany`),
- set `monitoring_since`,
- create schedules with `expires_at: null`,
- **keep `lookup`** — both fields present is a real state, and it is what tells
  a reader this company was diligenced before it was signed.

The diligence snapshots are already the newest `ok` snapshot per
(company, source), so they become the monitoring baseline with no copying. Day
one of monitoring starts with history instead of a blank baseline. The money
spent looking becomes the thing later runs compare against.

---

## 5. `scripts/lookup.ts`

Match the house pattern in `scripts/measure-credits.ts` and
`scripts/onboard-book.ts` exactly:

```
npx vite-node scripts/lookup.ts --name "Acme Corp" --country US          # REPLAY default, 0 credits
npx vite-node scripts/lookup.ts --name "Acme Corp" --country US --live   # requires the lookup ceiling
npx vite-node scripts/lookup.ts --name "Acme Corp" --watch-until 2026-11-30
```

Replay is the default and spends nothing. `--live` refuses to run without the
ceiling set. Print per-source status, credits, the four profile sections, the
coverage block, and **whether any schedule was written** — that last line is
how a reader confirms the one-shot rule held.

---

## 6. What done looks like

- No schedules written without `--watch-until`. **This is the test that matters
  most**; assert on the store, not on a return value.
- A schedule with `expires_at` in the past never comes back from
  `dueSchedules()`, and the reaper disables it.
- A schedule with `expires_at` in the future is due normally.
- The first lookup run is asserted a **baseline**: no changes emitted, signals
  carry `status: 'baseline'`, briefing mode is `profile` with four sections.
- Resolution below threshold parks with candidates attached and runs **no**
  batch — we do not spend eight fetches on a company we could not identify.
- An unreachable registry reports *could not look*, not `no_match`.
- `promoteToDeal` preserves snapshots, sets `monitoring_since`, keeps `lookup`,
  and writes schedules with `expires_at: null`.
- The lookup ceiling blocks a run that would exceed it, before any fetch.
- `npx vitest run` green at **466 or more**; `npx tsc -b` clean.

---

## 7. What not to do

- **Do not touch `surfaces()` or anything else in the validator.** The no-deal
  path is already correct and already tested; changing it is how the tier-2 gate
  starts suppressing real findings.
- Do not add a `lookups` collection. A lookup is a `companies` document without
  `monitoring_since`. No new entity, no new index.
- Do not give a prospect the normal cadence. One shot, or a bounded watch.
- Do not write `monitoring_since` on a lookup. That field is what the rollup and
  the loop read to decide what is being watched.
- Do not call `Date.now()` in anything testable; inject the clock as the
  existing modules do.
- Do not touch any collector or `donna-collectors`.
