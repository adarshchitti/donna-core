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

/** Ids look like `sig-...`, `dl-...`; brackets are the citation marker. */
const MARKER_RE = /\[([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})\]/g;

/** True when a chunk is nothing but markers and punctuation. */
const MARKERS_ONLY_RE = /^[\s.,;:]*(?:\[[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}\][\s.,;:]*)+$/;

export const extractMarkers = (text: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(MARKER_RE.source, MARKER_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (m[1] !== undefined) out.push(m[1]);
  return out;
};

/** Removes the markers and tidies the whitespace they leave behind. */
export const stripMarkers = (text: string): string =>
  text
    .replace(new RegExp(MARKER_RE.source, MARKER_RE.flags), '')
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
 * One deliberate repair: a chunk that is nothing but markers ("[sig-001].") is
 * merged back into the previous sentence, because models write both
 * "...2026 [sig-001]." and "...2026. [sig-001]" and the citation means the same
 * thing in both. Without this, half of all correctly-cited drafts would be
 * stripped.
 */
export const splitSentences = (text: string): Sentence[] => {
  const chunks = text
    .split(/(?<=[.!?])\s+/)
    .map((c) => c.trim())
    .filter((c) => c !== '');
  const out: string[] = [];
  for (const c of chunks) {
    const prev = out[out.length - 1];
    if (MARKERS_ONLY_RE.test(c) && prev !== undefined) out[out.length - 1] = `${prev} ${c}`;
    else out.push(c);
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
