import {
  SOURCE_LABELS, SOURCE_TRUST,
  type Change, type Company, type Evidence, type Item, type Source, type Trust,
} from '@donna/contracts';
import { loadRules, type MatchClause, type Rules, type SignalTypeRule } from './rules.js';
import { toDateOnly } from './dates.js';

/** Step 1 -- classify a change against the rules table and tier it. */

export interface Classified {
  rule: SignalTypeRule;
  type: string;
  /** The rule's FIXED tier, before the trust floor of step 2 is applied. */
  base_tier: SignalTypeRule['tier'];
  title: string;
  summary_fact: string;
  trust: Trust;
  evidence: Evidence;
  /** UTC day the change was detected -- the signal's first_seen candidate. */
  day: string;
  change: Change;
}

type Fields = Record<string, unknown>;

const matches = (
  clause: MatchClause,
  source: Source,
  kind: Change['kind'],
  itemType: string,
  fields: Fields,
): boolean => {
  if (clause.sources && !clause.sources.includes(source)) return false;
  if (clause.kinds && !clause.kinds.includes(kind)) return false;
  if (clause.item_types && !clause.item_types.includes(itemType)) return false;
  if (clause.item_fields) {
    for (const [field, allowed] of Object.entries(clause.item_fields)) {
      const value = fields[field];
      if (value === undefined || value === null) return false;
      const text = String(value).toLowerCase();
      if (!allowed.some((a) => a.toLowerCase() === text)) return false;
    }
  }
  // An all-empty clause matches nothing; otherwise `match: []` on the fallback
  // rule would swallow every change before the real rules were consulted.
  return Boolean(clause.sources ?? clause.kinds ?? clause.item_types ?? clause.item_fields);
};

/**
 * Match on (source, kind, item.type), plus an item field where the table asks
 * for one. First rule in the table wins, so the table's order is the
 * precedence order -- tier 1 rules are listed first.
 */
export const matchRule = (
  source: Source,
  kind: Change['kind'],
  itemType: string,
  rules: Rules = loadRules(),
  fields: Fields = {},
): SignalTypeRule =>
  rules.signal_types.find((r) => r.match.some((c) => matches(c, source, kind, itemType, fields)))
  ?? rules.fallback_signal_type;

const fill = (template: string, company: Company, source: Source, day: string): string =>
  template
    .replaceAll('{company}', company.canonical_name)
    .replaceAll('{source_label}', SOURCE_LABELS[source])
    .replaceAll('{date}', day);

/** A collector item may carry its own prose; prefer it, it is the observed fact. */
const itemText = (item: Item, key: string): string | undefined => {
  const v = (item as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
};

export const evidenceFromChange = (change: Change): Evidence => ({
  snapshot_id: change.snapshot_id,
  source: change.source,
  trust: SOURCE_TRUST[change.source],
  // Same text as snapshot.raw_excerpt under a different name. Do not normalize.
  excerpt: itemText(change.item, 'excerpt') ?? itemText(change.item, 'summary') ?? '',
  url: itemText(change.item, 'url') ?? itemText(change.item, 'source_url') ?? '',
});

export const classifyChange = (
  change: Change,
  company: Company,
  rules: Rules = loadRules(),
): Classified => {
  const rule = matchRule(
    change.source,
    change.kind,
    change.item.type,
    rules,
    change.item as Record<string, unknown>,
  );
  const day = toDateOnly(change.detected_at);
  return {
    rule,
    type: rule.type,
    base_tier: rule.tier,
    title: fill(rule.title, company, change.source, day),
    summary_fact: itemText(change.item, 'summary')
      ?? fill(rule.summary, company, change.source, day),
    trust: SOURCE_TRUST[change.source],
    evidence: evidenceFromChange(change),
    day,
    change,
  };
};
