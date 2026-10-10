import { z } from 'zod';

/**
 * Source ids. These are Track C's `sourceCatalog` ids verbatim
 * (src/components/donna/contractFixtures.js) -- note `executives`, NOT the
 * architecture PDF's `exec_moves`. Track C round-trips labels through
 * sourceId()/sourceLabel(), so a mismatch here produces dead evidence links.
 */
export const SOURCES = [
  'registry', 'court', 'regulator', 'layoffs',
  'news', 'executives', 'jobs', 'domain',
] as const;
export const sourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof sourceSchema>;

/** Human labels, byte-identical to Track C's `sourceNames`. Note the ampersands. */
export const SOURCE_LABELS: Record<Source, string> = {
  registry: 'Company registry',
  court: 'Court records',
  regulator: 'Regulator records',
  layoffs: 'Layoff notices',
  news: 'News & press',
  executives: 'Executive moves',
  jobs: 'Job postings',
  domain: 'Domain & site',
};

export const sourceLabel = (id: Source): string => SOURCE_LABELS[id];
export const sourceIdFromLabel = (label: string): Source | undefined =>
  SOURCES.find((s) => SOURCE_LABELS[s] === label);

/** Trust tiers. A source's trust is fixed, never per-item. */
export const trustSchema = z.enum(['primary', 'reported', 'inferred']);
export type Trust = z.infer<typeof trustSchema>;

export const SOURCE_TRUST: Record<Source, Trust> = {
  registry: 'primary', court: 'primary', regulator: 'primary', layoffs: 'primary',
  news: 'reported', executives: 'reported',
  jobs: 'inferred', domain: 'inferred',
};

/**
 * Tier is an INTEGER. Track C's TierBadge indexes style[tier] with numeric
 * keys 0-3; the string "1" yields undefined and renders an unstyled badge.
 */
export const tierSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type Tier = z.infer<typeof tierSchema>;

/**
 * Signal confidence is a WORD, not a number. Track C renders it raw as
 * "{confidence} confidence", so a float prints "0.92 confidence".
 * (companies.resolution.confidence IS a float -- different field, different type.)
 */
export const confidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof confidenceSchema>;

/** Starting confidence implied by source trust, before corroboration. */
export const TRUST_CONFIDENCE: Record<Trust, Confidence> = {
  primary: 'high', reported: 'medium', inferred: 'low',
};

/** Can a source of this trust reach an alerting tier on its own? */
export const TRUST_CAN_ESCALATE_ALONE: Record<Trust, boolean> = {
  primary: true, reported: false, inferred: false,
};

export const signalStatusSchema = z.enum(['baseline', 'reported', 'confirmed', 'inferred']);
export type SignalStatus = z.infer<typeof signalStatusSchema>;

export const changeKindSchema = z.enum(['added', 'removed', 'altered']);
export const runStatusSchema = z.enum(['started', 'ok', 'empty', 'failed']);
export const briefingModeSchema = z.enum(['briefing', 'profile']);
export const narrationStatusSchema = z.enum(['available', 'fallback']);
export const dealClassSchema = z.enum(['they_pay_us', 'we_pay_them', 'tied']);
export const substitutabilitySchema = z.enum(['', 'week', 'quarter', 'hard']);

/**
 * The four things this system does not observe, verbatim from Track C's
 * demoData.notCovered. Rendered raw with no label mapping, so they are
 * human labels and must stay exactly as written.
 */
export const NOT_COVERED_CATEGORIES = [
  'Private financials',
  'Payment behaviour',
  'Relationship sentiment',
  'Related-entity monitoring',
] as const;

/**
 * Declared freshness lag per source, in days. Franklin County's docket lags
 * real filings by 2-5 business days, which under this system's own rules is a
 * coverage fact to state rather than hide.
 */
export const SOURCE_LAG_DAYS: Partial<Record<Source, number>> = { court: 5 };
