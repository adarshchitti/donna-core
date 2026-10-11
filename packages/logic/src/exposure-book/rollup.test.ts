import { describe, it, expect } from 'vitest';
import {
  bookExposureSchema, NOT_COVERED_CATEGORIES,
  type Cluster, type Company, type Coverage, type Deal, type Source,
} from '@donna/contracts';
import { loadRules } from '../validator/rules.js';
import { findForbidden } from '../narrator/forbidden.js';
import { bookExposure, formatUsdShort } from './rollup.js';

const BOOK = 'book-rollup';
const TODAY = '2026-10-10T09:00:00Z';
const rules = loadRules();
const N = rules.exposure.notice_window_days;

const coverage = (checked: Source[], failed: Source[] = []): Coverage => ({
  checked, failed, not_covered: [...NOT_COVERED_CATEGORIES],
});

const company = (id: string, over: Partial<Company> = {}): Company => ({
  book_id: BOOK,
  company_id: id,
  canonical_name: `${id.toUpperCase()} Holdings LLC`,
  jurisdiction: 'US',
  registry_id: `OH-${id}`,
  registry_key: `OH-${id}`,
  aliases: [],
  domains: [],
  officers: [],
  related_entities: [],
  resolution: { confidence: 0.98, reason: 'Test fixture.', resolved_by: 'test', candidates_seen: [] },
  monitoring_since: '2026-01-01',
  ...over,
});

/** Every optional intake field blank unless a test says otherwise. */
const deal = (id: string, companyId: string | undefined, value: number, over: Partial<Deal> = {}): Deal => ({
  deal_id: id,
  ...(companyId === undefined ? {} : { company_id: companyId }),
  counterparty_name: `${companyId ?? 'unlinked'} counterparty`,
  country: 'US',
  deal_class: 'they_pay_us',
  annual_value_usd: value,
  start_date: '2025-01-01',
  end_date: '2027-12-31',
  status: companyId === undefined ? 'unresolved' : 'resolved',
  ...over,
});

const cluster = (companyId: string, topTier: Cluster['top_tier']): Cluster => ({
  book_id: BOOK,
  cluster_id: `cl-${companyId}`,
  company_id: companyId,
  mode: 'briefing',
  window: { from: '2026-09-26', to: '2026-10-10' },
  top_tier: topTier,
  verify_with_counterparty: false,
  signals: [`sig-${companyId}`],
  deals: [],
  exposure: { top_weight: 0, annual_value_usd: 0 },
  coverage: coverage(['registry']),
  fingerprint: `fp-${companyId}`,
});

/** All three optional exposure fields given, so exposure_known is true. */
const described = { share_pct: 10, substitutability: 'quarter', notice_days: 30 } as const;

const NOT_COVERED_SENTENCE = 'Not covered for any counterparty: private financials, payment behaviour, '
  + 'relationship sentiment, related-entity monitoring.';

describe('formatUsdShort', () => {
  it.each([
    [4_200_000, '$4.2M'], [820_000, '$820K'], [1_400_000, '$1.4M'], [1_000_000, '$1M'],
    [2_250_000, '$2.3M'], [999_499, '$999K'], [999_600, '$1M'], [950, '$950'], [0, '$0'],
    [999.6, '$1K'], [999_960_000, '$1B'], [2_500_000_000, '$2.5B'], [-50_000, '-$50K'],
  ])('%d -> %s', (usd, expected) => {
    expect(formatUsdShort(usd)).toBe(expected);
  });
});

