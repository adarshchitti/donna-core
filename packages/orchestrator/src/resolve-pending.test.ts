import { describe, it, expect, vi } from 'vitest';
import { resolvePending, type ResolveStore, type CandidateSource } from './resolve-pending.js';
import { CONFIDENCE_THRESHOLD, AUTO_RESOLVER, type Judge } from './resolution.js';
import { SOURCES, type Deal } from '@donna/contracts';

const deal = (over: Partial<Deal> = {}): Deal => ({
  deal_id: 'dl-1', counterparty_name: 'Nordvale Industrial', country: 'US',
  deal_class: 'they_pay_us', annual_value_usd: 820_000,
  start_date: '2024-03-01', end_date: '2027-02-28', status: 'unresolved', ...over,
});

const candidate = {
  canonical_name: 'Nordvale Industrial LLC', registry_id: 'OH-3819274', jurisdiction: 'US',
};

function harness(opts: {
  deals?: Deal[];
  candidates?: typeof candidate[];
  searchThrows?: boolean;
  judgement?: { registry_id: string | null; confidence: number; reason: string };
  linkReturns?: boolean;
} = {}) {
  const calls = {
    upsertCompany: [] as Record<string, unknown>[],
    link: [] as Record<string, unknown>[],
    park: [] as Record<string, unknown>[],
    schedules: [] as Record<string, unknown>[],
  };
  const store: ResolveStore = {
    unresolvedDeals: async () => opts.deals ?? [deal()],
    upsertCompany: async (i) => { calls.upsertCompany.push(i); return { company_id: 'co-uuid', outcome: 'inserted' }; },
    linkDealToCompany: async (i) => { calls.link.push(i); return opts.linkReturns ?? true; },
    parkDealForReview: async (i) => { calls.park.push(i); return true; },
    upsertSchedule: async (i) => { calls.schedules.push(i); },
  };
  const candidates: CandidateSource = {
    search: async () => {
      if (opts.searchThrows) throw new Error('registry portal timed out');
      return opts.candidates ?? [candidate];
    },
    identify: async () => ({ domains: ['nordvale.com'], aliases: [] }),
  };
  const judge: Judge = {
    resolve: async () => opts.judgement
      ?? { registry_id: 'OH-3819274', confidence: 0.97, reason: 'Legal name and jurisdiction match the registration.' },
  };
  return { store, candidates, judge, calls };
}

describe('a confident match is resolved all the way', () => {
  it('upserts the company, links the deal, and writes schedules', async () => {
    const h = harness();
    const r = await resolvePending(h);
    expect(r).toMatchObject({ considered: 1, resolved: 1, needs_review: 0, failed: 0 });
    expect(h.calls.upsertCompany).toHaveLength(1);
    expect(h.calls.link[0]).toMatchObject({ deal_id: 'dl-1', company_id: 'co-uuid' });
  });

  it('writes one schedule per source with next_run_at NOW, because that first batch is the profile', async () => {
    const h = harness();
    await resolvePending(h);
    expect(h.calls.schedules).toHaveLength(SOURCES.length);
    const now = Date.now();
    for (const s of h.calls.schedules) {
      expect(SOURCES).toContain(s.source);
      expect(Math.abs(new Date(String(s.next_run_at)).getTime() - now)).toBeLessThan(60_000);
    }
  });

  it('records the reason, so a user can see why we think this is their company', async () => {
    const h = harness();
    await resolvePending(h);
    expect(String(h.calls.link[0]!.reason)).toContain('Legal name and jurisdiction match');
  });
});

describe('it refuses to guess', () => {
  it('parks a below-threshold match instead of resolving it', async () => {
    const h = harness({ judgement: { registry_id: 'OH-3819274', confidence: CONFIDENCE_THRESHOLD - 0.01, reason: 'Partial name overlap only.' } });
    const r = await resolvePending(h);
    expect(r.needs_review).toBe(1);
    expect(r.resolved).toBe(0);
    expect(h.calls.link).toHaveLength(0);
    expect(h.calls.schedules).toHaveLength(0);
  });

  it('parks a no_match and attaches the candidates it considered', async () => {
    const h = harness({ judgement: { registry_id: null, confidence: 0, reason: 'No candidate resembled the counterparty.' } });
    await resolvePending(h);
    expect(h.calls.park[0]!.candidates_seen).toHaveLength(1);
  });

  it('never starts collection for a parked deal', async () => {
    const h = harness({ judgement: { registry_id: null, confidence: 0, reason: 'x' } });
    await resolvePending(h);
    expect(h.calls.schedules).toHaveLength(0);
  });
});

describe('an unreachable source is not an absent company', () => {
  it('parks the deal and says the registry could not be searched', async () => {
    const h = harness({ searchThrows: true });
    const r = await resolvePending(h);
    expect(r.needs_review).toBe(1);
    // The distinction that matters: we did not look, versus we looked and found
    // nothing. Recording `no_match` here would imply a search that never ran.
    expect(String(h.calls.park[0]!.reason)).toMatch(/could not be searched/);
    expect(String(h.calls.park[0]!.reason)).toContain('registry portal timed out');
  });

  it('does not call the judge when there are no candidates to judge', async () => {
    const judgeSpy = vi.fn();
    const h = harness({ searchThrows: true });
    await resolvePending({ ...h, judge: { resolve: judgeSpy } });
    expect(judgeSpy).not.toHaveBeenCalled();
  });
});

describe('concurrency and failure', () => {
  it('yields to a human who resolved the deal first, and starts no collection', async () => {
    const h = harness({ linkReturns: false });
    const r = await resolvePending(h);
    expect(r.resolved).toBe(0);
    expect(h.calls.schedules).toHaveLength(0);
  });

  it('one bad deal does not stop the rest', async () => {
    const h = harness({ deals: [deal({ deal_id: 'bad' }), deal({ deal_id: 'good' })] });
    let first = true;
    const candidates: CandidateSource = {
      search: async () => { if (first) { first = false; throw { toString: () => 'x' }; } return [candidate]; },
      identify: async () => ({ domains: [], aliases: [] }),
    };
    const r = await resolvePending({ ...h, candidates });
    expect(r.considered).toBe(2);
    expect(r.resolved + r.needs_review).toBeGreaterThanOrEqual(1);
  });

  it('marks every automated decision with the auto_resolver sentinel', async () => {
    const h = harness();
    await resolvePending(h);
    const res = h.calls.upsertCompany[0]!.resolution as { resolved_by: string };
    expect(res.resolved_by).toBe(AUTO_RESOLVER);
  });
});
