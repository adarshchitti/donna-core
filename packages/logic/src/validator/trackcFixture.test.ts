import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  changeSchema, clusterSchema, companySchema, dealSchema, signalSchema, snapshotSchema,
  type Change, type Company, type Deal, type Signal, type Snapshot,
} from '@donna/contracts';
import { loadRules } from './rules.js';
import { validate } from './validate.js';
import { exposureFor } from './exposure.js';

/**
 * The real documents Track C's screens already render. Our output has to be
 * the same shape AND the same judgement: the fixture's own signals state the
 * tier, confidence and status the UI expects for these exact changes.
 *
 * Track C's fixtures predate tenancy, so they carry no book_id; we stamp one
 * on the way in, exactly as A2 does.
 */

const BOOK = 'book-trackc';
const TODAY = '2026-10-10';
const rules = loadRules();

const fx = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../fixtures/trackc/allContracts.sample.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown[]>;

const withBook = <T>(schema: { parse: (v: unknown) => T }, docs: unknown[]): T[] =>
  docs.map((d) => schema.parse({ book_id: BOOK, ...(d as object) }));

const companies: Company[] = withBook(companySchema, (fx['companies'] ?? []).map((c) => ({
  ...(c as object),
  registry_key: String((c as { registry_id: string }).registry_id).toUpperCase(),
})));
const deals: Deal[] = (fx['deals'] ?? []).map((d) => dealSchema.parse(d));
const changes: Change[] = withBook(changeSchema, fx['changes'] ?? []);
const snapshots: Snapshot[] = withBook(snapshotSchema, fx['snapshots'] ?? []);
const fixtureSignals = (fx['signals'] ?? []) as Signal[];

const companyFor = (id: string): Company =>
  companies.find((c) => c.company_id === id)
  ?? companySchema.parse({
    book_id: BOOK,
    company_id: id,
    canonical_name: id,
    jurisdiction: 'US',
    registry_id: '',
    registry_key: `MANUAL:${id}`,
    aliases: [],
    domains: [],
    resolution: { confidence: null, reason: 'Not in the fixture.', resolved_by: null },
  });

const runFor = (companyId: string) =>
  validate({
    book_id: BOOK,
    company: companyFor(companyId),
    deals: deals.filter((d) => d.company_id === companyId),
    changes: changes.filter((c) => c.company_id === companyId),
    today: TODAY,
    rules,
  });

