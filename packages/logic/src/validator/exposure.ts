import { clusterDealSchema, type Deal } from '@donna/contracts';
import type { z } from 'zod';
import { loadRules, type Rules } from './rules.js';
import { daysBetween } from './dates.js';

export type ClusterDeal = z.infer<typeof clusterDealSchema>;

/**
 * Step 4 -- exposure.
 *
 * The weight is built only from fields the USER gave us, in a formula they can
 * re-do on paper: contract value against a cap, revenue share against a cap,
 * doubled if the supplier is hard to replace, plus a bump when the notice
 * window is nearly shut. Nothing here is learned or fitted, because the
 * question a finance person asks about any number on this screen is "where
 * does that come from", and "the model decided" is not an answer.
 *
 * `deal_class: 'tied'` deliberately does NOT move the weight. A tied deal (we
 * pay them and they pay us) is a compliance question, not a bigger number, so
 * it raises a flag instead.
 */

export interface ExposureBreakdown {
  deal_id: string;
  weight: number;
  compliance_flag: boolean;
  days_to_renewal: number;
  /** Days left before notice must be served. Negative means the window has shut. */
  notice_days_remaining: number;
  /** Every addend, so the number can be explained line by line. */
  parts: { value: number; share: number; substitutability_multiplier: number; notice_bonus: number };
}

const round = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export const exposureFor = (
  deal: Deal,
  today: string,
  rules: Rules = loadRules(),
): ExposureBreakdown => {
  const cfg = rules.exposure;

  const value = cfg.value_weight * clamp01(Math.abs(deal.annual_value_usd) / cfg.value_cap_usd);
  const share = cfg.share_weight * clamp01((deal.share_pct ?? 0) / cfg.share_cap_pct);

  const multiplier = deal.substitutability === 'hard' ? cfg.hard_substitutability_multiplier : 1;

  const daysToRenewal = daysBetween(today, deal.end_date);
  const noticeRemaining = daysToRenewal - (deal.notice_days ?? 0);
  const noticeBonus = noticeRemaining < cfg.notice_window_days ? cfg.notice_window_bonus : 0;

  const raw = (value + share) * multiplier + noticeBonus;

  return {
    deal_id: deal.deal_id,
    weight: round(clamp01(raw), cfg.weight_decimals),
    // 'tied' is a compliance flag, NOT a weight.
    compliance_flag: deal.deal_class === 'tied',
    days_to_renewal: daysToRenewal,
    notice_days_remaining: noticeRemaining,
    parts: { value, share, substitutability_multiplier: multiplier, notice_bonus: noticeBonus },
  };
};

export const toClusterDeal = (
  deal: Deal,
  today: string,
  rules: Rules = loadRules(),
): ClusterDeal => {
  const e = exposureFor(deal, today, rules);
  return clusterDealSchema.parse({
    deal_id: deal.deal_id,
    // `class` on a cluster deal, `deal_class` on the deal document. Two names, deliberately.
    class: deal.deal_class,
    annual_value_usd: deal.annual_value_usd,
    ...(deal.share_pct === undefined ? {} : { share_pct: deal.share_pct }),
    ...(deal.notice_days === undefined ? {} : { notice_days: deal.notice_days }),
    days_to_renewal: e.days_to_renewal,
    exposure_weight: e.weight,
    compliance_flag: e.compliance_flag,
  });
};

export interface CompanyExposure {
  deals: ClusterDeal[];
  top_weight: number;
  annual_value_usd: number;
}

export const companyExposure = (
  deals: readonly Deal[],
  today: string,
  rules: Rules = loadRules(),
): CompanyExposure => {
  const mapped = deals.map((d) => toClusterDeal(d, today, rules));
  return {
    deals: mapped,
    top_weight: mapped.reduce((top, d) => Math.max(top, d.exposure_weight), 0),
    annual_value_usd: mapped.reduce((sum, d) => sum + d.annual_value_usd, 0),
  };
};
