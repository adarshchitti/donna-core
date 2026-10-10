import { describe, it, expect } from 'vitest';
import { briefingSchema } from '@donna/contracts';
import { narrate } from './narrate.js';
import { findForbidden } from './forbidden.js';
import { clientFromEnv, narratorModel } from './model.js';
import { COVERAGE, cluster, input, signal } from './__fixtures.js';

/**
 * ONE live call, skipped unless a key is exported into the environment. Reads
 * process.env only -- the key lives in .env.local, which is gitignored, and is
 * never written into this file.
 *
 *   set -a && source .env.local && set +a && npx vitest run packages/logic
 *
 * The assertion is the whole point of the model choice: a real haiku-4-5 draft
 * passes the post-processor without being rejected, so the gate is not
 * carrying the product on its own.
 */
describe.skipIf(!process.env['ANTHROPIC_API_KEY'])('live narrator call', () => {
  it('produces a briefing that passes the post-processor', async () => {
    const realistic = input({
      cluster: cluster({
        signals: ['sig-coc-001', 'sig-court-002', 'sig-layoff-003'],
        top_tier: 1,
        verify_with_counterparty: true,
      }),
      signals: [
        signal({
          signal_id: 'sig-coc-001',
          type: 'change_of_control',
          title: 'Change of control recorded',
          tier: 1,
          confidence: 'high',
          status: 'confirmed',
          touches_terms: ['change of control', 'assignment'],
          summary_fact:
            'The registry filing records a transfer of majority ownership to Alder Holdings on 9 October 2026.',
        }),
        signal({
          signal_id: 'sig-court-002',
          type: 'court_docket',
          title: 'New docket entry',
          tier: 2,
          confidence: 'medium',
          status: 'reported',
          first_seen: '2026-10-07',
          touches_terms: [],
          summary_fact:
            'A new civil docket entry naming Nordvale Industrial LLC was recorded in Franklin County on 7 October 2026.',
          evidence: [
            {
              snapshot_id: 'snap-nordvale-court-2026',
              source: 'court',
              trust: 'primary',
              excerpt:
                'Case 26-CV-004812 filed 07 October 2026. Plaintiff: Harrow Freight Inc. Defendant: Nordvale Industrial LLC. Nature of suit: contract.',
              url: 'https://donna-sample.invalid/court/nordvale/26-CV-004812',
            },
          ],
        }),
        signal({
          signal_id: 'sig-layoff-003',
          type: 'layoff_notice',
          title: 'WARN notice filed',
          tier: 2,
          confidence: 'medium',
          status: 'reported',
          first_seen: '2026-10-02',
          touches_terms: ['service levels'],
          summary_fact:
            'A WARN notice covering 84 roles at the Columbus facility was filed on 2 October 2026.',
          evidence: [
            {
              snapshot_id: 'snap-nordvale-layoffs-2026',
              source: 'layoffs',
              trust: 'primary',
              excerpt:
                'Ohio WARN filing 2026-10-02. Employer: Nordvale Industrial LLC. Site: Columbus, OH. Affected: 84. Effective: 2026-12-01.',
              url: 'https://donna-sample.invalid/layoffs/nordvale/2026-10-02',
            },
          ],
        }),
      ],
    });

    const client = clientFromEnv();
    expect(client).not.toBeNull();

    const result = await narrate(realistic, {
      client,
      now: '2026-10-10T19:42:30Z',
      onReport: (report, stage) => {
        // Printed so a live failure says WHICH rule the live model tripped.
        if (report.violations.length > 0 || report.stripped_lines.length > 0) {
          console.log(`[live ${stage}]`, JSON.stringify(report, null, 2));
        }
      },
    });

    console.log(`[live model] ${narratorModel()}`);
    console.log(`[live result] ${JSON.stringify(result.briefing, null, 2)}`);
    if (result.failures.length > 0) console.log('[live failures]', result.failures);

    // The real draft passed the gate -- it was not rescued by the fallback.
    expect(result.used_fallback).toBe(false);
    expect(result.attempts).toBeLessThanOrEqual(2);

    expect(briefingSchema.safeParse(result.briefing).success).toBe(true);
    expect(findForbidden(JSON.stringify(result.briefing))).toEqual([]);
    expect(JSON.stringify(result.briefing.coverage)).toBe(JSON.stringify(COVERAGE));
    expect(result.briefing.what_changed.length).toBeGreaterThan(0);
    for (const line of result.briefing.what_changed) {
      expect(realistic.cluster.signals).toContain(line.signal_id);
    }
    expect(result.briefing.verify).not.toBeNull();
    expect(result.briefing.confidence_note).not.toBe('');
    // The gate's guarantee is that every surviving factual sentence is backed by
    // an id that resolves -- a signal id, or a deal id for an agreement fact.
    expect(
      result.briefing.citations.why_it_matters.length +
        result.briefing.citations.deal_context.length,
    ).toBeGreaterThan(0);
    expect(result.briefing.citations.headline.length).toBeGreaterThan(0);
  }, 90_000);
});
