import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { loadRules } from './rules.js';
import { companyExposure, exposureFor, toClusterDeal } from './exposure.js';
import { matchWatchTerms, parseWatchTerms } from './watchTerms.js';
import { validate } from './validate.js';
import { BOOK, TODAY, bigDeal, change, company, deal } from './__fixtures.js';

const rules = loadRules();
const co = company();
const threshold = rules.thresholds.tier2_min_exposure_weight;

/** A tier 2 signal on a primary record, so only exposure can gate it. */
const execDeparture = change({ source: 'registry', kind: 'removed', item_type: 'officer' });
/** A tier 1 signal on a primary record. */
const ownershipChange = change({ source: 'registry', item_type: 'change_of_control' });

describe('5. the exposure threshold gates a tier 2 but never a tier 1', () => {
  it('a small deal keeps a tier 2 out of the cluster', () => {
    const small = deal({ annual_value_usd: 100_000 });
    expect(exposureFor(small, TODAY, rules).weight).toBeLessThan(threshold);

    const result = validate({
      book_id: BOOK, company: co, deals: [small], changes: [execDeparture], today: TODAY, rules,
    });
    // The signal is still stored -- it just does not surface.
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.tier).toBe(2);
    expect(result.cluster).toBeNull();
  });

  it('a large deal lets the same tier 2 through', () => {
    const big = bigDeal();
    expect(exposureFor(big, TODAY, rules).weight).toBeGreaterThanOrEqual(threshold);

    const result = validate({
      book_id: BOOK, company: co, deals: [big], changes: [execDeparture], today: TODAY, rules,
    });
    expect(result.cluster).not.toBeNull();
    expect(result.cluster!.signals).toEqual([result.signals[0]!.signal_id]);
    expect(result.cluster!.top_tier).toBe(2);
  });

  it('a tier 1 surfaces on the smallest deal, and with no deal at all', () => {
    const tiny = validate({
      book_id: BOOK,
      company: co,
      deals: [deal({ annual_value_usd: 1 })],
      changes: [ownershipChange],
      today: TODAY,
      rules,
    });
    expect(tiny.cluster!.top_tier).toBe(1);
    expect(tiny.cluster!.signals).toHaveLength(1);

    const none = validate({
      book_id: BOOK, company: co, deals: [], changes: [ownershipChange], today: TODAY, rules,
    });
    expect(none.exposure.top_weight).toBe(0);
    expect(none.cluster!.top_tier).toBe(1);
  });

  it('the cluster exposure is the top weight and the summed annual value', () => {
    const result = validate({
      book_id: BOOK,
      company: co,
      deals: [deal({ deal_id: 'a', annual_value_usd: 100_000 }), bigDeal({ deal_id: 'b' })],
      changes: [ownershipChange],
      today: TODAY,
      rules,
    });
    const weights = result.exposure.deals.map((d) => d.exposure_weight);
    expect(result.cluster!.exposure.top_weight).toBe(Math.max(...weights));
    expect(result.cluster!.exposure.annual_value_usd).toBe(2_100_000);
  });
});

describe('6. the weight is built from the fields the user gave us', () => {
  const base = deal({ annual_value_usd: 1_000_000 });

  it('value and share set the base', () => {
    // 0.5 * (1.0m / 2.0m cap) = 0.25, no share, notice window wide open.
    expect(exposureFor(base, TODAY, rules).weight).toBe(0.25);
    // + 0.3 * (25 / 50 cap) = 0.15
    expect(exposureFor(deal({ ...base, share_pct: 25 }), TODAY, rules).weight).toBe(0.4);
  });

  it('substitutability hard doubles the weight', () => {
    const plain = exposureFor(base, TODAY, rules);
    const hard = exposureFor(deal({ ...base, substitutability: 'hard' }), TODAY, rules);
    expect(plain.weight).toBe(0.25);
    expect(hard.weight).toBe(0.5);
    expect(hard.weight).toBe(plain.weight * rules.exposure.hard_substitutability_multiplier);
    expect(hard.parts.substitutability_multiplier).toBe(2);
  });

  it('a notice window under 90 days remaining adds to it', () => {
    // end_date 2026-12-10 is 61 days out, less the 90 day notice period: the
    // window has already shut, so the bonus applies.
    const tight = exposureFor(
      deal({ ...base, end_date: '2026-12-10', notice_days: 90 }), TODAY, rules,
    );
    expect(tight.notice_days_remaining).toBeLessThan(rules.exposure.notice_window_days);
    expect(tight.weight).toBe(0.4);
    expect(tight.parts.notice_bonus).toBe(rules.exposure.notice_window_bonus);
  });

  it('deal_class tied sets compliance_flag and does NOT change the weight', () => {
    const paid = exposureFor(deal({ ...base, deal_class: 'they_pay_us' }), TODAY, rules);
    const tied = exposureFor(deal({ ...base, deal_class: 'tied' }), TODAY, rules);
    expect(tied.weight).toBe(paid.weight);
    expect(tied.compliance_flag).toBe(true);
    expect(paid.compliance_flag).toBe(false);

    const cd = toClusterDeal(deal({ ...base, deal_class: 'tied' }), TODAY, rules);
    expect(cd.compliance_flag).toBe(true);
    expect(cd.class).toBe('tied');
    expect(cd.exposure_weight).toBe(paid.weight);
  });

  it('the weight is normalised to 0..1', () => {
    const huge = exposureFor(
      deal({ annual_value_usd: 500_000_000, share_pct: 100, substitutability: 'hard', notice_days: 400 }),
      TODAY,
      rules,
    );
    expect(huge.weight).toBeLessThanOrEqual(1);
    expect(huge.weight).toBeGreaterThanOrEqual(0);
    expect(companyExposure([deal()], TODAY, rules).top_weight).toBeLessThanOrEqual(1);
  });
});

