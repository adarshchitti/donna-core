import {
  briefingId, briefingSchema, isoNow, profileBriefingId,
  type Briefing, type Coverage,
} from '@donna/contracts';
import { findForbidden, type ForbiddenHit } from './forbidden.js';
import { isFactualSentence, splitSentences, stripMarkers } from './sentences.js';
import type { NarratorDraft, NarratorInput, NarratorSignalView } from './types.js';

/**
 * THE POST-PROCESSOR.
 *
 * Deterministic. No model involved. This is the reason the output can be
 * believed, and it is the reason a cheap model is an acceptable narrator: a
 * violation is stripped or the whole draft is rejected, so a violation never
 * ships. Every rule below is numbered to the contract it enforces, and each
 * carries the failure it exists to prevent -- because the shape of most of
 * these rules looks redundant until you know which screen it crashes.
 *
 * Two kinds of outcome:
 *   STRIP   -- the offending part is removed and the rest is published.
 *   REJECT  -- the draft is unpublishable; the caller retries once, then falls
 *              back to a briefing built by code. Used where removing the
 *              offending part would change what the remaining text claims
 *              (forbidden language) or would leave a field the UI dereferences
 *              empty (what_changed).
 */

export type ViolationRule =
  | 'forbidden-language'
  | 'coverage-altered'
  | 'what_changed-empty'
  | 'headline-unsupported'
  | 'why_it_matters-unsupported'
  | 'verify-missing'
  | 'confidence_note-missing'
  | 'sections-missing'
  | 'schema';

export interface Violation {
  rule: ViolationRule;
  detail: string;
}

export interface PostProcessReport {
  /** what_changed lines removed, with the gate that removed them. */
  stripped_lines: { signal_id: string; reason: string }[];
  /** Sentences removed for having no citation behind them. */
  stripped_sentences: { field: string; sentence: string; reason: string }[];
  /** Citation ids that resolved to nothing. */
  stripped_citations: { field: string; id: string }[];
  dropped_sections: { title: string; reason: string }[];
  /** Non-empty means REJECT. */
  violations: Violation[];
}

export type PostProcessResult =
  | { ok: true; briefing: Briefing; report: PostProcessReport }
  | { ok: false; report: PostProcessReport };

export interface PostProcessOptions {
  narration_status: Briefing['narration_status'];
  /** Overrides input.now; both exist so generated_at is deterministic. */
  now?: string;
}

const emptyReport = (): PostProcessReport => ({
  stripped_lines: [],
  stripped_sentences: [],
  stripped_citations: [],
  dropped_sections: [],
  violations: [],
});

const uniq = (ids: readonly string[]): string[] => [...new Set(ids)];

const forbiddenDetail = (field: string, hits: readonly ForbiddenHit[]): string =>
  `${field}: ${hits.map((h) => `${h.rule}/"${h.match}"`).join(', ')}`;

