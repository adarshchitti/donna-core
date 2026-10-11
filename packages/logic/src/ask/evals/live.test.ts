import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpNarratorClient } from '../../narrator/model.js';
import { answerQuestion } from '../answer.js';
import { ASK_EVAL_CASES } from './cases.js';
import { evaluate } from './expect.js';

/**
 * The eval suite, live path. Opt-in: runs only when DONNA_ASK_LIVE=1 is set,
 * and needs ANTHROPIC_API_KEY in the environment or in .env.local at the repo
 * root (read, never written and never logged).
 *
 * The point of running it: a failure here that the deterministic suite does
 * not share is the finding -- it means the model draft, after the gate,
 * produced an answer the deterministic path would not have signed. The
 * scoreboard reports every case, which path answered, and -- on failure --
 * what the answer actually said.
 */

const ENV_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../.env.local',
);

const loadKey = (): string | null => {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return process.env.ANTHROPIC_API_KEY.trim();
  if (existsSync(ENV_PATH)) {
    try {
      process.loadEnvFile(ENV_PATH);
    } catch {
      // An unparseable .env.local is the operator's problem, not the suite's.
    }
    const key = process.env.ANTHROPIC_API_KEY;
    if (key !== undefined && key.trim() !== '') return key.trim();
  }
  return null;
};

const LIVE = process.env.DONNA_ASK_LIVE === '1';
const KEY = loadKey();

describe.skipIf(!LIVE || KEY === null)('ask evals -- live client', () => {
  const client = httpNarratorClient(KEY ?? '');
  const scoreboard: string[] = [];

  for (const caze of ASK_EVAL_CASES) {
    it(caze.name, async () => {
      const answer = await answerQuestion(
        { ...caze.input, question: caze.question },
        { client },
      );
      const failures = evaluate(answer, caze);
      const path = answer.used_fallback
        ? 'deterministic'
        : `model(${answer.attempts} call${answer.attempts === 1 ? '' : 's'})`;
      const line = `${failures.length === 0 ? 'PASS' : 'FAIL'}  ${caze.name.padEnd(34)} ${path}`;
      scoreboard.push(line);
      for (const f of failures) scoreboard.push(`       - ${f}`);
      if (failures.length > 0) scoreboard.push(`       answer was: ${answer.text}`);
      expect(failures, `\npath: ${path}\nthe answer was: ${answer.text}`).toEqual([]);
      // Live calls run a few seconds each; a retried case can take ~10s.
    }, 30_000);
  }

  afterAll(() => {
    const passed = scoreboard.filter((l) => l.startsWith('PASS')).length;
    const total = ASK_EVAL_CASES.length;
    // eslint-disable-next-line no-console
    console.log(
      `\n===== ASK LIVE SCOREBOARD (${passed}/${total} passed) =====\n${scoreboard.join('\n')}\n`,
    );
  });
});
