import { describe, it, expect } from 'vitest';
import { clusterSchema, signalSchema, type Signal } from '@donna/contracts';
import { loadRules } from './rules.js';
import { compareRanked, compareSignals, fingerprint } from './cluster.js';
import { validate } from './validate.js';
import { BOOK, TODAY, bigDeal, change, company, deal, snapshot } from './__fixtures.js';

const rules = loadRules();
const co = company();

const tier3Changes = [
  change({ source: 'jobs', item_type: 'job_postings', day: '2026-10-05', snapshot_id: 'snap-jobs' }),
  change({ source: 'domain', item_type: 'domain_change', day: '2026-10-06', snapshot_id: 'snap-domain' }),
  change({ source: 'news', item_type: 'press_tone_shift', day: '2026-10-07', snapshot_id: 'snap-news' }),
];

const run = (changes: typeof tier3Changes, deals = [bigDeal()]) =>
  validate({ book_id: BOOK, company: co, deals, changes, today: TODAY, rules });

describe('7. three tier 3 signals promote the cluster to tier 2; two do not', () => {
  it('three promote', () => {
    const result = run(tier3Changes);
    expect(result.signals.map((s) => s.tier)).toEqual([3, 3, 3]);
    expect(result.promoted_by_pattern).toBe(true);
    expect(result.cluster).not.toBeNull();
    expect(result.cluster!.top_tier).toBe(2);
    // The pattern IS the finding, so the three signals are what the cluster cites.
    expect(result.cluster!.signals).toHaveLength(3);
  });

  it('two do not -- and without a pattern a tier 3 does not surface at all', () => {
    const result = run(tier3Changes.slice(0, 2));
    expect(result.signals.map((s) => s.tier)).toEqual([3, 3]);
    expect(result.promoted_by_pattern).toBe(false);
    // Both are stored; neither alerts.
    expect(result.signals).toHaveLength(2);
    expect(result.cluster).toBeNull();
  });

  it('the promotion moves the cluster, not the signals', () => {
    const result = run(tier3Changes);
    expect(result.cluster!.top_tier).toBe(2);
    for (const s of result.cluster_signals) expect(s.tier).toBe(3);
  });

  it('a tier 1 present means the cluster keeps tier 1, not the promoted 2', () => {
    const result = run([
      ...tier3Changes,
      change({ source: 'registry', item_type: 'change_of_control', snapshot_id: 'snap-reg' }),
    ]);
    expect(result.cluster!.top_tier).toBe(1);
  });
});

describe('8. any tier 1 in the cluster sets verify_with_counterparty', () => {
  it('tier 1 sets it', () => {
    const result = run([change({ source: 'registry', item_type: 'change_of_control' })]);
    expect(result.cluster!.top_tier).toBe(1);
    expect(result.cluster!.verify_with_counterparty).toBe(true);
  });

  it('a tier 2 only cluster does not set it', () => {
    const result = run([change({ source: 'registry', kind: 'removed', item_type: 'officer' })]);
    expect(result.cluster!.top_tier).toBe(2);
    expect(result.cluster!.verify_with_counterparty).toBe(false);
  });

  it('a promoted tier 3 pattern does not set it', () => {
    expect(run(tier3Changes).cluster!.verify_with_counterparty).toBe(false);
  });

  it('a baseline profile cluster does not set it', () => {
    const result = validate({
      book_id: BOOK, company: co, changes: [], baseline_snapshots: [snapshot()], today: TODAY, rules,
    });
    expect(result.cluster!.verify_with_counterparty).toBe(false);
  });
});

describe('9. the fingerprint', () => {
  const sig = (signal_id: string, status: Signal['status']) => ({ signal_id, status });

  it('is stable under reordering', () => {
    const a = fingerprint([sig('sig-1', 'reported'), sig('sig-2', 'confirmed')]);
    const b = fingerprint([sig('sig-2', 'confirmed'), sig('sig-1', 'reported')]);
    expect(a).toBe(b);
  });

  it('changes when a status changes', () => {
    const before = fingerprint([sig('sig-1', 'reported')]);
    const after = fingerprint([sig('sig-1', 'confirmed')]);
    expect(after).not.toBe(before);
  });

  it('changes when a signal is added', () => {
    expect(fingerprint([sig('sig-1', 'confirmed'), sig('sig-2', 'confirmed')]))
      .not.toBe(fingerprint([sig('sig-1', 'confirmed')]));
  });

  it('the same cluster two days running keeps the same fingerprint', () => {
    const day1 = run([change({ source: 'registry', item_type: 'change_of_control', day: '2026-10-09' })]);
    const day2 = validate({
      book_id: BOOK,
      company: co,
      deals: [bigDeal()],
      changes: [],
      existing_signals: day1.signals,
      today: '2026-10-11',
      rules,
    });
    expect(day2.cluster!.window.to).not.toBe(day1.cluster!.window.to);
    // Only the signal ids and statuses are hashed, so the narrator does not
    // re-narrate the same cluster because the window slid by a day.
    expect(day2.cluster!.fingerprint).toBe(day1.cluster!.fingerprint);
  });

  it('a status flip from reported to confirmed changes the real cluster fingerprint', () => {
    const day1 = validate({
      book_id: BOOK,
      company: co,
      deals: [bigDeal()],
      changes: [
        change({ source: 'news', item_type: 'exec_departure', day: '2026-10-01', url: 'https://a.invalid/1' }),
        change({ source: 'executives', item_type: 'exec_departure', day: '2026-10-01', url: 'https://b.invalid/2', snapshot_id: 'snap-exec' }),
      ],
      today: TODAY,
      rules,
    });
    expect(day1.cluster_signals[0]!.status).toBe('reported');

    const day2 = validate({
      book_id: BOOK,
      company: co,
      deals: [bigDeal()],
      existing_signals: day1.signals,
      changes: [change({ source: 'registry', kind: 'removed', item_type: 'officer', day: '2026-10-06', snapshot_id: 'snap-reg' })],
      today: TODAY,
      rules,
    });
    expect(day2.cluster_signals[0]!.status).toBe('confirmed');
    expect(day2.cluster!.fingerprint).not.toBe(day1.cluster!.fingerprint);
  });
});