export const postProcess = (
  draft: NarratorDraft,
  input: NarratorInput,
  opts: PostProcessOptions,
): PostProcessResult => {
  const report = emptyReport();
  const { cluster } = input;

  const viewById = new Map<string, NarratorSignalView>(
    input.signals.map((s) => [s.signal_id, s]),
  );
  const citedByCluster = new Set(cluster.signals);
  const dealIds = new Set(cluster.deals.map((d) => d.deal_id));

  /**
   * Rules 1 + 2 as one predicate, because the UI applies both: Track C's
   * BriefingBody looks each what_changed signal_id up in the signals it holds
   * for THIS company and silently skips a miss, which renders as "0 cited
   * observations" over an empty panel -- a briefing that looks like a bug.
   * We strip first so the panel is honest and the strip is logged.
   */
  const resolveSignal = (id: string): NarratorSignalView | null => {
    if (!citedByCluster.has(id)) return null;
    const view = viewById.get(id);
    if (view === undefined) return null;
    if (view.company_id !== cluster.company_id) return null;
    return view;
  };

  // --- Rule 4: forbidden reassurance words and advice verbs ---------------
  // Scanned across everything the MODEL wrote, before anything else: a draft
  // that says "healthy" or "breached" is not repairable by deletion, because
  // deleting the word changes the claim. Reject and let the caller fall back.
  const modelText: [string, string][] = [
    ['headline', draft.headline],
    ['why_it_matters', draft.why_it_matters],
    ...(draft.verify != null ? ([['verify', draft.verify]] as [string, string][]) : []),
    ...(draft.confidence_note !== undefined
      ? ([['confidence_note', draft.confidence_note]] as [string, string][])
      : []),
    ...draft.what_changed.map((l, i): [string, string] => [`what_changed[${i}]`, l.text]),
    ...(draft.sections ?? []).flatMap((s, i): [string, string][] => [
      [`sections[${i}].title`, s.title],
      [`sections[${i}].text`, s.text],
    ]),
  ];
  for (const [field, text] of modelText) {
    const hits = findForbidden(text);
    if (hits.length > 0) {
      report.violations.push({ rule: 'forbidden-language', detail: forbiddenDetail(field, hits) });
    }
  }

  // --- Rule 5: coverage is copied through, byte-identically ---------------
  // The model is not asked for coverage at all, so this only fires if a draft
  // volunteered one. A model-summarised coverage list is the worst possible
  // error on this screen: it is the part of the page that says what we did NOT
  // look at, and a paraphrase of it is a quiet lie about our own blind spots.
  const coverage: Coverage = cluster.coverage;
  if (draft.coverage !== undefined) {
    const same = JSON.stringify(draft.coverage) === JSON.stringify(coverage);
    if (!same) {
      report.violations.push({
        rule: 'coverage-altered',
        detail: 'draft returned a coverage object that differs from the cluster',
      });
    }
  }

  // --- Rules 1 + 2: what_changed lines must resolve -----------------------
  const whatChanged: { text: string; signal_id: string }[] = [];
  for (const line of draft.what_changed) {
    const view = resolveSignal(line.signal_id);
    if (view === null) {
      report.stripped_lines.push({
        signal_id: line.signal_id,
        reason: citedByCluster.has(line.signal_id)
          ? 'signal company_id does not match the briefing'
          : 'signal_id is not in cluster.signals',
      });
      continue;
    }
    const text = stripMarkers(line.text);
    if (text === '') {
      report.stripped_lines.push({ signal_id: line.signal_id, reason: 'empty text' });
      continue;
    }
    whatChanged.push({ text, signal_id: line.signal_id });
  }

  // --- Rule 9: an empty what_changed must NOT be published ---------------
  // Track C dereferences what_changed[0] on the Book page. An empty array is
  // not a blank panel, it is a crash, so this is a REJECT and the caller falls
  // back to the code-built briefing (which lists every signal by construction).
  if (whatChanged.length === 0) {
    report.violations.push({
      rule: 'what_changed-empty',
      detail: `all ${draft.what_changed.length} line(s) were stripped`,
    });
  }

  /**
   * --- Rule 3: drop factual sentences with no citation behind them -------
   * The rule for "factual" lives in sentences.ts and is documented there.
   * Citations are stated inline by the model as [sig-...]; this is where they
   * are resolved, and the resolved ids are also what builds citations.* below
   * (rule 8) -- one source of truth, so the prose and the citation map cannot
   * disagree about what is cited.
   */
  const gate = (
    field: string,
    text: string,
    { requireCitations = true }: { requireCitations?: boolean } = {},
  ): { text: string; signals: string[]; deals: string[] } => {
    const keptSignals: string[] = [];
    const keptDeals: string[] = [];
    const kept: string[] = [];

    for (const sentence of splitSentences(text)) {
      const signals: string[] = [];
      const deals: string[] = [];
      for (const id of sentence.markers) {
        if (resolveSignal(id) !== null) signals.push(id);
        else if (dealIds.has(id)) deals.push(id);
        else report.stripped_citations.push({ field, id });
      }
      const backed = signals.length > 0 || deals.length > 0;
      if (requireCitations && !backed && isFactualSentence(sentence.raw)) {
        report.stripped_sentences.push({
          field,
          sentence: stripMarkers(sentence.raw),
          reason: 'factual sentence with no citation that resolves',
        });
        continue;
      }
      kept.push(stripMarkers(sentence.raw));
      keptSignals.push(...signals);
      keptDeals.push(...deals);
    }

    return {
      text: kept.join(' ').replace(/[ \t]{2,}/g, ' ').trim(),
      signals: uniq(keptSignals),
      deals: uniq(keptDeals),
    };
  };

  const headline = gate('headline', draft.headline);
  if (headline.text === '') {
    report.violations.push({
      rule: 'headline-unsupported',
      detail: 'headline had no sentence with a citation that resolves',
    });
  }

  const why = gate('why_it_matters', draft.why_it_matters);
  if (why.text === '') {
    report.violations.push({
      rule: 'why_it_matters-unsupported',
      detail: 'why_it_matters had no sentence with a citation that resolves',
    });
  }

  // --- Rule 6: verify non-null IFF verify_with_counterparty --------------
  // Asymmetric on purpose. An unwanted verify line is removable (strip); a
  // missing one when a tier 1 is in the cluster is content we do not have, so
  // it is a reject and the fallback writes a generic one.
  let verify: string | null = null;
  const verifyCites: string[] = [];
  if (cluster.verify_with_counterparty) {
    const raw = draft.verify;
    if (raw == null || stripMarkers(raw) === '') {
      report.violations.push({
        rule: 'verify-missing',
        detail: 'cluster.verify_with_counterparty is true but verify is empty',
      });
    } else {
      const g = gate('verify', raw);
      if (g.text === '') {
        report.violations.push({
          rule: 'verify-missing',
          detail: 'verify was stripped to nothing by the citation gate',
        });
      } else {
        verify = g.text;
        verifyCites.push(...g.signals);
      }
    }
  } else if (draft.verify != null && stripMarkers(draft.verify) !== '') {
    report.stripped_sentences.push({
      field: 'verify',
      sentence: stripMarkers(draft.verify),
      reason: 'cluster.verify_with_counterparty is false',
    });
  }

  // --- Rule 7: confidence_note present when any signal is medium or low ---
  // "No change observed" and "reported but not confirmed" are the two things
  // this product must never blur, so the note is mandatory whenever anything
  // in the cluster is below `high`.
  const needsNote = input.signals.some(
    (s) => s.confidence === 'medium' || s.confidence === 'low',
  );
  const noteGate =
    draft.confidence_note !== undefined && draft.confidence_note.trim() !== ''
      ? gate('confidence_note', draft.confidence_note, { requireCitations: false })
      : { text: '', signals: [], deals: [] };
  if (needsNote && noteGate.text === '') {
    report.violations.push({
      rule: 'confidence_note-missing',
      detail: 'a signal is medium or low but confidence_note is empty',
    });
  }

  // --- sections: profile mode only ---------------------------------------
  let sections: Briefing['sections'];
  if (cluster.mode === 'profile') {
    const out: NonNullable<Briefing['sections']> = [];
    for (const s of draft.sections ?? []) {
      // A `gap: true` section states an absence -- "officer churn is not
      // observed in the available history". There is by definition no signal
      // to cite, which is what `gap` MEANS, so the citation gate is off for it.
      const g = gate(`sections/${s.title}`, s.text, { requireCitations: s.gap !== true });
      if (g.text === '') {
        report.dropped_sections.push({ title: s.title, reason: 'text stripped to nothing' });
        continue;
      }
      const explicit = s.signal_id !== undefined && resolveSignal(s.signal_id) !== null
        ? s.signal_id
        : undefined;
      const signalId = explicit ?? g.signals[0];
      out.push({
        title: stripMarkers(s.title),
        text: g.text,
        ...(signalId !== undefined ? { signal_id: signalId } : {}),
        ...(s.gap === true ? { gap: true as const } : {}),
      });
    }
    if (out.length === 0) {
      report.violations.push({
        rule: 'sections-missing',
        detail: 'profile mode requires at least one section',
      });
    }
    sections = out;
  } else if ((draft.sections ?? []).length > 0) {
    // sections[] is a profile-mode field. Carrying them in briefing mode would
    // put narration on the Book page that nothing there renders or cites.
    for (const s of draft.sections ?? []) {
      report.dropped_sections.push({ title: s.title, reason: 'sections are profile-mode only' });
    }
  }

  /**
   * --- Rule 8: every citation id must resolve -----------------------------
   * The map is built from the ids the gate already resolved, so unresolved ids
   * cannot reach it. Ids a draft volunteered in its own `citations` object are
   * merged here and filtered by the same resolvers -- `deal_context` against
   * cluster.deals, everything else against cluster.signals.
   */
  const volunteered = draft.citations ?? {};
  const keepSignals = (field: string, ids: readonly string[] | undefined): string[] =>
    (ids ?? []).filter((id) => {
      if (resolveSignal(id) !== null) return true;
      report.stripped_citations.push({ field, id });
      return false;
    });
  const keepDeals = (field: string, ids: readonly string[] | undefined): string[] =>
    (ids ?? []).filter((id) => {
      if (dealIds.has(id)) return true;
      report.stripped_citations.push({ field, id });
      return false;
    });

  const citations = {
    headline: uniq([...headline.signals, ...keepSignals('citations.headline', volunteered.headline)]),
    why_it_matters: uniq([
      ...why.signals,
      ...keepSignals('citations.why_it_matters', volunteered.why_it_matters),
    ]),
    deal_context: uniq([
      ...why.deals,
      ...headline.deals,
      ...keepDeals('citations.deal_context', volunteered.deal_context),
    ]),
    verify: uniq([...verifyCites, ...keepSignals('citations.verify', volunteered.verify)]),
    confidence_note: uniq([
      ...noteGate.signals,
      ...keepSignals('citations.confidence_note', volunteered.confidence_note),
    ]),
  };

  if (report.violations.length > 0) return { ok: false, report };

  const parsed = briefingSchema.safeParse({
    book_id: cluster.book_id,
    briefing_id:
      cluster.mode === 'profile'
        ? profileBriefingId(cluster.company_id)
        : briefingId(cluster.company_id),
    company_id: cluster.company_id,
    mode: cluster.mode,
    headline: headline.text,
    what_changed: whatChanged,
    why_it_matters: why.text,
    verify,
    confidence_note: noteGate.text,
    // Rule 5 again, at the only point that matters: the SAME object, not a
    // reformat, not a re-derivation. `as_of` has gone missing this way before.
    coverage,
    generated_at: opts.now ?? input.now ?? isoNow(),
    citations,
    narration_status: opts.narration_status,
    ...(sections !== undefined ? { sections } : {}),
    cluster_id: cluster.cluster_id,
  });

  if (!parsed.success) {
    report.violations.push({
      rule: 'schema',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return { ok: false, report };
  }

  // Belt and braces on rule 5. If this ever throws, somebody added a transform.
  if (JSON.stringify(parsed.data.coverage) !== JSON.stringify(cluster.coverage)) {
    throw new Error('narrator: coverage was altered between cluster and briefing');
  }

  return { ok: true, briefing: parsed.data, report };
};
