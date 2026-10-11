import type { CandidateSource } from './resolve-pending.js';
import type { RegistryCandidate } from './resolution.js';

/**
 * Where resolution's candidates come from.
 *
 * The registry is OpenCorporates rather than a state Secretary of State site,
 * because Bright Data refuses every government domain by policy -- so the
 * official portals are unreachable through the only sanctioned fetch path.
 * OpenCorporates republishes the same registrations and is fetchable.
 *
 * Candidates are deliberately shallow: a name, a registration, a jurisdiction
 * and a status. Resolution's job is to pick the right ENTITY, and a richer
 * payload would invite the judge to reason about things it has not verified.
 */
export interface CandidateDeps {
  /** Returns the body of a page fetched through Bright Data. */
  unlocker(url: string): Promise<{ body: string; url: string }>;
  serp(query: string): Promise<{ body: string; url: string }>;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * OpenCorporates jurisdiction codes.
 *
 * A single hardcoded `us_oh` was wrong by construction: searching Ohio for a
 * Virginia company returns twelve Ohio entities, and the judge then correctly
 * refuses all twelve -- a right answer to a question we should not have asked.
 *
 * For a US deal we do not know the state of incorporation up front, and there
 * is no federated US search: `jurisdiction_code=us` redirects to a landing
 * page, not results. So a bare `US` searches globally and the ranking below
 * prefers US candidates rather than guessing one of fifty states. A deal that
 * names a state gets that state's filter.
 */
const OC_JURISDICTION: Record<string, string> = {
  US: 'us', GB: 'gb', CA: 'ca', AU: 'au', IE: 'ie', NZ: 'nz', SG: 'sg',
};

/** US state codes, when a deal carries one, e.g. `US-OH`. */
const US_STATES = new Set(['oh','de','ca','ny','tx','fl','il','pa','wa','ma','va','nj','ga','nc','mi','az','co','mn','wi','mo','in','tn','md','or','nv','ut','ct','ia','ks','ne','sc','al','ky','la','ok','ar','ms','nm','wv','id','hi','me','nh','ri','mt','sd','nd','ak','vt','wy','dc']);

/** Map a deal's country (optionally `US-OH`) to an OpenCorporates jurisdiction. */
export function ocJurisdiction(country: string): string {
  const [base, sub] = country.trim().toUpperCase().split('-');
  if (base === 'US' && sub && US_STATES.has(sub.toLowerCase())) return `us_${sub.toLowerCase()}`;
  return OC_JURISDICTION[base ?? ''] ?? (base ?? '').toLowerCase();
}

/**
 * Corporate suffixes, stripped before comparing names.
 *
 * This is what lets "Capital One" match "CAPITAL ONE FINANCIAL CORPORATION":
 * the legal-form tail is jurisdiction boilerplate, not identity, and leaving
 * it in makes a shorter-but-equal name look like a worse match.
 */
const CORPORATE_SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'llc', 'lc', 'ltd', 'limited', 'lp', 'llp', 'pllc', 'pc', 'plc',
  'gmbh', 'ag', 'sa', 'sarl', 'sl', 'sas', 'bv', 'nv', 'se',
  'pte', 'pty', 'ab', 'as', 'oy', 'spa', 'srl', 'eood', 'ood', 'dac', 'ulc',
]);

/** Lowercase, fold accents, drop punctuation and corporate suffixes. */
function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0 && !CORPORATE_SUFFIXES.has(t))
    .join(' ');
}

/**
 * Name similarity to the query, in [0, 1].
 *
 * Exact normalised match (1.0) above a prefix match (0.7-0.95) above token
 * overlap (0-0.6), so page order never decides which of two companies the
 * judge sees first -- the page is alphabetical by default, and alphabetical
 * is not relevance.
 */
function nameScore(query: string, candidate: string): number {
  const q = normaliseName(query);
  const c = normaliseName(candidate);
  if (!q || !c) return 0;
  if (c === q) return 1;
  const qTokens = new Set(q.split(' '));
  const cTokens = new Set(c.split(' '));
  const overlap = [...qTokens].filter((t) => cTokens.has(t)).length / qTokens.size;
  if (c.startsWith(q) || q.startsWith(c)) return 0.7 + 0.25 * overlap;
  return 0.6 * overlap;
}

/**
 * Whether the candidate's OWN registered jurisdiction fits the deal's.
 * `US` covers every `us_xx` state -- a US deal can legitimately be a Delaware
 * company, so matching here is a ranking preference, never a filter.
 */
function jurisdictionMatches(dealJurisdiction: string, candidateJurisdiction: string): boolean {
  const deal = dealJurisdiction.trim().toUpperCase().replace(/-/g, '_');
  const cand = candidateJurisdiction.trim().toUpperCase();
  if (!deal || !cand) return false;
  return cand === deal || cand.startsWith(`${deal}_`);
}

/** The handful of named entities a registry name actually carries, plus
 *  numeric references for everything else. */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', reg: '®', copy: '©', trade: '™',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith('#')) {
      const n = body[1]?.toLowerCase() === 'x'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : entity;
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/**
 * Status from the anchor's class list, where OpenCorporates already
 * normalises: `company_search_result inactive gelöscht` is inactive even
 * though `gelöscht` is the raw foreign-register status. `inactive` must be
 * checked before `active` -- it contains the substring.
 */
function statusOf(classes: string): 'active' | 'inactive' | undefined {
  const c = classes.toLowerCase();
  if (/\binactive\b|dissolv|struck|strike_off|gel.scht|liquidat|revoked|forfeit/.test(c)) return 'inactive';
  if (/\bactive\b|current_active|live_company|immatricul/.test(c)) return 'active';
  return undefined;
}

