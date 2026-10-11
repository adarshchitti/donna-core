import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { SOURCES, type Cluster, type Company, type Deal, type Source } from '@donna/contracts';
import { DonnaStore } from '@donna/store';
import { PROFILE_SECTION_TITLES, narrate, narratorInput, validate } from '@donna/logic';
import {
  LOOKUP_PASS_CREDITS, RESOLUTION_CREDITS, LookupInputError,
  lookupPending, promoteToDeal, runLookup, watchExpiresAt, type LookupDeps, type LookupPollStore,
} from './lookup.js';
import { CONFIDENCE_THRESHOLD, type Judge, type RegistryCandidate } from './resolution.js';
import type { CandidateSource } from './resolve-pending.js';
import type { CollectorRunner } from './run-batch.js';
import { LocalSandboxRunner } from './sandbox-local.js';

/**
 * runLookup end to end against a real (in-memory) Mongo through DonnaStore,
 * with the REAL validator and narrator (code fallback, no model call). Only
 * the network edges are faked: registry candidates, the judge, and the
 * collectors. Assertions are on the store, not on return values, wherever the
 * store is what a reader of the product would see.
 */
const DB = 'donna_lookup_test';
const BOOK = 'book-under-test';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const CREDITS_PER_SOURCE = 1;

let mongod: MongoMemoryServer;
let client: MongoClient;
let store: DonnaStore;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
}, 120_000);

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

beforeEach(async () => {
  await client.db(DB).dropDatabase();
  store = DonnaStore.fromClient(client, { database: DB, bookId: BOOK });
  await store.ensureIndexes();
});

const candidate: RegistryCandidate = {
  canonical_name: 'Acme Corporation', registry_id: 'DE-1234567', jurisdiction: 'US',
};

function harness(opts: {
  searchThrows?: boolean;
  confidence?: number;
  lookupCeiling?: number;
  creditCeiling?: number;
} = {}) {
  const fetched: Source[] = [];
  const candidates: CandidateSource = {
    search: async () => {
      if (opts.searchThrows) throw new Error('registry portal timed out');
      return [candidate];
    },
    identify: async () => ({ domains: ['acme.example'], aliases: [] }),
  };
  const judge: Judge = {
    resolve: async () => ({
      registry_id: candidate.registry_id,
      confidence: opts.confidence ?? 0.97,
      reason: 'Legal name and jurisdiction match the registration.',
    }),
  };
  const collectors: CollectorRunner = {
    async collect({ company, source, runId }) {
      fetched.push(source);
      return {
        sandbox_id: 'in-process',
        envelope: {
          company_id: company.company_id, source, run_id: runId,
          fetched_at: NOW.toISOString(), ok: true, error: null,
          items: [{ key: `${source}:record-1`, type: 'record', title: `${source} record` }],
          raw_excerpt: `${company.canonical_name}: ${source} record as of 11 October 2026.`,
          source_url: `https://${source}.example/acme`,
          credits_spent: CREDITS_PER_SOURCE,
        },
      };
    },
  };
  const deps: LookupDeps & { store: LookupPollStore } = {
    // DonnaStore's inputs are typed; the seams take records (see onboard-book).
    store: store as unknown as LookupPollStore,
    candidates,
    judge,
    lookupCeiling: opts.lookupCeiling ?? 100,
    ...(opts.creditCeiling !== undefined ? { creditCeiling: opts.creditCeiling } : {}),
    now: () => NOW,
    batch: {
      collectors,
      sandboxes: new LocalSandboxRunner(),
      bookId: BOOK,
      validate: (input) => {
        const r = validate({
          book_id: input.book_id,
          company: input.company as unknown as Company,
          deals: input.deals as unknown as Deal[],
          changes: input.changes,
          existing_signals: input.existing_signals,
          baseline_snapshots: input.baseline_snapshots,
          today: '2026-10-11',
        });
        return { signals: r.signals, cluster: r.cluster as Record<string, unknown> | null, mode: r.mode };
      },
      narrate: async (input) => ({
        briefing: (await narrate(narratorInput(input.cluster as unknown as Cluster, input.signals), { client: null })).briefing,
      }),
    },
  };
  return { deps, fetched };
}

