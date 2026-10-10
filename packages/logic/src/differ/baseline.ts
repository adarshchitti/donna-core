/**
 * Rule 3 -- advancing the baseline.
 *
 * This module reports what the new baseline SHOULD be. It does not write it.
 * The differ has no store access by design: deciding and persisting are
 * separate jobs, and keeping the decision pure is what makes "which snapshot
 * did we compare against?" answerable after the fact from values alone.
 */
import type { Snapshot, Source } from '@donna/contracts';

/** What the next run should compare against, for one company+source. */
export interface BaselinePointer {
  readonly company_id: string;
  readonly source: Source;
  readonly snapshot_id: string;
  readonly fetched_at: string;
}

/**
 * ISO instants are compared as epoch millis, not as strings: '...:00Z' and
 * '...:00.000Z' are the same moment but sort differently as text, and picking
 * the wrong baseline silently re-reports last week's change as new.
 */
const instant = (iso: string): number => {
  const parsed = Date.parse(iso);
  // An unparseable instant must never win the "newest" contest.
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/**
 * The newest successful snapshot for one company+source, or null.
 *
 * Null is the signal the differ reads as "first run" -- a company whose every
 * fetch has failed has no baseline, and must not be told its world changed the
 * first time a fetch succeeds.
 */
export const latestOkSnapshot = (
  snapshots: readonly Snapshot[],
  companyId: string,
  source: Source,
): Snapshot | null => {
  let best: Snapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.company_id !== companyId || snapshot.source !== source) continue;
    // The Snapshot contract already pins `ok` to true; this guards callers who
    // hand us a looser shape, such as envelopes widened into snapshots.
    if (snapshot.ok !== true) continue;
    // Strictly-greater, so an exact tie keeps the first one seen and an ordered
    // input always produces the same answer.
    if (best === null || instant(snapshot.fetched_at) > instant(best.fetched_at)) {
      best = snapshot;
    }
  }
  return best;
};

/**
 * The full set of baseline pointers implied by a pile of snapshots: the newest
 * `ok` snapshot per company+source. Sorted by company then source so two runs
 * over the same data produce identical output.
 */
export const advanceBaselines = (snapshots: readonly Snapshot[]): BaselinePointer[] => {
  const best = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.ok !== true) continue;
    const key = `${snapshot.company_id}\u0000${snapshot.source}`;
    const held = best.get(key);
    if (held === undefined || instant(snapshot.fetched_at) > instant(held.fetched_at)) {
      best.set(key, snapshot);
    }
  }
  return [...best.values()]
    .map((snapshot) => ({
      company_id: snapshot.company_id,
      source: snapshot.source,
      snapshot_id: snapshot.snapshot_id,
      fetched_at: snapshot.fetched_at,
    }))
    .sort((a, b) =>
      a.company_id === b.company_id
        ? a.source.localeCompare(b.source)
        : a.company_id.localeCompare(b.company_id),
    );
};
