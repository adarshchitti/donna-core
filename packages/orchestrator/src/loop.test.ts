import { describe, it, expect, vi } from 'vitest';
import { tick, runLoop, CADENCE, type LoopDeps } from './loop.js';
import { outcomeFor, CONFIDENCE_THRESHOLD, AUTO_RESOLVER, type RegistryCandidate } from './resolution.js';
import { SOURCES } from '@donna/contracts';

function deps(over: Partial<LoopDeps> = {}): LoopDeps & { calls: string[] } {
  const calls: string[] = [];
  const base: LoopDeps = {
    store: {
      reapStaleRuns: async () => { calls.push('reap'); return { reaped: 0 }; },
      dueSchedules: async () => { calls.push('due'); return []; },
      creditsSpentTotal: async () => { calls.push('credits'); return 0; },
      listCompanies: async () => [],
      companiesWithoutSchedules: async () => { calls.push('orphans'); return []; },
      upsertSchedule: async () => { calls.push('schedule'); },
    },
    runBatch: async () => { calls.push('batch'); return 1; },
    resolvePending: async () => { calls.push('resolve'); return 0; },
    creditCeiling: 250,
  };
  return { ...base, ...over, store: { ...base.store, ...(over.store ?? {}) }, calls };
}

describe('the loop does four things in order', () => {
  it('reaps BEFORE resolving or scheduling, so a restart recovers by itself', async () => {
    const d = deps();
    await tick(d);
    expect(d.calls[0]).toBe('reap');
    expect(d.calls.indexOf('reap')).toBeLessThan(d.calls.indexOf('resolve'));
    expect(d.calls.indexOf('resolve')).toBeLessThan(d.calls.indexOf('due'));
  });

  it('reports what it reaped', async () => {
    const d = deps({ store: { reapStaleRuns: async () => ({ reaped: 3 }) } as never });
    expect((await tick(d)).reaped).toBe(3);
  });
});

