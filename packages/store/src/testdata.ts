/**
 * Minimal valid documents, for tests. Exported from the package source rather
 * than a test file so both the in-memory suite and the env-gated real-cluster
 * suite build the same shapes -- if a contract changes, both fail together.
 */
import type {
  BriefingInput, ClusterInput, CompanyUpsertInput, SignalInput, SnapshotInput,
} from './types.js';
import type { Coverage } from '@donna/contracts';

export const aCoverage = (over: Partial<Coverage> = {}): Coverage => ({
  checked: ['registry'],
  failed: [],
  not_covered: ['Private financials'],
  ...over,
});

export const aCompanyInput = (over: Partial<CompanyUpsertInput> = {}): CompanyUpsertInput => ({
  canonical_name: 'Northwind Trading Ltd',
  jurisdiction: 'GB',
  registry_id: 'gb-12345678',
  domains: ['northwind.example'],
  ...over,
});

export const aSnapshotInput = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  snapshot_id: 'snap-c1-registry-1',
  company_id: 'c1',
  source: 'registry',
  fetched_at: '2026-03-01T10:00:00.000Z',
  run_id: 'run-c1-registry',
  ok: true,
  items: [{ key: 'officer:jane-doe', type: 'officer' }],
  raw_excerpt: 'Jane Doe appointed director 2026-02-27',
  source_url: 'https://registry.example/gb-12345678',
  ...over,
});

export const aSignalInput = (over: Partial<SignalInput> = {}): SignalInput => ({
  company_id: 'c1',
  type: 'officer_churn',
  title: 'Two directors resigned in 30 days',
  tier: 2,
  confidence: 'medium',
  status: 'reported',
  evidence: [{
    snapshot_id: 'snap-c1-registry-1',
    source: 'registry',
    trust: 'primary',
    excerpt: 'Jane Doe appointed director 2026-02-27',
    url: 'https://registry.example/gb-12345678',
  }],
  first_seen: '2026-03-01',
  summary_fact: 'Two of three directors resigned between 2026-02-01 and 2026-03-01.',
  touches_terms: [],
  ...over,
});

export const aClusterInput = (over: Partial<ClusterInput> = {}): ClusterInput => ({
  cluster_id: 'cl-c1',
  company_id: 'c1',
  mode: 'briefing',
  window: { from: '2026-02-15', to: '2026-03-01' },
  top_tier: 2,
  verify_with_counterparty: true,
  signals: ['sig-c1-officer_churn-2026-03-01'],
  deals: [],
  exposure: { top_weight: 0.4, annual_value_usd: 250_000 },
  coverage: aCoverage(),
  fingerprint: 'fp-1',
  ...over,
});

export const aBriefingInput = (over: Partial<BriefingInput> = {}): BriefingInput => ({
  briefing_id: 'br-c1',
  company_id: 'c1',
  mode: 'briefing',
  headline: 'Two directors resigned at Northwind Trading',
  what_changed: [{ text: 'Two directors resigned.', signal_id: 'sig-c1-officer_churn-2026-03-01' }],
  why_it_matters: 'Northwind supplies 40% of your Q3 volume.',
  verify: 'Ask for a current signatory list before the next release.',
  confidence_note: 'Registry filings are primary evidence.',
  coverage: aCoverage(),
  generated_at: '2026-03-01T11:00:00.000Z',
  citations: {
    headline: ['sig-c1-officer_churn-2026-03-01'],
    why_it_matters: ['sig-c1-officer_churn-2026-03-01'],
    deal_context: [],
    verify: [],
    confidence_note: [],
  },
  narration_status: 'available',
  cluster_id: 'cl-c1',
  ...over,
});