describe('Track C fixture changes produce Track C fixture signals', () => {
  it('halcyon job postings: tier 3, low, inferred -- matching sig-006', () => {
    const expected = fixtureSignals.find((s) => s.type === 'job_postings')!;
    const result = runFor('halcyon');
    expect(result.signals).toHaveLength(1);
    const s = result.signals[0]!;
    expect(s.type).toBe(expected.type);
    expect(s.tier).toBe(expected.tier);
    expect(s.confidence).toBe(expected.confidence);
    expect(s.status).toBe(expected.status);
    // The collector's own sentence is the summary_fact, verbatim.
    expect(s.summary_fact).toBe(expected.summary_fact);
    // One inferred tier 3 on its own is not a pattern, so nothing surfaces.
    expect(result.cluster).toBeNull();
  });

  it('nordvale CFO removal: a primary record holds tier 2 and touches the signed term', () => {
    const result = runFor('nordvale');
    expect(result.signals).toHaveLength(1);
    const s = result.signals[0]!;
    expect(s.type).toBe('exec_departure');
    expect(s.tier).toBe(2);
    expect(s.confidence).toBe('high');
    expect(s.status).toBe('confirmed');
    expect(s.touches_terms).toEqual(['key_person: Jane Doe, CFO']);

    // The fixture's single nordvale deal clears the tier 2 threshold, so the
    // departure surfaces. If this starts failing, the threshold in rules.json
    // moved past the demo's own exposure -- tune the table, not the code.
    const weight = exposureFor(deals[0]!, TODAY, rules).weight;
    expect(weight).toBeGreaterThanOrEqual(rules.thresholds.tier2_min_exposure_weight);
    expect(result.cluster).not.toBeNull();
    expect(result.cluster!.top_tier).toBe(2);
    expect(result.cluster!.verify_with_counterparty).toBe(false);
    expect(result.cluster!.deals[0]).toMatchObject({
      deal_id: 'dl-nordvale-1',
      class: 'they_pay_us',
      compliance_flag: false,
      days_to_renewal: 141,
    });
  });

  it('northstar change of control: tier 1, high, confirmed -- matching sig-001', () => {
    const expected = fixtureSignals.find((s) => s.type === 'change_of_control')!;
    const snap = snapshots.find((s) => s.company_id === 'northstar')!;
    // The fixture ships the snapshot but not the change; the differ would emit
    // this on the first registry filing it saw.
    const change = changeSchema.parse({
      book_id: BOOK,
      company_id: 'northstar',
      source: snap.source,
      kind: 'added',
      item: { ...snap.items[0], url: snap.source_url },
      previous: null,
      snapshot_id: snap.snapshot_id,
      baseline_id: 'snap-northstar-baseline',
      detected_at: '2026-10-09T19:00:00Z',
    });

    const result = validate({
      book_id: BOOK, company: companyFor('northstar'), deals: [], changes: [change], today: TODAY, rules,
    });
    const s = result.signals[0]!;
    expect(s.type).toBe(expected.type);
    expect(s.tier).toBe(expected.tier);
    expect(s.confidence).toBe(expected.confidence);
    expect(s.status).toBe(expected.status);
    expect(s.first_seen).toBe(expected.first_seen);
    expect(s.summary_fact).toBe(expected.summary_fact);
    expect(s.evidence[0]).toMatchObject({ source: 'registry', trust: 'primary', excerpt: expected.summary_fact });
    // Tier 1 surfaces with no deals at all.
    expect(result.cluster!.top_tier).toBe(1);
    expect(result.cluster!.verify_with_counterparty).toBe(true);
  });

  it('northstar baseline: tier 0, high, baseline -- matching sig-profile-northstar', () => {
    const expected = fixtureSignals.find((s) => s.status === 'baseline')!;
    const result = validate({
      book_id: BOOK,
      company: companyFor('northstar'),
      changes: [],
      baseline_snapshots: snapshots.filter((s) => s.company_id === 'northstar'),
      today: TODAY,
      rules,
    });
    const s = result.signals[0]!;
    expect(s.type).toBe(expected.type);
    expect(s.tier).toBe(expected.tier);
    expect(s.confidence).toBe(expected.confidence);
    expect(s.status).toBe('baseline');
    expect(s.evidence.length).toBeGreaterThan(0);
    expect(result.cluster!.mode).toBe('profile');
  });
});

describe('every document we emit for the fixture parses against its contract', () => {
  const ids = ['nordvale', 'halcyon', 'northstar'];

  it('signals parse against signalSchema', () => {
    for (const id of ids) {
      for (const s of runFor(id).signals) expect(() => signalSchema.parse(s)).not.toThrow();
    }
  });

  it('clusters parse against clusterSchema, and against the fixture-shaped variant', () => {
    // Track C renders book_id-less clusters, so the same document must also
    // satisfy the relaxed shape its screens were built against.
    const relaxed = clusterSchema.omit({ book_id: true });
    for (const id of ids) {
      const cluster = runFor(id).cluster;
      if (cluster === null) continue;
      expect(() => clusterSchema.parse(cluster)).not.toThrow();
      const { book_id: _book, ...rest } = cluster;
      expect(() => relaxed.parse(rest)).not.toThrow();
    }
  });

  it('cluster ids match the convention Track C mints client-side', () => {
    expect(runFor('nordvale').cluster!.cluster_id).toBe('cl-nordvale');
  });
});