const input = { name: 'Acme Corp', country: 'US', requestedBy: 'user-1' };
const db = () => client.db(DB);

describe('a lookup is one shot', () => {
  it('writes NO schedules without watchUntil -- asserted on the store', async () => {
    const { deps } = harness();
    const out = await runLookup(input, deps);
    expect(out.status).toBe('profiled');
    expect(await db().collection('schedules').countDocuments({})).toBe(0);
    expect(out.schedules_written).toBe(0);
  });

  it('runBatch pushSchedule() is a real no-op against no schedule document', async () => {
    const { deps } = harness();
    const out = await runLookup(input, deps);
    // Every source ran (and pushSchedule was called after each); none created one.
    expect(out.runs).toHaveLength(SOURCES.length);
    expect(await store.pushSchedule(out.company_id!, 'registry', NOW)).toBe(false);
    expect(await db().collection('schedules').countDocuments({})).toBe(0);
  });

  it('upserts the company with lookup and NO monitoring_since', async () => {
    const { deps } = harness();
    const out = await runLookup(input, deps);
    const company = await store.getCompany(out.company_id!);
    expect(company?.registry_id).toBe('DE-1234567');
    expect(company?.lookup).toEqual({
      requested_at: NOW.toISOString(), requested_by: 'user-1', watch_until: null,
    });
    expect(company).not.toHaveProperty('monitoring_since');
    // ...and the loop's backfill will not hand it the normal cadence.
    expect((await store.companiesWithoutSchedules()).map((c) => c.company_id)).not.toContain(out.company_id);
  });

  it('runs all eight sources once and reports runs, credits and coverage', async () => {
    const { deps, fetched } = harness();
    const out = await runLookup(input, deps);
    expect([...fetched].sort()).toEqual([...SOURCES].sort());
    expect(out.runs.every((r) => r.status === 'ok')).toBe(true);
    expect(out.credits_spent).toBe(SOURCES.length * CREDITS_PER_SOURCE);
    expect([...out.coverage!.checked].sort()).toEqual([...SOURCES].sort());
    expect(out.coverage!.failed).toEqual([]);
  });
});

describe('the first lookup run is a baseline', () => {
  it('emits no changes, only baseline signals, and a four-section profile', async () => {
    const { deps } = harness();
    const out = await runLookup(input, deps);
    expect(out.baseline_violations).toEqual([]);

    const id = out.company_id!;
    expect(await db().collection('changes').countDocuments({ company_id: id })).toBe(0);
    const signals = await store.signalsForCompany(id);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.status === 'baseline')).toBe(true);

    const profile = await store.latestBriefing(id, 'profile');
    expect(profile?.briefing_id).toBe(out.briefing_id);
    expect(profile?.mode).toBe('profile');
    expect(profile?.sections?.map((s) => s.title)).toEqual([...PROFILE_SECTION_TITLES]);
    expect(profile?.sections?.[3]?.title).toBe('What to ask before signing');
    expect(await store.latestBriefing(id, 'briefing')).toBeNull();
  });
});

describe('it refuses to guess', () => {
  it('parks below the threshold with candidates attached and runs NO batch', async () => {
    const { deps, fetched } = harness({ confidence: CONFIDENCE_THRESHOLD - 0.01 });
    const out = await runLookup(input, deps);
    expect(out.status).toBe('needs_review');
    expect(out.resolution?.candidates_seen).toHaveLength(1);
    expect(fetched).toEqual([]);
    expect(await db().collection('collector_runs').countDocuments({})).toBe(0);
    expect(await db().collection('companies').countDocuments({})).toBe(0);
  });

  it('an unreachable registry reports could-not-look, never no_match', async () => {
    const { deps, fetched } = harness({ searchThrows: true });
    const out = await runLookup(input, deps);
    expect(out.status).toBe('could_not_look');
    expect(out.reason).toContain('could not be searched');
    expect(out.reason).toContain('registry portal timed out');
    expect(out.reason).not.toMatch(/no.?match/i);
    expect(fetched).toEqual([]);
  });
});

