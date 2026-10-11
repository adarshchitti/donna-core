import { describe, expect, it } from 'vitest';
import { answerQuestion } from '../answer.js';
import { ASK_EVAL_CASES } from './cases.js';
import { evaluate } from './expect.js';

/**
 * The eval suite, deterministic path: client: null, no network, no key.
 * Every case must pass here -- this is the floor the product never goes under.
 */
describe('ask evals -- deterministic (client: null)', () => {
  for (const caze of ASK_EVAL_CASES) {
    it(caze.name, async () => {
      const answer = await answerQuestion(
        { ...caze.input, question: caze.question },
        { client: null },
      );
      const failures = evaluate(answer, caze);
      expect(failures, `\nthe answer was: ${answer.text}`).toEqual([]);
    });
  }
});
