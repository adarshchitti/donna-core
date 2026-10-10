import {
  signalId,
  type Change, type Company, type Deal, type Evidence, type Item, type Signal,
} from '@donna/contracts';
import { loadRules, type Rules, type SignalTypeRule } from './rules.js';
import { classifyChange, type Classified } from './classify.js';
import { TRUST_RANK, resolveConfidence, resolveStatus, resolveTier } from './trust.js';
import { daysApart } from './dates.js';
import { matchWatchTerms, parseDealWatchTerms, type WatchTerm } from './watchTerms.js';

/**
 * Step 3 -- corroboration.
 *
 * Changes about the same underlying fact, seen through different sources,
 * must become ONE signal with several evidence entries. The key is
 * (book_id, company_id, type, 14-day window) and it is COARSE ON PURPOSE:
 * a news story today and the court record five days later are the same event
 * to a human, and any cleverer key (entity extraction, text similarity) would
 * be a model we cannot explain to the person reading the briefing.
 *
 * This is a pure function. There is no database here -- callers pass the
 * existing signals in and get the upserted set back.
 */

export const ruleForType = (type: string, rules: Rules = loadRules()): SignalTypeRule =>
  rules.signal_types.find((r) => r.type === type) ?? rules.fallback_signal_type;

const evidenceKey = (e: Evidence): string => `${e.snapshot_id}|${e.url}|${e.excerpt}`;

const bestTrustRank = (evidence: readonly Evidence[]): number =>
  evidence.reduce((best, e) => Math.max(best, TRUST_RANK[e.trust]), -1);

/** The reported-and-unconfirmed label is appended, so it must be removable on promotion. */
const stripLabel = (text: string, label: string): string =>
  text.endsWith(label) ? text.slice(0, -label.length).trimEnd() : text;

const withLabel = (text: string, labelled: boolean, label: string): string =>
  labelled ? `${text} ${label}`.trim() : text;

export interface UpsertSignalsInput {
  book_id: string;
  company: Company;
  changes: readonly Change[];
  /** Signals already on file -- typically the last 14 days for this company. */
  existing?: readonly Signal[];
  /** Only used to resolve watch terms; exposure is a later step. */
  deals?: readonly Deal[];
  rules?: Rules;
}

/** Signals plus the raw items behind each, kept for watch-term matching. */
export interface UpsertSignalsResult {
  signals: Signal[];
  /** signal_id -> ids touched this run. Lets the caller tell new/updated from carried-over. */
  touched_ids: string[];
  items_by_signal: Record<string, Item[]>;
}

const recompute = (
  signal: Signal,
  rule: SignalTypeRule,
  rules: Rules,
  terms: readonly WatchTerm[],
  items: readonly Item[],
): Signal => {
  const baseline = signal.status === 'baseline' && signal.type === rules.baseline.type;
  const status = resolveStatus(signal.evidence, { baseline });
  const confidence = resolveConfidence(signal.evidence);
  const tier = baseline ? rules.baseline.tier : resolveTier(rule.tier, signal.evidence, rules);
  const label = rules.labels.reported_unconfirmed;
  const touched = matchWatchTerms({ type: signal.type, items }, terms, rules);
  return {
    ...signal,
    tier,
    confidence,
    status,
    summary_fact: withLabel(
      stripLabel(signal.summary_fact, label),
      status === 'reported',
      label,
    ),
    touches_terms: [...new Set([...signal.touches_terms, ...touched])],
  };
};

export const upsertSignals = (input: UpsertSignalsInput): UpsertSignalsResult => {
  const rules = input.rules ?? loadRules();
  const terms = parseDealWatchTerms(input.deals ?? []);
  const window = rules.corroboration_window_days;

  const working: Signal[] = (input.existing ?? []).map((s) => ({
    ...s,
    evidence: [...s.evidence],
    touches_terms: [...s.touches_terms],
  }));
  const items: Record<string, Item[]> = {};
  const touchedIds: string[] = [];
  const dirty = new Set<string>();

  // Oldest change first, so first_seen is the earliest observation and the
  // signal id minted from it stays stable as later evidence arrives.
  const classified: Classified[] = input.changes
    .filter((c) => c.company_id === input.company.company_id)
    .map((c) => classifyChange(c, input.company, rules))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  for (const c of classified) {
    const match = working.find(
      (s) =>
        s.book_id === input.book_id
        && s.company_id === c.change.company_id
        && s.type === c.type
        && daysApart(s.first_seen, c.day) <= window,
    );

    if (match) {
      const priorTrust = bestTrustRank(match.evidence);
      const key = evidenceKey(c.evidence);
      if (!match.evidence.some((e) => evidenceKey(e) === key)) {
        match.evidence = [...match.evidence, c.evidence];
      }
      // The strongest record states the fact. A registry removal outranks the
      // press release that reported it, so its wording wins.
      if (TRUST_RANK[c.evidence.trust] > priorTrust) {
        match.summary_fact = c.summary_fact;
        match.title = c.title;
      }
      if (c.day < match.first_seen) match.first_seen = c.day;
      (items[match.signal_id] ??= []).push(c.change.item);
      dirty.add(match.signal_id);
      continue;
    }

    const id = signalId(c.change.company_id, c.type, c.day);
    const fresh: Signal = {
      book_id: input.book_id,
      signal_id: id,
      company_id: c.change.company_id,
      type: c.type,
      title: c.title,
      tier: c.base_tier,
      confidence: 'low',
      status: 'inferred',
      evidence: [c.evidence],
      first_seen: c.day,
      summary_fact: c.summary_fact,
      touches_terms: [],
    };
    working.push(fresh);
    (items[id] ??= []).push(c.change.item);
    dirty.add(id);
  }

  const signals = working.map((s) => {
    if (!dirty.has(s.signal_id)) return s;
    touchedIds.push(s.signal_id);
    return recompute(s, ruleForType(s.type, rules), rules, terms, items[s.signal_id] ?? []);
  });

  return { signals, touched_ids: touchedIds, items_by_signal: items };
};
