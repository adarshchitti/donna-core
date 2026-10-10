import {
  SOURCE_TRUST, signalId,
  type Company, type Evidence, type Item, type Signal, type Snapshot,
} from '@donna/contracts';
import { loadRules, type Rules } from './rules.js';
import { resolveConfidence } from './trust.js';
import { toDateOnly } from './dates.js';

/**
 * First run / baseline mode.
 *
 * On a first run the differ has nothing to compare against, so it emits no
 * changes -- but the narrator still has to write a profile, and every sentence
 * in this product must cite a signal with evidence behind it. So the baseline
 * snapshots themselves become signals: tier 0, status 'baseline', never
 * alerting, but citable. Same citation rule, same evidence page.
 */

export interface BaselineInput {
  book_id: string;
  company: Company;
  /** The first-run snapshots. Sources with no items contribute nothing. */
  snapshots: readonly Snapshot[];
  rules?: Rules;
}

export interface BaselineResult {
  signals: Signal[];
  items_by_signal: Record<string, Item[]>;
}

/**
 * One baseline signal per company, with one evidence entry per source that
 * returned anything. One signal rather than one per source, because the
 * profile cites "what we know about this company", not eight separate facts.
 */
export const baselineSignals = (input: BaselineInput): BaselineResult => {
  const rules = input.rules ?? loadRules();
  const order = rules.baseline.preferred_source_order;

  const usable = input.snapshots
    .filter((s) => s.company_id === input.company.company_id && s.items.length > 0)
    .slice()
    .sort((a, b) => {
      const ai = order.indexOf(a.source);
      const bi = order.indexOf(b.source);
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
    });

  if (usable.length === 0) return { signals: [], items_by_signal: {} };

  const evidence: Evidence[] = usable.map((s) => ({
    snapshot_id: s.snapshot_id,
    source: s.source,
    trust: SOURCE_TRUST[s.source],
    excerpt: s.raw_excerpt,
    url: s.source_url,
  }));

  const firstSeen = usable
    .map((s) => toDateOnly(s.fetched_at))
    .reduce((earliest, d) => (d < earliest ? d : earliest));

  // The most trusted baseline record states the fact, verbatim. We do not
  // paraphrase a registry extract in baseline mode -- there is nothing to add.
  const lead = usable[0]!;
  const type = rules.baseline.type;

  const signal: Signal = {
    book_id: input.book_id,
    signal_id: signalId(input.company.company_id, type, firstSeen),
    company_id: input.company.company_id,
    type,
    title: rules.baseline.title,
    tier: rules.baseline.tier,
    confidence: resolveConfidence(evidence),
    status: 'baseline',
    evidence,
    first_seen: firstSeen,
    summary_fact: lead.raw_excerpt.trim() !== ''
      ? lead.raw_excerpt
      : `Baseline record on file for ${input.company.canonical_name} as at ${firstSeen}.`,
    touches_terms: [],
  };

  return {
    signals: [signal],
    items_by_signal: { [signal.signal_id]: usable.flatMap((s) => s.items) },
  };
};
