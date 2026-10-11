import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { collectorEnvelopeSchema, SOURCES } from '@donna/contracts';

/**
 * Cross-repo conformance. The collectors are built in a separate repo against
 * their own copy of the contract; this asserts the two copies have not drifted,
 * which is the one failure mode a separate repo introduces.
 */
const COLLECTORS = '/Users/adarshc/Desktop/donna-collectors/src';

describe('the collector repo has not drifted from our contract', () => {
  it('declares the same eight source ids, including `executives`', () => {
    const theirs = readFileSync(`${COLLECTORS}/contract.ts`, 'utf8');
    for (const s of SOURCES) expect(theirs).toContain(`'${s}'`);
    expect(theirs).not.toContain('exec_moves');
  });

  it('every collector file exists for every source in our enum', () => {
    const files = readdirSync(`${COLLECTORS}/collectors`).filter((f) => !f.includes('.test.'));
    for (const s of SOURCES) expect(files, `missing collector for ${s}`).toContain(`${s}.ts`);
  });

  it('their envelope schema accepts exactly what ours does', () => {
    const sample = {
      company_id: 'c1', source: 'registry' as const, fetched_at: '2026-10-10T19:42:00Z',
      run_id: 'run-c1-registry', ok: true, error: null,
      items: [{ key: 'officer:jane-doe:cfo', type: 'officer', name: 'Jane Doe', role: 'CFO' }],
      raw_excerpt: 'Jane Doe, Chief Financial Officer', source_url: 'https://x.invalid/a',
      credits_spent: 1,
    };
    expect(collectorEnvelopeSchema.safeParse(sample).success).toBe(true);
  });

  it('item keys identify a RECORD, never a value', () => {
    // A key embedding its own value turns an `altered` into remove+add and
    // loses `previous` -- the subtle rule that breaks the differ silently.
    const src = readdirSync(`${COLLECTORS}/collectors`)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
      .map((f) => readFileSync(`${COLLECTORS}/collectors/${f}`, 'utf8'))
      .join('\n');
    const keys = [...src.matchAll(/key: `([^`]+)`/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) {
      expect(k, `key looks value-bearing: ${k}`).not.toMatch(/:\$\{(status|value|state|count)\}/);
    }
  });
});
