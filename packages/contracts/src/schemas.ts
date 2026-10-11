import { z } from 'zod';
import {
  sourceSchema, trustSchema, tierSchema, confidenceSchema, signalStatusSchema,
  changeKindSchema, runStatusSchema, briefingModeSchema, narrationStatusSchema,
  dealClassSchema, substitutabilitySchema,
} from './enums.js';

/**
 * Date discipline. Track C's dateLabel() does new Date(v + 'T12:00:00Z'), so a
 * full ISO string in a date-only field renders "Invalid Date".
 *   dateOnly  -> first_seen, window.from/to, start_date, end_date
 *   isoInstant -> generated_at, fetched_at, detected_at, started_at, ended_at
 */
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const isoInstant = z.string().datetime({ offset: true });

/** book_id scopes EVERY document. Omitting it renders Track C blank with no error. */
export const bookScoped = z.object({ book_id: z.string().min(1) });

export const idSchema = z.string().min(1).max(100);

// ---------------------------------------------------------------------------
// Items -- what a collector returns inside an envelope.
// `key` is the differ's comparison key, so its shape is part of the contract.
// ---------------------------------------------------------------------------
export const itemSchema = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
}).passthrough();
export type Item = z.infer<typeof itemSchema>;

// ---------------------------------------------------------------------------
// 1. Collector envelope  (collector -> store).  No book_id: collectors are
//    pure and know nothing about tenancy. A2 stamps it on write.
// ---------------------------------------------------------------------------
export const collectorEnvelopeSchema = z.object({
  company_id: idSchema,
  source: sourceSchema,
  fetched_at: isoInstant,
  run_id: idSchema,
  ok: z.boolean(),
  error: z.string().nullable(),
  items: z.array(itemSchema),
  raw_excerpt: z.string(),
  source_url: z.string(),
  credits_spent: z.number().int().min(0),
});
export type CollectorEnvelope = z.infer<typeof collectorEnvelopeSchema>;

// ---------------------------------------------------------------------------
// 2. Snapshot  (immutable; never updated, never deleted)
//
// The envelope minus `error` and `credits_spent`: a snapshot exists only for a
// successful fetch, and credit accounting lives on collector_runs, not here.
// Keeping every snapshot is what makes the behaviour profile possible --
// three years of officer lists is a churn pattern, one officer list is a fact.
// ---------------------------------------------------------------------------
export const snapshotSchema = collectorEnvelopeSchema.omit({
  error: true,
  credits_spent: true,
}).extend({
  snapshot_id: idSchema,
  content_hash: z.string().min(1),
  ok: z.literal(true),
}).merge(bookScoped);
export type Snapshot = z.infer<typeof snapshotSchema>;

// ---------------------------------------------------------------------------
// 3. collector_runs -- a SUPERSET of the envelope, not the envelope itself.
//    The evidence page names the sandbox; the coverage matrix needs status.
// ---------------------------------------------------------------------------
export const collectorRunSchema = z.object({
  run_id: idSchema,
  batch_id: idSchema,
  company_id: idSchema,
  source: sourceSchema,
  started_at: isoInstant,
  ended_at: isoInstant.nullable(),
  status: runStatusSchema,
  error: z.string().nullable(),
  credits_spent: z.number().int().min(0),
  sandbox_id: z.string().nullable(),
  cache_hit: z.boolean(),
}).merge(bookScoped);
export type CollectorRun = z.infer<typeof collectorRunSchema>;

// ---------------------------------------------------------------------------
// 4. Change  (differ -> validator)
// ---------------------------------------------------------------------------
export const changeSchema = z.object({
  company_id: idSchema,
  source: sourceSchema,
  kind: changeKindSchema,
  item: itemSchema,
  previous: itemSchema.nullable(),
  snapshot_id: idSchema,
  baseline_id: idSchema,
  detected_at: isoInstant,
}).merge(bookScoped);
export type Change = z.infer<typeof changeSchema>;

