import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { sourceSchema, changeKindSchema, tierSchema } from '@donna/contracts';

/**
 * The rules table.
 *
 * WHY this is a JSON file read at runtime rather than a TypeScript constant:
 * the tier/type mapping and every threshold are tuned between user
 * sense-checks. Keeping them as DATA means an operator edits one file and the
 * next run picks it up -- no deploy, no code review of a number. It is also
 * why nothing in this package may hard-code a tier literal: the table is the
 * single place tiers live. This step is deliberately plain code plus this
 * table. It is not a model.
 *
 * It is read with fs rather than `import rules.json` because the shared
 * tsconfig does not enable resolveJsonModule, and because a runtime read is
 * what makes "tune without a deploy" true.
 */

/** One match clause. An omitted field means "don't care". All present fields must hold. */
export const matchClauseSchema = z.object({
  sources: z.array(sourceSchema).nonempty().optional(),
  kinds: z.array(changeKindSchema).nonempty().optional(),
  item_types: z.array(z.string().min(1)).nonempty().optional(),
});
export type MatchClause = z.infer<typeof matchClauseSchema>;

export const signalTypeRuleSchema = z.object({
  type: z.string().min(1),
  /** FIXED per type. Classification never computes a tier; it looks one up here. */
  tier: tierSchema,
  /** Signal.title is required by the UI and rendered as the heading. */
  title: z.string().min(1),
  /** Fallback summary_fact when the change item carries no `summary`. */
  summary: z.string().min(1),
  match: z.array(matchClauseSchema),
});
export type SignalTypeRule = z.infer<typeof signalTypeRuleSchema>;

export const rulesSchema = z.object({
  version: z.number().int().positive(),
  /** Coarse on purpose: same company, same type, within this many days. */
  corroboration_window_days: z.number().int().positive(),
  thresholds: z.object({
    /** A tier 2 surfaces only when the top linked-deal exposure clears this. */
    tier2_min_exposure_weight: z.number().min(0).max(1),
    /** This many tier 3 signals in the window promote the cluster to tier 2. */
    tier3_pattern_count: z.number().int().positive(),
    /** Independent reported outlets needed before a reported-only signal may hold tier 1/2. */
    reported_min_independent_outlets: z.number().int().positive(),
  }),
  labels: z.object({ reported_unconfirmed: z.string().min(1) }),
  exposure: z.object({
    value_cap_usd: z.number().positive(),
    value_weight: z.number().min(0),
    share_cap_pct: z.number().positive(),
    share_weight: z.number().min(0),
    hard_substitutability_multiplier: z.number().positive(),
    notice_window_days: z.number().int().positive(),
    notice_window_bonus: z.number().min(0),
    weight_decimals: z.number().int().min(0).max(6),
  }),
  watch_terms: z.object({
    amount_fields: z.array(z.string().min(1)),
    name_fields: z.array(z.string().min(1)),
    key_person_types: z.array(z.string().min(1)),
    litigation_types: z.array(z.string().min(1)),
    change_of_control_types: z.array(z.string().min(1)),
  }),
  cluster: z.object({
    min_tier_in_cluster: tierSchema,
    max_tier_in_cluster: tierSchema,
    include_tier3_signal_ids_when_promoted: z.boolean(),
  }),
  baseline: z.object({
    type: z.string().min(1),
    tier: tierSchema,
    title: z.string().min(1),
    preferred_source_order: z.array(sourceSchema),
  }),
  fallback_signal_type: signalTypeRuleSchema,
  signal_types: z.array(signalTypeRuleSchema).nonempty(),
});
export type Rules = z.infer<typeof rulesSchema>;

export const RULES_PATH = new URL('./rules.json', import.meta.url);

/** Parse a rules table from text. Exported so a test can load a tuned variant. */
export const parseRules = (text: string): Rules => rulesSchema.parse(JSON.parse(text));

let cached: Rules | undefined;

/** The table on disk. Cached, because a run reads it once. */
export const loadRules = (): Rules => {
  cached ??= parseRules(readFileSync(RULES_PATH, 'utf8'));
  return cached;
};