/**
 * Rank candidates for the judge. The criteria are lexicographic, not a summed
 * score, because a bonus must never flip a higher-priority criterion:
 *
 *   1. name similarity -- an exact match in the wrong country still beats a
 *      prefix match in the right one; the judge needs to see it first
 *   2. status -- a dissolved registration goes below every active one of the
 *      same name strength; a dead entity can never be what we should monitor
 *   3. jurisdiction -- a candidate registered where the deal is beats the same
 *      name elsewhere, WITHOUT being discarded: a US deal can be a Delaware
 *      company, or legitimately a foreign one
 *
 * The page's own order breaks remaining ties, which keeps the server-side
 * `order=score` relevance meaningful.
 */
function rankCandidates(
  name: string,
  dealJurisdiction: string,
  candidates: RegistryCandidate[],
): RegistryCandidate[] {
  return candidates
    .map((c) => ({
      c,
      key: [
        nameScore(name, c.canonical_name),
        c.status === 'inactive' ? 0 : 1,
        jurisdictionMatches(dealJurisdiction, c.jurisdiction) ? 1 : 0,
      ] as const,
    }))
    .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2])
    .map((x) => x.c);
}

export function openCorporatesCandidates(deps: CandidateDeps): CandidateSource {
  const log = deps.log ?? (() => {});

  return {
    async search({ name, jurisdiction }) {
      // `&order=score` is load-bearing. Without it the search returns results
      // ALPHABETICALLY: "Capital One" matches 5,093 companies, the first page
      // holds "16 AND ONE CAPITAL PARTNERS LLC" and "3B CAPITAL ONE LLC", and
      // Capital One Financial Corporation is not on it at all. No amount of
      // client-side ranking can surface a company that was never fetched.
      //
      // `/companies?q=` is the search endpoint. Three parameters matter:
      //
      //   order=score        the ONLY relevance ordering the anonymous page
      //                      honours (mode=phrase_prefix redirects to a login
      //                      wall). Without it results come back ALPHABETICALLY
      //                      -- for "Capital One" the first page is Polish spółkas
      //                      and "16 AND ONE CAPITAL PARTNERS" -- and no amount
      //                      of client-side ranking surfaces a company that
      //                      was never on the page.
      //   inactive=false     drops dissolved registrations server-side, so the
      //                      30 slots are not spent on dead entities.
      //   jurisdiction_code  narrows to one sub-jurisdiction, applied only when
      //                      the deal names a state: bare `us` is a redirect,
      //                      and a country-level filter would discard foreign
      //                      candidates a judge might legitimately pick.
      const juris = ocJurisdiction(jurisdiction);
      const narrow = juris.includes('_') ? `&jurisdiction_code=${juris}` : '';
      const url = `https://opencorporates.com/companies?q=${encodeURIComponent(name)}${narrow}&order=score&utf8=%E2%9C%93`;
      const { body } = await deps.unlocker(url);

      // Kept to anchor + text rather than a brittle nested-selector walk: the
      // page changes shape more often than its links do. Result anchors carry
      // `company_search_result` plus a normalised status in the class list.
      const rows = [...body.matchAll(
        /<a\b[^>]*href="\/companies\/([a-z_]+)\/([^"]+)"[^>]*>([^<]{2,160})<\/a>/gi,
      )]
        .map((m) => ({
          ocJuris: m[1]!,
          registry: m[2]!,
          label: m[3]!,
          classes: /class="([^"]*)"/i.exec(m[0])?.[1] ?? '',
        }));

      // Result anchors are marked by the class; everything else matching that
      // URL shape is navigation. If a redesign drops the class entirely, fall
      // back to every match rather than returning "no candidates" forever.
      const marked = rows.filter((r) => /company_search_result/.test(r.classes));
      const usable = marked.length > 0 ? marked : rows;

      const seen = new Set<string>();
      const candidates: RegistryCandidate[] = [];
      for (const { ocJuris, registry, label, classes } of usable) {
        const canonical = decodeEntities(label).replace(/\s+/g, ' ').trim();
        if (canonical.length < 3 || /^(search|next|previous|\d+)$/i.test(canonical)) continue;
        const key = `${ocJuris}/${registry}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const status = statusOf(classes);
        candidates.push({
          canonical_name: canonical,
          registry_id: registry.toUpperCase(),
          // The candidate's OWN jurisdiction, from its link -- not the deal's.
          // A global search returns entities from everywhere, and the judge can
          // only reject a Delaware company on a UK agreement if it is told
          // where each candidate is actually registered.
          jurisdiction: ocJuris.toUpperCase(),
          ...(status ? { status } : {}),
          source_url: `https://opencorporates.com/companies/${ocJuris}/${registry}`,
        });
      }

      const ranked = rankCandidates(name, jurisdiction, candidates).slice(0, 12);
      log('candidates', { name, jurisdiction, found: ranked.length });
      return ranked;
    },

    async identify({ name, jurisdiction }) {
      // SERP gives the official domain and the aliases a company is known by.
      // Failure here is tolerable: resolution can proceed on registry candidates
      // alone, which is why resolvePending settles these two independently.
      const query = `"${name}" ${jurisdiction} official site`;
      const { body } = await deps.serp(query);

      let domains: string[] = [];
      try {
        const parsed = JSON.parse(body) as { organic?: Array<{ link?: string; url?: string }> };
        domains = (parsed.organic ?? [])
          .map((r) => r.link ?? r.url ?? '')
          .filter(Boolean)
          .map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } })
          .filter((h) => h && !/google|wikipedia|linkedin|facebook|bloomberg|crunchbase/i.test(h));
      } catch {
        // SERP returned HTML rather than parsed JSON; no domains is an honest answer.
        domains = [];
      }

      return { domains: [...new Set(domains)].slice(0, 3), aliases: [] };
    },
  };
}
