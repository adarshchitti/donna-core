import {
  collectorRunSchema,
  coverageSchema,
  dealSchema,
  signalSchema,
  type CollectorRun,
  type Coverage,
  type Deal,
  type Signal,
} from '@donna/contracts';

/** Record builders for the eval table. Each case states only what it varies. */

export const BOOK = 'book-eval';
export const NORD = 'nordvale';
export const OTHER = 'otherco';

export const sig = (over: Partial<Signal> = {}): Signal =>
  signalSchema.parse({
    book_id: BOOK,
    signal_id: 'sig-n1',
    company_id: NORD,
    type: 'change_of_control',
    title: 'Change of control recorded',
    tier: 1,
    confidence: 'high',
    status: 'confirmed',
    evidence: [
      {
        snapshot_id: 'snap-nord-registry',
        source: 'registry',
        trust: 'primary',
        excerpt:
          'Filing 2026-1009-4821. Effective 09 October 2026: Alder Holdings LLC is recorded as the majority member of Nordvale Industrial LLC.',
        url: 'https://donna-sample.invalid/registry/nordvale/latest',
      },
    ],
    first_seen: '2026-10-09',
    summary_fact:
      'The registry filing records a transfer of majority ownership to Alder Holdings on 9 October 2026.',
    touches_terms: ['change of control'],
    ...over,
  });

export const execSignal = (over: Partial<Signal> = {}): Signal =>
  sig({
    signal_id: 'sig-n2',
    type: 'exec_departure',
    title: 'Officer departure recorded',
    tier: 2,
    confidence: 'medium',
    status: 'reported',
    evidence: [
      {
        snapshot_id: 'snap-nord-registry-officers',
        source: 'registry',
        trust: 'primary',
        excerpt:
          'Officer list change: Jane Doe removed as Chief Financial Officer, effective 8 October 2026.',
        url: 'https://donna-sample.invalid/registry/nordvale/officers',
      },
    ],
    first_seen: '2026-10-08',
    summary_fact:
      'Jane Doe was removed from the registry officer list as Chief Financial Officer on 8 October 2026.',
    touches_terms: ['key_person'],
    ...over,
  });

export const baselineSignal = (over: Partial<Signal> = {}): Signal =>
  sig({
    signal_id: 'sig-n3',
    type: 'baseline_identity',
    title: 'Baseline identity on file',
    tier: 0,
    confidence: 'high',
    status: 'baseline',
    evidence: [
      {
        snapshot_id: 'snap-nord-baseline',
        source: 'registry',
        trust: 'primary',
        excerpt:
          'Registry entry, 28 September 2026. Registered entity: Nordvale Industrial LLC. Registration number: OH-3819274.',
        url: 'https://donna-sample.invalid/registry/nordvale/baseline',
      },
    ],
    first_seen: '2026-09-28',
    summary_fact:
      'The registry entry identifies Nordvale Industrial LLC, registration OH-3819274, in US.',
    touches_terms: [],
    ...over,
  });

export const litigationSignal = (over: Partial<Signal> = {}): Signal =>
  sig({
    signal_id: 'sig-n4',
    type: 'litigation',
    title: 'Court filing naming the company',
    tier: 2,
    confidence: 'medium',
    status: 'reported',
    evidence: [
      {
        snapshot_id: 'snap-nord-court',
        source: 'court',
        trust: 'primary',
        excerpt:
          'Docket 26-CV-1187, filed 6 October 2026: Halberd Components Inc v. Nordvale Industrial LLC, contract claim, $412,000.',
        url: 'https://donna-sample.invalid/court/nordvale/26-cv-1187',
      },
    ],
    first_seen: '2026-10-06',
    summary_fact:
      'A court filing dated 6 October 2026 names Nordvale Industrial LLC as defendant in a contract claim for $412,000.',
    touches_terms: ['litigation_cap_usd'],
    ...over,
  });

/** A big event at a DIFFERENT company -- the record a scoped answer must not cite. */
export const otherSignal = (over: Partial<Signal> = {}): Signal =>
  sig({
    signal_id: 'sig-o1',
    company_id: OTHER,
    type: 'insolvency',
    title: 'Insolvency filing recorded',
    tier: 1,
    confidence: 'high',
    status: 'confirmed',
    evidence: [
      {
        snapshot_id: 'snap-other-court',
        source: 'court',
        trust: 'primary',
        excerpt:
          'Meridian Freight Corp entered administration on 7 October 2026, filing 26-INS-0091.',
        url: 'https://donna-sample.invalid/court/otherco/26-ins-0091',
      },
    ],
    first_seen: '2026-10-07',
    summary_fact:
      'Meridian Freight Corp entered administration on 7 October 2026.',
    touches_terms: [],
    ...over,
  });

export const deal = (over: Partial<Deal> = {}): Deal =>
  dealSchema.parse({
    deal_id: 'dl-n1',
    company_id: NORD,
    counterparty_name: 'Nordvale Industrial',
    country: 'US',
    deal_class: 'they_pay_us',
    annual_value_usd: 410_000,
    start_date: '2024-03-01',
    end_date: '2027-02-28',
    notice_days: 90,
    share_pct: 14,
    substitutability: 'quarter',
    owner_email: 'analyst@donna-sample.invalid',
    watch_terms: 'key_person: Jane Doe, CFO; litigation_cap_usd: 500000',
    status: 'resolved',
    ...over,
  });

export const otherDeal = (over: Partial<Deal> = {}): Deal =>
  deal({
    deal_id: 'dl-o1',
    company_id: OTHER,
    counterparty_name: 'Meridian Freight',
    watch_terms: '',
    ...over,
  });

export const coverage = (over: Partial<Coverage> = {}): Coverage =>
  coverageSchema.parse({
    checked: ['registry', 'regulator', 'layoffs', 'news', 'executives', 'jobs', 'domain'],
    failed: ['court'],
    not_covered: [
      'Private financials',
      'Payment behaviour',
      'Relationship sentiment',
      'Related-entity monitoring',
    ],
    as_of: '2026-10-10T19:40:00Z',
    ...over,
  });

export const run = (over: Partial<CollectorRun> = {}): CollectorRun =>
  collectorRunSchema.parse({
    book_id: BOOK,
    run_id: 'run-nord-registry',
    batch_id: 'batch-2026-10-10',
    company_id: NORD,
    source: 'registry',
    started_at: '2026-10-10T19:42:00Z',
    ended_at: '2026-10-10T19:42:12Z',
    status: 'ok',
    error: null,
    credits_spent: 0,
    sandbox_id: 'sandbox-demo',
    cache_hit: false,
    ...over,
  });

export const failedCourtRun = (over: Partial<CollectorRun> = {}): CollectorRun =>
  run({
    run_id: 'run-nord-court',
    source: 'court',
    status: 'failed',
    error: 'source fetch exceeded its time limit',
    ...over,
  });
