/**
 * Seed the demonstration book: four fictional companies with complete worked
 * record sets, so the UI has something to render before collection has run.
 *
 * Every name contains "Demonstration" and every excerpt is stamped
 * DEMONSTRATION RECORD. The seeder in @donna/store throws if a name does not
 * announce itself, because a fabricated observation under a plausible real name
 * is the one thing this product must never produce.
 */
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { DonnaStore } from '../packages/store/src/store.ts';
import { seedDemonstrationCompany } from '../packages/store/src/demo-seed.ts';
import { DEMO_BOOK } from '../packages/store/src/demo-book.ts';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
);

const COMMIT = process.argv.includes('--commit');
const bookId = env.DONNA_BOOK_ID;
if (!bookId?.startsWith('user_')) throw new Error(`DONNA_BOOK_ID must be a Clerk subject, got: ${bookId}`);

console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'}  book=${bookId}\n`);
for (const spec of DEMO_BOOK) {
  console.log(`  ${spec.canonical_name}`);
  console.log(`    tier ${spec.top_tier} | checked ${spec.checked.length} | failed ${spec.failed.length} | signals ${spec.signals.length} | briefing ${spec.briefing ? 'yes' : 'NO (quiet state)'}`);
}
if (!COMMIT) { console.log('\nnothing written. re-run with --commit'); process.exit(0); }

const client = await new MongoClient(env.MONGODB_URI).connect();
try {
  const store = DonnaStore.fromClient(client, { database: env.MONGODB_DATABASE || 'Donna', bookId });
  await store.ensureIndexes();
  console.log('');
  for (const spec of DEMO_BOOK) {
    const r = await seedDemonstrationCompany(store, spec);
    console.log(`  ${spec.canonical_name}`);
    console.log(`    company_id=${r.company_id} runs=${r.runs} snapshots=${r.snapshots} signals=${r.signals} narrated=${r.narrated}`);
  }
} finally { await client.close(); }