describe('batching', () => {
  it('groups due schedules BY COMPANY, so the validator sees a whole company at once', async () => {
    const seen: Array<{ company: string; sources: string[] }> = [];
    const d = deps({
      store: {
        dueSchedules: async () => [
          { company_id: 'a', source: 'registry' as const },
          { company_id: 'b', source: 'court' as const },
          { company_id: 'a', source: 'news' as const },
        ],
      } as never,
      runBatch: async (company, sources) => { seen.push({ company, sources: [...sources] }); return sources.length; },
    });
    const r = await tick(d);
    expect(r.batches).toBe(2);
    expect(r.jobs).toBe(3);
    expect(seen.find((s) => s.company === 'a')?.sources.sort()).toEqual(['news', 'registry']);
  });

  it('names the batch with the convention Track C filters on', async () => {
    let batch = '';
    const d = deps({
      store: { dueSchedules: async () => [{ company_id: 'nordvale', source: 'registry' as const }] } as never,
      runBatch: async (_c, _s, b) => { batch = b; return 1; },
    });
    await tick(d);
    expect(batch).toMatch(/^batch-nordvale-\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps going when one company batch throws, because one bad source must not halt the rest', async () => {
    const done: string[] = [];
    const d = deps({
      store: {
        dueSchedules: async () => [
          { company_id: 'bad', source: 'registry' as const },
          { company_id: 'good', source: 'registry' as const },
        ],
      } as never,
      runBatch: async (company) => {
        if (company === 'bad') throw new Error('portal down');
        done.push(company); return 1;
      },
    });
    const r = await tick(d);
    expect(done).toEqual(['good']);
    expect(r.batches).toBe(1);
  });
});

describe('the credit ceiling', () => {
  it('stops scheduling BEFORE spending, not after reporting the damage', async () => {
    const d = deps({
      store: { creditsSpentTotal: async () => 250, dueSchedules: async () => [{ company_id: 'a', source: 'registry' as const }] } as never,
    });
    const r = await tick(d);
    expect(r.credit_ceiling_hit).toBe(true);
    expect(r.batches).toBe(0);
    expect(d.calls).not.toContain('batch');
  });

  it('still reaps and resolves at the ceiling -- recovery is not collection', async () => {
    const d = deps({ store: { creditsSpentTotal: async () => 999 } as never });
    await tick(d);
    expect(d.calls).toContain('reap');
    expect(d.calls).toContain('resolve');
  });
});

describe('cadence', () => {
  it('runs primary and reported daily, inferred weekly, and nothing hourly', () => {
    for (const s of SOURCES) expect(['daily', 'weekly']).toContain(CADENCE[s]);
    expect(CADENCE.jobs).toBe('weekly');
    expect(CADENCE.domain).toBe('weekly');
    expect(CADENCE.registry).toBe('daily');
  });
});

describe('runLoop', () => {
  it('survives a throwing tick rather than dying', async () => {
    let n = 0;
    const d = deps({ store: { reapStaleRuns: async () => { n += 1; if (n === 1) throw new Error('boom'); return { reaped: 0 }; } } as never });
    const ac = new AbortController();
    const p = runLoop(d, { intervalMs: 1, signal: ac.signal });
    await vi.waitFor(() => expect(n).toBeGreaterThan(1));
    ac.abort();
    await p;
  });
});

describe('entity resolution never auto-resolves a doubtful match', () => {
  const deal = { counterparty_name: 'Nordvale Industrial', country: 'US' as const };
  const candidate: RegistryCandidate = {
    canonical_name: 'Nordvale Industrial LLC', registry_id: 'OH-3819274', jurisdiction: 'US',
  };

  it('resolves above the threshold', () => {
    const o = outcomeFor(deal, [candidate], { registry_id: 'OH-3819274', confidence: 0.98, reason: 'Name and jurisdiction match.' }, []);
    expect(o.status).toBe('resolved');
    expect(o.registry_id).toBe('OH-3819274');
    expect(o.resolution.resolved_by).toBe(AUTO_RESOLVER);
  });

  it('parks a below-threshold match for a human, WITH the candidates', () => {
    const o = outcomeFor(deal, [candidate], { registry_id: 'OH-3819274', confidence: CONFIDENCE_THRESHOLD - 0.01, reason: 'Partial name overlap only.' }, []);
    expect(o.status).toBe('needs_review');
    expect(o.resolution.candidates_seen).toHaveLength(1);
    expect(o.resolution.reason).toContain('below the');
  });

  it('parks a no_match and records a null confidence, not a zero', () => {
    const o = outcomeFor(deal, [candidate], { registry_id: null, confidence: 0, reason: 'No candidate resembled the counterparty.' }, []);
    expect(o.status).toBe('needs_review');
    expect(o.resolution.confidence).toBeNull();
  });

  it('keeps the user-typed name as an ALIAS, never as canonical_name', () => {
    // Track C 409s on a canonical_name change, which would break the user's
    // next "Add company".
    const o = outcomeFor(deal, [candidate], { registry_id: 'OH-3819274', confidence: 0.99, reason: 'Match.' }, []);
    expect(o.canonical_name).toBe('Nordvale Industrial LLC');
    expect(o.aliases).toContain('Nordvale Industrial');
  });

  it('does not collect related entities, because that multiplies credit spend by group size', () => {
    const o = outcomeFor(deal, [{ ...candidate, officers: [{ name: 'Jane Doe', role: 'CFO' }] }], { registry_id: 'OH-3819274', confidence: 0.99, reason: 'Match.' }, []);
    expect(o.officers).toHaveLength(1);
    expect(o.related_entities).toEqual([]);
  });

  it('records the reason, so a user can see why we think this is their company', () => {
    const o = outcomeFor(deal, [candidate], { registry_id: 'OH-3819274', confidence: 0.97, reason: 'Registered address matches the invoice address on the deal.' }, []);
    expect(o.resolution.reason).toContain('Registered address matches');
  });
});


describe('schedules are an invariant the loop converges on', () => {
  it('gives a hand-added company schedules for every source', async () => {
    const written: Array<Record<string, unknown>> = [];
    const d = deps({
      store: {
        companiesWithoutSchedules: async () => [{ company_id: 'added-by-hand' }],
        upsertSchedule: async (i: Record<string, unknown>) => { written.push(i); },
      } as never,
    });
    const r = await tick(d);
    expect(r.scheduled).toBe(1);
    expect(written).toHaveLength(SOURCES.length);
    for (const s of written) expect(SOURCES).toContain(s.source);
  });

  it('schedules it to run NOW, because the first batch is its profile', async () => {
    const written: Array<Record<string, unknown>> = [];
    const d = deps({
      store: {
        companiesWithoutSchedules: async () => [{ company_id: 'x' }],
        upsertSchedule: async (i: Record<string, unknown>) => { written.push(i); },
      } as never,
    });
    await tick(d);
    const at = new Date(String(written[0]!.next_run_at)).getTime();
    expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
  });

  it('does nothing when every company already has schedules', async () => {
    const d = deps();
    const r = await tick(d);
    expect(r.scheduled).toBe(0);
    expect(d.calls).not.toContain('schedule');
  });

  it('backfills BEFORE the credit ceiling, so a full budget still fixes the book', async () => {
    // A company with no schedules is a correctness problem, not a spending one:
    // giving it schedules costs nothing and collection is gated separately.
    const written: Array<Record<string, unknown>> = [];
    const d = deps({
      store: {
        creditsSpentTotal: async () => 9999,
        companiesWithoutSchedules: async () => [{ company_id: 'x' }],
        upsertSchedule: async (i: Record<string, unknown>) => { written.push(i); },
      } as never,
    });
    const r = await tick(d);
    expect(r.credit_ceiling_hit).toBe(true);
    expect(r.scheduled).toBe(1);
    expect(written).toHaveLength(SOURCES.length);
  });

  it('still works against a store that lacks the methods', async () => {
    const d = deps();
    // Optional on the interface, so removing it is legal -- which is the point:
    // a store that predates this step must still tick.
    delete d.store.companiesWithoutSchedules;
    await expect(tick(d)).resolves.toMatchObject({ scheduled: 0 });
  });
});

describe('step 2b: one lookup per tick, between resolve and schedule', () => {
  it('polls lookups after resolve and before due work', async () => {
    const d = deps({ lookupPending: async () => { d.calls.push('lookup'); return 1; } });
    const r = await tick(d);
    expect(d.calls.indexOf('resolve')).toBeLessThan(d.calls.indexOf('lookup'));
    expect(d.calls.indexOf('lookup')).toBeLessThan(d.calls.indexOf('orphans'));
    expect(d.calls.indexOf('lookup')).toBeLessThan(d.calls.indexOf('due'));
    expect(r.looked_up).toBe(1);
  });

  it('a failing lookup does not stop due monitoring', async () => {
    const d = deps({
      lookupPending: async () => { throw new Error('judge down'); },
      store: { dueSchedules: async () => [{ company_id: 'a', source: 'registry' as const }] } as never,
    });
    const r = await tick(d);
    expect(r.looked_up).toBe(0);
    expect(r.batches).toBe(1);
  });
});

describe('the reap step also ends expired watches', () => {
  it('disables expired schedules in step 1, with the injected clock', async () => {
    const at = new Date('2026-12-02T00:00:00.000Z');
    let seen: unknown;
    let dueAt: unknown;
    const d = deps({
      now: () => at,
      store: {
        disableExpiredSchedules: async (now?: string | Date) => { d.calls.push('expire'); seen = now; return 8; },
        dueSchedules: async (now?: string | Date) => { d.calls.push('due'); dueAt = now; return []; },
      } as never,
    });
    const r = await tick(d);
    expect(r.expired).toBe(8);
    expect(seen).toBe(at);
    expect(dueAt).toBe(at);
    expect(d.calls.indexOf('reap')).toBeLessThan(d.calls.indexOf('expire'));
    expect(d.calls.indexOf('expire')).toBeLessThan(d.calls.indexOf('resolve'));
  });
});