describe('bookExposure: a hand-built book, every line', () => {
  // Five companies, seven deals. TODAY is 2026-10-10 and N is 90.
  //
  //   co   tier      monitored  coverage.failed      deals
  //   a    1         yes        regulator, layoffs   d1 800,000 they_pay_us hard  share 14 notice 60 ends 2027-01-31 (r = 113-60 = 53, closing)
  //                                                  d2 200,000 we_pay_them  nothing described (unknown)
  //   b    2         yes        regulator            d3 500,000 they_pay_us described, far out
  //                                                  d4 150,000 tied        notice 90 ends 2026-11-30 (r = 51-90 = -39, already SHUT)
  //   c    none      yes        --                   d5 300,000 we_pay_them hard, nothing else (unknown)
  //   d    0 (lookup) no, lookup court               (no deals)
  //   e    3         yes        --                   d6 250,000 they_pay_us described, far out
  //   --   --        --         --                   d7  50,000 they_pay_us unlinked, nothing described (unknown)
  const companies = [
    company('a', { coverage: coverage(['registry', 'court', 'news', 'executives'], ['regulator', 'layoffs']) }),
    company('b', { coverage: coverage(['registry', 'court', 'jobs', 'domain'], ['regulator']) }),
    company('c'),
    company('d', {
      monitoring_since: undefined,
      lookup: { requested_at: '2026-10-01T10:00:00Z', requested_by: 'analyst@x.invalid', watch_until: null },
      coverage: coverage(['registry'], ['court']),
    }),
    company('e', { coverage: coverage(['registry']) }),
  ];
  const deals = [
    deal('d1', 'a', 800_000, { share_pct: 14, substitutability: 'hard', notice_days: 60, end_date: '2027-01-31' }),
    deal('d2', 'a', 200_000, { deal_class: 'we_pay_them', end_date: '2028-06-30' }),
    deal('d3', 'b', 500_000, { ...described }),
    deal('d4', 'b', 150_000, { deal_class: 'tied', share_pct: 5, substitutability: 'week', notice_days: 90, end_date: '2026-11-30' }),
    deal('d5', 'c', 300_000, { deal_class: 'we_pay_them', substitutability: 'hard' }),
    deal('d6', 'e', 250_000, { share_pct: 20, substitutability: 'week', notice_days: 30, end_date: '2027-08-31' }),
    deal('d7', undefined, 50_000, { end_date: '2027-06-30' }),
  ];
  const clusters = [cluster('a', 1), cluster('b', 2), cluster('d', 0), cluster('e', 3)];
  const out = bookExposure(companies, deals, clusters, TODAY, rules);

  it('validates against the contract', () => {
    expect(() => bookExposureSchema.parse(out)).not.toThrow();
    expect(out.book_id).toBe(BOOK);
    expect(out.as_of).toBe(TODAY);
  });

  it('counts counterparties', () => {
    expect(out.counterparties).toEqual({ total: 5, monitored: 4, lookup_only: 1 });
  });

  it('sums contracted value by deal class, tied on its own line', () => {
    expect(out.contracted_value_usd).toEqual({
      total: 2_250_000, // 800 + 200 + 500 + 150 + 300 + 250 + 50 (thousand)
      they_pay_us: 1_600_000, // d1 + d3 + d6 + d7
      we_pay_them: 500_000, // d2 + d5
      tied: 150_000, // d4
    });
  });

  it('groups value by cluster top tier, and the four lines add to the total', () => {
    expect(out.value_by_top_tier).toEqual({
      tier1: 1_000_000, // a: d1 + d2
      tier2: 650_000, // b: d3 + d4
      tier3: 250_000, // e: d6
      none: 350_000, // c (no cluster): d5, plus unlinked d7; d (tier-0 cluster) has no deals
    });
    const t = out.value_by_top_tier;
    expect(t.tier1 + t.tier2 + t.tier3 + t.none).toBe(out.contracted_value_usd.total);
  });

  it('counts closing AND already-shut notice windows, and carries the threshold', () => {
    expect(out.value_notice_window_closing).toBe(950_000); // d1 (53 days left) + d4 (shut 39 days ago)
    expect(out.notice_window_days).toBe(N);
  });

  it('sums hard-to-replace value', () => {
    expect(out.value_hard_to_replace).toBe(1_100_000); // d1 + d5
  });

  it('names the largest counterparty as a share of the book', () => {
    expect(out.largest_counterparty).toEqual({
      company_id: 'a',
      canonical_name: 'A Holdings LLC',
      annual_value_usd: 1_000_000,
      share_of_book_pct: 44.44, // 1,000,000 / 2,250,000
      share_pct: 14, // the user's own field on d1
    });
  });

  it('carries the understatement up to the book', () => {
    expect(out.value_exposure_unknown).toBe(550_000); // d2 + d5 + d7
    expect(out.companies_exposure_unknown).toBe(2); // a and c; d7 has no company
  });

  it('puts money behind each failed source, by name, omitting sources with nothing behind them', () => {
    expect(out.value_behind_failed_source).toEqual({
      regulator: 1_650_000, // a + b
      layoffs: 1_000_000, // a
      // court failed only for d, a lookup with no deals: not a line.
    });
  });

  it('carries not_covered verbatim', () => {
    expect(out.not_covered).toEqual([...NOT_COVERED_CATEGORIES]);
  });

  it('assembles the headline from the figures', () => {
    expect(out.headline).toBe(
      '$2.3M contracted across 4 counterparties, watched on 6 of 8 sources. '
      + '$1M sits behind a tier-1 signal awaiting a human call. '
      + '$550K is incompletely described at intake, so its exposure is unknown rather than low. '
      + NOT_COVERED_SENTENCE,
    );
    expect(findForbidden(out.headline)).toEqual([]);
  });

  it('has no score, rating or weight anywhere in the returned value', () => {
    const keys = (v: unknown): string[] => (v && typeof v === 'object'
      ? Object.entries(v).flatMap(([k, inner]) => [k, ...keys(inner)])
      : []);
    for (const k of keys(out)) expect(k).not.toMatch(/score|rating|weight/i);
  });
});

describe('bookExposure: Rule B, a book with every optional field blank', () => {
  it('reads as wholly unknown, never as low', () => {
    const companies = [company('a'), company('b'), company('c')];
    const deals = [
      deal('d1', 'a', 400_000), deal('d2', 'a', 100_000),
      deal('d3', 'b', 250_000, { deal_class: 'we_pay_them' }),
      deal('d4', 'c', 75_000, { substitutability: '' }),
    ];
    const out = bookExposure(companies, deals, [], TODAY, rules);
    expect(out.contracted_value_usd.total).toBe(825_000);
    expect(out.value_exposure_unknown).toBe(out.contracted_value_usd.total);
    expect(out.companies_exposure_unknown).toBe(companies.length);
    expect(out.headline).toContain('$825K is incompletely described at intake');
    bookExposureSchema.parse(out);
  });
});

