import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openCorporatesCandidates } from './candidates.js';

/**
 * The committed fixture is OpenCorporates' live page-one for "Capital One" --
 * alphabetical, global, and missing the company anyone would actually mean.
 * It is the fixed input the ranking has to make sense of; the `order=score`
 * parameter in the request URL is what fixes the live page itself.
 */
const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../../fixtures/opencorporates/search-capital-one.html', import.meta.url)),
  'utf8',
);

function source(body: string) {
  const requested: string[] = [];
  const candidates = openCorporatesCandidates({
    unlocker: async (url) => { requested.push(url); return { body, url }; },
    serp: async () => { throw new Error('identify is not under test here'); },
  });
  return { candidates, requested };
}

const names = (cs: { canonical_name: string }[]) => cs.map((c) => c.canonical_name);

describe('the request itself carries the fix', () => {
  it('asks OpenCorporates for relevance order, not the default alphabetical page', async () => {
    const s = source(FIXTURE);
    await s.candidates.search({ name: 'Capital One', jurisdiction: 'US' });
    expect(s.requested[0]).toContain('order=score');
    expect(s.requested[0]).toContain('inactive=false');
  });

  it('narrows by jurisdiction only when the deal names a sub-jurisdiction', async () => {
    const s = source(FIXTURE);
    await s.candidates.search({ name: 'X', jurisdiction: 'US-OH' });
    expect(s.requested[0]).toContain('jurisdiction_code=us_oh');
    await s.candidates.search({ name: 'X', jurisdiction: 'US' });
    // `jurisdiction_code=us` redirects to a landing page -- no federated index.
    expect(s.requested[1]).not.toContain('jurisdiction_code=');
  });
});

describe('ranking on a real captured page', () => {
  it('puts an exact-name match first, not the first alphabetical row', async () => {
    const cs = await source(FIXTURE).candidates.search({ name: 'A ONE CAPITAL', jurisdiction: 'US' });
    // "A ONE CAPITAL LLC" is the 20th row of 30 on the page. Page order is
    // not rank order.
    expect(cs[0]!.canonical_name).toBe('A ONE CAPITAL LLC');
    expect(cs[0]!.jurisdiction).toBe('US_MO');
  });

  it('does not let a corporate suffix stop an exact match', async () => {
    const cs = await source(FIXTURE).candidates.search({ name: 'A ONE CAPITAL', jurisdiction: 'US' });
    // Three names normalise to "a one capital" once LLC/CORP/SA come off.
    // All three must outrank every name that only overlaps.
    const top = names(cs.slice(0, 3));
    expect(top).toContain('A ONE CAPITAL LLC');
    expect(top).toContain('A One Capital LLC');
    expect(top).toContain('A-ONE CAPITAL CORP.');
  });

  it('decodes HTML entities before the judge ever sees a name', async () => {
    const cs = await source(FIXTURE).candidates.search({ name: 'A&A CAPITAL ONE', jurisdiction: 'US' });
    expect(names(cs)).toContain('A&A CAPITAL ONE LLC');
    for (const n of names(cs)) {
      expect(n).not.toMatch(/&(amp|quot|lt|gt|#\d+);/);
    }
  });

  it('prefers a candidate in the deal jurisdiction over the same name elsewhere', async () => {
    const cs = await source(FIXTURE).candidates.search({ name: 'A ONE CAPITAL', jurisdiction: 'US' });
    // Same normalised name on both sides of the tie; only jurisdiction differs.
    const usIndex = cs.findIndex((c) => c.jurisdiction === 'US_CA');
    const caIndex = cs.findIndex((c) => c.jurisdiction === 'CA_ON' && c.canonical_name === 'A-ONE CAPITAL CORP.');
    expect(usIndex).toBeGreaterThanOrEqual(0);
    expect(caIndex).toBeGreaterThan(usIndex);
  });

  it('keeps each candidate\'s own jurisdiction so the judge can reject a foreign match', async () => {
    const cs = await source(FIXTURE).candidates.search({ name: 'Capital One', jurisdiction: 'US' });
    for (const c of cs) {
      expect(c.source_url).toContain(`/companies/${c.jurisdiction.toLowerCase()}/`);
    }
  });

  it('ranks an inactive registration below the same name held by an active one', async () => {
    const cs = await source(FIXTURE).candidates.search({ name: 'A ONE CAPITAL', jurisdiction: 'US' });
    // "A one Capital SA" and "A-ONE CAPITAL CORP." normalise to the same name.
    // The Swiss entity is marked `inactive gelöscht`; the Canadian one is not.
    const inactive = cs.findIndex((c) => c.canonical_name === 'A one Capital SA');
    const active = cs.findIndex((c) => c.canonical_name === 'A-ONE CAPITAL CORP.');
    expect(inactive).toBeGreaterThanOrEqual(0);
    expect(active).toBeGreaterThanOrEqual(0);
    expect(cs[inactive]!.status).toBe('inactive');
    expect(cs[active]!.status).toBe('active');
    expect(inactive).toBeGreaterThan(active);
  });

  it('returns at most twelve candidates', async () => {
    const cs = await source(FIXTURE).candidates.search({ name: 'Capital One', jurisdiction: 'US' });
    expect(cs.length).toBeLessThanOrEqual(12);
    expect(cs.length).toBeGreaterThan(0);
  });
});

describe('edge cases', () => {
  it('an exact match wins wherever it sits on the page', async () => {
    const page = `
      <a class="company_search_result active" href="/companies/us_ca/1">ACME TOOLING &amp; DIE LLC</a>
      <a class="company_search_result" href="/companies/gb/2">ACME HOLDINGS LIMITED</a>
      <a class="company_search_result active" href="/companies/us_de/3">ACME</a>`;
    const cs = await source(page).candidates.search({ name: 'acme', jurisdiction: 'GB' });
    expect(cs[0]!.canonical_name).toBe('ACME');
    expect(cs[0]!.jurisdiction).toBe('US_DE');
  });

  it('returns an empty list, not a crash, when the page has no results', async () => {
    const cs = await source('<html><body><ul id="companies"></ul></body></html>')
      .candidates.search({ name: 'Nonexistent', jurisdiction: 'US' });
    expect(cs).toEqual([]);
  });

  it('still returns candidates when a redesign drops the result-marker class', async () => {
    const page = '<a href="/companies/us_de/99">PLAIN LINK COMPANY LLC</a>';
    const cs = await source(page).candidates.search({ name: 'Plain Link', jurisdiction: 'US' });
    expect(cs).toHaveLength(1);
    expect(cs[0]!.registry_id).toBe('99');
  });
});
