import { describe, it, expect } from 'vitest';
import { signalSchema } from '@donna/contracts';
import { loadRules } from './rules.js';
import { upsertSignals } from './corroborate.js';
import { baselineSignals } from './baseline.js';
import { validate } from './validate.js';
import { BOOK, TODAY, change, company, snapshot } from './__fixtures.js';

const rules = loadRules();
const co = company();

const newsStory = change({
  source: 'news',
  item_type: 'litigation',
  day: '2026-10-01',
  url: 'https://outlet-a.invalid/suit',
  summary: 'A trade publication reports that a claim has been filed against Nordvale Industrial.',
});

const courtRecord = change({
  source: 'court',
  item_type: 'case_filed',
  day: '2026-10-06',
  snapshot_id: 'snap-nordvale-court',
  url: 'https://donna-sample.invalid/court/nordvale',
  summary: 'Case 2026-CV-1182 was filed against Nordvale Industrial LLC on 6 October 2026.',
});

describe('4. corroboration merges a news item and a court record five days apart', () => {
  it('the lone news story is medium, reported and labelled unconfirmed', () => {
    const { signals } = upsertSignals({ book_id: BOOK, company: co, changes: [newsStory], rules });
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.confidence).toBe('medium');
    expect(s.status).toBe('reported');
    expect(s.summary_fact).toContain(rules.labels.reported_unconfirmed);
    // Reported-only, so the tier 2 rule is held down to a lead.
    expect(s.tier).toBe(3);
  });

  it('the docket five days later updates the SAME signal', () => {
    const first = upsertSignals({ book_id: BOOK, company: co, changes: [newsStory], rules });
    const second = upsertSignals({
      book_id: BOOK,
      company: co,
      existing: first.signals,
      changes: [courtRecord],
      rules,
    });

    expect(second.signals).toHaveLength(1);
    const s = second.signals[0]!;
    expect(s.signal_id).toBe(first.signals[0]!.signal_id);
    expect(s.evidence).toHaveLength(2);
    expect(s.evidence.map((e) => e.source)).toEqual(['news', 'court']);
    expect(s.status).toBe('confirmed');
    expect(s.confidence).toBe('high');
    expect(s.tier).toBe(2);
    // first_seen stays the day we first heard anything.
    expect(s.first_seen).toBe('2026-10-01');
    // The primary record now states the fact, and the unconfirmed label is gone.
    expect(s.summary_fact).toBe(courtRecord.item['summary']);
    expect(s.summary_fact).not.toContain(rules.labels.reported_unconfirmed);
  });

  it('both orders of arrival produce the same evidence count and status', () => {
    const a = upsertSignals({ book_id: BOOK, company: co, changes: [newsStory, courtRecord], rules });
    const b = upsertSignals({ book_id: BOOK, company: co, changes: [courtRecord, newsStory], rules });
    expect(a.signals).toHaveLength(1);
    expect(b.signals).toHaveLength(1);
    expect(a.signals[0]!.status).toBe(b.signals[0]!.status);
    expect(a.signals[0]!.evidence).toHaveLength(2);
    expect(b.signals[0]!.evidence).toHaveLength(2);
    expect(a.signals[0]!.signal_id).toBe(b.signals[0]!.signal_id);
  });

  it('the same evidence twice is not double counted', () => {
    const first = upsertSignals({ book_id: BOOK, company: co, changes: [courtRecord], rules });
    const again = upsertSignals({
      book_id: BOOK,
      company: co,
      existing: first.signals,
      changes: [courtRecord],
      rules,
    });
    expect(again.signals).toHaveLength(1);
    expect(again.signals[0]!.evidence).toHaveLength(1);
  });

  it('outside the 14 day window it is a new signal, not an update', () => {
    const first = upsertSignals({ book_id: BOOK, company: co, changes: [newsStory], rules });
    const late = upsertSignals({
      book_id: BOOK,
      company: co,
      existing: first.signals,
      changes: [change({ source: 'court', item_type: 'case_filed', day: '2026-10-20', snapshot_id: 'snap-late' })],
      rules,
    });
    expect(late.signals).toHaveLength(2);
  });

  it('a different company never merges into another company\'s signal', () => {
    const { signals } = upsertSignals({
      book_id: BOOK,
      company: co,
      changes: [newsStory, change({ source: 'court', item_type: 'case_filed', company_id: 'halcyon' })],
      rules,
    });
    // The off-company change is filtered out; the validator works one company at a time.
    expect(signals).toHaveLength(1);
    expect(signals[0]!.company_id).toBe('nordvale');
  });
});

describe('12. baseline mode produces status baseline signals with evidence', () => {
  it('turns baseline snapshots into one tier 0 citable signal', () => {
    const { signals } = baselineSignals({
      book_id: BOOK,
      company: co,
      snapshots: [snapshot()],
      rules,
    });
    expect(signals).toHaveLength(1);
    const s = signalSchema.parse(signals[0]);
    expect(s.status).toBe('baseline');
    expect(s.tier).toBe(0);
    expect(s.type).toBe('baseline_identity');
    expect(s.evidence.length).toBeGreaterThan(0);
    expect(s.evidence[0]!.excerpt).toBe(snapshot().raw_excerpt);
    expect(s.evidence[0]!.url).toBe(snapshot().source_url);
    expect(s.first_seen).toBe('2026-09-28');
    expect(s.summary_fact.length).toBeGreaterThan(0);
  });

  it('collapses several baseline sources into one signal with several evidence entries', () => {
    const { signals } = baselineSignals({
      book_id: BOOK,
      company: co,
      snapshots: [
        snapshot({ source: 'domain', snapshot_id: 'snap-nordvale-domain', raw_excerpt: 'Site snapshot, 28 September 2026.' }),
        snapshot(),
      ],
      rules,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence).toHaveLength(2);
    // The registry record leads, because it is the most trusted source on file.
    expect(signals[0]!.evidence[0]!.source).toBe('registry');
  });

  it('a snapshot with no items contributes nothing', () => {
    const { signals } = baselineSignals({
      book_id: BOOK,
      company: co,
      snapshots: [snapshot({ items: [] })],
      rules,
    });
    expect(signals).toHaveLength(0);
  });

  it('validate() enters profile mode on a first run and cites the baseline signal', () => {
    const result = validate({
      book_id: BOOK,
      company: co,
      changes: [],
      baseline_snapshots: [snapshot()],
      today: TODAY,
      rules,
    });
    expect(result.mode).toBe('profile');
    expect(result.cluster).not.toBeNull();
    expect(result.cluster!.mode).toBe('profile');
    expect(result.cluster!.top_tier).toBe(0);
    expect(result.cluster!.verify_with_counterparty).toBe(false);
    expect(result.cluster!.signals).toEqual([result.signals[0]!.signal_id]);
    expect(result.cluster_signals[0]!.status).toBe('baseline');
  });

  it('once changes exist, baseline mode is not used', () => {
    const result = validate({
      book_id: BOOK,
      company: co,
      changes: [change({ source: 'registry', item_type: 'change_of_control' })],
      baseline_snapshots: [snapshot()],
      today: TODAY,
      rules,
    });
    expect(result.mode).toBe('briefing');
    expect(result.signals.every((s) => s.status !== 'baseline')).toBe(true);
  });
});
