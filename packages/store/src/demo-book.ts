import type { DemoCompanySpec } from './demo-seed.js';

/**
 * The demonstration book: four companies chosen to exercise the four states a
 * user actually encounters, including the one that matters most.
 *
 * Every name says "Demonstration" because every observation below is invented.
 * Real companies in the fixed universe get real collection instead.
 */
export const DEMO_BOOK: DemoCompanySpec[] = [
  // 1. TIER 1 -- always surfaces, and tells the owner to pick up the phone.
  //    This is session 3's event: a control change that required advance
  //    notification and approval, so discovering it late is itself a problem.
  {
    canonical_name: 'Northgate Demonstration Holdings LLC',
    registry_id: 'DEMO-OH-0001', jurisdiction: 'US', top_tier: 1,
    checked: ['registry', 'court', 'regulator', 'news', 'executives', 'jobs', 'domain'],
    failed: ['layoffs'],
    signals: [{
      type: 'change_of_control', title: 'Change of control recorded', tier: 1,
      confidence: 'high', status: 'confirmed', source: 'registry',
      first_seen: '2026-10-09',
      excerpt: 'DEMONSTRATION RECORD. Filing 2026-1009-0001. Effective 09 October 2026: Alder Demonstration Holdings LLC is recorded as the majority member of Northgate Demonstration Holdings LLC.',
      summary_fact: 'The registry filing records a transfer of majority ownership on 9 October 2026.',
      touches_terms: ['change_of_control'],
    }],
    briefing: {
      headline: 'Majority ownership transferred at Northgate Demonstration Holdings',
      why_it_matters: 'A change of control is recorded against an entity on this book. Where an agreement requires advance notice of a control change, that window may already have passed.',
      verify: 'Ask who now holds the controlling interest, on what date it took effect, and whether notice was served under the change-of-control provision.',
      confidence_note: 'The transfer is recorded in the registry, a primary source. Layoff notices could not be checked for this counterparty.',
    },
  },

  // 2. TIER 2, CORROBORATED -- two primary sources on one company, which is
  //    what the trust rules are built to reward. Session 2's event.
  {
    canonical_name: 'Westmill Demonstration Industrial LLC',
    registry_id: 'DEMO-OH-0002', jurisdiction: 'US', top_tier: 2,
    checked: ['registry', 'court', 'regulator', 'layoffs', 'news', 'executives', 'jobs', 'domain'],
    failed: [],
    signals: [
      {
        type: 'exec_departure', title: 'Finance chief removed from the officer list', tier: 2,
        confidence: 'high', status: 'confirmed', source: 'registry', first_seen: '2026-10-08',
        excerpt: 'DEMONSTRATION RECORD. Officer amendment filed 08 October 2026. Jane Demonstration, Chief Financial Officer: appointment terminated. All other officer appointments remain unchanged.',
        summary_fact: 'The Chief Financial Officer was removed from the registry officer list on 8 October 2026.',
        touches_terms: ['key_person: Jane Demonstration, CFO'],
      },
      {
        type: 'litigation', title: 'Supplier claim appears on the docket', tier: 2,
        confidence: 'high', status: 'confirmed', source: 'court', first_seen: '2026-10-02',
        excerpt: 'DEMONSTRATION RECORD. Civil docket DEMO-CV-2026-0002. Defendant: Westmill Demonstration Industrial LLC. Claim amount: USD 540,000. Filed 02 October 2026. Status: pending. No determination entered.',
        summary_fact: 'A $540,000 supplier claim was filed on 2 October 2026. The docket records no determination.',
        touches_terms: ['litigation_cap_usd: 500000'],
      },
    ],
    briefing: {
      headline: 'Finance chief departed and a supplier claim filed at Westmill Demonstration Industrial',
      why_it_matters: 'Two separate primary records moved within a week on the same counterparty. Each touches a term that was signed: the named key person, and the litigation cap.',
      verify: null,
      confidence_note: 'Both observations come from primary records -- the registry and the court docket. Neither rests on a single reported source. A filed claim is a claim, not a judgment.',
    },
  },

  // 3. TIER 3 ONLY -- inferred signals that must NOT escalate on their own.
  //    Two of them, deliberately: three is what makes a pattern.
  {
    canonical_name: 'Halcourt Demonstration Packaging Ltd',
    registry_id: 'DEMO-OH-0003', jurisdiction: 'US', top_tier: 3,
    checked: ['registry', 'court', 'regulator', 'layoffs', 'news', 'executives', 'jobs', 'domain'],
    failed: [],
    signals: [{
      type: 'job_postings', title: 'Open roles decreased', tier: 3,
      confidence: 'low', status: 'inferred', source: 'jobs', first_seen: '2026-10-05',
      excerpt: 'DEMONSTRATION RECORD. Careers snapshot, 05 October 2026: 12 open positions. Preceding snapshot, 28 September 2026: 28 open positions. This count does not establish why the listings changed.',
      summary_fact: 'Open roles fell from 28 to 12 between snapshots. The reason is not observed.',
    }],
    // No briefing: a lone tier-3 inferred signal is a pattern candidate, not a
    // finding, and must not produce an alert.
  },

  // 4. THE QUIET COMPANY -- no signals, no cluster, no briefing.
  //
  //    This is the most important record in the demonstration book. Its page
  //    must read as a COVERAGE STATEMENT -- "no change observed across 7
  //    sources since <date>; not checked: court records; not covered: ..." --
  //    and never as reassurance. One source is failed on purpose, so the quiet
  //    state still shows a visible gap. Nobody has ever user-tested this state,
  //    and the whole product exists to get it right.
  {
    canonical_name: 'Oakbridge Demonstration Foods Inc.',
    registry_id: 'DEMO-OH-0004', jurisdiction: 'US', top_tier: 0,
    checked: ['registry', 'regulator', 'layoffs', 'news', 'executives', 'jobs', 'domain'],
    failed: ['court'],
    signals: [{
      type: 'baseline_identity', title: 'Starting registry record', tier: 0,
      confidence: 'high', status: 'baseline', source: 'registry', first_seen: '2026-09-28',
      excerpt: 'DEMONSTRATION RECORD. Registry entry, 28 September 2026. Registered entity: Oakbridge Demonstration Foods Inc. Registration: DEMO-OH-0004. Jurisdiction: US.',
      summary_fact: 'The starting registry snapshot identifies the entity and its registration.',
    }],
  },
];
