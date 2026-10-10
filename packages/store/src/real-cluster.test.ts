/**
 * Env-gated smoke test against the REAL MongoDB cluster.
 *
 * SKIPPED unless both MONGODB_URI and MONGODB_DATABASE are set, so the default
 * `npx vitest run packages/store` stays offline and credential-free.
 *
 * To run it:
 *   set -a; source .env.local; set +a
 *   npx vitest run packages/store/src/real-cluster.test.ts
 *
 * SAFETY -- this writes to a live database another team reads:
 *   - every document goes under book_id `test-book-<uuid>`, minted fresh per
 *     run, so it cannot collide with a real book;
 *   - the suite refuses to start if that id looks anything like DONNA_BOOK_ID;
 *   - afterAll deletes everything under that book id from every collection and
 *     asserts the deletions were complete;
 *   - no credential is ever hardcoded here.
 *
 * It DOES create indexes on the real cluster, including the Track C ones. That
 * is deliberate: proving `createIndex` is a no-op against production is the
 * single most valuable thing this file can check (see indexes.ts for why a
 * mismatch would break every Track C write with a generic 503).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { isoNow } from '@donna/contracts';
import { AUTO_RESOLVER, COLLECTIONS } from './index.js';
import { DonnaStore } from './store.js';
import {
  aBriefingInput, aClusterInput, aCompanyInput, aCoverage, aSignalInput, aSnapshotInput,
} from './testdata.js';

const URI = process.env.MONGODB_URI;
const DATABASE = process.env.MONGODB_DATABASE;
const enabled = Boolean(URI && DATABASE);

/** Obviously disposable, and unique per run. */
const TEST_BOOK = `test-book-${randomUUID()}`;
const TEST_COMPANY = `test-company-${randomUUID()}`;
const ALL_COLLECTIONS = Object.values(COLLECTIONS).filter((c) => c !== COLLECTIONS.authLinks);

let client: MongoClient;
let store: DonnaStore;

