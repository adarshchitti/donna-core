import { snapshotId, type Change, type Company, type Deal, type Item, type Snapshot, type Source } from '@donna/contracts';

/**
 * Builders for the validator's tests. Minimal and explicit: every test states
 * only the fields that rule under test reads, so a failure points at one rule.
 */

export const BOOK = 'book-test';
export const TODAY = '2026-10-10';

export const company = (over: Partial<Company> = {}): Company => ({
  book_id: BOOK,
  company_id: 'nordvale',
  canonical_name: 'Nordvale Industrial LLC',
  jurisdiction: 'US',
  registry_id: 'OH-3819274',
  registry_key: 'OH-3819274',
  aliases: [],
  domains: ['nordvale.invalid'],
  officers: [],
  related_entities: [],
  resolution: {
    confidence: 0.98,
    reason: 'Test fixture.',
    resolved_by: 'test',
    candidates_seen: [],
  },
  ...over,
});

export interface ChangeOpts {
  source: Source;
  item_type: string;
  kind?: Change['kind'];
  day?: string;
  company_id?: string;
  item?: Record<string, unknown>;
  url?: string;
  summary?: string;
  snapshot_id?: string;
}

export const change = (opts: ChangeOpts): Change => {
  const companyId = opts.company_id ?? 'nordvale';
  const day = opts.day ?? TODAY;
  const item: Item = {
    key: `${opts.item_type}:${companyId}`,
    type: opts.item_type,
    summary: opts.summary ?? `${opts.item_type} observed on ${day}.`,
    url: opts.url ?? `https://donna-sample.invalid/${opts.source}/${companyId}`,
    ...opts.item,
  };
  return {
    book_id: BOOK,
    company_id: companyId,
    source: opts.source,
    kind: opts.kind ?? 'added',
    item,
    previous: null,
    snapshot_id: opts.snapshot_id ?? snapshotId(companyId, opts.source),
    baseline_id: `base-${companyId}-${opts.source}`,
    detected_at: `${day}T12:00:00Z`,
  };
};

export const deal = (over: Partial<Deal> = {}): Deal => ({
  deal_id: 'dl-nordvale-1',
  company_id: 'nordvale',
  counterparty_name: 'Nordvale Industrial',
  country: 'US',
  deal_class: 'they_pay_us',
  annual_value_usd: 100_000,
  start_date: '2024-03-01',
  // Far enough out that the notice window is wide open unless a test says otherwise.
  end_date: '2027-10-10',
  status: 'resolved',
  ...over,
});

/** A deal whose top exposure comfortably clears the tier 2 threshold. */
export const bigDeal = (over: Partial<Deal> = {}): Deal =>
  deal({ deal_id: 'dl-nordvale-big', annual_value_usd: 2_000_000, share_pct: 50, ...over });

export const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  book_id: BOOK,
  snapshot_id: snapshotId('nordvale', 'registry'),
  company_id: 'nordvale',
  source: 'registry',
  fetched_at: '2026-09-28T09:00:00Z',
  run_id: 'run-nordvale-registry',
  ok: true,
  items: [{ key: 'baseline_identity:nordvale', type: 'baseline_identity' }],
  raw_excerpt:
    'Sample registry entry, 28 September 2026. Registered entity: Nordvale Industrial LLC. Registration number: OH-3819274. Jurisdiction: US.',
  source_url: 'https://donna-sample.invalid/registry/nordvale/baseline',
  content_hash: 'hash-nordvale-registry',
  ...over,
});
