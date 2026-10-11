import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { DonnaStore } from './store.js';
import { seedRealCompanies, seedDemonstrationCompany, demoCoverage, SEED_MARKER } from './demo-seed.js';
import { DEMO_BOOK } from './demo-book.js';
import { SOURCES, NOT_COVERED_CATEGORIES, CADENCE_FALLBACK } from './demo-cadence.js';

let mongod: MongoMemoryServer; let client: MongoClient; let store: DonnaStore;
const BOOK = 'test-book-demo-seed';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await new MongoClient(mongod.getUri()).connect();
  store = DonnaStore.fromClient(client, { database: 'donna_test', bookId: BOOK });
  await store.ensureIndexes();
}, 120_000);

afterAll(async () => { await client?.close(); await mongod?.stop(); });

describe('the fixed universe gets identity and schedules, never invented observations', () => {
  it('seeds companies and one schedule per source', async () => {
    const r = await seedRealCompanies(store, [
      { canonical_name: 'Big Lots, Inc.', jurisdiction: 'US', domains: ['biglots.com'] },
      { canonical_name: 'Cardinal Health, Inc.', jurisdiction: 'US', domains: ['cardinalhealth.com'] },
    ], CADENCE_FALLBACK);
    expect(r.companies).toBe(2);
    expect(r.schedules).toBe(2 * SOURCES.length);
  });

  it('writes NO signals, snapshots or briefings for a real company', async () => {
    const db = client.db('donna_test');
    for (const c of ['signals', 'snapshots', 'briefings', 'clusters']) {
      expect(await db.collection(c).countDocuments({ book_id: BOOK }), c).toBe(0);
    }
  });

  it('says plainly that no registry match is claimed when there is no registration', async () => {
    const companies = await store.listCompanies();
    const big = companies.find((c) => c.canonical_name === 'Big Lots, Inc.')!;
    expect(big.resolution.reason).toMatch(/no registration confirmed/i);
    expect(big.resolution.confidence).toBeNull();
    expect(big.resolution.resolved_by).toBe(SEED_MARKER);
  });

  it('schedules fire immediately, because the first batch is the profile', async () => {
    const due = await store.dueSchedules(new Date(Date.now() + 1000));
    expect(due.length).toBeGreaterThanOrEqual(SOURCES.length);
  });

  it('is idempotent -- re-seeding does not duplicate', async () => {
    const before = (await store.listCompanies()).length;
    await seedRealCompanies(store, [
      { canonical_name: 'Big Lots, Inc.', jurisdiction: 'US', domains: ['biglots.com'] },
    ], CADENCE_FALLBACK);
    expect((await store.listCompanies()).length).toBe(before);
  });

  it('skips a malformed jurisdiction rather than writing a future 500', async () => {
    const r = await seedRealCompanies(store, [
      { canonical_name: 'Bad Jurisdiction Co', jurisdiction: 'USA' },
    ], CADENCE_FALLBACK);
    expect(r.companies).toBe(0);
    expect(r.skipped[0]).toMatch(/2-letter uppercase/);
  });
});

describe('invented observations are refused under a plausible real name', () => {
  it('throws rather than fabricating evidence against a real company', async () => {
    await expect(seedDemonstrationCompany(store, {
      ...DEMO_BOOK[0]!, canonical_name: 'Big Lots, Inc.',
    })).rejects.toThrow(/must say so/);
  });

  it('accepts a name that announces itself', async () => {
    const r = await seedDemonstrationCompany(store, DEMO_BOOK[0]!);
    expect(r.company_id).toBeTruthy();
    expect(r.narrated).toBe(true);
  });
});

