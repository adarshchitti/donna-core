import {
  signalSchema, utcDay,
  type Change, type Cluster, type Company, type Coverage, type Deal,
  type Signal, type Snapshot,
} from '@donna/contracts';
import { loadRules, type Rules } from './rules.js';
import { upsertSignals } from './corroborate.js';
import { baselineSignals } from './baseline.js';
import { companyExposure, type CompanyExposure } from './exposure.js';
import { buildCluster, EMPTY_COVERAGE } from './cluster.js';
import { daysApart } from './dates.js';

/**
 * The validator, end to end, for ONE company on ONE day.
 *
 * In: that company's changes for the day, its Company record, every Deal
 * linked to it, and whatever signals are already on file.
 * Out: zero or one Cluster, plus the Signal[] it references.
 *
 * No I/O. The caller reads and writes; this returns values. That is what makes
 * every rule here testable in a few lines and tunable through rules.json.
 */

export interface ValidateInput {
  book_id: string;
  company: Company;
  /** Every deal linked to this company. Unlinked deals must not be passed. */
  deals?: readonly Deal[];
  /** The day's changes from the differ. Empty on a first run. */
  changes?: readonly Change[];
  /** Signals already on file for this company, ideally the last 14 days. */
  existing_signals?: readonly Signal[];
  /** First-run snapshots. Used only when there are no changes and no signals. */
  baseline_snapshots?: readonly Snapshot[];
  /** Travels unchanged from the orchestrator onto the cluster. */
  coverage?: Coverage;
  /** UTC day, YYYY-MM-DD. Defaults to today. */
  today?: string;
  rules?: Rules;
}

export interface ValidateResult {
  /** Every signal on file after this run, including tier 0 ones that never alert. */
  signals: Signal[];
  /** The signals the cluster references, in cluster order. */
  cluster_signals: Signal[];
  cluster: Cluster | null;
  mode: Cluster['mode'];
  exposure: CompanyExposure;
  promoted_by_pattern: boolean;
}

export const validate = (input: ValidateInput): ValidateResult => {
  const rules = input.rules ?? loadRules();
  const today = input.today ?? utcDay();
  const deals = (input.deals ?? []).filter(
    (d) => d.company_id === undefined || d.company_id === input.company.company_id,
  );
  const changes = (input.changes ?? []).filter(
    (c) => c.company_id === input.company.company_id,
  );
  const existing = (input.existing_signals ?? []).filter(
    (s) => s.company_id === input.company.company_id && s.book_id === input.book_id,
  );

  const exposure = companyExposure(deals, today, rules);

  // Baseline mode: the differ found nothing to compare, so the profile is
  // written from the snapshots themselves.
  const firstRun = changes.length === 0 && existing.length === 0
    && (input.baseline_snapshots?.length ?? 0) > 0;

  const upserted = firstRun
    ? baselineSignals({
      book_id: input.book_id,
      company: input.company,
      snapshots: input.baseline_snapshots ?? [],
      rules,
    })
    : upsertSignals({
      book_id: input.book_id,
      company: input.company,
      changes,
      existing,
      deals,
      rules,
    });

  // Every emitted signal goes through its own contract before it leaves here.
  // A signal that fails the schema renders as a blank panel in the UI rather
  // than an error, so it must fail loudly at the boundary instead.
  const signals = upserted.signals.map((s) => signalSchema.parse(s));

  const mode: Cluster['mode'] = firstRun ? 'profile' : 'briefing';

  // The rolling window: only signals first seen within it cluster together.
  const inWindow = signals.filter(
    (s) => daysApart(s.first_seen, today) <= rules.corroboration_window_days,
  );

  const built = buildCluster({
    book_id: input.book_id,
    company_id: input.company.company_id,
    mode,
    signals: inWindow,
    exposure,
    coverage: input.coverage ?? EMPTY_COVERAGE,
    today,
    rules,
  });

  const byId = new Map(signals.map((s) => [s.signal_id, s]));
  const clusterSignals = (built.cluster?.signals ?? [])
    .map((id) => byId.get(id))
    .filter((s): s is Signal => s !== undefined);

  return {
    signals,
    cluster_signals: clusterSignals,
    cluster: built.cluster,
    mode,
    exposure,
    promoted_by_pattern: built.promoted_by_pattern,
  };
};
