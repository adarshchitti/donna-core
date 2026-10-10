/**
 * Forbidden language.
 *
 * Two families, both hard rejections rather than edits:
 *
 *  1. REASSURANCE. "healthy", "good standing", "safe", "low risk". This product
 *     reports records; it does not certify a counterparty. Absence of a finding
 *     is "no change observed", which is a statement about our coverage, not
 *     about the company. A reassurance word cannot be deleted from a sentence
 *     without changing what the sentence claims, so the draft is rejected and
 *     we fall back.
 *
 *  2. VERDICTS AND ADVICE. "breach"/"breached" -- a signal TOUCHES A TERM YOU
 *     SIGNED; whether that is a breach is a lawyer's determination and saying
 *     it here is the single most expensive sentence we could print. And
 *     "you should"/"you must" -- we are not advising. "Worth asking about" and
 *     "consider" are allowed and are the sanctioned phrasings.
 *
 * Every pattern is WORD-BOUNDARY AWARE using explicit letter lookaround rather
 * than \b, because \b treats a hyphen as a boundary and we want "unsafe" and
 * "safety" to pass while "safe" and "safe." are caught. Do not "simplify" these
 * to \bsafe\b -- that is the same regex, but do not simplify them to /safe/i,
 * which silently rejects every sentence containing "safety".
 */

export interface ForbiddenHit {
  rule: 'reassurance' | 'advice';
  term: string;
  match: string;
}

interface Pattern {
  rule: ForbiddenHit['rule'];
  term: string;
  re: RegExp;
}

/** Not preceded by a letter, not followed by a letter. */
const word = (body: string): RegExp => new RegExp(`(?<![A-Za-z])(?:${body})(?![A-Za-z])`, 'gi');

export const FORBIDDEN_PATTERNS: readonly Pattern[] = [
  // --- reassurance -------------------------------------------------------
  { rule: 'reassurance', term: 'healthy', re: word('healthy|healthier|healthiest') },
  { rule: 'reassurance', term: 'good standing', re: word('good\\s+standing') },
  // "safe" only. "unsafe" (letter before) and "safety" (letter after) pass.
  { rule: 'reassurance', term: 'safe', re: word('safe|safely') },
  { rule: 'reassurance', term: 'low risk', re: word('low[\\s-]risk') },
  // --- verdicts and advice ----------------------------------------------
  // A lawyer decides breach. We say a term was touched.
  { rule: 'advice', term: 'breach', re: word('breach|breaches|breached|breaching') },
  { rule: 'advice', term: 'you should', re: word('you\\s+should') },
  { rule: 'advice', term: 'you must', re: word('you\\s+must') },
  // Same imperative in different clothes; rejected for the same reason.
  { rule: 'advice', term: 'you need to', re: word('you\\s+need\\s+to') },
  { rule: 'advice', term: 'you have to', re: word('you\\s+have\\s+to') },
];

/** Every violation in `text`, in pattern order. Empty array means clean. */
export const findForbidden = (text: string): ForbiddenHit[] => {
  const hits: ForbiddenHit[] = [];
  for (const p of FORBIDDEN_PATTERNS) {
    // Fresh regex per call: the shared literals carry /g and therefore lastIndex.
    const re = new RegExp(p.re.source, p.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ rule: p.rule, term: p.term, match: m[0] });
      if (m.index === re.lastIndex) re.lastIndex += 1; // guard a zero-width match
    }
  }
  return hits;
};

export const isForbidden = (text: string): boolean => findForbidden(text).length > 0;

/**
 * Neutralises forbidden language in text we did not write.
 *
 * Only used on the code-built fallback, whose lines are signal `summary_fact`
 * strings produced upstream from source records -- a court docket really can
 * contain the word "breach". The fallback cannot reject itself (it is the thing
 * we fall back TO), and it must not ship the word, so the offending line is
 * replaced wholesale with a neutral line that still carries its signal_id. The
 * evidence panel still shows the original text; this is the one-line summary.
 */
export const NEUTRAL_LINE =
  'A record was observed for this signal; the cited evidence has the wording.';

export const neutraliseLine = (text: string): string =>
  isForbidden(text) ? NEUTRAL_LINE : text;