describe.skipIf(!enabled)('real cluster smoke test', () => {
  beforeAll(async () => {
    // Belt and braces: never run under anything that could be a real book.
    expect(TEST_BOOK.startsWith('test-book-')).toBe(true);
    expect(TEST_BOOK).not.toBe(process.env.DONNA_BOOK_ID);

    client = new MongoClient(URI!);
    await client.connect();
    store = DonnaStore.fromClient(client, { database: DATABASE!, bookId: TEST_BOOK });

    // Our namespace must start empty, or a previous run leaked.
    for (const collection of ALL_COLLECTIONS) {
      const leftover = await client.db(DATABASE!).collection(collection)
        .countDocuments({ book_id: TEST_BOOK });
      expect(leftover, `${collection} already has documents for ${TEST_BOOK}`).toBe(0);
    }
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    try {
      expect(TEST_BOOK).not.toBe(process.env.DONNA_BOOK_ID);
      for (const collection of ALL_COLLECTIONS) {
        await client.db(DATABASE!).collection(collection).deleteMany({ book_id: TEST_BOOK });
        const left = await client.db(DATABASE!).collection(collection)
          .countDocuments({ book_id: TEST_BOOK });
        expect(left, `failed to clean up ${collection}`).toBe(0);
      }
    } finally {
      await client.close();
    }
  }, 60_000);

  it('createIndex is a no-op against the live cluster, in both directions', async () => {
    const db = client.db(DATABASE!);
    await store.ensureIndexes();
    await store.ensureIndexes();

    // Exactly what Track C's backend issues on every request. If our specs had
    // drifted, this is where IndexOptionsConflict would surface -- here, in a
    // test, instead of as a 503 in their app.
    await expect(db.collection('companies').createIndex(
      { book_id: 1, jurisdiction: 1, registry_key: 1 }, { unique: true },
    )).resolves.toBe('book_id_1_jurisdiction_1_registry_key_1');
    await expect(db.collection('companies').createIndex(
      { book_id: 1, company_id: 1 }, { unique: true },
    )).resolves.toBe('book_id_1_company_id_1');
    await expect(db.collection('deals').createIndex(
      { book_id: 1, created_date: -1, deal_id: -1 },
    )).resolves.toBe('book_id_1_created_date_-1_deal_id_-1');
    await expect(db.collection('deals').createIndex(
      { book_id: 1, status: 1, company_id: 1 },
    )).resolves.toBe('book_id_1_status_1_company_id_1');
  }, 60_000);

  it('writes a company, snapshot, signal and briefing and reads them back', async () => {
    const company = await store.upsertCompany(aCompanyInput({
      company_id: TEST_COMPANY,
      canonical_name: `ZZ Disposable Test Co ${TEST_BOOK}`,
      jurisdiction: 'GB',
      registry_id: `TEST-${TEST_BOOK}`,
    }));
    expect(company.company_id).toBe(TEST_COMPANY);

    await store.setCoverage(TEST_COMPANY, aCoverage({ checked: ['registry'], failed: [] }));
    await store.setResolution(TEST_COMPANY, { confidence: 0.99, reason: 'smoke test' });

    const snapshotIdValue = `snap-${TEST_COMPANY}-registry`;
    const snapshot = await store.insertSnapshot(aSnapshotInput({
      snapshot_id: snapshotIdValue, company_id: TEST_COMPANY,
      run_id: `run-${TEST_COMPANY}-registry`, fetched_at: isoNow(),
    }));
    expect(snapshot.inserted).toBe(true);
    // Immutability holds against the real unique index too.
    expect((await store.insertSnapshot(aSnapshotInput({
      snapshot_id: snapshotIdValue, company_id: TEST_COMPANY,
      run_id: `run-${TEST_COMPANY}-registry`, fetched_at: isoNow(),
    }))).inserted).toBe(false);

    const signal = await store.upsertSignal(aSignalInput({
      company_id: TEST_COMPANY,
      evidence: [{
        snapshot_id: snapshotIdValue, source: 'registry', trust: 'primary',
        excerpt: 'smoke test excerpt', url: 'https://example.invalid/smoke',
      }],
    }));
    expect(signal.outcome).toBe('created');

    await store.putCluster(aClusterInput({
      cluster_id: `cl-${TEST_COMPANY}`, company_id: TEST_COMPANY,
      signals: [signal.signal_id],
    }));
    await store.putBriefing(aBriefingInput({
      briefing_id: `br-${TEST_COMPANY}`, company_id: TEST_COMPANY,
      cluster_id: `cl-${TEST_COMPANY}`,
      what_changed: [{ text: 'Smoke test change.', signal_id: signal.signal_id }],
      citations: {
        headline: [signal.signal_id], why_it_matters: [signal.signal_id],
        deal_context: [], verify: [], confidence_note: [],
      },
      generated_at: isoNow(),
    }));

    // --- read back -------------------------------------------------------
    const stored = await store.getCompany(TEST_COMPANY);
    expect(stored?.book_id).toBe(TEST_BOOK);
    expect(stored?.registry_key).toBe(`TEST-${TEST_BOOK}`.toUpperCase());
    expect(stored?.coverage?.checked).toEqual(['registry']);
    expect(stored?.resolution.resolved_by).toBe(AUTO_RESOLVER);

    expect((await store.latestOkSnapshot(TEST_COMPANY, 'registry'))?.snapshot_id)
      .toBe(snapshotIdValue);
    expect((await store.getSignal(signal.signal_id))?.evidence).toHaveLength(1);
    expect((await store.getCluster(`cl-${TEST_COMPANY}`))?.company_id).toBe(TEST_COMPANY);
    expect((await store.latestBriefing(TEST_COMPANY, 'briefing'))?.briefing_id)
      .toBe(`br-${TEST_COMPANY}`);

    // The book filter works against REAL neighbouring data: the live cluster
    // holds other books' companies, and we see exactly one.
    const mine = await store.listCompanies();
    expect(mine).toHaveLength(1);
    expect(mine[0]?.company_id).toBe(TEST_COMPANY);
  }, 120_000);

  it('a run, a schedule and the reaper work against the real cluster', async () => {
    const run = await store.startRun({
      run_id: `run-${TEST_COMPANY}-news`,
      batch_id: `batch-${TEST_COMPANY}-smoke`,
      company_id: TEST_COMPANY,
      source: 'news',
      started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    await store.upsertSchedule({
      company_id: TEST_COMPANY, source: 'news', cadence: 'daily',
      next_run_at: '2026-01-01T00:00:00.000Z',
    });
    expect((await store.dueSchedules()).map((s) => s.company_id)).toEqual([TEST_COMPANY]);

    const reaped = await store.reapStaleRuns(10);
    expect(reaped.reaped).toBe(1);
    expect(reaped.schedules_pushed).toBe(1);
    expect((await store.getRun(run))?.status).toBe('failed');
    expect(await store.dueSchedules()).toHaveLength(0);

    await store.putCached('https://example.invalid/smoke', { v: 1 });
    expect(await store.getCached('https://example.invalid/smoke')).toEqual({ v: 1 });
  }, 60_000);
});
