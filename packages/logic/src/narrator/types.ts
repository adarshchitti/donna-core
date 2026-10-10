import { z } from 'zod';
import {
  confidenceSchema, idSchema, signalStatusSchema, tierSchema, dateOnly,
  type Cluster, type Signal,
} from '@donna/contracts';

/**
 * How much of an evidence excerpt the narrator may see.
 *
 * `evidence.excerpt` is documented in the contracts as "same text as
 * snapshot.raw_excerpt", i.e. it CAN be a whole fetched page. The narrator must
 * never see a raw page -- only validated signals -- so the projection below
 * truncates. This is the enforcement point, not a performance tweak.
 */
export const MAX_EXCERPT_CHARS = 400;

/**
 * The narrator's view of a signal.
 *
 * Deliberately NOT `Signal`. There is no `evidence` array, no `snapshot_id`, no
 * `url` and no `raw_excerpt` field, so there is no field through which a raw
 * page could reach the prompt. The narrator's input type IS the guarantee:
 * `buildNarratorRequest` accepts only these, so a future caller cannot hand it
 * a `Signal` (and with it a page) by accident.
 */
export interface NarratorSignalView {
  signal_id: string;
  /** Needed by post-processor rule 2 (company gate), not by the prompt. */
  company_id: string;
  type: string;
  title: string;
  tier: Signal['tier'];
  confidence: Signal['confidence'];
  status: Signal['status'];
  first_seen: string;
  summary_fact: string;
  touches_terms: readonly string[];
  /** Bounded quotes from the validated evidence. Never a whole page. */
  excerpts: readonly string[];
}

export const narratorSignalViewSchema = z.object({
  signal_id: idSchema,
  company_id: idSchema,
  type: z.string().min(1),
  title: z.string().min(1),
  tier: tierSchema,
  confidence: confidenceSchema,
  status: signalStatusSchema,
  first_seen: dateOnly,
  summary_fact: z.string().min(1),
  touches_terms: z.array(z.string()),
  excerpts: z.array(z.string().max(MAX_EXCERPT_CHARS)),
});

const clip = (s: string): string =>
  s.length <= MAX_EXCERPT_CHARS ? s : `${s.slice(0, MAX_EXCERPT_CHARS - 1)}…`;

/** The projection. The only sanctioned way to turn a Signal into prompt input. */
export const toNarratorView = (signal: Signal): NarratorSignalView => ({
  signal_id: signal.signal_id,
  company_id: signal.company_id,
  type: signal.type,
  title: signal.title,
  tier: signal.tier,
  confidence: signal.confidence,
  status: signal.status,
  first_seen: signal.first_seen,
  summary_fact: signal.summary_fact,
  touches_terms: [...signal.touches_terms],
  excerpts: signal.evidence.map((e) => clip(e.excerpt)),
});

export interface NarratorInput {
  /** Carries mode, window, deals, coverage, verify_with_counterparty, book_id. */
  cluster: Cluster;
  /** Projected views of the signals `cluster.signals` names. */
  signals: readonly NarratorSignalView[];
  /** Injected so generated_at is deterministic in tests. */
  now?: string;
}

/**
 * Builds the narrator input from a cluster and the signal documents it
 * references, projecting each one and dropping anything the cluster does not
 * cite. A cluster that names a signal we were not given is a caller bug, so it
 * throws rather than silently narrating a shorter list.
 */
export const narratorInput = (
  cluster: Cluster,
  signals: readonly Signal[],
  now?: string,
): NarratorInput => {
  const byId = new Map(signals.map((s) => [s.signal_id, s]));
  const views = cluster.signals.map((id) => {
    const s = byId.get(id);
    if (s === undefined) {
      throw new Error(`narrator: cluster ${cluster.cluster_id} cites unknown signal ${id}`);
    }
    return toNarratorView(s);
  });
  return now === undefined ? { cluster, signals: views } : { cluster, signals: views, now };
};

// ---------------------------------------------------------------------------
// The draft -- what the model is asked to return.
//
// Note what is NOT here: `coverage` and `citations` are not the model's to
// write. Coverage is copied through from the cluster verbatim (rule 5) and the
// citation map is DERIVED from inline [signal_id] markers by the
// post-processor. One source of truth for "what counts as a citation" is the
// whole reason the prompt and the gate are built together: if the model wrote
// the citation map and the gate read the prose, the two would drift apart and
// an uncited sentence would ship with a citation beside it.
//
// `citations` is still accepted if the model volunteers one, so that rule 8
// (strip ids that resolve to nothing) has something to bite on either way.
// ---------------------------------------------------------------------------

export const draftWhatChangedSchema = z.object({
  text: z.string().min(1),
  signal_id: z.string().min(1),
});

export const draftSectionSchema = z.object({
  title: z.string().min(1),
  text: z.string().min(1),
  gap: z.boolean().optional(),
  signal_id: z.string().optional(),
});

export const narratorDraftSchema = z.object({
  headline: z.string().min(1),
  what_changed: z.array(draftWhatChangedSchema),
  why_it_matters: z.string().min(1),
  verify: z.string().nullable().optional(),
  confidence_note: z.string().optional(),
  sections: z.array(draftSectionSchema).optional(),
  /** Optional, and never trusted: every id is re-resolved. */
  citations: z
    .object({
      headline: z.array(z.string()).optional(),
      why_it_matters: z.array(z.string()).optional(),
      deal_context: z.array(z.string()).optional(),
      verify: z.array(z.string()).optional(),
      confidence_note: z.array(z.string()).optional(),
    })
    .optional(),
  /** Accepted only so rule 5 can REJECT a model that tried to rewrite it. */
  coverage: z.unknown().optional(),
});
export type NarratorDraft = z.infer<typeof narratorDraftSchema>;
