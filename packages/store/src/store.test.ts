import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { isoNow, signalId } from '@donna/contracts';
import { AUTO_RESOLVER, DONNA_INDEXES } from './index.js';
import { DonnaStore } from './store.js';
import { StoreError, StoreValidationError } from './validate.js';
import {
  aBriefingInput, aClusterInput, aCompanyInput, aCoverage, aSignalInput, aSnapshotInput,
} from './testdata.js';

const DB = 'donna_store_test';
const BOOK = 'book-under-test';
const OTHER_BOOK = 'book-belonging-to-someone-else';

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

/**
 * Track C's company write, reproduced verbatim in spirit: an upsert on
 * {book_id, jurisdiction, registry_key} whose ONLY operator is $setOnInsert.
 * Several tests below exist because of this shape.
 */
function trackCUpsertCompany(doc: {
  book_id: string; company_id: string; canonical_name: string;
  jurisdiction: string; registry_id: string; registry_key: string;
}) {
  return db.collection('companies').updateOne(
    { book_id: doc.book_id, jurisdiction: doc.jurisdiction, registry_key: doc.registry_key },
    { $setOnInsert: doc },
    { upsert: true },
  );
}

// ===========================================================================
// RULE 1 -- book_id on every document, on every read
// ===========================================================================
describe('rule 1: book_id is structural, not a convention', () => {
  it('a store cannot exist without a usable book id', async () => {
    expect(() => DonnaStore.fromClient(client, { database: DB, bookId: '' })).toThrow(StoreError);
    expect(() => DonnaStore.fromClient(client, { database: DB, bookId: '   ' }))
      .toThrow(/non-empty bookId/);
    expect(() => DonnaStore.fromClient(client, { database: DB, bookId: undefined as unknown as string }))
      .toThrow(StoreError);
    await expect(DonnaStore.connect({ uri: mongod.getUri(), database: DB, bookId: '' }))
      .rejects.toThrow(/non-empty bookId/);
  });

  it('a write that tries to supply its own book_id is refused', async () => {
    // The input types have no book_id field at all, so this is only reachable
    // from JS -- which is exactly the caller we have to defend against.
    await expect(store.insertSnapshot({ ...aSnapshotInput(), book_id: OTHER_BOOK } as never))
      .rejects.toThrow(/stamps it/);
    await expect(store.upsertCompany({ ...aCompanyInput(), book_id: OTHER_BOOK } as never))
      .rejects.toThrow(/stamps it/);
    await expect(store.upsertSignal({ ...aSignalInput(), book_id: OTHER_BOOK } as never))
      .rejects.toThrow(/stamps it/);
    expect(await db.collection('snapshots').countDocuments({})).toBe(0);
    expect(await db.collection('companies').countDocuments({})).toBe(0);
    expect(await db.collection('signals').countDocuments({})).toBe(0);
  });

  it('stamps our book_id on every collection we write', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput());
    await store.insertSnapshot(aSnapshotInput({ company_id }));
    await store.insertChanges([{
      company_id, source: 'registry', kind: 'added',
      item: { key: 'officer:jane-doe', type: 'officer' }, previous: null,
      snapshot_id: 'snap-c1-registry-1', baseline_id: 'snap-c1-registry-0',
      detected_at: '2026-03-01T10:05:00.000Z',
    }]);
    await store.upsertSignal(aSignalInput({ company_id }));
    await store.putCluster(aClusterInput({ company_id }));
    await store.putBriefing(aBriefingInput({ company_id }));
    const run = await store.startRun({
      run_id: 'run-x-registry', batch_id: 'batch-x-2026-03-01', company_id, source: 'registry',
    });
    await store.finishRun(run, { status: 'ok', credits_spent: 1 });
    await store.upsertSchedule({
      company_id, source: 'registry', cadence: 'daily', next_run_at: isoNow(),
    });
    await store.putCached('https://registry.example/x', { body: 'hi' });

    for (const name of [
      'companies', 'snapshots', 'changes', 'signals', 'clusters',
      'briefings', 'collector_runs', 'schedules', 'fetch_cache',
    ]) {
      const total = await db.collection(name).countDocuments({});
      const scoped = await db.collection(name).countDocuments({ book_id: BOOK });
      expect(total, `${name} should have documents`).toBeGreaterThan(0);
      expect(scoped, `${name} has a document without our book_id`).toBe(total);
    }
  });

  it('reads never cross books', async () => {
    const other = DonnaStore.fromClient(client, { database: DB, bookId: OTHER_BOOK });
    const mine = await store.upsertCompany(aCompanyInput());
    await store.insertSnapshot(aSnapshotInput({ company_id: mine.company_id }));
    await store.upsertSignal(aSignalInput({ company_id: mine.company_id }));

    expect(await other.getCompany(mine.company_id)).toBeNull();
    expect(await other.listCompanies()).toHaveLength(0);
    expect(await other.latestOkSnapshot(mine.company_id, 'registry')).toBeNull();
    expect(await other.signalsForCompany(mine.company_id)).toHaveLength(0);
    // ...and mine is still there, i.e. the isolation is real, not an empty db.
    expect(await store.getCompany(mine.company_id)).not.toBeNull();
  });

  it('refuses a hand-written book_id in a filter', () => {
    // scope() is private; reached through a method that takes a raw filter is
    // not possible by design, so assert the guard directly.
    expect(() => (store as unknown as { scope: (e: object) => void })
      .scope({ book_id: OTHER_BOOK })).toThrow(/scopes every query/);
  });
});

