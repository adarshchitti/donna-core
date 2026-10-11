import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AUTO_RESOLVER } from './index.js';
import { DonnaStore } from './store.js';
import { aCompanyInput } from './testdata.js';

/**
 * The store half of pre-deal lookups and the bounded negotiation watch. Kept
 * in its own file rather than store.test.ts so it never text-collides with
 * other work on the store's tests.
 */
const DB = 'donna_store_lookup_test';
const BOOK = 'book-under-test';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
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
  db = client.db(DB);
  store = DonnaStore.fromClient(client, { database: DB, bookId: BOOK });
  await store.ensureIndexes();
});

const lookup = { requested_at: '2026-10-11T09:00:00.000Z', requested_by: 'user-1', watch_until: null };

const schedule = (company_id: string, expires_at: string | null, source: 'registry' | 'court' = 'registry') =>
  store.upsertSchedule({
    company_id, source, cadence: 'daily', next_run_at: '2026-10-11T08:00:00.000Z', enabled: true, expires_at,
  });

describe('schedule.expires_at: the bounded watch', () => {
  it('writes expires_at as null by default, so monitoring never expires', async () => {
    await store.upsertSchedule({
      company_id: 'c1', source: 'registry', cadence: 'daily', next_run_at: '2026-10-11T08:00:00.000Z',
    });
    expect((await store.getSchedule('c1', 'registry'))?.expires_at).toBeNull();
  });

  it('never returns an expired schedule from dueSchedules()', async () => {
    await schedule('expired', PAST);
    expect(await store.dueSchedules(NOW)).toEqual([]);
  });

  it('returns a schedule with a future expiry normally', async () => {
    await schedule('watching', FUTURE);
    expect((await store.dueSchedules(NOW)).map((s) => s.company_id)).toEqual(['watching']);
  });

  it('still returns a schedule written before expires_at existed', async () => {
    await db.collection('schedules').insertOne({
      book_id: BOOK, company_id: 'legacy', source: 'registry', cadence: 'daily',
      next_run_at: '2026-10-11T08:00:00.000Z', last_run_at: null, enabled: true,
    });
    expect((await store.dueSchedules(NOW)).map((s) => s.company_id)).toEqual(['legacy']);
  });

  it('disableExpiredSchedules turns off ended watches and nothing else', async () => {
    await schedule('expired', PAST);
    await schedule('watching', FUTURE);
    await schedule('monitored', null);
    expect(await store.disableExpiredSchedules(NOW)).toBe(1);
    expect((await store.getSchedule('expired', 'registry'))?.enabled).toBe(false);
    expect((await store.getSchedule('watching', 'registry'))?.enabled).toBe(true);
    expect((await store.getSchedule('monitored', 'registry'))?.enabled).toBe(true);
    // Idempotent: a second reap has nothing left to do.
    expect(await store.disableExpiredSchedules(NOW)).toBe(0);
  });
});

describe('a lookup is a companies document without monitoring_since', () => {
  it('writes lookup on insert and no monitoring_since', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput({ lookup }));
    const doc = await store.getCompany(company_id);
    expect(doc?.lookup).toEqual(lookup);
    expect(doc).not.toHaveProperty('monitoring_since');
  });

  it('does not backfill schedules for a prospect: a lookup is one shot', async () => {
    await store.upsertCompany(aCompanyInput({ lookup }));
    const monitored = await store.upsertCompany(aCompanyInput({
      registry_id: 'gb-87654321', canonical_name: 'Monitored Ltd', monitoring_since: '2026-09-01',
    }));
    const promoted = await store.upsertCompany(aCompanyInput({
      registry_id: 'gb-11111111', canonical_name: 'Promoted Ltd', lookup, monitoring_since: '2026-10-11',
    }));
    const orphans = (await store.companiesWithoutSchedules()).map((c) => c.company_id).sort();
    expect(orphans).toEqual([monitored.company_id, promoted.company_id].sort());
  });

  it('lookupIntents returns uncollected lookups only, oldest first', async () => {
    const later = await store.upsertCompany(aCompanyInput({
      registry_id: 'gb-2', canonical_name: 'Later Ltd',
      lookup: { ...lookup, requested_at: '2026-10-11T10:00:00.000Z' },
    }));
    const first = await store.upsertCompany(aCompanyInput({ registry_id: 'gb-1', canonical_name: 'First Ltd', lookup }));
    const collected = await store.upsertCompany(aCompanyInput({
      registry_id: 'gb-3', canonical_name: 'Collected Ltd', lookup, last_checked_at: '2026-10-10T10:00:00.000Z',
    }));
    await store.upsertCompany(aCompanyInput({ registry_id: 'gb-4', canonical_name: 'Plain Ltd' }));
    expect((await store.lookupIntents(10)).map((c) => c.company_id)).toEqual([first.company_id, later.company_id]);
    expect((await store.lookupIntents()).map((c) => c.company_id)).toEqual([first.company_id]);
    expect(collected.company_id).toBeDefined();
  });

  it('lookupIntents skips an intent the resolver already parked, so it is not re-billed every tick', async () => {
    const manual = await store.upsertCompany(aCompanyInput({ registry_id: '', canonical_name: 'Unknown Co', lookup }));
    expect((await store.lookupIntents(10)).map((c) => c.company_id)).toEqual([manual.company_id]);
    await store.setResolution(manual.company_id, { confidence: 0.4, reason: 'Partial overlap only.' });
    expect((await store.getCompany(manual.company_id))?.resolution.resolved_by).toBe(AUTO_RESOLVER);
    expect(await store.lookupIntents(10)).toEqual([]);
  });

  it('setMonitoringSince keeps the first day it was set', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput({ lookup }));
    expect(await store.setMonitoringSince(company_id, '2026-10-11')).toBe('2026-10-11');
    expect(await store.setMonitoringSince(company_id, '2026-10-20')).toBe('2026-10-11');
    expect((await store.getCompany(company_id))?.lookup).toEqual(lookup);
  });

  it('creditsSpentOnLookups counts prospects only', async () => {
    const prospect = await store.upsertCompany(aCompanyInput({ lookup }));
    const monitored = await store.upsertCompany(aCompanyInput({
      registry_id: 'gb-9', canonical_name: 'Monitored Ltd', monitoring_since: '2026-09-01',
    }));
    for (const [company_id, credits] of [[prospect.company_id, 5], [monitored.company_id, 7]] as const) {
      const run = await store.startRun({
        run_id: `run-${company_id}`, batch_id: `batch-${company_id}-2026-10-11`, company_id, source: 'registry',
      });
      await store.finishRun(run, { status: 'ok', credits_spent: credits });
    }
    expect(await store.creditsSpentOnLookups()).toBe(5);
    expect(await store.creditsSpentTotal()).toBe(12);
  });
});
