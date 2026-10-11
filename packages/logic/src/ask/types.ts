import { z } from 'zod';
import type { CollectorRun, Coverage, Deal, Signal } from '@donna/contracts';
import type { NarratorSignalView } from '../narrator/types.js';

/**
 * What the Ask surface is answering WITH, and what it returns.
 *
 * The shape mirrors the narrator for a reason: an answer is prose over stored
 * records, so it inherits the same contract -- every factual sentence cites a
 * record id, absence/ask sentences are exempt, and coverage is copied through
 * rather than paraphrased.
 */

/** The intent the deterministic classifier assigns to a question. */
export type AskIntent =
  /** "are they healthy", "should I renew" -- a verdict is refused, then observed records shown. */
  | 'verdict'
  /** "what did you check", "do you cover courts" -- coverage is stated, verbatim. */
  | 'coverage'
  /** "did they breach the contract" -- answered as signals touching watched terms. */
  | 'watched_terms'
  /** Everything else: keyword retrieval over stored records. */
  | 'records';

export interface AskInput {
  question: string;
  /** Already scoped to the book, and to a company when the UI scoped it. */
  signals: Signal[];
  deals: Deal[];
  coverage: Coverage[];
  runs: CollectorRun[];
}

/**
 * The records retrieval selected for THIS question. This -- not the input --
 * is what the model sees and what the gate resolves citations against. A record
 * that is not here cannot be cited, which is the mechanism that stops the model
 * importing a fact from outside the answer's scope.
 */
export interface AskCandidates {
  /** Projected views (toNarratorView): summaries + bounded excerpts, no pages. */
  signals: NarratorSignalView[];
  deals: Deal[];
  coverage: Coverage[];
  runs: CollectorRun[];
  /** Company ids the question names. Null means the question was book-wide. */
  scoped_company_ids: readonly string[] | null;
}

export type AskLineKind =
  /** A record-backed sentence. Must carry at least one citation. */
  | 'observation'
  /** An absence or refusal sentence. Exempt from citation by construction. */
  | 'absence'
  /** Coverage, copied from stored Coverage records. Never model-written. */
  | 'coverage';

export interface AskLine {
  /** Clean text: citation markers already removed. */
  text: string;
  /** Record ids backing this line -- signal, deal and run ids. */
  citations: string[];
  kind: AskLineKind;
}

export type AskKind =
  /** A verdict question: refusal first, then observed records. */
  | 'verdict_refusal'
  /** A coverage question: what was checked, verbatim. */
  | 'coverage'
  /** A watched-terms question: signals touching signed terms. */
  | 'watched_terms'
  /** Ordinary cited observations. */
  | 'observations'
  /** Nothing in the records answers the question. */
  | 'not_observed';

export interface AskViolation {
  rule: 'forbidden-language' | 'answer-empty';
  detail: string;
}

export interface AskReport {
  /** Sentences removed for having no citation that resolves. */
  stripped_sentences: { sentence: string; reason: string }[];
  /** Citation ids that resolved to no candidate record. */
  stripped_citations: { id: string }[];
  /** Non-empty means the model draft was rejected and we fell back. */
  violations: AskViolation[];
}

export interface AskAnswer {
  question: string;
  kind: AskKind;
  /** The rendered answer. Citation markers are kept inline for the UI. */
  text: string;
  lines: AskLine[];
  /** True when the answer was built by code: no client, or model rejected. */
  used_fallback: boolean;
  /** Model calls actually made. 0 on the offline path. */
  attempts: number;
  failures: { attempt: number; reason: string }[];
  report: AskReport;
}

/**
 * What the model returns. One field on purpose: the citation map is DERIVED
 * from inline [record-id] markers by the gate, so there is no second channel
 * through which prose and citations could disagree.
 */
export const askDraftSchema = z.object({
  answer: z.string().min(1),
});
export type AskDraft = z.infer<typeof askDraftSchema>;
