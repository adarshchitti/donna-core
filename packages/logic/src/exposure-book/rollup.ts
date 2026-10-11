import {
  bookExposureSchema, NOT_COVERED_CATEGORIES, SOURCES,
  type BookExposure, type Cluster, type Company, type Deal, type Source,
} from '@donna/contracts';
import { exposureFor } from '../validator/exposure.js';
import { loadRules, type Rules } from '../validator/rules.js';

/**
 * Book exposure: the whole book instead of one deal.
 *
 * NOT A SCORE. Every figure is a sum of dollars the user typed at intake, a
 * count of companies, or a tier out of the rules table, so each one can be
 * re-added by hand from the deal list. exposure_weight is never summed,
 * averaged or normalised here: one weight is explainable, thirty added
 * together are a verdict nobody can check.
 *
 * Pure: records in, one rollup out. Computed on read and never stored, so it
 * cannot go stale behind the deals.
 */

/** `$4.2M`, `$820K`, `$950`. One decimal at M and B with a trailing `.0` dropped; whole K. */
export const formatUsdShort = (usd: number): string => {
  const sign = usd < 0 ? '-' : '';
  const n = Math.abs(usd);
  const oneDp = (v: number): string => v.toFixed(1).replace(/\.0$/, '');
  // Step up a unit only when the smaller unit would ROUND to 1000 or more, so
  // 999,600 reads "$1M" rather than "$1000K" while 999,499 stays "$999K".
  if (Math.round(n / 1e5) >= 10_000) return `${sign}$${oneDp(n / 1e9)}B`;
  if (Math.round(n / 1e3) >= 1000) return `${sign}$${oneDp(n / 1e6)}M`;
  if (Math.round(n) >= 1000) return `${sign}$${Math.round(n / 1e3)}K`;
  return `${sign}$${Math.round(n)}`;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const sum = (deals: readonly Deal[]): number => deals.reduce((t, d) => t + d.annual_value_usd, 0);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The book id comes from the records, because every company and cluster
 * carries one. `bookId` exists only for the empty book, which has no record
 * to read it from but still has to validate.
 */
const resolveBookId = (companies: Company[], clusters: Cluster[], bookId?: string): string => {
  const seen = new Set([...companies, ...clusters].map((r) => r.book_id));
  if (bookId !== undefined) seen.add(bookId);
  if (seen.size > 1) {
    throw new Error(`bookExposure: records span more than one book (${[...seen].join(', ')}).`);
  }
  const [only] = seen;
  if (only === undefined) throw new Error('bookExposure: an empty book needs an explicit bookId.');
  return only;
};

export const bookExposure = (
  companies: Company[],
  deals: Deal[],
  clusters: Cluster[],
  today: string,
  rules: Rules = loadRules(),
  bookId?: string,
): BookExposure => {
  const noticeWindow = rules.exposure.notice_window_days;
  // exposure_known and notice_days_remaining come from the per-deal code, never
  // re-derived here, so the book and the deal cannot disagree about a deal.
  const exposure = new Map(deals.map((d) => [d.deal_id, exposureFor(d, today, rules)]));
  const unknown = (d: Deal): boolean => !exposure.get(d.deal_id)!.exposure_known;

  const companyIds = new Set(companies.map((c) => c.company_id));
  const isLinked = (d: Deal): boolean => d.company_id !== undefined && companyIds.has(d.company_id);
  const dealsOf = new Map<string, Deal[]>();
  for (const d of deals.filter(isLinked)) {
    dealsOf.set(d.company_id!, [...(dealsOf.get(d.company_id!) ?? []), d]);
  }
  const linked = (c: Company): Deal[] => dealsOf.get(c.company_id) ?? [];
  const tierOf = new Map(clusters.map((cl) => [cl.company_id, cl.top_tier]));

  const total = sum(deals);

  // The four tier lines partition the WHOLE book, so they add up to
  // contracted_value_usd.total and the screen can be checked on paper. That
  // means a deal not linked to any company (no company, so no cluster) lands
  // in `none` -- and `none` therefore mixes two different situations: a
  // company that was checked with nothing surfacing, and a deal with no
  // company at all. Neither is a clean bill of health.
  const byTier = { tier1: 0, tier2: 0, tier3: 0, none: 0 };
  for (const c of companies) {
    const tier = tierOf.get(c.company_id) ?? 0;
    byTier[tier === 0 ? 'none' : (`tier${tier}` as const)] += sum(linked(c));
  }
  byTier.none += sum(deals.filter((d) => !isLinked(d)));

  const contracted = companies.filter((c) => linked(c).length > 0);
  let largest: Company | undefined;
  for (const c of contracted) {
    if (largest === undefined || sum(linked(c)) > sum(linked(largest))) largest = c;
  }

  const failed: Partial<Record<Source, number>> = {};
  for (const c of contracted) {
    const value = sum(linked(c));
    for (const s of new Set(c.coverage?.failed ?? [])) failed[s] = (failed[s] ?? 0) + value;
  }
  // Partial by design: a failed source with nothing behind it is not a line.
  for (const s of Object.keys(failed) as Source[]) if (failed[s] === 0) delete failed[s];

  const checked = new Set(companies.flatMap((c) => c.coverage?.checked ?? []));
  const valueUnknown = sum(deals.filter(unknown));

  // Each sentence is omitted when its figure is zero; the last never is, so
  // even an empty book says what is not watched.
  const headline = [
    total !== 0 && `${formatUsdShort(total)} contracted across `
      + `${plural(contracted.length, 'counterparty', 'counterparties')}, `
      + `watched on ${checked.size} of ${SOURCES.length} sources.`,
    byTier.tier1 !== 0
      && `${formatUsdShort(byTier.tier1)} sits behind a tier-1 signal awaiting a human call.`,
    valueUnknown !== 0 && `${formatUsdShort(valueUnknown)} is incompletely described at intake, `
      + 'so its exposure is unknown rather than low.',
    `Not covered for any counterparty: ${NOT_COVERED_CATEGORIES.map(lowerFirst).join(', ')}.`,
  ].filter((s): s is string => typeof s === 'string').join(' ');

  const shares = largest
    ? linked(largest).flatMap((d) => (d.share_pct === undefined ? [] : [d.share_pct]))
    : [];

  return bookExposureSchema.parse({
    book_id: resolveBookId(companies, clusters, bookId),
    as_of: today,
    counterparties: {
      total: companies.length,
      monitored: companies.filter((c) => c.monitoring_since !== undefined).length,
      lookup_only: companies.filter((c) => c.lookup !== undefined && c.monitoring_since === undefined)
        .length,
    },
    contracted_value_usd: {
      total,
      they_pay_us: sum(deals.filter((d) => d.deal_class === 'they_pay_us')),
      we_pay_them: sum(deals.filter((d) => d.deal_class === 'we_pay_them')),
      tied: sum(deals.filter((d) => d.deal_class === 'tied')),
    },
    value_by_top_tier: byTier,
    // `r <= N`, negatives INCLUDED -- deliberately not exposureFor()'s notice
    // bump, which is bounded `0 <= r < N` because a bonus for a window that has
    // already shut would be nonsense. This line reports value at stake, not a
    // deal's score: a shut window is worse than a closing one (the chance to
    // exit on notice is gone), so leaving it out would understate the book
    // exactly when it matters most. The Base44 screen applies the same test.
    value_notice_window_closing: sum(
      deals.filter((d) => exposure.get(d.deal_id)!.notice_days_remaining <= noticeWindow),
    ),
    notice_window_days: noticeWindow,
    value_hard_to_replace: sum(deals.filter((d) => d.substitutability === 'hard')),
    largest_counterparty: largest === undefined ? null : {
      company_id: largest.company_id,
      canonical_name: largest.canonical_name,
      annual_value_usd: sum(linked(largest)),
      share_of_book_pct: total === 0 ? 0 : round2((sum(linked(largest)) / total) * 100),
      // The user's own figure, never derived. Two deals with one counterparty
      // can each state the same relationship share, so the largest stated
      // value is reported rather than a sum that would double it.
      share_pct: shares.length > 0 ? Math.max(...shares) : null,
    },
    value_exposure_unknown: valueUnknown,
    companies_exposure_unknown: companies.filter((c) => linked(c).some(unknown)).length,
    value_behind_failed_source: failed,
    not_covered: [...NOT_COVERED_CATEGORIES],
    headline,
  });
};