// ---------------------------------------------------------------------------
// 5. Signal  (validator, after corroboration)
// ---------------------------------------------------------------------------
export const evidenceSchema = z.object({
  snapshot_id: idSchema,
  source: sourceSchema,
  trust: trustSchema,
  /** Same text as snapshot.raw_excerpt, under a different name. Do not normalize. */
  excerpt: z.string(),
  url: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const signalSchema = z.object({
  signal_id: idSchema,
  company_id: idSchema,
  type: z.string().min(1),
  /** Required by Track C's SignalList, which renders it as the <h3>. Absent from the PDF. */
  title: z.string().min(1),
  tier: tierSchema,
  confidence: confidenceSchema,
  status: signalStatusSchema,
  evidence: z.array(evidenceSchema).min(1),
  first_seen: dateOnly,
  summary_fact: z.string().min(1),
  /** Which watched deal terms this signal touches. Never "breached". */
  touches_terms: z.array(z.string()).default([]),
}).merge(bookScoped);
export type Signal = z.infer<typeof signalSchema>;

// ---------------------------------------------------------------------------
// 6. Coverage -- travels unchanged from validator to briefing to screen.
//    checked/failed are source IDS; not_covered are human LABELS.
// ---------------------------------------------------------------------------
export const coverageSchema = z.object({
  checked: z.array(sourceSchema),
  failed: z.array(sourceSchema),
  not_covered: z.array(z.string()),
  as_of: isoInstant.optional(),
});
export type Coverage = z.infer<typeof coverageSchema>;

// ---------------------------------------------------------------------------
// 7. Cluster  (validator -> narrator)
// ---------------------------------------------------------------------------
export const clusterDealSchema = z.object({
  deal_id: idSchema,
  /** `class` here; deal documents keep `deal_class`. Two names, deliberately. */
  class: dealClassSchema,
  annual_value_usd: z.number(),
  share_pct: z.number().optional(),
  notice_days: z.number().int().optional(),
  days_to_renewal: z.number().int(),
  exposure_weight: z.number(),
  /** deal_class 'tied' raises a compliance flag rather than a weight. */
  compliance_flag: z.boolean().default(false),
});

export const clusterSchema = z.object({
  cluster_id: idSchema,
  company_id: idSchema,
  mode: briefingModeSchema,
  window: z.object({ from: dateOnly, to: dateOnly }),
  top_tier: tierSchema,
  verify_with_counterparty: z.boolean(),
  signals: z.array(idSchema),
  deals: z.array(clusterDealSchema),
  /** Read by Track C's useBookData for ordering. Absent from the PDF. */
  exposure: z.object({ top_weight: z.number(), annual_value_usd: z.number() }),
  coverage: coverageSchema,
  /** Hash of signal ids + statuses. Narrator runs only when this changes. */
  fingerprint: z.string().min(1),
}).merge(bookScoped);
export type Cluster = z.infer<typeof clusterSchema>;

// ---------------------------------------------------------------------------
// 8. Briefing  (narrator -> surface)
// ---------------------------------------------------------------------------
export const whatChangedSchema = z.object({
  text: z.string().min(1),
  signal_id: idSchema,
});

/** Citation map. Track C dereferences citations.why_it_matters.some(...) --
 *  absent, that is a TypeError, not a blank screen. */
export const citationsSchema = z.object({
  headline: z.array(idSchema),
  why_it_matters: z.array(idSchema),
  deal_context: z.array(idSchema),
  verify: z.array(idSchema),
  confidence_note: z.array(idSchema),
});

export const profileSectionSchema = z.object({
  title: z.string().min(1),
  text: z.string().min(1),
  signal_id: idSchema.optional(),
  /** Marks a section that states an absence rather than an observation. */
  gap: z.literal(true).optional(),
});

export const briefingSchema = z.object({
  briefing_id: idSchema,
  company_id: idSchema,
  mode: briefingModeSchema,
  headline: z.string().min(1),
  what_changed: z.array(whatChangedSchema).min(1),
  why_it_matters: z.string().min(1),
  verify: z.string().nullable(),
  confidence_note: z.string(),
  coverage: coverageSchema,
  generated_at: isoInstant,
  citations: citationsSchema,
  /** 'fallback' means narration was unavailable and the UI shows a signal list. */
  narration_status: narrationStatusSchema,
  /** Required by CompanyProfile when mode === 'profile'. */
  sections: z.array(profileSectionSchema).optional(),
  cluster_id: idSchema.optional(),
}).merge(bookScoped).refine(
  (b) => b.mode !== 'profile' || (b.sections?.length ?? 0) > 0,
  { path: ['sections'], message: 'A profile briefing must carry sections[].' },
);
export type Briefing = z.infer<typeof briefingSchema>;

// ---------------------------------------------------------------------------
// 9. Company  (A2 upserts; Track C also creates these by hand)
// ---------------------------------------------------------------------------
export const companySchema = z.object({
  company_id: idSchema,
  canonical_name: z.string().min(1),
  /** 2-letter uppercase, or linkDeal() throws on a country mismatch. */
  jurisdiction: z.string().regex(/^[A-Z]{2}$/),
  registry_id: z.string(),
  /** registry_id.toUpperCase(), or MANUAL:<uuid>. Required by the unique index. */
  registry_key: z.string().min(1),
  aliases: z.array(z.string()),
  domains: z.array(z.string()),
  officers: z.array(z.record(z.unknown())).default([]),
  /** Stored and shown, but deliberately NOT collected -- credit cost scales with group size. */
  related_entities: z.array(z.record(z.unknown())).default([]),
  resolution: z.object({
    /** A FLOAT here, unlike signal.confidence which is a word. */
    confidence: z.number().nullable(),
    reason: z.string(),
    resolved_by: z.string().nullable(),
    candidates_seen: z.array(z.record(z.unknown())).default([]),
    resolved_at: isoInstant.optional(),
  }),
  coverage: coverageSchema.optional(),
  last_checked_at: isoInstant.optional(),
  monitoring_since: z.string().optional(),
  /**
   * Present ONLY on a company that entered through a pre-deal lookup rather
   * than through a deal row.
   *
   * `lookup` and `monitoring_since` are deliberately independent fields rather
   * than one enum, because they describe two different facts and all three
   * combinations are real:
   *   lookup, no monitoring_since  -> looked up, never signed, not watched
   *   lookup + monitoring_since    -> looked up, then signed; history kept
   *   monitoring_since, no lookup  -> arrived as a deal the ordinary way
   *
   * That middle state is the point of the feature: companies are upserted by
   * registry_id, so signing reuses this record and the diligence snapshots
   * become the monitoring baseline instead of being thrown away.
   *
   * `watch_until` is the negotiation window; null is the one-shot default.
   */
  lookup: z.object({
    requested_at: isoInstant,
    requested_by: z.string().min(1),
    /** Date-only: a user picks a day, not an instant. */
    watch_until: dateOnly.nullable(),
  }).optional(),
}).merge(bookScoped);
export type Company = z.infer<typeof companySchema>;

// ---------------------------------------------------------------------------
// 10. Schedule -- one per (company, source). The orchestrator loop IS the scheduler.
// ---------------------------------------------------------------------------
export const scheduleSchema = z.object({
  company_id: idSchema,
  source: sourceSchema,
  cadence: z.enum(['daily', 'weekly']),
  next_run_at: isoInstant,
  last_run_at: isoInstant.nullable(),
  enabled: z.boolean(),
  /**
   * When this schedule stops being due. Null -- the default and the case for
   * every monitored deal -- means no expiry.
   *
   * It exists for `watch while we negotiate`: a prospect can be watched for a
   * bounded window without becoming a permanent credit cost. `.default(null)`
   * rather than `.optional()` on purpose, so schedules written before this
   * field existed read back as null instead of undefined and dueSchedules()
   * needs no special case for them.
   */
  expires_at: isoInstant.nullable().default(null),
}).merge(bookScoped);
export type Schedule = z.infer<typeof scheduleSchema>;

export const dealSchema = z.object({
  deal_id: idSchema,
  company_id: idSchema.optional(),
  counterparty_name: z.string().min(1),
  country: z.string().regex(/^[A-Z]{2}$/),
  deal_class: dealClassSchema,
  annual_value_usd: z.number(),
  start_date: dateOnly,
  end_date: dateOnly,
  notice_days: z.number().int().optional(),
  share_pct: z.number().optional(),
  substitutability: substitutabilitySchema.optional(),
  owner_email: z.string().optional(),
  watch_terms: z.string().optional(),
  status: z.enum(['unresolved', 'needs_review', 'resolved']),
});
export type Deal = z.infer<typeof dealSchema>;

// ---------------------------------------------------------------------------
// 11. Book exposure  (store reads -> surface).  The whole book, not one deal.
// ---------------------------------------------------------------------------
/**
 * What the book carries in total.
 *
 * THIS IS NOT A SCORE, AND THE SHAPE IS THE GUARANTEE. Rule 1 is that the
 * system reports observed change and never asserts health; a single number for
 * a whole book is a verdict, and a verdict is precisely what the first tester
 * said they would not trust. So every field below is either a sum of DOLLARS
 * the user typed at intake, a COUNT of companies, or a tier that came out of
 * the rules table -- each one re-derivable on paper.
 *
 * Three rules this shape enforces by construction:
 *
 *  1. NOTHING IS BLENDED. There is no field here that sums or averages
 *     `exposure_weight`. A per-deal weight is explainable (value against a cap,
 *     share against a cap, doubled when hard to replace, plus a notice bump);
 *     thirty of them added together is a number nobody can check by hand. If
 *     you are adding a field and reach for a weight, that is the signal you are
 *     building a score. Add the dollars instead.
 *
 *  2. UNKNOWN AGGREGATES AS UNKNOWN. share_pct, substitutability and
 *     notice_days are optional at intake and each only ever ADDS to a weight,
 *     so a sparsely described deal always understates. `value_exposure_unknown`
 *     carries that up: it is the contracted value whose exposure is a floor
 *     rather than a measurement. A book that is mostly unknown must read as
 *     mostly unknown, not as mostly low.
 *
 *  3. COVERAGE IS MONEY, NOT A PERCENTAGE. "94% source coverage" hides which
 *     6%. `value_behind_failed_source` states the contracted value sitting
 *     behind each unreachable source BY NAME, which for this build is a
 *     permanent, honest line about `regulator` and `layoffs`.
 *
 * Computed on read and never stored, so it cannot go stale behind the data.
 */
export const bookExposureSchema = z.object({
  as_of: isoInstant,

  counterparties: z.object({
    total: z.number().int(),
    /** Has monitoring_since: on a cadence. */
    monitored: z.number().int(),
    /** Entered via lookup and never signed. Contributes no contracted value. */
    lookup_only: z.number().int(),
  }),

  /** Sums of deals.annual_value_usd. `tied` is its own line, never a weight. */
  contracted_value_usd: z.object({
    total: z.number(),
    they_pay_us: z.number(),
    we_pay_them: z.number(),
    tied: z.number(),
  }),

  /**
   * Contracted value grouped by the top tier of the company's live cluster.
   * `none` is companies with no surfacing signal -- which is a coverage
   * statement about them, not a clean bill of health.
   */
  value_by_top_tier: z.object({
    tier1: z.number(),
    tier2: z.number(),
    tier3: z.number(),
    none: z.number(),
  }),

  /** Value whose notice window shuts within `notice_window_days`. */
  value_notice_window_closing: z.number(),
  /** Carried so the figure above is self-describing on screen. */
  notice_window_days: z.number().int(),

  /** Value on counterparties the user marked `substitutability: 'hard'`. */
  value_hard_to_replace: z.number(),

  /** Concentration, stated rather than scored. Null on an empty book. */
  largest_counterparty: z.object({
    company_id: idSchema,
    canonical_name: z.string().min(1),
    annual_value_usd: z.number(),
    /** This counterparty's value as a percentage of contracted_value_usd.total. */
    share_of_book_pct: z.number(),
    /** The user's own share_pct, when they gave one. */
    share_pct: z.number().nullable(),
  }).nullable(),

  /** See rule 2. The understatement, named. */
  value_exposure_unknown: z.number(),
  companies_exposure_unknown: z.number().int(),

  /** See rule 3. Source id -> contracted value behind it. Partial by design. */
  value_behind_failed_source: z.record(sourceSchema, z.number()),

  /** Verbatim from NOT_COVERED_CATEGORIES. True of every counterparty. */
  not_covered: z.array(z.string()),

  /**
   * The honest replacement for a risk score, assembled by CODE from the fields
   * above -- never by the narrator. No model writes it, so the citation gate
   * does not apply and the sentence cannot drift between screens.
   */
  headline: z.string().min(1),
}).merge(bookScoped);
export type BookExposure = z.infer<typeof bookExposureSchema>;