describe('bookExposure: Rule C, coverage is money', () => {
  it('regulator failed everywhere puts the whole book behind it', () => {
    const companies = ['a', 'b', 'c'].map((id) => company(id, {
      coverage: coverage(['registry', 'court'], ['regulator']),
    }));
    const deals = [deal('d1', 'a', 300_000), deal('d2', 'b', 200_000), deal('d3', 'c', 500_000)];
    const out = bookExposure(companies, deals, [], TODAY, rules);
    expect(out.value_behind_failed_source.regulator).toBe(out.contracted_value_usd.total);
    expect(out.value_behind_failed_source.regulator).toBe(1_000_000);
    bookExposureSchema.parse(out);
  });
});

describe('bookExposure: the empty book', () => {
  const out = bookExposure([], [], [], TODAY, rules, BOOK);

  it('has no largest counterparty and every total is zero', () => {
    expect(out.largest_counterparty).toBeNull();
    expect(out.counterparties).toEqual({ total: 0, monitored: 0, lookup_only: 0 });
    expect(out.contracted_value_usd).toEqual({ total: 0, they_pay_us: 0, we_pay_them: 0, tied: 0 });
    expect(out.value_by_top_tier).toEqual({ tier1: 0, tier2: 0, tier3: 0, none: 0 });
    expect(out.value_notice_window_closing).toBe(0);
    expect(out.value_hard_to_replace).toBe(0);
    expect(out.value_exposure_unknown).toBe(0);
    expect(out.companies_exposure_unknown).toBe(0);
    expect(out.value_behind_failed_source).toEqual({});
  });

  it('still validates and still says what is not covered', () => {
    expect(() => bookExposureSchema.parse(out)).not.toThrow();
    expect(out.headline).toBe(NOT_COVERED_SENTENCE);
  });

  it('needs an explicit book id, having no record to read one from', () => {
    expect(() => bookExposure([], [], [], TODAY, rules)).toThrow(/explicit bookId/);
  });
});

describe('bookExposure: edges', () => {
  it('a lookup-only company is counted and contributes nothing', () => {
    const looked = company('p', {
      monitoring_since: undefined,
      lookup: { requested_at: '2026-10-01T10:00:00Z', requested_by: 'analyst@x.invalid', watch_until: '2026-11-30' },
      coverage: coverage(['registry'], ['regulator']),
    });
    const out = bookExposure([looked], [], [cluster('p', 1)], TODAY, rules);
    expect(out.counterparties).toEqual({ total: 1, monitored: 0, lookup_only: 1 });
    expect(out.contracted_value_usd.total).toBe(0);
    expect(out.value_by_top_tier).toEqual({ tier1: 0, tier2: 0, tier3: 0, none: 0 });
    expect(out.value_behind_failed_source).toEqual({});
    expect(out.largest_counterparty).toBeNull();
    bookExposureSchema.parse(out);
  });

  it('a looked-up company that then signed is monitored, not lookup-only', () => {
    const signed = company('p', {
      lookup: { requested_at: '2026-10-01T10:00:00Z', requested_by: 'analyst@x.invalid', watch_until: null },
    });
    expect(bookExposure([signed], [], [], TODAY, rules).counterparties)
      .toEqual({ total: 1, monitored: 1, lookup_only: 0 });
  });

  it('a tier-0 cluster puts its company in none', () => {
    const out = bookExposure([company('a')], [deal('d1', 'a', 100_000)], [cluster('a', 0)], TODAY, rules);
    expect(out.value_by_top_tier).toEqual({ tier1: 0, tier2: 0, tier3: 0, none: 100_000 });
  });

  it('the notice window is inclusive at N and open to already-shut windows', () => {
    // 2027-02-07 is 120 days after TODAY.
    const at = (id: string, notice: number) => deal(id, 'a', 1_000, { notice_days: notice, end_date: '2027-02-07' });
    const deals = [at('exactly-n', 120 - N), at('n-plus-one', 120 - N - 1), at('shut', 200)];
    const out = bookExposure([company('a')], deals, [], TODAY, rules);
    expect(out.value_notice_window_closing).toBe(2_000); // exactly-n + shut
  });

  it('omits zero-figure sentences and passes the language gate', () => {
    const out = bookExposure(
      [company('a', { coverage: coverage(['registry', 'court']) })],
      [deal('d1', 'a', 820_000, { ...described })],
      [cluster('a', 2)],
      TODAY, rules,
    );
    expect(out.headline).toBe(
      `$820K contracted across 1 counterparty, watched on 2 of 8 sources. ${NOT_COVERED_SENTENCE}`,
    );
    expect(out.headline).not.toMatch(/tier-1|unknown/);
    expect(findForbidden(out.headline)).toEqual([]);
  });

  it('refuses records from more than one book', () => {
    expect(() => bookExposure([company('a'), company('b', { book_id: 'someone-else' })], [], [], TODAY, rules))
      .toThrow(/more than one book/);
  });
});