// ===========================================================================
// RULE 2 -- index specs byte-identical to Track C's
// ===========================================================================
describe('rule 2: index specs cannot conflict with Track C', () => {
  const nameOf = async (collection: string) =>
    (await db.collection(collection).indexes()).map((i) => i.name);

  it("reproduces Track C's exact index names on companies and deals", async () => {
    expect(await nameOf('companies')).toEqual(expect.arrayContaining([
      '_id_',
      'book_id_1_jurisdiction_1_registry_key_1',
      'book_id_1_company_id_1',
    ]));
    expect(await nameOf('deals')).toEqual(expect.arrayContaining([
      '_id_',
      'book_id_1_created_date_-1_deal_id_-1',
      'book_id_1_status_1_company_id_1',
    ]));
  });

  it("keeps Track C's unique flags exactly where Track C has them", async () => {
    const companies = await db.collection('companies').indexes();
    const byKey = companies.find((i) => i.name === 'book_id_1_jurisdiction_1_registry_key_1');
    const byId = companies.find((i) => i.name === 'book_id_1_company_id_1');
    expect(byKey?.unique).toBe(true);
    expect(byId?.unique).toBe(true);

    const deals = await db.collection('deals').indexes();
    for (const name of ['book_id_1_created_date_-1_deal_id_-1', 'book_id_1_status_1_company_id_1']) {
      expect(deals.find((i) => i.name === name)?.unique).toBeUndefined();
    }
  });

  it('is idempotent: ensureIndexes twice changes nothing and throws nothing', async () => {
    const before = await Promise.all(
      ['companies', 'deals', 'snapshots', 'signals', 'collector_runs', 'schedules', 'fetch_cache']
        .map(async (c) => [c, (await db.collection(c).indexes()).length] as const),
    );
    await store.ensureIndexes();
    await store.ensureIndexes();
    for (const [c, count] of before) {
      expect((await db.collection(c).indexes()).length, c).toBe(count);
    }
  });

  it('Track C can still create its own indexes afterwards (the whole point)', async () => {
    // Byte-for-byte what Track C's backend issues on EVERY request. If any of
    // our specs differed, this would raise IndexOptionsConflict, which Track C
    // swallows into a 503 and every one of its writes would fail.
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
  });

  it('demonstrates the hazard is real: the same keys under our own name DO conflict', async () => {
    // This is why indexes.ts passes no `name` on Track C's collections. Delete
    // this test and the next person will "tidy up" those specs.
    await expect(db.collection('companies').createIndex(
      { book_id: 1, jurisdiction: 1, registry_key: 1 },
      { unique: true, name: 'donna_companies_registry_key' },
    )).rejects.toThrow(/already exists/i);
  });

  it('names every index on our own collections with a donna_ prefix', () => {
    const ours = DONNA_INDEXES.filter((d) => !['companies', 'deals'].includes(d.collection));
    expect(ours.length).toBeGreaterThan(10);
    for (const def of ours) expect(def.options?.name).toMatch(/^donna_/);
    // ...and our extra index on Track C's `deals` deliberately has NO name, so
    // it lands on Mongo's default and a future Track C createIndex is a no-op.
    const dealsExtra = DONNA_INDEXES.find((d) => d.collection === 'deals');
    expect(dealsExtra?.options?.name).toBeUndefined();
  });

  it('indexes the queries we actually run', async () => {
    const snapshots = await db.collection('snapshots').indexes();
    expect(snapshots.find((i) => i.name === 'donna_snapshots_baseline')?.key)
      .toEqual({ book_id: 1, company_id: 1, source: 1, fetched_at: -1 });
    expect(snapshots.find((i) => i.name === 'donna_snapshots_snapshot_id')?.unique).toBe(true);

    const signals = await db.collection('signals').indexes();
    expect(signals.find((i) => i.name === 'donna_signals_corroboration')?.key)
      .toEqual({ book_id: 1, company_id: 1, type: 1, first_seen: 1 });

    const runs = await db.collection('collector_runs').indexes();
    expect(runs.find((i) => i.name === 'donna_runs_batch')?.key).toEqual({ book_id: 1, batch_id: 1 });
    expect(runs.find((i) => i.name === 'donna_runs_reaper')?.key)
      .toEqual({ book_id: 1, status: 1, started_at: 1 });

    const schedules = await db.collection('schedules').indexes();
    expect(schedules.find((i) => i.name === 'donna_schedules_due')?.key)
      .toEqual({ book_id: 1, next_run_at: 1 });
    expect(schedules.find((i) => i.name === 'donna_schedules_identity')?.unique).toBe(true);

    const cache = await db.collection('fetch_cache').indexes();
    expect(cache.find((i) => i.name === 'donna_fetch_cache_key')?.unique).toBe(true);
    expect(cache.find((i) => i.name === 'donna_fetch_cache_ttl')?.expireAfterSeconds).toBe(0);

    const deals = await db.collection('deals').indexes();
    expect(deals.find((i) => i.name === 'book_id_1_company_id_1')?.key)
      .toEqual({ book_id: 1, company_id: 1 });
  });
});