describe('the demonstration book exercises every state a user meets', () => {
  it('seeds all four companies', async () => {
    for (const spec of DEMO_BOOK.slice(1)) await seedDemonstrationCompany(store, spec);
    const names = (await store.listCompanies()).map((c) => c.canonical_name);
    for (const spec of DEMO_BOOK) expect(names).toContain(spec.canonical_name);
  });

  it('a failed source is recorded as failed and produces NO snapshot', async () => {
    const companies = await store.listCompanies();
    const northgate = companies.find((c) => c.canonical_name.startsWith('Northgate'))!;
    const runs = await store.runsForBatch(`batch-${northgate.company_id}-${new Date().toISOString().slice(0, 10)}`);
    const failed = runs.find((r) => r.status === 'failed');
    expect(failed, 'expected one failed run').toBeTruthy();
    expect(failed!.source).toBe('layoffs');
    expect(await store.latestOkSnapshot(northgate.company_id, 'layoffs')).toBeNull();
  });

  it('the failed source appears in coverage.failed and NOT in checked', async () => {
    const companies = await store.listCompanies();
    const northgate = companies.find((c) => c.canonical_name.startsWith('Northgate'))!;
    const cov = (await store.getCompany(northgate.company_id))!.coverage!;
    expect(cov.failed).toContain('layoffs');
    expect(cov.checked).not.toContain('layoffs');
  });

  it('the quiet company has NO cluster and NO briefing -- its page is the coverage sentence', async () => {
    const companies = await store.listCompanies();
    const oak = companies.find((c) => c.canonical_name.startsWith('Oakbridge'))!;
    expect(await store.latestBriefing(oak.company_id, 'briefing')).toBeNull();
    const cov = (await store.getCompany(oak.company_id))!.coverage!;
    // Quiet still shows a gap: silence must never read as reassurance.
    expect(cov.failed).toContain('court');
  });

  it('a lone tier-3 inferred signal produces no briefing', async () => {
    const companies = await store.listCompanies();
    const hal = companies.find((c) => c.canonical_name.startsWith('Halcourt'))!;
    expect(await store.latestBriefing(hal.company_id, 'briefing')).toBeNull();
  });

  it('every briefing line cites a signal that is in its cluster', async () => {
    const companies = await store.listCompanies();
    for (const c of companies) {
      const b = await store.latestBriefing(c.company_id, 'briefing');
      if (!b) continue;
      const cluster = await store.getCluster(`cl-${c.company_id}`);
      expect(cluster, `cluster missing for ${c.canonical_name}`).toBeTruthy();
      expect(b.what_changed.length).toBeGreaterThan(0);
      for (const line of b.what_changed) {
        // Track C silently drops a line whose signal_id is absent from the
        // cluster, rendering "0 cited observations" and an empty panel.
        expect(cluster!.signals, 'uncited line would be dropped by the UI')
          .toContain(line.signal_id);
      }
    }
  });

  it('tier 1 asks the owner to verify; tier 2 does not', async () => {
    const companies = await store.listCompanies();
    const north = companies.find((c) => c.canonical_name.startsWith('Northgate'))!;
    const west = companies.find((c) => c.canonical_name.startsWith('Westmill'))!;
    expect((await store.getCluster(`cl-${north.company_id}`))!.verify_with_counterparty).toBe(true);
    expect((await store.getCluster(`cl-${west.company_id}`))!.verify_with_counterparty).toBe(false);
    expect((await store.latestBriefing(north.company_id, 'briefing'))!.verify).toBeTruthy();
    expect((await store.latestBriefing(west.company_id, 'briefing'))!.verify).toBeNull();
  });

  it('never asserts health, and never says breach', async () => {
    const db = client.db('donna_test');
    const text = JSON.stringify(await db.collection('briefings').find({ book_id: BOOK }).toArray()).toLowerCase();
    for (const banned of ['healthy', 'good standing', 'low risk', 'breach', 'you should', 'you must']) {
      expect(text, `found "${banned}"`).not.toContain(banned);
    }
  });

  it('every excerpt is marked as a demonstration record', async () => {
    const db = client.db('donna_test');
    const sigs = await db.collection('signals').find({ book_id: BOOK }).toArray();
    expect(sigs.length).toBeGreaterThan(0);
    for (const s of sigs) {
      for (const e of s.evidence as { excerpt: string }[]) {
        expect(e.excerpt).toMatch(/DEMONSTRATION RECORD/);
      }
    }
  });
});

describe('coverage semantics', () => {
  it('checked/failed are source ids, not_covered are labels', () => {
    const cov = demoCoverage(['registry'], ['court']);
    expect(cov.checked).toEqual(['registry']);
    expect(cov.failed).toEqual(['court']);
    for (const cat of NOT_COVERED_CATEGORIES) expect(cov.not_covered).toContain(cat);
    // An unattempted source is uncovered, not implicitly fine.
    expect(cov.not_covered).toContain('Job postings');
  });
});