describe('10. ordering is lexicographic, with no composite score', () => {
  it('a tier 3 with a huge deal sorts below a tier 1 with a small one', () => {
    const tier3Huge = { tier: 3 as const, exposure_weight: 1, confidence: 'high' as const };
    const tier1Tiny = { tier: 1 as const, exposure_weight: 0.01, confidence: 'low' as const };
    expect(compareRanked(tier3Huge, tier1Tiny)).toBeGreaterThan(0);
    expect([tier3Huge, tier1Tiny].sort(compareRanked)[0]).toBe(tier1Tiny);
  });

  it('within a tier, the heavier exposure comes first, then confidence', () => {
    const heavy = { tier: 2 as const, exposure_weight: 0.8, confidence: 'low' as const };
    const light = { tier: 2 as const, exposure_weight: 0.2, confidence: 'high' as const };
    expect(compareRanked(heavy, light)).toBeLessThan(0);

    const sure = { tier: 2 as const, exposure_weight: 0.5, confidence: 'high' as const };
    const unsure = { tier: 2 as const, exposure_weight: 0.5, confidence: 'medium' as const };
    expect(compareRanked(sure, unsure)).toBeLessThan(0);
  });

  it('tier 0 sorts last, below tier 3', () => {
    const t0 = { tier: 0 as const, exposure_weight: 1, confidence: 'high' as const };
    const t3 = { tier: 3 as const, exposure_weight: 0, confidence: 'low' as const };
    expect(compareRanked(t0, t3)).toBeGreaterThan(0);
  });

  it('cluster.signals is ordered tier first', () => {
    const result = run([
      change({ source: 'registry', kind: 'removed', item_type: 'officer', snapshot_id: 'snap-officer' }),
      change({ source: 'registry', item_type: 'change_of_control', snapshot_id: 'snap-control' }),
    ]);
    const tiers = result.cluster_signals.map((s) => s.tier);
    expect(tiers).toEqual([1, 2]);
  });

  it('compareSignals is a thin wrapper over the same three keys', () => {
    const base = {
      book_id: BOOK, signal_id: 'sig-a', company_id: 'nordvale', type: 'x', title: 't',
      confidence: 'high' as const, status: 'confirmed' as const, first_seen: TODAY,
      summary_fact: 'f', touches_terms: [],
      evidence: [{ snapshot_id: 's', source: 'registry' as const, trust: 'primary' as const, excerpt: '', url: '' }],
    };
    const a: Signal = { ...base, tier: 1 };
    const b: Signal = { ...base, signal_id: 'sig-b', tier: 3 };
    expect(compareSignals(a, b, () => 0)).toBeLessThan(0);
    expect(compareSignals(b, a, (s) => (s.signal_id === 'sig-b' ? 1 : 0))).toBeGreaterThan(0);
  });
});

describe('13. every emitted document parses against its contract', () => {
  const scenarios = {
    'tier 1 plus corroboration': run([
      change({ source: 'registry', item_type: 'change_of_control', snapshot_id: 'snap-reg' }),
      change({ source: 'news', item_type: 'ownership_change', snapshot_id: 'snap-news', url: 'https://a.invalid/1' }),
    ]),
    'promoted tier 3 pattern': run(tier3Changes),
    'tier 2 gated out by exposure': run(
      [change({ source: 'registry', kind: 'removed', item_type: 'officer' })],
      [deal({ annual_value_usd: 50_000 })],
    ),
    'tied deal, compliance flag': run(
      [change({ source: 'registry', item_type: 'change_of_control' })],
      [bigDeal({ deal_class: 'tied', substitutability: 'hard' })],
    ),
    'baseline profile': validate({
      book_id: BOOK, company: co, changes: [], baseline_snapshots: [snapshot()], today: TODAY, rules,
    }),
  };

  for (const [name, result] of Object.entries(scenarios)) {
    it(`${name}: signals parse`, () => {
      expect(result.signals.length).toBeGreaterThan(0);
      for (const s of result.signals) expect(() => signalSchema.parse(s)).not.toThrow();
    });

    it(`${name}: the cluster parses and its signal ids all resolve`, () => {
      if (result.cluster === null) return;
      const cluster = clusterSchema.parse(result.cluster);
      const ids = new Set(result.signals.map((s) => s.signal_id));
      for (const id of cluster.signals) expect(ids.has(id)).toBe(true);
      expect(cluster.window.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(cluster.window.to).toBe(TODAY);
      expect(Number.isInteger(cluster.top_tier)).toBe(true);
      expect(cluster.fingerprint.length).toBeGreaterThan(0);
    });
  }

  it('the window is the rolling corroboration window', () => {
    const cluster = run([change({ source: 'registry', item_type: 'change_of_control' })]).cluster!;
    expect(cluster.window.from).toBe('2026-09-26');
    expect(cluster.window.to).toBe('2026-10-10');
  });

  it('zero signals means zero clusters', () => {
    const result = validate({ book_id: BOOK, company: co, changes: [], today: TODAY, rules });
    expect(result.signals).toHaveLength(0);
    expect(result.cluster).toBeNull();
  });

  it('a tier 0 signal is stored and never alerts', () => {
    const result = run([change({ source: 'registry', item_type: 'address_update' })]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.tier).toBe(0);
    expect(result.cluster).toBeNull();
  });
});