// ===========================================================================
// RULE 3 -- coverage via $set, never $setOnInsert
// ===========================================================================
describe('rule 3: coverage is written with $set', () => {
  it('upsertCompany never writes coverage at all', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput());
    expect((await store.getCompany(company_id))?.coverage).toBeUndefined();
  });

  it('coverage survives a subsequent Track-C-style $setOnInsert upsert', async () => {
    const input = aCompanyInput();
    const { company_id } = await store.upsertCompany(input);
    await store.setCoverage(company_id, aCoverage({ checked: ['registry', 'news'], failed: ['court'] }));

    // The user presses "Add company" again in Track C. Same unique key, so
    // nothing is inserted and the whole $setOnInsert block is discarded.
    const res = await trackCUpsertCompany({
      book_id: BOOK,
      company_id: 'a-brand-new-uuid-from-track-c',
      canonical_name: 'Northwind Trading Ltd',
      jurisdiction: 'GB',
      registry_id: 'gb-12345678',
      registry_key: 'GB-12345678',
    });
    expect(res.upsertedCount).toBe(0);

    const after = await store.getCompany(company_id);
    expect(after?.coverage?.checked).toEqual(['registry', 'news']);
    expect(after?.coverage?.failed).toEqual(['court']);
    expect(after?.company_id).toBe(company_id);
  });

  it('shows WHY: coverage inside a $setOnInsert block never lands', async () => {
    // The counterfactual. If setCoverage is ever "simplified" into the upsert's
    // $setOnInsert block, this is the silent failure you get.
    const { company_id } = await store.upsertCompany(aCompanyInput());
    await db.collection('companies').updateOne(
      { book_id: BOOK, jurisdiction: 'GB', registry_key: 'GB-12345678' },
      { $setOnInsert: { coverage: aCoverage() } },
      { upsert: true },
    );
    expect((await store.getCompany(company_id))?.coverage).toBeUndefined();
  });

  it('validates coverage and stamps as_of', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput());
    await expect(store.setCoverage(company_id, { checked: ['nope'] } as never))
      .rejects.toThrow(StoreValidationError);
    await store.setCoverage(company_id, aCoverage());
    const c = await store.getCompany(company_id);
    expect(c?.coverage?.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(c?.last_checked_at).toBe(c?.coverage?.as_of);
  });

  it('refuses to write coverage for a company that is not in this book', async () => {
    await expect(store.setCoverage('no-such-company', aCoverage()))
      .rejects.toThrow(/no company/);
  });
});

// ===========================================================================
// RULE 4 -- canonical_name is never rewritten
// ===========================================================================
describe('rule 4: canonical_name is never rewritten', () => {
  it('puts a different incoming name into aliases[] instead', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput());
    const again = await store.upsertCompany(aCompanyInput({
      canonical_name: 'NORTHWIND TRADING LIMITED',
      aliases: ['Northwind'],
      domains: ['northwind.co.example'],
    }));
    expect(again.company_id).toBe(company_id);
    expect(again.outcome).toBe('updated');

    const c = await store.getCompany(company_id);
    expect(c?.canonical_name).toBe('Northwind Trading Ltd');
    expect(c?.aliases).toEqual(expect.arrayContaining(['NORTHWIND TRADING LIMITED', 'Northwind']));
    expect(c?.domains).toEqual(expect.arrayContaining(['northwind.example', 'northwind.co.example']));
  });

  it('does not alias a name that differs only by case (Track C compares case-insensitively)', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput());
    await store.upsertCompany(aCompanyInput({ canonical_name: 'northwind trading ltd' }));
    const c = await store.getCompany(company_id);
    expect(c?.canonical_name).toBe('Northwind Trading Ltd');
    expect(c?.aliases).not.toContain('northwind trading ltd');
  });

  it('never clobbers a hand-entered officer list with an empty one', async () => {
    const { company_id } = await store.upsertCompany(
      aCompanyInput({ officers: [{ name: 'Jane Doe' }] }),
    );
    await store.upsertCompany(aCompanyInput({ officers: [] }));
    expect((await store.getCompany(company_id))?.officers).toEqual([{ name: 'Jane Doe' }]);
  });
});

// ===========================================================================
// RULE 5 -- the auto_resolver sentinel
// ===========================================================================
describe('rule 5: automated resolutions are labelled', () => {
  it('exports the sentinel Track C and we both read', () => {
    expect(AUTO_RESOLVER).toBe('auto_resolver');
  });

  it('defaults resolved_by to auto_resolver', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput());
    await store.setResolution(company_id, { confidence: 0.92, reason: 'exact registry id match' });
    const c = await store.getCompany(company_id);
    expect(c?.resolution.resolved_by).toBe(AUTO_RESOLVER);
    expect(c?.resolution.confidence).toBe(0.92);
    expect(c?.resolution.resolved_at).toMatch(/Z$/);
  });

  it('keeps a human resolution distinguishable', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput());
    await store.setResolution(company_id, {
      confidence: 1, reason: 'operator picked candidate 2', resolved_by: 'ops@example.com',
    });
    expect((await store.getCompany(company_id))?.resolution.resolved_by).toBe('ops@example.com');
  });
});