describe('the bounded negotiation watch', () => {
  it('writes one schedule per source expiring after watchUntil', async () => {
    const { deps } = harness();
    const out = await runLookup({ ...input, watchUntil: '2026-11-30' }, deps);
    expect(out.schedules_written).toBe(SOURCES.length);
    const schedules = await store.schedulesForCompany(out.company_id!);
    expect(schedules).toHaveLength(SOURCES.length);
    for (const s of schedules) {
      expect(s.expires_at).toBe('2026-12-01T00:00:00.000Z');
      expect(s.enabled).toBe(true);
      // The lookup batch just ran, so nothing is due again today.
      expect(s.next_run_at > NOW.toISOString()).toBe(true);
    }
    expect((await store.getCompany(out.company_id!))?.lookup?.watch_until).toBe('2026-11-30');
    // Due normally while the watch runs...
    expect(await store.dueSchedules(new Date('2026-11-29T12:00:00.000Z'))).toHaveLength(SOURCES.length);
    // ...and never once it has ended, and the reaper switches it off.
    const after = new Date('2026-12-02T12:00:00.000Z');
    expect(await store.dueSchedules(after)).toEqual([]);
    expect(await store.disableExpiredSchedules(after)).toBe(SOURCES.length);
  });

  it('includes the whole last day', () => {
    expect(watchExpiresAt('2026-11-30')).toBe('2026-12-01T00:00:00.000Z');
  });

  it('rejects a malformed or already-ended watch before fetching', async () => {
    const { deps, fetched } = harness();
    await expect(runLookup({ ...input, watchUntil: '30/11/2026' }, deps)).rejects.toThrow(LookupInputError);
    await expect(runLookup({ ...input, watchUntil: '2026-10-10' }, deps)).rejects.toThrow(LookupInputError);
    expect(fetched).toEqual([]);
  });
});

describe('the lookup ceiling', () => {
  it('blocks a lookup that would exceed it, before any fetch', async () => {
    const { deps, fetched } = harness({ lookupCeiling: LOOKUP_PASS_CREDITS + RESOLUTION_CREDITS - 1 });
    const out = await runLookup(input, deps);
    expect(out.status).toBe('over_ceiling');
    expect(fetched).toEqual([]);
    expect(await db().collection('companies').countDocuments({})).toBe(0);
  });

  it('counts what earlier lookups spent', async () => {
    const ceiling = LOOKUP_PASS_CREDITS + RESOLUTION_CREDITS + 2;
    const first = harness({ lookupCeiling: ceiling });
    expect((await runLookup(input, first.deps)).status).toBe('profiled'); // spends 8
    const second = harness({ lookupCeiling: ceiling });
    const out = await runLookup({ ...input, name: 'Other Co' }, second.deps);
    expect(out.status).toBe('over_ceiling');
    expect(second.fetched).toEqual([]);
  });

  it('also respects DONNA_CREDIT_CEILING', async () => {
    const { deps, fetched } = harness({ creditCeiling: 5 });
    expect((await runLookup(input, deps)).status).toBe('over_ceiling');
    expect(fetched).toEqual([]);
  });
});

