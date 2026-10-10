/**
 * Where the committed cassettes live, and the clock the tests pin.
 *
 * The cache key is URL + UTC day, so a cassette committed today would miss
 * tomorrow. Tests therefore inject a fixed clock, which is also what makes the
 * "same URL, different day = miss" assertion possible at all.
 */

import { fileURLToPath } from 'node:url';

/** Repo-root fixtures/cassettes, resolved from this file so cwd never matters. */
export const CASSETTE_DIR = fileURLToPath(new URL('../../../fixtures/cassettes', import.meta.url));

/** The UTC day the committed cassettes were recorded on. */
export const PINNED_DAY = '2026-10-10';
export const pinnedNow = (): Date => new Date(`${PINNED_DAY}T09:15:00.000Z`);
export const otherDayNow = (): Date => new Date('2026-10-11T09:15:00.000Z');

export const RECORDED_PAGE_URL = 'https://registry.example.gov/company/0100-hartwell-logistics';
export const RECORDED_SERP_QUERY = '"Hartwell Logistics" layoffs';
