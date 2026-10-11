import { SOURCES, NOT_COVERED_CATEGORIES, type Source } from '@donna/contracts';

/**
 * Cadence for seeding, duplicated from the orchestrator rather than imported.
 *
 * `@donna/store` must not depend on `@donna/orchestrator` -- the orchestrator
 * depends on the store, and the reverse edge would be a cycle. Primary and
 * reported sources daily, inferred weekly, nothing hourly.
 */
export const CADENCE_FALLBACK: Record<Source, 'daily' | 'weekly'> = {
  registry: 'daily', court: 'daily', regulator: 'daily', layoffs: 'daily',
  news: 'daily', executives: 'daily',
  jobs: 'weekly', domain: 'weekly',
};

export { SOURCES, NOT_COVERED_CATEGORIES };
