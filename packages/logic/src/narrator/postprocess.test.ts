import { describe, it, expect } from 'vitest';
import { briefingSchema } from '@donna/contracts';
import { postProcess } from './postprocess.js';
import { buildFallbackDraft } from './fallback.js';
import { PROFILE_SECTION_TITLES } from './prompt.js';
import { COVERAGE, goodDraft, input, signal } from './__fixtures.js';
import type { NarratorDraft } from './types.js';

const run = (draft: NarratorDraft, inp = input()) =>
  postProcess(draft, inp, { narration_status: 'available' });

describe('the critical test: uncited sentence, bogus signal_id, forbidden word', () => {
  // Two signals so that stripping one what_changed line still leaves one, which
  // is what lets us observe the strip instead of only the resulting rejection.
  const inp = input({
    cluster: { signals: ['sig-001', 'sig-002'] },
    signals: [
      signal(),
      signal({
        signal_id: 'sig-002',
        type: 'court_docket',
        title: 'New docket entry',
        tier: 2,
        confidence: 'medium',
        status: 'reported',
        summary_fact: 'A new docket entry was recorded in Franklin County on 7 October 2026.',
      }),
    ],
  });

  const dirty = (over: Partial<NarratorDraft> = {}): NarratorDraft => ({
    ...goodDraft(),
    what_changed: [
      {
        text: 'The registry filing records a transfer of majority ownership.',
        signal_id: 'sig-001',
      },
      // (b) a bogus signal_id -- not in cluster.signals
      { text: 'An unrelated filing was recorded.', signal_id: 'sig-does-not-exist' },
    ],
    // (a) an uncited factual sentence, alongside two properly cited ones
    why_it_matters:
      'The observation touches the change-of-control term on an agreement worth $1.2M a year [sig-001] [dl-nordvale-1]. The counterparty also moved its head office to Delaware last quarter. Worth asking about the new controlling entity.',
    confidence_note:
      'One cited observation is reported rather than confirmed [sig-002]. A recorded claim or notice is not a determination of wrongdoing.',
    ...over,
  });

  it('(a) strips the uncited sentence and (b) strips the bogus signal_id line', () => {
    const result = run(dirty(), inp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // (a)
    expect(result.briefing.why_it_matters).not.toContain('head office');
    expect(result.report.stripped_sentences).toEqual([
      {
        field: 'why_it_matters',
        sentence: 'The counterparty also moved its head office to Delaware last quarter.',
        reason: 'factual sentence with no citation that resolves',
      },
    ]);
    // The cited sentences survived.
    expect(result.briefing.why_it_matters).toContain('change-of-control term');
    expect(result.briefing.why_it_matters).toContain('Worth asking about');

    // (b)
    expect(result.briefing.what_changed.map((l) => l.signal_id)).toEqual(['sig-001']);
    expect(result.report.stripped_lines).toEqual([
      { signal_id: 'sig-does-not-exist', reason: 'signal_id is not in cluster.signals' },
    ]);

    // (5) coverage is byte-identical to the cluster's.
    expect(JSON.stringify(result.briefing.coverage)).toBe(JSON.stringify(COVERAGE));
    expect(result.briefing.coverage).toEqual(COVERAGE);
  });

  it('(c) rejects the draft outright when it says "healthy"', () => {
    const result = run(
      dirty({
        why_it_matters:
          'The agreement looks healthy despite the filing [sig-001]. Worth asking about the new controlling entity.',
      }),
      inp,
    );
    expect(result.ok).toBe(false);
    expect(result.report.violations.map((v) => v.rule)).toContain('forbidden-language');
    expect(result.report.violations[0]?.detail).toContain('healthy');
  });
});

describe('rule 1 + 2: what_changed lines must resolve', () => {
  it('strips a line whose signal_id is absent from cluster.signals', () => {
    const inp = input({
      cluster: { signals: ['sig-001', 'sig-002'] },
      signals: [signal(), signal({ signal_id: 'sig-002' })],
    });
    const result = run(
      goodDraft({
        what_changed: [
          { text: 'Ownership moved.', signal_id: 'sig-001' },
          { text: 'Something else moved.', signal_id: 'sig-404' },
        ],
      }),
      inp,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.what_changed).toHaveLength(1);
    expect(result.report.stripped_lines[0]).toEqual({
      signal_id: 'sig-404',
      reason: 'signal_id is not in cluster.signals',
    });
  });

  it('strips a line whose signal belongs to another company', () => {
    const inp = input({
      cluster: { signals: ['sig-001', 'sig-other'] },
      signals: [signal(), signal({ signal_id: 'sig-other', company_id: 'someone-else' })],
    });
    const result = run(
      goodDraft({
        what_changed: [
          { text: 'Ownership moved.', signal_id: 'sig-001' },
          { text: 'A different company filed something.', signal_id: 'sig-other' },
        ],
      }),
      inp,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.what_changed.map((l) => l.signal_id)).toEqual(['sig-001']);
    expect(result.report.stripped_lines[0]?.reason).toBe(
      'signal company_id does not match the briefing',
    );
  });
});

describe('rule 9: an emptied what_changed is never published', () => {
  it('rejects rather than publishing an empty array', () => {
    const result = run(
      goodDraft({ what_changed: [{ text: 'Ownership moved.', signal_id: 'sig-nope' }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.report.violations.map((v) => v.rule)).toContain('what_changed-empty');
  });
});

describe('rule 5: coverage is copied through, never summarised', () => {
  it('rejects a draft that returned its own coverage object', () => {
    const result = run(
      goodDraft({ coverage: { checked: ['registry'], failed: [], not_covered: [] } }),
    );
    expect(result.ok).toBe(false);
    expect(result.report.violations.map((v) => v.rule)).toContain('coverage-altered');
  });

  it('accepts a draft that echoed coverage back unchanged', () => {
    const result = run(goodDraft({ coverage: JSON.parse(JSON.stringify(COVERAGE)) }));
    expect(result.ok).toBe(true);
  });

  it('keeps as_of, which a re-derivation would lose', () => {
    const result = run(goodDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.coverage.as_of).toBe(COVERAGE.as_of);
  });
});

describe('rule 6: verify non-null IFF verify_with_counterparty', () => {
  it('is non-null when the cluster asks for it', () => {
    const result = run(goodDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.verify).toContain('Confirm the new controlling entity');
    expect(result.briefing.citations.verify).toEqual(['sig-001']);
  });

  it('is null, and the line is stripped, when the cluster does not', () => {
    const inp = input({ cluster: { verify_with_counterparty: false, top_tier: 2 } });
    const result = run(goodDraft(), inp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.verify).toBeNull();
    expect(result.report.stripped_sentences.some((s) => s.field === 'verify')).toBe(true);
  });

  it('rejects when the cluster asks for it and the draft gave null', () => {
    const result = run(goodDraft({ verify: null }));
    expect(result.ok).toBe(false);
    expect(result.report.violations.map((v) => v.rule)).toContain('verify-missing');
  });
});

describe('rule 7: confidence_note when anything is medium or low', () => {
  const medium = () =>
    input({ signals: [signal({ confidence: 'medium', status: 'reported' })] });

  it('is present for a medium signal', () => {
    const result = run(goodDraft(), medium());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.confidence_note).not.toBe('');
    expect(result.briefing.confidence_note).toContain('not a determination');
  });

  it('rejects a medium signal with no note', () => {
    const result = run(goodDraft({ confidence_note: '' }), medium());
    expect(result.ok).toBe(false);
    expect(result.report.violations.map((v) => v.rule)).toContain('confidence_note-missing');
  });

  it('does not require a note when everything is high', () => {
    const result = run(goodDraft({ confidence_note: '' }));
    expect(result.ok).toBe(true);
  });
});

describe('rule 8: every citation id must resolve', () => {
  it('strips volunteered ids that resolve to nothing', () => {
    const result = run(
      goodDraft({
        citations: {
          headline: ['sig-001', 'sig-ghost'],
          deal_context: ['dl-nordvale-1', 'dl-ghost'],
          why_it_matters: [],
          verify: [],
          confidence_note: [],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.citations.headline).toEqual(['sig-001']);
    expect(result.briefing.citations.deal_context).toEqual(['dl-nordvale-1']);
    expect(result.report.stripped_citations).toEqual(
      expect.arrayContaining([
        { field: 'citations.headline', id: 'sig-ghost' },
        { field: 'citations.deal_context', id: 'dl-ghost' },
      ]),
    );
  });

  it('builds the citation map from the inline markers', () => {
    const result = run(goodDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.citations).toEqual({
      headline: ['sig-001'],
      why_it_matters: ['sig-001'],
      deal_context: ['dl-nordvale-1'],
      verify: ['sig-001'],
      confidence_note: ['sig-001'],
    });
  });

  it('drops a sentence whose only marker was bogus', () => {
    const result = run(
      goodDraft({
        why_it_matters:
          'The counterparty moved its head office to Delaware [sig-ghost]. Worth asking about the new controlling entity.',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.why_it_matters).toBe('Worth asking about the new controlling entity.');
    expect(result.report.stripped_citations).toEqual([
      { field: 'why_it_matters', id: 'sig-ghost' },
    ]);
  });
});

describe('profile mode', () => {
  const profileInput = () =>
    input({
      cluster: {
        mode: 'profile',
        top_tier: 0,
        verify_with_counterparty: false,
        signals: ['sig-base'],
      },
      signals: [
        signal({
          signal_id: 'sig-base',
          type: 'baseline_identity',
          title: 'Starting registry record',
          tier: 0,
          status: 'baseline',
          summary_fact:
            'The starting registry snapshot identifies Nordvale Industrial LLC, registration OH-3819274, in US.',
        }),
      ],
    });

  it('emits sections[] and validates', () => {
    const inp = profileInput();
    const result = postProcess(buildFallbackDraft(inp), inp, { narration_status: 'fallback' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.mode).toBe('profile');
    expect(result.briefing.sections?.map((s) => s.title)).toEqual([...PROFILE_SECTION_TITLES]);
    // A section stating an absence rather than an observation flags itself.
    expect(result.briefing.sections?.filter((s) => s.gap === true).length).toBeGreaterThan(0);
    expect(briefingSchema.safeParse(result.briefing).success).toBe(true);
  });

  it('rejects profile narration whose sections all stripped to nothing', () => {
    const inp = profileInput();
    const result = postProcess(
      {
        ...goodDraft({
          verify: null,
          headline: 'The starting registry record identifies the entity [sig-base].',
          what_changed: [{ text: 'A starting registry record exists.', signal_id: 'sig-base' }],
          why_it_matters:
            'This is a starting record, not evidence of historical behaviour. Worth discussing before signing.',
        }),
        sections: [{ title: 'How this company has behaved', text: 'It moved to Delaware.' }],
      },
      inp,
      { narration_status: 'available' },
    );
    expect(result.ok).toBe(false);
    expect(result.report.violations.map((v) => v.rule)).toContain('sections-missing');
  });

  it('briefing mode does not require sections, and drops any it is given', () => {
    const result = run(
      goodDraft({ sections: [{ title: 'Extra', text: 'Something [sig-001].' }] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.briefing.sections).toBeUndefined();
    expect(result.report.dropped_sections[0]?.reason).toBe('sections are profile-mode only');
  });
});

describe('every produced briefing parses against briefingSchema', () => {
  it('narration and fallback alike', () => {
    const cases = [
      input(),
      input({ cluster: { verify_with_counterparty: false, top_tier: 2 } }),
      input({ signals: [signal({ confidence: 'low', status: 'inferred', tier: 3 })] }),
      input({
        cluster: { mode: 'profile', top_tier: 0, verify_with_counterparty: false },
        signals: [signal({ status: 'baseline', tier: 0 })],
      }),
    ];
    for (const inp of cases) {
      const fallback = postProcess(buildFallbackDraft(inp), inp, {
        narration_status: 'fallback',
      });
      expect(fallback.ok, JSON.stringify(fallback.report.violations)).toBe(true);
      if (fallback.ok) {
        expect(briefingSchema.parse(fallback.briefing).narration_status).toBe('fallback');
        expect(fallback.briefing.what_changed.length).toBeGreaterThan(0);
        expect(JSON.stringify(fallback.briefing.coverage)).toBe(
          JSON.stringify(inp.cluster.coverage),
        );
      }
    }
    const narrated = run(goodDraft());
    expect(narrated.ok).toBe(true);
    if (narrated.ok) expect(briefingSchema.parse(narrated.briefing).narration_status).toBe('available');
  });
});

describe('the fallback satisfies every post-processor rule', () => {
  it('including when a summary_fact carries wording we may not print', () => {
    const inp = input({
      signals: [
        signal({
          summary_fact: 'The docket alleges a breach of the supply agreement.',
        }),
      ],
    });
    const result = postProcess(buildFallbackDraft(inp), inp, { narration_status: 'fallback' });
    expect(result.ok, JSON.stringify(result.report.violations)).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.briefing).toLowerCase()).not.toContain('breach');
    expect(result.briefing.what_changed[0]?.signal_id).toBe('sig-001');
  });
});
