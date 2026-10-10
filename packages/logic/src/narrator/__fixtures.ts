import {
  clusterId, clusterSchema, NOT_COVERED_CATEGORIES, signalSchema,
  type Cluster, type Signal,
} from '@donna/contracts';
import { narratorInput } from './types.js';
import type { NarratorClient, NarratorMessageRequest, NarratorMessageResponse } from './model.js';
import type { NarratorDraft } from './types.js';

/** Builders for the narrator's tests. Each test states only what it exercises. */

export const BOOK = 'book-test';
export const COMPANY = 'nordvale';
export const NOW = '2026-10-10T19:42:30Z';

export const signal = (over: Partial<Signal> = {}): Signal =>
  signalSchema.parse({
    book_id: BOOK,
    signal_id: 'sig-001',
    company_id: COMPANY,
    type: 'change_of_control',
    title: 'Change of control recorded',
    tier: 1,
    confidence: 'high',
    status: 'confirmed',
    evidence: [
      {
        snapshot_id: 'snap-nordvale-registry-2026',
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

export const COVERAGE = {
  checked: ['registry', 'regulator', 'layoffs', 'news', 'executives', 'jobs', 'domain'],
  failed: ['court'],
  not_covered: [...NOT_COVERED_CATEGORIES],
  as_of: '2026-10-10T19:40:00Z',
} as const;

export const cluster = (over: Partial<Cluster> = {}): Cluster =>
  clusterSchema.parse({
    book_id: BOOK,
    cluster_id: clusterId(COMPANY),
    company_id: COMPANY,
    mode: 'briefing',
    window: { from: '2026-09-26', to: '2026-10-10' },
    top_tier: 1,
    verify_with_counterparty: true,
    signals: ['sig-001'],
    deals: [
      {
        deal_id: 'dl-nordvale-1',
        class: 'they_pay_us',
        annual_value_usd: 1_200_000,
        share_pct: 18,
        notice_days: 90,
        days_to_renewal: 141,
        exposure_weight: 0.92,
        compliance_flag: false,
      },
    ],
    exposure: { top_weight: 0.92, annual_value_usd: 1_200_000 },
    coverage: COVERAGE,
    fingerprint: 'fixture-nordvale-v1',
    ...over,
  });

/** A cluster plus its signals, projected to the narrator's view. */
export const input = (
  over: { cluster?: Partial<Cluster>; signals?: Signal[] } = {},
) => {
  const c = cluster(over.cluster ?? {});
  const signals = over.signals ?? [signal()];
  return narratorInput(c, signals, NOW);
};

/** A draft that passes every rule, for tests that mutate one thing. */
export const goodDraft = (over: Partial<NarratorDraft> = {}): NarratorDraft => ({
  headline:
    'A change of control was recorded on the Nordvale agreement [sig-001].',
  what_changed: [
    {
      text:
        'The registry filing records a transfer of majority ownership to Alder Holdings on 9 October 2026.',
      signal_id: 'sig-001',
    },
  ],
  why_it_matters:
    'The observation touches the change-of-control term on an agreement worth $1.2M a year [sig-001] [dl-nordvale-1]. The notice period is 90 days with 141 days to the stated end date [dl-nordvale-1]. Worth asking about the new controlling entity.',
  verify:
    'Confirm the new controlling entity and whether the change-of-control provision requires notice [sig-001].',
  confidence_note:
    'The cited observation comes from a primary registry record [sig-001]. A recorded claim or notice is not a determination of wrongdoing.',
  ...over,
});

/** A client that returns one canned body, and records every request. */
export const stubClient = (
  bodies: readonly (string | object)[],
): NarratorClient & { calls: NarratorMessageRequest[] } => {
  const calls: NarratorMessageRequest[] = [];
  return {
    calls,
    createMessage: async (req) => {
      calls.push(req);
      const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return { content: [{ type: 'text', text }] } satisfies NarratorMessageResponse;
    },
  };
};

/** A client that fails the test if anything calls it. */
export const explodingClient = (): NarratorClient => ({
  createMessage: async () => {
    throw new Error('network call attempted when none was allowed');
  },
});
