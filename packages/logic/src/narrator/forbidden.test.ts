import { describe, it, expect } from 'vitest';
import { findForbidden, isForbidden, neutraliseLine, NEUTRAL_LINE } from './forbidden.js';
import {
  extractMarkers, isAskStatement, isFactualSentence, splitSentences, stripMarkers,
} from './sentences.js';

describe('forbidden reassurance words', () => {
  it('rejects healthy, good standing, safe and low risk', () => {
    for (const s of [
      'The counterparty looks healthy.',
      'The company is in good standing with the registry.',
      'This agreement is safe for now.',
      'This is a low risk observation.',
      'This is a low-risk observation.',
    ]) {
      expect(isForbidden(s), s).toBe(true);
      expect(findForbidden(s)[0]?.rule).toBe('reassurance');
    }
  });

  it('does NOT false-positive on unsafe or safety', () => {
    for (const s of [
      'The site was flagged as unsafe by the regulator.',
      'A workplace safety notice was filed.',
      'Safety inspections are not covered.',
      'unsafely stored goods were recorded',
    ]) {
      expect(findForbidden(s), s).toEqual([]);
    }
  });

  it('catches safe at a sentence boundary and in punctuation', () => {
    expect(isForbidden('Nothing suggests it is not safe.')).toBe(true);
    expect(isForbidden('"Safe", the filing said.')).toBe(true);
  });
});

describe('breach is never ours to say', () => {
  it('rejects breach and breached', () => {
    for (const s of [
      'The notice period was breached.',
      'This is a breach of the change-of-control term.',
      'Two breaches are recorded.',
      'The filing suggests breaching the notice clause.',
    ]) {
      expect(isForbidden(s), s).toBe(true);
      expect(findForbidden(s)[0]?.term).toBe('breach');
    }
  });

  it('allows the sanctioned phrasing', () => {
    expect(isForbidden('The signal touches a term you signed.')).toBe(false);
  });
});

describe('advice verbs', () => {
  it('rejects you should and you must', () => {
    expect(isForbidden('You should call the counterparty.')).toBe(true);
    expect(isForbidden('You must serve notice within 90 days.')).toBe(true);
    expect(isForbidden('you need to review the agreement')).toBe(true);
  });

  it('allows worth asking about and consider', () => {
    expect(isForbidden('Worth asking about the new controlling entity.')).toBe(false);
    expect(isForbidden('Consider confirming the legal entity before signing.')).toBe(false);
  });
});

describe('neutraliseLine (fallback only)', () => {
  it('replaces a line carrying source wording we may not print', () => {
    expect(neutraliseLine('The docket alleges a breach of contract.')).toBe(NEUTRAL_LINE);
  });
  it('leaves a clean line alone', () => {
    const clean = 'A new docket entry was recorded on 9 October 2026.';
    expect(neutraliseLine(clean)).toBe(clean);
  });
});

describe('the factual-sentence rule', () => {
  it('treats an ordinary claim as factual', () => {
    expect(isFactualSentence('Alder Holdings is recorded as majority member.')).toBe(true);
  });

  it('exempts absence and limitation statements', () => {
    for (const s of [
      'No change observed in the registry.',
      'Payment behaviour is not covered.',
      'A recorded claim or notice is not a determination of wrongdoing.',
      'Officer churn is not observed in the available history.',
    ]) {
      expect(isFactualSentence(s), s).toBe(false);
    }
  });

  it('exempts a sentence FRAMED as an ask', () => {
    for (const s of [
      'Worth asking about the new controlling entity.',
      'Consider confirming the legal entity.',
      'Confirm whether the provision requires notice.',
    ]) {
      expect(isAskStatement(s), s).toBe(true);
      expect(isFactualSentence(s), s).toBe(false);
    }
  });

  it('does NOT let an ask verb buried mid-sentence launder a fact', () => {
    const s = 'The registry filing, consider, records a transfer of ownership.';
    expect(isAskStatement(s)).toBe(false);
    expect(isFactualSentence(s)).toBe(true);
  });
});

describe('citation markers', () => {
  it('re-attaches a marker the model put after the full stop', () => {
    const sentences = splitSentences('Ownership moved to Alder. [sig-001] Nothing else changed.');
    expect(sentences).toHaveLength(2);
    expect(sentences[0]?.markers).toEqual(['sig-001']);
  });

  it('strips markers and tidies the space they leave', () => {
    expect(stripMarkers('Ownership moved to Alder [sig-001].')).toBe('Ownership moved to Alder.');
  });

  // A real haiku-4-5 draft wrote both ids in one bracket. A parser that only
  // accepted one id per bracket read the sentence as uncited and deleted it.
  it('accepts several ids in one bracket', () => {
    expect(extractMarkers('Ownership moved [dl-nordvale-1, sig-coc-001].')).toEqual([
      'dl-nordvale-1',
      'sig-coc-001',
    ]);
    expect(extractMarkers('Two signals [sig-a; sig-b]')).toEqual(['sig-a', 'sig-b']);
    expect(stripMarkers('Ownership moved [dl-nordvale-1, sig-coc-001].')).toBe(
      'Ownership moved.',
    );
  });

  it('leaves a bracket that holds no id at all -- that is prose, not a citation', () => {
    expect(extractMarkers('The filing [see note 3] was recorded.')).toEqual([]);
    expect(stripMarkers('The filing [see note 3] was recorded.')).toBe(
      'The filing [see note 3] was recorded.',
    );
  });
});