describe('11. watch terms are touched, never breached', () => {
  const terms = 'key_person: Jane Doe, CFO; litigation_cap_usd: 500000; change_of_control';

  it('parses the three kinds', () => {
    const parsed = parseWatchTerms(terms);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ kind: 'key_person', person: 'Jane Doe', role: 'CFO' });
    expect(parsed[1]).toMatchObject({ kind: 'litigation_cap_usd', cap_usd: 500_000 });
    expect(parsed[2]).toMatchObject({ kind: 'change_of_control' });
  });

  it('a named key person\'s departure sets touches_terms', () => {
    const result = validate({
      book_id: BOOK,
      company: co,
      deals: [bigDeal({ watch_terms: terms })],
      changes: [change({
        source: 'registry',
        kind: 'removed',
        item_type: 'exec_departure',
        item: { name: 'Jane Doe', role: 'CFO' },
        summary: 'Jane Doe was removed from the registry officer list as Chief Financial Officer on 8 October 2026.',
      })],
      today: TODAY,
      rules,
    });
    expect(result.signals[0]!.touches_terms).toEqual(['key_person: Jane Doe, CFO']);
  });

  it('a different person\'s departure touches nothing', () => {
    const result = validate({
      book_id: BOOK,
      company: co,
      deals: [bigDeal({ watch_terms: terms })],
      changes: [change({
        source: 'registry',
        kind: 'removed',
        item_type: 'exec_departure',
        item: { name: 'John Smith', role: 'COO' },
        summary: 'John Smith was removed from the registry officer list.',
      })],
      today: TODAY,
      rules,
    });
    expect(result.signals[0]!.touches_terms).toEqual([]);
  });

  it('a claim over the cap touches the litigation term; one under it does not', () => {
    const run = (amount: number) => validate({
      book_id: BOOK,
      company: co,
      deals: [bigDeal({ watch_terms: terms })],
      changes: [change({
        source: 'court',
        item_type: 'case_filed',
        item: { claim_amount_usd: amount },
      })],
      today: TODAY,
      rules,
    }).signals[0]!.touches_terms;

    expect(run(750_000)).toEqual(['litigation_cap_usd: 500000']);
    expect(run(100_000)).toEqual([]);
  });

  it('an ownership change touches a change_of_control term', () => {
    const result = validate({
      book_id: BOOK,
      company: co,
      deals: [bigDeal({ watch_terms: terms })],
      changes: [ownershipChange],
      today: TODAY,
      rules,
    });
    expect(result.signals[0]!.touches_terms).toEqual(['change_of_control']);
  });

  it('matchWatchTerms is directly testable on a subject', () => {
    expect(matchWatchTerms(
      { type: 'exec_departure', items: [{ key: 'k', type: 'exec_departure', name: 'JANE DOE' }] },
      parseWatchTerms(terms),
      rules,
    )).toEqual(['key_person: Jane Doe, CFO']);
  });

  it('the word "breach" appears in no validator output', () => {
    const outputs = [
      validate({
        book_id: BOOK,
        company: co,
        deals: [bigDeal({ watch_terms: terms })],
        changes: [
          ownershipChange,
          change({ source: 'court', item_type: 'case_filed', item: { claim_amount_usd: 900_000 }, snapshot_id: 'snap-c' }),
          change({ source: 'news', item_type: 'layoff', snapshot_id: 'snap-n' }),
          change({ source: 'jobs', item_type: 'job_postings', snapshot_id: 'snap-j' }),
        ],
        today: TODAY,
        rules,
      }),
    ];
    for (const out of outputs) {
      expect(JSON.stringify(out).toLowerCase()).not.toContain('breach');
    }
  });

  it('the word "breach" appears nowhere in the validator source or rules table', () => {
    const dir = new URL('.', import.meta.url);
    for (const name of readdirSync(dir)) {
      // The tests themselves name the forbidden word in order to search for it.
      if (name.endsWith('.test.ts')) continue;
      const text = readFileSync(new URL(name, dir), 'utf8').toLowerCase();
      expect(text.includes('breach'), `${name} contains the word`).toBe(false);
    }
  });
});