// ===========================================================================
// RULE 6 -- snapshots are immutable
// ===========================================================================
describe('rule 6: snapshots are immutable', () => {
  it('offers no update or delete path', () => {
    const surface = store as unknown as Record<string, unknown>;
    for (const forbidden of [
      'updateSnapshot', 'deleteSnapshot', 'removeSnapshot', 'replaceSnapshot', 'putSnapshot',
    ]) {
      expect(surface[forbidden], forbidden).toBeUndefined();
    }
  });

  it('re-inserting the same snapshot_id is an idempotent no-op', async () => {
    const first = await store.insertSnapshot(aSnapshotInput());
    expect(first).toEqual({ snapshot_id: 'snap-c1-registry-1', inserted: true });

    // Same id, different body -- a retried collector run. Not an error, not a
    // duplicate, and the original is untouched.
    const second = await store.insertSnapshot(aSnapshotInput({
      raw_excerpt: 'a different excerpt entirely',
      items: [{ key: 'officer:someone-else', type: 'officer' }],
    }));
    expect(second).toEqual({ snapshot_id: 'snap-c1-registry-1', inserted: false });

    expect(await db.collection('snapshots').countDocuments({})).toBe(1);
    expect((await store.getSnapshot('snap-c1-registry-1'))?.raw_excerpt)
      .toBe('Jane Doe appointed director 2026-02-27');
  });

  it('computes a stable content_hash when one is not supplied', async () => {
    await store.insertSnapshot(aSnapshotInput());
    const a = await store.getSnapshot('snap-c1-registry-1');
    await store.insertSnapshot(aSnapshotInput({ snapshot_id: 'snap-c1-registry-2' }));
    const b = await store.getSnapshot('snap-c1-registry-2');
    expect(a?.content_hash).toBe(b?.content_hash);
    expect(a?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a failed fetch: a snapshot only exists for a successful one', async () => {
    await expect(store.insertSnapshot(aSnapshotInput({ ok: false as never })))
      .rejects.toThrow(StoreValidationError);
    expect(await db.collection('snapshots').countDocuments({})).toBe(0);
  });
});

// ===========================================================================
// RULE 7 -- MANUAL: registry_key backfill, clean and colliding
// ===========================================================================
describe('rule 7: company upsert and the MANUAL: backfill', () => {
  it('keys on {book_id, jurisdiction, registry_key} and uppercases the registry id', async () => {
    const { company_id } = await store.upsertCompany(aCompanyInput({ registry_id: 'gb-12345678' }));
    const doc = await db.collection('companies').findOne({ book_id: BOOK, company_id });
    expect(doc?.registry_key).toBe('GB-12345678');
    expect(doc?.registry_id).toBe('gb-12345678');

    // A second upsert of the same registry id is the SAME company, whatever
    // case the caller used.
    const again = await store.upsertCompany(aCompanyInput({ registry_id: 'GB-12345678' }));
    expect(again.company_id).toBe(company_id);
    expect(await db.collection('companies').countDocuments({ book_id: BOOK })).toBe(1);
  });

  it('mints MANUAL:<uuid> when there is no registry id', async () => {
    const a = await store.upsertCompany(aCompanyInput({ registry_id: '' }));
    const b = await store.upsertCompany(aCompanyInput({ registry_id: undefined }));
    const docs = await db.collection('companies').find({ book_id: BOOK }).toArray();
    expect(a.company_id).not.toBe(b.company_id);
    expect(docs).toHaveLength(2);
    for (const d of docs) expect(d.registry_key).toMatch(/^MANUAL:[0-9a-f-]{36}$/);
  });

  it('CLEAN BACKFILL: nothing owns the target key, so the document moves onto it', async () => {
    const manual = await store.upsertCompany(aCompanyInput({ registry_id: '' }));
    await store.setCoverage(manual.company_id, aCoverage());

    const out = await store.backfillRegistryId(manual.company_id, 'gb-99999999');
    expect(out).toEqual({
      outcome: 'backfilled', company_id: manual.company_id, registry_key: 'GB-99999999',
    });

    const c = await store.getCompany(manual.company_id);
    expect(c?.registry_key).toBe('GB-99999999');
    expect(c?.registry_id).toBe('gb-99999999');
    // Everything else, coverage included, is still there.
    expect(c?.coverage?.checked).toEqual(['registry']);
    expect(await db.collection('companies').countDocuments({ book_id: BOOK })).toBe(1);
  });

  it('COLLIDING BACKFILL: a canonical document already owns the key, so we merge', async () => {
    // Track C added this one by hand, and the user linked two deals to it.
    const manual = await store.upsertCompany(aCompanyInput({
      canonical_name: 'Northwind (manual entry)',
      registry_id: '',
      domains: ['northwind-manual.example'],
      aliases: ['NW manual'],
    }));
    await db.collection('deals').insertMany([
      {
        book_id: BOOK, deal_id: 'deal-1', company_id: manual.company_id,
        counterparty_name: 'Northwind (manual entry)', country: 'GB',
        deal_class: 'they_pay_us', annual_value_usd: 250_000, status: 'resolved',
      },
      {
        book_id: BOOK, deal_id: 'deal-2', company_id: manual.company_id,
        counterparty_name: 'Northwind (manual entry)', country: 'GB',
        deal_class: 'we_pay_them', annual_value_usd: 40_000, status: 'resolved',
      },
    ]);
    // ...and a deal in another book that must NOT move.
    await db.collection('deals').insertOne({
      book_id: OTHER_BOOK, deal_id: 'deal-other', company_id: manual.company_id,
      counterparty_name: 'x', country: 'GB', deal_class: 'tied',
      annual_value_usd: 1, status: 'resolved',
    });

    // Meanwhile we resolved the same company properly from the registry.
    const canonical = await store.upsertCompany(aCompanyInput({
      canonical_name: 'Northwind Trading Ltd', registry_id: 'gb-12345678',
    }));
    expect(canonical.company_id).not.toBe(manual.company_id);
    expect(await db.collection('companies').countDocuments({ book_id: BOOK })).toBe(2);

    // A blind $set of registry_key here would be E11000 -> Track C 503.
    const out = await store.backfillRegistryId(manual.company_id, 'gb-12345678');
    expect(out).toEqual({
      outcome: 'merged',
      company_id: canonical.company_id,
      removed_company_id: manual.company_id,
      registry_key: 'GB-12345678',
      deals_moved: 2,
    });

    // The canonical document survives, with its own name intact (rule 4).
    const survivor = await store.getCompany(canonical.company_id);
    expect(survivor?.canonical_name).toBe('Northwind Trading Ltd');
    expect(survivor?.aliases).toEqual(expect.arrayContaining(['Northwind (manual entry)', 'NW manual']));
    expect(survivor?.domains).toEqual(expect.arrayContaining(['northwind-manual.example']));

    // The manual document is gone, and the user's deals came with it.
    expect(await store.getCompany(manual.company_id)).toBeNull();
    expect(await db.collection('companies').countDocuments({ book_id: BOOK })).toBe(1);
    const moved = await store.dealsForCompany(canonical.company_id);
    expect(moved.map((d) => d.deal_id).sort()).toEqual(['deal-1', 'deal-2']);
    // The other book's deal was not touched.
    expect(await db.collection('deals').findOne({ deal_id: 'deal-other' }))
      .toMatchObject({ company_id: manual.company_id });
  });

  it('upsertCompany delegates to the merge path when handed a known manual company_id', async () => {
    const manual = await store.upsertCompany(aCompanyInput({ registry_id: '' }));
    const canonical = await store.upsertCompany(aCompanyInput({
      canonical_name: 'Northwind Trading Ltd', registry_id: 'gb-12345678',
    }));
    const out = await store.upsertCompany(aCompanyInput({
      company_id: manual.company_id,
      canonical_name: 'Northwind Trading Ltd',
      registry_id: 'gb-12345678',
      aliases: ['Northwind GB'],
    }));
    expect(out).toEqual({ company_id: canonical.company_id, outcome: 'merged' });
    expect((await store.getCompany(canonical.company_id))?.aliases)
      .toEqual(expect.arrayContaining(['Northwind GB']));
  });

  it('a backfill to the key it already has is a no-op', async () => {
    const c = await store.upsertCompany(aCompanyInput({ registry_id: 'gb-12345678' }));
    expect(await store.backfillRegistryId(c.company_id, 'GB-12345678'))
      .toEqual({ outcome: 'noop', company_id: c.company_id });
  });

  it('refuses to repoint a company that already has a real registry key', async () => {
    const c = await store.upsertCompany(aCompanyInput({ registry_id: 'gb-12345678' }));
    await expect(store.backfillRegistryId(c.company_id, 'gb-87654321'))
      .rejects.toThrow(/not a MANUAL: placeholder/);
    expect((await store.getCompany(c.company_id))?.registry_key).toBe('GB-12345678');
  });

  it('refuses to merge away a manual company that already has evidence', async () => {
    const manual = await store.upsertCompany(aCompanyInput({ registry_id: '' }));
    await store.upsertCompany(aCompanyInput({ registry_id: 'gb-12345678' }));
    await store.insertSnapshot(aSnapshotInput({
      company_id: manual.company_id, snapshot_id: `snap-${manual.company_id}-registry`,
    }));
    await expect(store.backfillRegistryId(manual.company_id, 'gb-12345678'))
      .rejects.toThrow(/cannot merge/);
    // Nothing was destroyed by the refusal.
    expect(await store.getCompany(manual.company_id)).not.toBeNull();
    expect(await db.collection('companies').countDocuments({ book_id: BOOK })).toBe(2);
  });

  it('tolerates a real Track C company document, which omits half our schema', async () => {
    // The live cluster's companies look like this -- no aliases, domains,
    // officers or resolution. Reads must not validate, or we reject real data.
    await trackCUpsertCompany({
      book_id: BOOK, company_id: '7b040439-0ed6-4a4e-b3ae-6ab1161b4e98',
      canonical_name: 'Fictional Test Co', jurisdiction: 'US',
      registry_id: 'TEST-FICTIONAL-1', registry_key: 'TEST-FICTIONAL-1',
    });
    const c = await store.getCompany('7b040439-0ed6-4a4e-b3ae-6ab1161b4e98');
    expect(c?.canonical_name).toBe('Fictional Test Co');

    // And an upsert of the same company finds it rather than duplicating it.
    const out = await store.upsertCompany({
      canonical_name: 'Fictional Test Company Inc',
      jurisdiction: 'US',
      registry_id: 'test-fictional-1',
    });
    expect(out.company_id).toBe('7b040439-0ed6-4a4e-b3ae-6ab1161b4e98');
    expect((await store.getCompany(out.company_id))?.canonical_name).toBe('Fictional Test Co');
    expect((await store.getCompany(out.company_id))?.aliases)
      .toEqual(['Fictional Test Company Inc']);
  });
});

// ===========================================================================
// snapshots: the baseline lookup
// ===========================================================================
describe('latestOkSnapshot', () => {
  it('returns the newest ok snapshot and ignores failed ones', async () => {
    await store.insertSnapshot(aSnapshotInput({
      snapshot_id: 'snap-old', fetched_at: '2026-02-01T10:00:00.000Z',
    }));
    await store.insertSnapshot(aSnapshotInput({
      snapshot_id: 'snap-new', fetched_at: '2026-03-01T10:00:00.000Z',
    }));
    // A pre-contract / hand-written document with ok:false. Using one as a
    // baseline would read as "every officer was removed".
    await db.collection('snapshots').insertOne({
      ...aSnapshotInput({ snapshot_id: 'snap-failed', fetched_at: '2026-04-01T10:00:00.000Z' }),
      ok: false, book_id: BOOK, content_hash: 'x',
    });

    const latest = await store.latestOkSnapshot('c1', 'registry');
    expect(latest?.snapshot_id).toBe('snap-new');
  });

  it('is per (company, source) and per book', async () => {
    await store.insertSnapshot(aSnapshotInput({ snapshot_id: 's-reg', source: 'registry' }));
    await store.insertSnapshot(aSnapshotInput({
      snapshot_id: 's-news', source: 'news', fetched_at: '2026-04-01T10:00:00.000Z',
    }));
    expect((await store.latestOkSnapshot('c1', 'registry'))?.snapshot_id).toBe('s-reg');
    expect((await store.latestOkSnapshot('c1', 'news'))?.snapshot_id).toBe('s-news');
    expect(await store.latestOkSnapshot('c2', 'registry')).toBeNull();
  });
});

// ===========================================================================
// signals: the 14-day corroboration window
// ===========================================================================
describe('upsertSignal and the 14-day corroboration window', () => {
  const newsEvidence = {
    snapshot_id: 'snap-c1-news-1', source: 'news' as const, trust: 'reported' as const,
    excerpt: 'Northwind names interim CFO', url: 'https://news.example/1',
  };

  it('merges new evidence into an existing signal inside the window', async () => {
    const first = await store.upsertSignal(aSignalInput({ first_seen: '2026-03-01' }));
    expect(first).toEqual({
      signal_id: signalId('c1', 'officer_churn', '2026-03-01'), outcome: 'created',
    });

    const second = await store.upsertSignal(aSignalInput({
      first_seen: '2026-03-10',
      evidence: [newsEvidence],
      tier: 3,
      confidence: 'high',
      status: 'confirmed',
      touches_terms: ['change_of_control'],
    }));
    expect(second).toEqual({ signal_id: first.signal_id, outcome: 'merged' });

    const s = await store.getSignal(first.signal_id);
    expect(await db.collection('signals').countDocuments({ book_id: BOOK })).toBe(1);
    expect(s?.evidence).toHaveLength(2);
    expect(s?.first_seen).toBe('2026-03-01');  // "first" stays first
    expect(s?.tier).toBe(3);
    expect(s?.confidence).toBe('high');
    expect(s?.status).toBe('confirmed');
    expect(s?.touches_terms).toEqual(['change_of_control']);
  });

  it('creates a separate signal outside the window', async () => {
    const first = await store.upsertSignal(aSignalInput({ first_seen: '2026-03-01' }));
    const later = await store.upsertSignal(aSignalInput({
      first_seen: '2026-04-05', evidence: [newsEvidence],
    }));
    expect(later.outcome).toBe('created');
    expect(later.signal_id).not.toBe(first.signal_id);
    expect(later.signal_id).toBe(signalId('c1', 'officer_churn', '2026-04-05'));
    expect(await db.collection('signals').countDocuments({ book_id: BOOK })).toBe(2);
  });

  it('separates signals of a different type in the same window', async () => {
    await store.upsertSignal(aSignalInput({ first_seen: '2026-03-01' }));
    const other = await store.upsertSignal(aSignalInput({
      type: 'litigation', title: 'New claim filed', first_seen: '2026-03-02',
      evidence: [newsEvidence],
    }));
    expect(other.outcome).toBe('created');
    expect(await db.collection('signals').countDocuments({ book_id: BOOK })).toBe(2);
  });

  it('corroboration never weakens a signal', async () => {
    const first = await store.upsertSignal(aSignalInput({
      first_seen: '2026-03-01', tier: 3, confidence: 'high',
    }));
    await store.upsertSignal(aSignalInput({
      first_seen: '2026-03-03', tier: 1, confidence: 'low', evidence: [newsEvidence],
    }));
    const s = await store.getSignal(first.signal_id);
    expect(s?.tier).toBe(3);
    expect(s?.confidence).toBe('high');
  });

  it('does not duplicate identical evidence', async () => {
    const first = await store.upsertSignal(aSignalInput({ first_seen: '2026-03-01' }));
    await store.upsertSignal(aSignalInput({ first_seen: '2026-03-02' }));
    expect((await store.getSignal(first.signal_id))?.evidence).toHaveLength(1);
  });
});

// ===========================================================================
// collector_runs, the reaper, credits
// ===========================================================================
describe('collector_runs', () => {
  const start = (companyId: string, startedAt?: string) => store.startRun({
    run_id: `run-${companyId}-registry`,
    batch_id: `batch-${companyId}-2026-03-01`,
    company_id: companyId,
    source: 'registry',
    ...(startedAt ? { started_at: startedAt } : {}),
  });

  it('startRun then finishRun records status and credits', async () => {
    const handle = await start('c1');
    expect((await store.getRun(handle))?.status).toBe('started');
    await store.finishRun(handle, { status: 'ok', credits_spent: 4, cache_hit: true });
    const run = await store.getRun(handle);
    expect(run?.status).toBe('ok');
    expect(run?.credits_spent).toBe(4);
    expect(run?.cache_hit).toBe(true);
    expect(run?.ended_at).toMatch(/Z$/);
  });

  it('rejects a finishRun patch that would make the row invalid', async () => {
    const handle = await start('c1');
    await expect(store.finishRun(handle, { status: 'ok', credits_spent: -2 }))
      .rejects.toThrow(StoreValidationError);
    expect((await store.getRun(handle))?.status).toBe('started');
  });

  it('reapStaleRuns flips only runs older than the threshold', async () => {
    const fresh = await start('c-fresh', new Date(Date.now() - 2 * 60_000).toISOString());
    const stale = await start('c-stale', new Date(Date.now() - 25 * 60_000).toISOString());
    const done = await start('c-done', new Date(Date.now() - 25 * 60_000).toISOString());
    await store.finishRun(done, { status: 'ok', credits_spent: 1 });

    await store.upsertSchedule({
      company_id: 'c-stale', source: 'registry', cadence: 'daily',
      next_run_at: '2026-03-01T00:00:00.000Z',
    });

    const result = await store.reapStaleRuns(10);
    expect(result.reaped).toBe(1);
    expect(result.run_ids).toEqual(['run-c-stale-registry']);
    expect(result.schedules_pushed).toBe(1);

    expect((await store.getRun(stale))?.status).toBe('failed');
    expect((await store.getRun(stale))?.error).toMatch(/stale run reaped/);
    expect((await store.getRun(fresh))?.status).toBe('started');
    expect((await store.getRun(done))?.status).toBe('ok');

    // The schedule was pushed to the next slot, so a restart recovers itself.
    const schedule = await store.getSchedule('c-stale', 'registry');
    expect(new Date(schedule!.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(await store.dueSchedules()).toHaveLength(0);
  });

  it('reaping is a no-op when nothing is stale', async () => {
    await start('c1');
    expect(await store.reapStaleRuns(10)).toEqual({ reaped: 0, run_ids: [], schedules_pushed: 0 });
  });

  it('creditsSpentTotal sums the book and nothing else', async () => {
    const a = await start('c1');
    const b = await start('c2');
    await store.finishRun(a, { status: 'ok', credits_spent: 3 });
    await store.finishRun(b, { status: 'empty', credits_spent: 5 });
    const other = DonnaStore.fromClient(client, { database: DB, bookId: OTHER_BOOK });
    const c = await other.startRun({
      run_id: 'run-x-registry', batch_id: 'b', company_id: 'x', source: 'registry',
    });
    await other.finishRun(c, { status: 'ok', credits_spent: 100 });

    expect(await store.creditsSpentTotal()).toBe(8);
    expect(await other.creditsSpentTotal()).toBe(100);
  });

  it('runsForBatch finds the batch Track C links to', async () => {
    await start('c1');
    expect(await store.runsForBatch('batch-c1-2026-03-01')).toHaveLength(1);
  });
});

// ===========================================================================
// schedules
// ===========================================================================
describe('schedules', () => {
  it('dueSchedules returns enabled, past-due schedules oldest first', async () => {
    await store.upsertSchedule({
      company_id: 'c1', source: 'registry', cadence: 'daily',
      next_run_at: '2026-01-01T00:00:00.000Z',
    });
    await store.upsertSchedule({
      company_id: 'c2', source: 'news', cadence: 'weekly',
      next_run_at: '2025-12-01T00:00:00.000Z',
    });
    await store.upsertSchedule({
      company_id: 'c3', source: 'court', cadence: 'daily',
      next_run_at: '2099-01-01T00:00:00.000Z',
    });
    await store.upsertSchedule({
      company_id: 'c4', source: 'jobs', cadence: 'daily',
      next_run_at: '2026-01-01T00:00:00.000Z', enabled: false,
    });

    const due = await store.dueSchedules(new Date('2026-03-01T00:00:00.000Z'));
    expect(due.map((s) => s.company_id)).toEqual(['c2', 'c1']);
  });

  it('is one schedule per (company, source)', async () => {
    const input = {
      company_id: 'c1', source: 'registry' as const, cadence: 'daily' as const,
      next_run_at: '2026-01-01T00:00:00.000Z',
    };
    await store.upsertSchedule(input);
    await store.upsertSchedule({ ...input, cadence: 'weekly', next_run_at: '2026-02-01T00:00:00.000Z' });
    expect(await db.collection('schedules').countDocuments({ book_id: BOOK })).toBe(1);
    expect((await store.getSchedule('c1', 'registry'))?.cadence).toBe('weekly');
  });

  it('pushSchedule advances by the cadence and is false when there is nothing to push', async () => {
    const from = new Date('2026-03-01T00:00:00.000Z');
    await store.upsertSchedule({
      company_id: 'c1', source: 'registry', cadence: 'weekly',
      next_run_at: '2026-01-01T00:00:00.000Z',
    });
    expect(await store.pushSchedule('c1', 'registry', from)).toBe(true);
    expect((await store.getSchedule('c1', 'registry'))?.next_run_at)
      .toBe('2026-03-08T00:00:00.000Z');
    expect(await store.pushSchedule('nope', 'registry', from)).toBe(false);
  });

  it('normalises offset instants to UTC, so range queries are correct', async () => {
    // Mongo compares strings byte-wise; a "+05:30" instant sorts wrongly
    // against a "Z" one and the scheduler silently skips it.
    await store.upsertSchedule({
      company_id: 'c1', source: 'registry', cadence: 'daily',
      next_run_at: '2026-03-01T05:30:00+05:30',
    });
    expect((await store.getSchedule('c1', 'registry'))?.next_run_at)
      .toBe('2026-03-01T00:00:00.000Z');
  });
});

// ===========================================================================
// clusters, briefings, fetch_cache
// ===========================================================================
describe('clusters and briefings', () => {
  it('round-trips a cluster and replaces it in place', async () => {
    await store.putCluster(aClusterInput());
    await store.putCluster(aClusterInput({ fingerprint: 'fp-2', top_tier: 3 }));
    expect(await db.collection('clusters').countDocuments({ book_id: BOOK })).toBe(1);
    const c = await store.getCluster('cl-c1');
    expect(c?.fingerprint).toBe('fp-2');
    expect(c?.top_tier).toBe(3);
  });

  it('round-trips a briefing and finds the latest per mode', async () => {
    await store.putBriefing(aBriefingInput());
    await store.putBriefing(aBriefingInput({
      briefing_id: 'profile-c1', mode: 'profile',
      generated_at: '2026-03-02T11:00:00.000Z',
      sections: [{ title: 'Officers', text: 'Three directors, two resigned.' }],
    }));
    expect((await store.latestBriefing('c1', 'briefing'))?.briefing_id).toBe('br-c1');
    expect((await store.latestBriefing('c1', 'profile'))?.briefing_id).toBe('profile-c1');
  });

  it('enforces the contract refinement: a profile briefing must carry sections', async () => {
    await expect(store.putBriefing(aBriefingInput({ briefing_id: 'profile-c1', mode: 'profile' })))
      .rejects.toThrow(/sections/);
    expect(await db.collection('briefings').countDocuments({})).toBe(0);
  });
});

describe('fetch_cache', () => {
  it('caches by URL plus UTC day', async () => {
    await store.putCached('https://registry.example/x', { officers: ['Jane'] }, { day: '2026-03-01' });
    expect(await store.getCached('https://registry.example/x', '2026-03-01'))
      .toEqual({ officers: ['Jane'] });
    // A different day is a different key -- that is the whole point of the key.
    expect(await store.getCached('https://registry.example/x', '2026-03-02')).toBeNull();
    expect(await store.getCached('https://registry.example/other', '2026-03-01')).toBeNull();
  });

  it('overwrites the same key rather than duplicating it', async () => {
    await store.putCached('https://registry.example/x', { v: 1 }, { day: '2026-03-01' });
    await store.putCached('https://registry.example/x', { v: 2 }, { day: '2026-03-01' });
    expect(await db.collection('fetch_cache').countDocuments({ book_id: BOOK })).toBe(1);
    expect(await store.getCached('https://registry.example/x', '2026-03-01')).toEqual({ v: 2 });
  });

  it('honours expiry on read, because the TTL monitor only runs each minute', async () => {
    await store.putCached('https://registry.example/x', { v: 1 }, { day: '2026-03-01', ttlHours: -1 });
    expect(await store.getCached('https://registry.example/x', '2026-03-01')).toBeNull();
  });

  it('stores expires_at as a BSON Date so the TTL index can see it', async () => {
    await store.putCached('https://registry.example/x', { v: 1 }, { day: '2026-03-01' });
    const doc = await db.collection('fetch_cache').findOne({ book_id: BOOK });
    expect(doc?.expires_at).toBeInstanceOf(Date);
  });
});

// ===========================================================================
// the validation boundary
// ===========================================================================
describe('the zod boundary', () => {
  it('a document rejected by its schema never reaches the database', async () => {
    const cases: [string, () => Promise<unknown>][] = [
      ['companies', () => store.upsertCompany(aCompanyInput({ jurisdiction: 'gbr' }))],
      ['signals', () => store.upsertSignal(aSignalInput({ tier: 9 as never }))],
      ['signals', () => store.upsertSignal(aSignalInput({ confidence: 0.92 as never }))],
      ['signals', () => store.upsertSignal(aSignalInput({ evidence: [] }))],
      ['signals', () => store.upsertSignal(aSignalInput({ first_seen: '2026-03-01T10:00:00Z' }))],
      ['snapshots', () => store.insertSnapshot(aSnapshotInput({ source: 'exec_moves' as never }))],
      ['clusters', () => store.putCluster(aClusterInput({ fingerprint: '' }))],
      ['briefings', () => store.putBriefing(aBriefingInput({ what_changed: [] }))],
    ];
    for (const [collection, run] of cases) {
      await expect(run(), collection).rejects.toThrow(StoreValidationError);
    }
    for (const collection of ['companies', 'signals', 'snapshots', 'clusters', 'briefings']) {
      expect(await db.collection(collection).countDocuments({}), collection).toBe(0);
    }
  });

  it('names the offending field in the message', async () => {
    try {
      await store.upsertSignal(aSignalInput({ confidence: 'quite sure' as never }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StoreValidationError);
      expect((err as StoreValidationError).message).toMatch(/signals failed contract validation/);
      expect((err as StoreValidationError).issues.map((i) => i.path)).toContain('confidence');
    }
  });

  it('rejects a date-only value in an instant field (Track C renders Invalid Date)', async () => {
    await expect(store.insertSnapshot(aSnapshotInput({ fetched_at: '2026-03-01' })))
      .rejects.toThrow(/full ISO instant/);
    expect(await db.collection('snapshots').countDocuments({})).toBe(0);
  });
});
