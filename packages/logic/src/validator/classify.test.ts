import { describe, it, expect } from 'vitest';
import { SOURCES, SOURCE_TRUST, type Source } from '@donna/contracts';
import { loadRules } from './rules.js';
import { classifyChange, matchRule } from './classify.js';
import { upsertSignals } from './corroborate.js';
import { BOOK, change, company } from './__fixtures.js';

const rules = loadRules();
const co = company();

/** A primary source, so these cases exercise classification and not the trust floor. */
const PRIMARY: Source = 'registry';

describe('1. every tier mapping in rules.json resolves', () => {
  const cases = rules.signal_types.flatMap((rule) =>
    rule.match.map((clause, i) => ({
      name: `${rule.type} [clause ${i}] -> tier ${rule.tier}`,
      rule,
      source: clause.sources?.[0] ?? PRIMARY,
      kind: clause.kinds?.[0] ?? ('added' as const),
      item_type: clause.item_types?.[0] ?? rule.type,
      // A clause that constrains an item field needs that field present.
      item: Object.fromEntries(
        Object.entries(clause.item_fields ?? {}).map(([k, v]) => [k, v[0]]),
      ),
    })),
  );

  it('the table has at least one clause per type', () => {
    expect(cases.length).toBeGreaterThanOrEqual(rules.signal_types.length);
  });

  for (const c of cases) {
    it(c.name, () => {
      const matched = matchRule(c.source, c.kind, c.item_type, rules, c.item);
      // First match wins, so a clause that resolves to a different rule means
      // two rules claim the same item type -- an ambiguous table, not a bug here.
      expect(matched.type).toBe(c.rule.type);
      expect(matched.tier).toBe(c.rule.tier);

      const classified = classifyChange(
        change({ source: c.source, kind: c.kind, item_type: c.item_type, item: c.item }),
        co,
        rules,
      );
      expect(classified.type).toBe(c.rule.type);
      expect(classified.base_tier).toBe(c.rule.tier);
      expect(classified.title.length).toBeGreaterThan(0);
      expect(classified.summary_fact.length).toBeGreaterThan(0);
    });
  }

  it('no item type is claimed by two rules', () => {
    const seen = new Map<string, string>();
    for (const rule of rules.signal_types) {
      for (const clause of rule.match) {
        for (const t of clause.item_types ?? []) {
          // Two rules may share an item type only if some other part of the
          // key separates them -- the kind, or a constrained item field.
          const key = `${t}|${(clause.kinds ?? []).join(',')}|${JSON.stringify(clause.item_fields ?? {})}`;
          expect(seen.has(key), `${t} claimed by ${seen.get(key)} and ${rule.type}`).toBe(false);
          seen.set(key, rule.type);
        }
      }
    }
  });

  it('an unknown item type falls back to the tier 0 rule', () => {
    const matched = matchRule('registry', 'added', 'something_nobody_mapped', rules);
    expect(matched.type).toBe(rules.fallback_signal_type.type);
    expect(matched.tier).toBe(0);
  });

  it('each source carries its contract trust onto the evidence', () => {
    for (const source of SOURCES) {
      const c = classifyChange(change({ source, item_type: 'filing' }), co, rules);
      expect(c.evidence.trust).toBe(SOURCE_TRUST[source]);
    }
  });
});

const tierOf = (source: Source, itemType: string, kind?: 'added' | 'removed' | 'altered') =>
  upsertSignals({
    book_id: BOOK,
    company: co,
    changes: [change({ source, item_type: itemType, ...(kind ? { kind } : {}) })],
    rules,
  }).signals[0]!;

