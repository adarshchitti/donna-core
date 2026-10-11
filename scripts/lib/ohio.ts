/**
 * The fixed universe: 30 real Ohio companies, owned by donna-collectors.
 * Loaded here rather than duplicated so the collectors repo stays the single
 * source of truth for who is in the book.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COLLECTORS_REPO, UsageError } from './env.js';
import type { CanonicalCompany } from '../../../donna-collectors/src/contract.js';

export const OHIO_COMPANIES_PATH = resolve(COLLECTORS_REPO, 'ohio-companies.json');

export interface SeedCompany {
  canonical_name: string;
  registry_id: string;
  jurisdiction: string;
  domains: string[];
  aliases: string[];
  notes?: string;
}

export const loadOhioCompanies = (path: string = OHIO_COMPANIES_PATH): SeedCompany[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(
      `cannot read the fixed universe at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(raw)) throw new UsageError(`${path}: expected a JSON array of companies.`);

  return raw.map((entry, i) => {
    const c = entry as Partial<SeedCompany>;
    if (typeof c.canonical_name !== 'string' || c.canonical_name.trim() === '') {
      throw new UsageError(`${path}[${i}]: canonical_name is required.`);
    }
    const jurisdiction = (c.jurisdiction ?? 'US').trim();
    if (!/^[A-Z]{2}$/.test(jurisdiction)) {
      throw new UsageError(
        `${path}[${i}] (${c.canonical_name}): jurisdiction ${JSON.stringify(jurisdiction)} ` +
          'is not 2-letter uppercase -- the backend throws on anything else.',
      );
    }
    return {
      canonical_name: c.canonical_name.trim(),
      registry_id: (c.registry_id ?? '').trim(),
      jurisdiction,
      domains: Array.isArray(c.domains) ? c.domains.filter((d): d is string => typeof d === 'string') : [],
      aliases: Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === 'string') : [],
      ...(c.notes !== undefined ? { notes: c.notes } : {}),
    };
  });
};

/** company_id is caller-supplied: crypto.randomUUID() on insert, the stored id on a re-run. */
export const toCanonical = (seed: SeedCompany, companyId: string): CanonicalCompany => ({
  company_id: companyId,
  canonical_name: seed.canonical_name,
  jurisdiction: seed.jurisdiction,
  registry_id: seed.registry_id,
  aliases: seed.aliases,
  domains: seed.domains,
});

/** Same matching as the collectors CLI: numeric index, then name or alias (case-insensitive). */
export const findCompany = (
  list: readonly SeedCompany[],
  needle: string,
): SeedCompany | undefined => {
  const n = needle.trim().toLowerCase();
  if (/^\d+$/.test(n)) return list[Number(n)];
  return list.find(
    (c) =>
      c.canonical_name.toLowerCase() === n
      || c.aliases.some((a) => a.toLowerCase() === n)
      || (c.registry_id !== '' && c.registry_id === needle.trim()),
  );
};
