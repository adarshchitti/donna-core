import { describe, it, expect } from 'vitest';
import {
  bookExposureSchema, companySchema, scheduleSchema, clusterSchema,
  NOT_COVERED_CATEGORIES,
} from '@donna/contracts';

const BOOK = { book_id: 'book_1' };

const rollup = {
  ...BOOK,
  as_of: '2026-10-10T19:42:00Z',
  counterparties: { total: 31, monitored: 30, lookup_only: 1 },
  contracted_value_usd: { total: 4_200_000, they_pay_us: 3_000_000, we_pay_them: 900_000, tied: 300_000 },
  value_by_top_tier: { tier1: 820_000, tier2: 1_100_000, tier3: 400_000, none: 1_880_000 },
  value_notice_window_closing: 620_000,
  notice_window_days: 90,
  value_hard_to_replace: 1_450_000,
  largest_counterparty: {
    company_id: 'co_1', canonical_name: 'Big Lots, Inc.',
    annual_value_usd: 820_000, share_of_book_pct: 19.52, share_pct: 14,
  },
  value_exposure_unknown: 1_400_000,
  companies_exposure_unknown: 11,
  value_behind_failed_source: { regulator: 4_200_000, layoffs: 4_200_000 },
  not_covered: [...NOT_COVERED_CATEGORIES],
  headline: '$4.2M contracted across 30 counterparties, watched on 6 of 8 sources.',
};

describe('book exposure', () => {
  it('accepts a full rollup', () => {
    const parsed = bookExposureSchema.safeParse(rollup);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('allows an empty book: no largest counterparty, no failed sources', () => {
    const empty = {
      ...rollup,
      counterparties: { total: 0, monitored: 0, lookup_only: 0 },
      contracted_value_usd: { total: 0, they_pay_us: 0, we_pay_them: 0, tied: 0 },
      largest_counterparty: null,
      value_behind_failed_source: {},
    };
    expect(bookExposureSchema.safeParse(empty).success).toBe(true);
  });

  it('rejects an unknown source id as a coverage key', () => {
    const bad = { ...rollup, value_behind_failed_source: { exec_moves: 1 } };
    expect(bookExposureSchema.safeParse(bad).success).toBe(false);
  });

  /**
   * The structural guard on Rule 1. The rollup must not grow a composite: no
   * field may be a score, a rating, or a sum of exposure weights. This asserts
   * it on the SHAPE rather than trusting review, because the pressure to add
   * "overall_risk" to a book screen is constant and the whole product position
   * rests on it not being there.
   */
  it('has no score, rating or blended-weight field', () => {
    const keys = Object.keys(bookExposureSchema._def.schema?.shape ?? bookExposureSchema.shape);
    for (const k of keys) {
      expect(k, `${k} looks like a composite`).not.toMatch(/score|rating|risk_level|index$|grade/i);
      expect(k, `${k} looks like a blended weight`).not.toMatch(/weight/i);
    }
  });
});

describe('contract additions for pre-deal lookup', () => {
  const baseSchedule = {
    ...BOOK, company_id: 'co_1', source: 'registry' as const, cadence: 'daily' as const,
    next_run_at: '2026-10-11T00:00:00Z', last_run_at: null, enabled: true,
  };

  it('a schedule written before expires_at existed reads back as null', () => {
    const parsed = scheduleSchema.parse(baseSchedule);
    expect(parsed.expires_at).toBeNull();
  });

  it('a negotiation watch carries an expiry', () => {
    const parsed = scheduleSchema.parse({ ...baseSchedule, expires_at: '2026-11-30T00:00:00Z' });
    expect(parsed.expires_at).toBe('2026-11-30T00:00:00Z');
  });

  const baseCompany = {
    ...BOOK, company_id: 'co_9', canonical_name: 'Prospect Co', jurisdiction: 'US',
    registry_id: '123', registry_key: '123', aliases: [], domains: [],
    resolution: { confidence: 0.91, reason: 'name and address match', resolved_by: null, candidates_seen: [] },
  };

  it('a looked-up company has lookup and no monitoring_since', () => {
    const parsed = companySchema.parse({
      ...baseCompany,
      lookup: { requested_at: '2026-10-10T19:00:00Z', requested_by: 'analyst@x.invalid', watch_until: null },
    });
    expect(parsed.lookup?.watch_until).toBeNull();
    expect(parsed.monitoring_since).toBeUndefined();
  });

  it('a lookup that became a deal keeps both fields, which is the point', () => {
    const parsed = companySchema.parse({
      ...baseCompany,
      lookup: { requested_at: '2026-10-10T19:00:00Z', requested_by: 'analyst@x.invalid', watch_until: '2026-11-30' },
      monitoring_since: '2026-10-12',
    });
    expect(parsed.lookup).toBeDefined();
    expect(parsed.monitoring_since).toBe('2026-10-12');
  });

  it('watch_until is date-only, because a user picks a day', () => {
    const bad = {
      ...baseCompany,
      lookup: { requested_at: '2026-10-10T19:00:00Z', requested_by: 'a@x.invalid', watch_until: '2026-11-30T00:00:00Z' },
    };
    expect(companySchema.safeParse(bad).success).toBe(false);
  });

  it('a lookup cluster validates with no deals and zeroed exposure', () => {
    const parsed = clusterSchema.safeParse({
      ...BOOK, cluster_id: 'cl_1', company_id: 'co_9', mode: 'profile',
      window: { from: '2026-10-10', to: '2026-10-10' }, top_tier: 0,
      verify_with_counterparty: false, signals: ['sig_1'],
      deals: [],
      exposure: { top_weight: 0, annual_value_usd: 0 },
      coverage: { checked: ['registry'], failed: ['regulator'], not_covered: [...NOT_COVERED_CATEGORIES] },
      fingerprint: 'abc123',
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
