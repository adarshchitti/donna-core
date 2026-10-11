import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { loadRules } from './rules.js';

/**
 * CROSS-REPO TYPE CONFORMANCE.
 *
 * rules.json matches changes almost entirely on `item.type`. The collectors are
 * built in a separate repo, and the brief specified item KEYS and the fields the
 * differ reads -- but never the item TYPE vocabulary. So both sides ended up
 * internally consistent and mutually wrong, with every test green:
 * collectors emitted `executive_move` while rules expected `exec_move`, so every
 * executive departure classified to the tier-0 fallback. The architecture's own
 * flagship headline could not be produced by the source that observes it.
 *
 * A green unit test on each side cannot catch that. Only this can.
 */
const COLLECTORS = '/Users/adarshc/Desktop/donna-collectors/src/collectors';

function emittedTypes(): string[] {
  const files = readdirSync(COLLECTORS).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
  const src = files.map((f) => readFileSync(`${COLLECTORS}/${f}`, 'utf8')).join('\n');
  return [...new Set([...src.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]!))].sort();
}

function matchedTypes(): Set<string> {
  const rules = loadRules();
  const out = new Set<string>();
  for (const st of rules.signal_types) {
    for (const clause of st.match ?? []) {
      for (const t of clause.item_types ?? []) out.add(t);
    }
  }
  return out;
}

describe('every type a collector emits is classified by a real rule', () => {
  const matched = matchedTypes();
  const emitted = emittedTypes();

  it('found collectors to check', () => {
    expect(emitted.length).toBeGreaterThan(10);
  });

  for (const type of emitted) {
    it(`\`${type}\` matches a rule rather than falling to the tier-0 fallback`, () => {
      expect(
        matched.has(type),
        `Collectors emit '${type}' but no rules.json clause matches it, so every such ` +
        `change silently classifies to the tier-0 fallback and is never surfaced.`,
      ).toBe(true);
    });
  }
});