describe('2. a reported source alone cannot reach tier 1 or 2', () => {
  const alerting = rules.signal_types.filter((r) => r.tier === 1 || r.tier === 2);

  for (const rule of alerting) {
    const itemType = rule.match[0]?.item_types?.[0] ?? rule.type;
    it(`${rule.type} (tier ${rule.tier}) from news alone is demoted to tier 3`, () => {
      const signal = tierOf('news', itemType);
      expect(signal.type).toBe(rule.type);
      // One reported source is a lead, not a finding.
      expect(signal.tier).toBe(3);
      expect(signal.confidence).toBe('medium');
      expect(signal.status).toBe('reported');
      expect(signal.summary_fact).toContain(rules.labels.reported_unconfirmed);
    });
  }

  it('two independent reported outlets may hold the rule tier', () => {
    const { signals } = upsertSignals({
      book_id: BOOK,
      company: co,
      changes: [
        change({ source: 'news', item_type: 'exec_departure', url: 'https://outlet-a.invalid/1' }),
        change({
          source: 'executives',
          item_type: 'exec_departure',
          url: 'https://outlet-b.invalid/2',
          snapshot_id: 'snap-nordvale-executives',
        }),
      ],
      rules,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.tier).toBe(2);
    // Still no primary record, so still medium and still unconfirmed.
    expect(signals[0]!.confidence).toBe('medium');
    expect(signals[0]!.status).toBe('reported');
  });

  it('the same outlet twice is still one outlet', () => {
    const { signals } = upsertSignals({
      book_id: BOOK,
      company: co,
      changes: [
        change({ source: 'news', item_type: 'litigation', url: 'https://outlet-a.invalid/1', summary: 'First write-up.' }),
        change({ source: 'news', item_type: 'litigation', url: 'https://outlet-a.invalid/1', summary: 'Follow-up write-up.' }),
      ],
      rules,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.tier).toBe(3);
  });

  it('a primary record alone may escalate', () => {
    const signal = tierOf('registry', 'change_of_control');
    expect(signal.tier).toBe(1);
    expect(signal.confidence).toBe('high');
    expect(signal.status).toBe('confirmed');
  });
});

describe('3. an inferred source never promotes a tier by itself', () => {
  const alerting = rules.signal_types.filter((r) => r.tier === 1 || r.tier === 2);

  for (const rule of alerting) {
    const itemType = rule.match[0]?.item_types?.[0] ?? rule.type;
    it(`${rule.type} seen only through jobs stays at tier 3`, () => {
      const signal = tierOf('jobs', itemType);
      expect(signal.tier).toBe(3);
      expect(signal.confidence).toBe('low');
      expect(signal.status).toBe('inferred');
    });
  }

  it('a tier 3 rule from an inferred source stays tier 3, low, inferred', () => {
    const signal = tierOf('jobs', 'job_postings');
    expect(signal.type).toBe('job_postings');
    expect(signal.tier).toBe(3);
    expect(signal.confidence).toBe('low');
    expect(signal.status).toBe('inferred');
  });

  it('inferred evidence added to a reported-only signal does not lift it', () => {
    const { signals } = upsertSignals({
      book_id: BOOK,
      company: co,
      changes: [
        change({ source: 'news', item_type: 'layoff', url: 'https://outlet-a.invalid/1' }),
        change({ source: 'jobs', item_type: 'layoff', url: 'https://jobs.invalid/1', snapshot_id: 'snap-nordvale-jobs' }),
      ],
      rules,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence).toHaveLength(2);
    expect(signals[0]!.tier).toBe(3);
  });
});

/**
 * The item types the collectors and the differ actually emit, as opposed to
 * the signal-shaped types Track C's own change fixtures use. Both vocabularies
 * reach the validator, so the table has to cover both; this is the one that
 * breaks silently if the table and the collectors drift apart.
 */
describe('the collectors\' own item vocabulary classifies', () => {
  const cases: {
    source: Source;
    kind: 'added' | 'removed' | 'altered';
    item_type: string;
    item?: Record<string, unknown>;
    type: string;
    tier: number;
  }[] = [
    { source: 'registry', kind: 'altered', item_type: 'status', type: 'registry_status_inactive', tier: 1 },
    { source: 'registry', kind: 'removed', item_type: 'officer', type: 'exec_departure', tier: 2 },
    { source: 'registry', kind: 'added', item_type: 'officer', type: 'routine_filing', tier: 0 },
    { source: 'registry', kind: 'added', item_type: 'filing', type: 'routine_filing', tier: 0 },
    { source: 'registry', kind: 'altered', item_type: 'address', type: 'address_update', tier: 0 },
    { source: 'court', kind: 'added', item_type: 'case', type: 'litigation', tier: 2 },
    { source: 'regulator', kind: 'altered', item_type: 'licence', type: 'licence_lapse', tier: 2 },
    { source: 'layoffs', kind: 'added', item_type: 'warn_notice', type: 'layoff', tier: 2 },
    {
      source: 'executives', kind: 'added', item_type: 'exec_move',
      item: { direction: 'departed' }, type: 'exec_departure', tier: 2,
    },
    {
      source: 'executives', kind: 'added', item_type: 'exec_move',
      item: { direction: 'appointed' }, type: 'exec_appointment', tier: 0,
    },
    { source: 'news', kind: 'added', item_type: 'article', type: 'passing_mention', tier: 0 },
    { source: 'jobs', kind: 'altered', item_type: 'job_count', type: 'job_postings', tier: 3 },
    { source: 'jobs', kind: 'removed', item_type: 'job_title', type: 'job_postings', tier: 3 },
    { source: 'domain', kind: 'altered', item_type: 'homepage', type: 'domain_change', tier: 3 },
    { source: 'domain', kind: 'altered', item_type: 'whois_field', type: 'domain_change', tier: 3 },
  ];

  for (const c of cases) {
    it(`${c.source}/${c.kind}/${c.item_type}${c.item ? ` ${JSON.stringify(c.item)}` : ''} -> ${c.type} (tier ${c.tier})`, () => {
      const classified = classifyChange(
        change({ source: c.source, kind: c.kind, item_type: c.item_type, ...(c.item ? { item: c.item } : {}) }),
        co,
        rules,
      );
      expect(classified.type).toBe(c.type);
      expect(classified.base_tier).toBe(c.tier);
    });
  }

  it('an officer appointment is never titled as a departure', () => {
    const appointment = classifyChange(
      change({ source: 'executives', item_type: 'exec_move', item: { direction: 'appointed' } }),
      co,
      rules,
    );
    expect(appointment.title.toLowerCase()).not.toContain('departure');
    expect(appointment.base_tier).toBe(0);
  });
});
