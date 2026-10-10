import type { Deal, Item } from '@donna/contracts';
import { loadRules, type Rules } from './rules.js';

/**
 * Watch terms -- the clauses the user told us they signed.
 *
 * PRODUCT RULE, not a style preference: a signal "touches a term you signed",
 * and never that the term was violated. Whether a contract has been violated
 * is a legal conclusion a lawyer reaches with the contract in front of them;
 * we have a semicolon-separated string the user typed. So this module records
 * touches only. The forbidden verb -- the one starting "brea-" -- appears
 * nowhere in this package's source or output, and a test asserts exactly that,
 * which is why this comment talks around it.
 */

export type WatchTerm =
  | { kind: 'key_person'; raw: string; person: string; role?: string }
  | { kind: 'litigation_cap_usd'; raw: string; cap_usd: number }
  | { kind: 'change_of_control'; raw: string }
  | { kind: 'unknown'; raw: string };

/**
 * `key_person: Jane Doe, CFO; litigation_cap_usd: 500000; change_of_control`
 * Semicolons separate terms; the part before the first colon is the kind.
 */
export const parseWatchTerms = (watchTerms: string | undefined): WatchTerm[] => {
  if (!watchTerms) return [];
  const out: WatchTerm[] = [];
  for (const chunk of watchTerms.split(';')) {
    const raw = chunk.trim();
    if (raw === '') continue;
    const colon = raw.indexOf(':');
    const kind = (colon === -1 ? raw : raw.slice(0, colon)).trim().toLowerCase();
    const value = colon === -1 ? '' : raw.slice(colon + 1).trim();

    if (kind === 'key_person') {
      const [person, ...rest] = value.split(',').map((p) => p.trim());
      const role = rest.filter((r) => r !== '').join(', ');
      out.push({ kind: 'key_person', raw, person: person ?? '', ...(role ? { role } : {}) });
    } else if (kind === 'litigation_cap_usd') {
      const cap = Number(value.replace(/[^0-9.]/g, ''));
      out.push({ kind: 'litigation_cap_usd', raw, cap_usd: Number.isFinite(cap) ? cap : 0 });
    } else if (kind === 'change_of_control') {
      out.push({ kind: 'change_of_control', raw });
    } else {
      out.push({ kind: 'unknown', raw });
    }
  }
  return out;
};

export const parseDealWatchTerms = (deals: readonly Deal[]): WatchTerm[] => {
  const seen = new Set<string>();
  const out: WatchTerm[] = [];
  for (const deal of deals) {
    for (const term of parseWatchTerms(deal.watch_terms)) {
      if (seen.has(term.raw)) continue;
      seen.add(term.raw);
      out.push(term);
    }
  }
  return out;
};

const numberField = (item: Item, fields: readonly string[]): number | undefined => {
  const rec = item as Record<string, unknown>;
  for (const f of fields) {
    const v = rec[f];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.replace(/[^0-9.]/g, ''));
      if (v.trim() !== '' && Number.isFinite(n)) return n;
    }
  }
  return undefined;
};

const textOf = (item: Item, fields: readonly string[]): string => {
  const rec = item as Record<string, unknown>;
  const parts = [...fields, 'summary', 'excerpt', 'title', 'role']
    .map((f) => rec[f])
    .filter((v): v is string => typeof v === 'string');
  return parts.join(' • ').toLowerCase();
};

/** What a signal needs to look like for term matching: its type plus the raw items behind it. */
export interface TermSubject {
  type: string;
  items: readonly Item[];
}

/**
 * Which of these terms the subject touches. Matching is direct and literal --
 * a departure of the named person, a claim over the named amount, an
 * ownership change -- so the user can check any match by eye.
 */
export const matchWatchTerms = (
  subject: TermSubject,
  terms: readonly WatchTerm[],
  rules: Rules = loadRules(),
): string[] => {
  const cfg = rules.watch_terms;
  const touched: string[] = [];

  for (const term of terms) {
    let hit = false;

    if (term.kind === 'key_person' && cfg.key_person_types.includes(subject.type)) {
      const needle = term.person.trim().toLowerCase();
      hit = needle !== ''
        && subject.items.some((item) => textOf(item, cfg.name_fields).includes(needle));
    } else if (term.kind === 'litigation_cap_usd' && cfg.litigation_types.includes(subject.type)) {
      hit = subject.items.some((item) => {
        const amount = numberField(item, cfg.amount_fields);
        return amount !== undefined && amount >= term.cap_usd;
      });
    } else if (term.kind === 'change_of_control') {
      hit = cfg.change_of_control_types.includes(subject.type);
    }

    if (hit && !touched.includes(term.raw)) touched.push(term.raw);
  }

  return touched;
};
