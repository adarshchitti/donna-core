/**
 * Sentence handling and the "factual sentence" rule.
 *
 * The contract the prompt states is "every sentence stating a fact must cite a
 * signal_id", and the model states the citation INLINE as `[sig-...]`. The
 * post-processor therefore has a per-sentence, not per-field, notion of backing:
 * it can drop one uncited sentence out of three and keep the rest.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS A FACTUAL SENTENCE (the defensible rule)
 *
 * Deciding "is this a fact" in general is unbounded. So the rule is INVERTED:
 * every sentence is treated as factual and therefore needs a citation, UNLESS
 * it falls in one of two closed, enumerated categories -- which are exactly the
 * two kinds of sentence this product is allowed to write without evidence:
 *
 *   (a) ABSENCE / LIMITATION. "no change observed", "not covered",
 *       "is not a determination of wrongdoing". These are claims about OUR
 *       coverage, not about the company. There is no signal to cite because the
 *       point is that there is no signal. These may match anywhere in the
 *       sentence.
 *
 *   (b) AN ASK. "Worth asking about ...", "Consider ...", "Confirm whether ...".
 *       These are the sanctioned non-advice phrasings, and a question is not an
 *       assertion. These must match at the START of the sentence: the sentence
 *       has to be FRAMED as an ask. A fact with "consider" buried in the middle
 *       ("The filing, consider, records a transfer") is still a fact and still
 *       needs its citation. That anchoring is the whole difference between a
 *       rule and a loophole -- do not relax it to an unanchored search.
 *
 * Anything else -- a date, a name, a number, a status, a relationship -- is
 * factual and is dropped when nothing backs it. Erring toward "factual" is the
 * safe direction: the cost of dropping a hedge is a slightly terser briefing,
 * the cost of keeping an uncited claim is the product's credibility.
 * ---------------------------------------------------------------------------
 */

/**
 * A citation marker is a bracketed list of ids: `[sig-001]` or
 * `[sig-001, dl-acme-1]`. The multi-id form is here because a real haiku-4-5
 * draft used it on the first live call -- a parser that only accepted one id
 * per bracket read those sentences as uncited and stripped two correctly cited
 * sentences out of a good briefing. The rule did not need loosening; the
 * tokenizer did.
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const BRACKET_RE = /\[([^\[\]\n]{1,300})\]/g;

/** Ids inside one bracket, or [] if the bracket held something else entirely. */
const idsInBracket = (body: string): string[] =>
  body
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter((part) => ID_RE.test(part));

/** Markers sitting at the head of a chunk, i.e. just after the previous full stop. */
const LEADING_BRACKETS_RE = /^((?:\s*\[[^\[\]\n]{1,300}\])+)\s*/;

export const extractMarkers = (text: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(BRACKET_RE.source, BRACKET_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) out.push(...idsInBracket(m[1]));
  }
  return out;
};

/**
 * Removes citation markers and tidies the whitespace they leave behind.
 * A bracket that holds no id at all is prose, not a citation, so it stays.
 */
export const stripMarkers = (text: string): string =>
  text
    .replace(new RegExp(BRACKET_RE.source, BRACKET_RE.flags), (whole, body: string) =>
      idsInBracket(body).length > 0 ? '' : whole,
    )
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

export interface Sentence {
  /** The sentence as written, markers included. */
  raw: string;
  /** Citation ids found inside it. */
  markers: string[];
}

/**
 * Splits on sentence-final punctuation followed by whitespace.
 *
 * One deliberate repair. The prompt states the convention: the marker goes at
 * the END of the sentence it backs. Models write both "...2026 [sig-001]." and
 * "...2026. [sig-001]", and the citation means the same thing in both, so
 * markers found at the HEAD of a chunk are moved back onto the previous
 * sentence. Without this repair, about half of all correctly-cited drafts would
 * have their first sentence stripped as uncited.
 *
 * The transfer is one-directional on purpose -- a leading marker backs the
 * PREVIOUS sentence, never the one it precedes. That keeps the stated
 * convention the only convention, instead of letting a marker back whichever
 * neighbour happens to need it.
 */
export const splitSentences = (text: string): Sentence[] => {
  const chunks = text
    .split(/(?<=[.!?])\s+/)
    .map((c) => c.trim())
    .filter((c) => c !== '');

  const out: string[] = [];
  for (const chunk of chunks) {
    let rest = chunk;
    const prev = out.length - 1;
    if (prev >= 0) {
      const lead = LEADING_BRACKETS_RE.exec(rest);
      if (lead?.[1] !== undefined) {
        out[prev] = `${out[prev] as string} ${lead[1].trim()}`;
        rest = rest.slice(lead[0].length).trim();
      }
    }
    // A chunk left with only punctuation ("." after its marker moved) carries
    // nothing and would otherwise rejoin the text as a stray full stop.
    if (/[A-Za-z0-9]/.test(rest)) out.push(rest);
  }

  return out.map((raw) => ({ raw, markers: extractMarkers(raw) }));
};

/** (a) absence / limitation -- may appear anywhere in the sentence. */
const ABSENCE_PATTERNS: readonly RegExp[] = [
  /\bno\s+change\s+observed\b/i,
  /\bnot\s+observed\b/i,
  /\bnot\s+covered\b/i,
  /\bnot\s+monitored\b/i,
  /\bnot\s+in\s+scope\b/i,
  /\bnot\s+available\b/i,
  /\bdoes\s+not\s+(?:cover|observe|monitor|check|collect)\b/i,
  /\bdo\s+not\s+(?:cover|observe|monitor|check|collect)\b/i,
  /\bis\s+not\s+(?:a\s+determination|an?\s+assessment|evidence)\b/i,
  /\bare\s+not\s+(?:a\s+determination|an?\s+assessment|evidence|new-change)\b/i,
  /\bnot\s+evidence\s+of\b/i,
  /\bno\s+(?:records?|filings?|notices?|signals?)\b/i,
  /\bnothing\s+(?:was\s+)?observed\b/i,
];

/** (b) an ask -- must FRAME the sentence, so this is anchored at the start. */
const ASK_PATTERNS: readonly RegExp[] = [
  /^(?:it\s+(?:may\s+be|is)\s+)?worth\s+(?:asking|discussing|confirming|checking|verifying|clarifying)\b/i,
  /^consider\b/i,
  /^confirm\b/i,
  /^ask\b/i,
  /^check\b/i,
  /^verify\b/i,
  /^clarify\b/i,
  /^request\b/i,
  /^before\s+signing\b/i,
];

export const isAbsenceStatement = (sentence: string): boolean =>
  ABSENCE_PATTERNS.some((re) => re.test(sentence));

export const isAskStatement = (sentence: string): boolean => {
  const s = stripMarkers(sentence).replace(/^["'‘“(]+/, '').trim();
  return ASK_PATTERNS.some((re) => re.test(s));
};

/** The rule, in one place. A sentence needs a citation unless it is exempt. */
export const isFactualSentence = (sentence: string): boolean => {
  const bare = stripMarkers(sentence);
  if (!/[A-Za-z0-9]/.test(bare)) return false; // punctuation only
  if (isAbsenceStatement(bare)) return false;
  if (isAskStatement(sentence)) return false;
  return true;
};
