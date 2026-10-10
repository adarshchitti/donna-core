/**
 * The differ: two snapshots in, zero or more Change documents out.
 *
 * Pure and synchronous. No store, no clock, no network -- the caller supplies
 * `detectedAt` so a replayed run produces byte-identical output.
 */
import type { Change, Item, Snapshot } from '@donna/contracts';
import { indexItems, stateOf } from './sources.js';

export interface DiffOptions {
  /** book_id scopes EVERY document. A Change without it renders blank in Track C. */
  readonly bookId: string;
  /** Full ISO instant. The run's detection time, not the snapshot's fetch time. */
  readonly detectedAt: string;
}

export interface DiffResult {
  /** Empty is a normal, meaningful result. See `outcomeOf`. */
  readonly changes: Change[];
  /** True when there was nothing to compare against. See Rule 1 below. */
  readonly isFirstRun: boolean;
  /**
   * The items the next run should compare against: post-collapse, so a
   * syndicated story is stored once. Also the narrator's material for the
   * opening profile on a first run.
   */
  readonly baselineItems: Item[];
}

/**
 * The three outcomes, named.
 *
 * Rule 4: silence is a result. "No change observed across N sources since T"
 * is the system's most common and most useful sentence, and it is a different
 * statement from "we have only just started watching". Collapsing both to an
 * empty array would let a caller say "nothing changed" about a company it had
 * never looked at before.
 */
export type DiffOutcome = 'baseline' | 'unchanged' | 'changed';

export const outcomeOf = (result: DiffResult): DiffOutcome => {
  if (result.isFirstRun) return 'baseline';
  return result.changes.length === 0 ? 'unchanged' : 'changed';
};

/**
 * Compare `next` against `baseline` and report the change between them.
 *
 * ---------------------------------------------------------------------------
 * RULE 1 -- THE FIRST RUN IS A BASELINE AND NEVER AN ALERT.
 *
 * With no baseline, every item in `next` is new to us, so naive set difference
 * calls all of them `added`. That would be false in the way that matters most:
 * the company did not acquire four court cases and lay off 200 people the
 * moment we started watching -- we simply opened our eyes. Shipping those as
 * changes would make a customer's first briefing the loudest one they ever
 * receive, and every finding in it would be unfalsifiable, because there is no
 * prior state to point at as evidence of movement.
 *
 * So a first run returns `isFirstRun: true`, NO changes, and its items as the
 * starting state. The differ begins emitting changes on the second run, when
 * "before" exists and a claim of movement can be evidenced.
 * ---------------------------------------------------------------------------
 */
export function diffSnapshot(
  next: Snapshot,
  baseline: Snapshot | null,
  opts: DiffOptions,
): DiffResult {
  const nextItems = indexItems(next.source, next.items);

  if (baseline === null) {
    return { changes: [], isFirstRun: true, baselineItems: [...nextItems.values()] };
  }

  if (baseline.company_id !== next.company_id || baseline.source !== next.source) {
    // Diffing a company against another company, or a registry against a court
    // docket, would emit a wholesale removed/added pair that reads as a
    // catastrophe. Fail loudly instead; this can only be an orchestration bug.
    throw new Error(
      `diffSnapshot: baseline ${baseline.company_id}/${baseline.source} does not match ` +
        `next ${next.company_id}/${next.source}`,
    );
  }

  // Bound to a const so the null check above still narrows inside `emit`.
  const base = baseline;
  const baseItems = indexItems(base.source, base.items);
  const changes: Change[] = [];

  /**
   * `previous` is uniformly "the state recorded in the baseline, or null if
   * this record was not in the baseline". For a removal that is the same
   * record as `item` -- deliberately: `item` is always the record the change
   * is about, and a consumer never has to special-case which field to read.
   */
  const emit = (kind: Change['kind'], item: Item, previous: Item | null): void => {
    changes.push({
      book_id: opts.bookId,
      company_id: next.company_id,
      source: next.source,
      kind,
      item,
      previous,
      snapshot_id: next.snapshot_id,
      baseline_id: base.snapshot_id,
      detected_at: opts.detectedAt,
    });
  };

  // Walk the baseline first, so removals and alterations are reported in the
  // order the previous run observed them, then the genuinely new items in
  // arrival order. Deterministic output makes a diff of two diffs readable.
  for (const [id, previous] of baseItems) {
    const current = nextItems.get(id);
    if (current === undefined) {
      emit('removed', previous, previous);
    } else if (stateOf(next.source, current) !== stateOf(next.source, previous)) {
      // Identity carries `type`, so both sides resolve to the same rule and
      // this is always a like-for-like comparison of the same field list.
      emit('altered', current, previous);
    }
  }
  for (const [id, item] of nextItems) {
    if (!baseItems.has(id)) emit('added', item, null);
  }

  return { changes, isFirstRun: false, baselineItems: [...nextItems.values()] };
}