describe('the loop poll turns one intent into one lookup', () => {
  const intent = async (over: Record<string, unknown> = {}) =>
    store.upsertCompany({
      canonical_name: 'Acme Corporation', jurisdiction: 'US', registry_id: 'DE-1234567',
      lookup: { requested_at: '2026-10-11T09:00:00.000Z', requested_by: 'user-9', watch_until: null },
      ...over,
    });

  it('collects an intent that already carries a registry id without re-resolving', async () => {
    const { company_id } = await intent();
    const { deps } = harness({ searchThrows: true }); // resolution would fail if it ran
    const out = await lookupPending(deps);
    expect(out?.status).toBe('profiled');
    expect(out?.company_id).toBe(company_id);
    expect(out?.resolution?.status).toBe('preresolved');
    expect((await store.getCompany(company_id))?.last_checked_at).toBeDefined();
    // Collected, so it is no longer an intent.
    expect(await store.lookupIntents()).toEqual([]);
    expect(await db().collection('schedules').countDocuments({})).toBe(0);
  });

  it('resolves an intent with no registry identity first, and parks it on low confidence', async () => {
    const { company_id } = await intent({ registry_id: '', canonical_name: 'Acme Corp' });
    const { deps, fetched } = harness({ confidence: 0.5 });
    const out = await lookupPending(deps);
    expect(out?.status).toBe('needs_review');
    expect(fetched).toEqual([]);
    const parked = await store.getCompany(company_id);
    expect(parked?.resolution.candidates_seen).toHaveLength(1);
    // Parked intents wait for a person; the next tick does not re-bill them.
    expect(await store.lookupIntents()).toEqual([]);
  });

  it('resolves a manual intent onto its registry key and collects it', async () => {
    const { company_id } = await intent({ registry_id: '', canonical_name: 'Acme Corp' });
    const { deps } = harness();
    const out = await lookupPending(deps);
    expect(out?.status).toBe('profiled');
    expect(out?.company_id).toBe(company_id);
    const company = await store.getCompany(company_id);
    expect(company?.registry_id).toBe('DE-1234567');
    expect(company?.lookup?.requested_by).toBe('user-9');
  });

  it('returns null when there is nothing to look up', async () => {
    expect(await lookupPending(harness().deps)).toBeNull();
  });
});

describe('promoteToDeal', () => {
  it('links the deal, sets monitoring_since, keeps lookup and snapshots, and writes non-expiring schedules', async () => {
    const { deps } = harness();
    const looked = await runLookup({ ...input, watchUntil: '2026-11-30' }, deps);
    const id = looked.company_id!;
    const snapshotsBefore = await db().collection('snapshots').find({ company_id: id }).toArray();
    expect(snapshotsBefore).toHaveLength(SOURCES.length);

    await db().collection('deals').insertOne({
      book_id: BOOK, deal_id: 'deal-1', counterparty_name: 'Acme Corp', country: 'US',
      deal_class: 'they_pay_us', annual_value_usd: 100_000, start_date: '2026-11-01',
      end_date: '2027-10-31', status: 'unresolved',
    });
    const later = new Date('2026-10-20T09:00:00.000Z');
    const out = await promoteToDeal(id, 'deal-1', { store, now: () => later });
    expect(out).toMatchObject({ linked: 'linked', monitoring_since: '2026-10-20', schedules_written: SOURCES.length });

    const company = await store.getCompany(id);
    expect(company?.monitoring_since).toBe('2026-10-20');
    expect(company?.lookup?.requested_by).toBe('user-1');
    const deal = await db().collection('deals').findOne({ deal_id: 'deal-1' });
    expect(deal).toMatchObject({ company_id: id, status: 'resolved' });

    // The diligence snapshots are untouched and ARE the monitoring baseline.
    const snapshotsAfter = await db().collection('snapshots').find({ company_id: id }).toArray();
    expect(snapshotsAfter.map((s) => s.snapshot_id).sort()).toEqual(snapshotsBefore.map((s) => s.snapshot_id).sort());
    expect((await store.latestOkSnapshot(id, 'registry'))?.snapshot_id)
      .toBe(snapshotsBefore.find((s) => s.source === 'registry')?.snapshot_id);

    // The watch's expiry is replaced: monitoring does not end.
    const schedules = await store.schedulesForCompany(id);
    expect(schedules).toHaveLength(SOURCES.length);
    expect(schedules.every((s) => s.expires_at === null && s.enabled)).toBe(true);
    expect(await store.dueSchedules(new Date('2027-06-01T00:00:00.000Z'))).toHaveLength(SOURCES.length);
  });

  it('is safe to retry, and refuses to re-point a deal linked elsewhere', async () => {
    const { deps } = harness();
    const id = (await runLookup(input, deps)).company_id!;
    await db().collection('deals').insertMany([
      { book_id: BOOK, deal_id: 'deal-1', company_id: id, status: 'resolved' },
      { book_id: BOOK, deal_id: 'deal-2', company_id: 'someone-else', status: 'resolved' },
    ]);
    expect((await promoteToDeal(id, 'deal-1', { store, now: () => NOW })).linked).toBe('already_linked');
    await expect(promoteToDeal(id, 'deal-2', { store, now: () => NOW })).rejects.toThrow(/refusing to re-point/);
  });
});
