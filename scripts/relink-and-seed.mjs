/**
 * One-shot: point the book at Bhagyesh's Clerk subject, clear the connectivity
 * test rows, and seed the real fixed universe.
 *
 * Why a script rather than a one-liner: MONGODB_URI lives in .env.local and its
 * value contains an unquoted `&`, so `source .env.local` breaks under zsh.
 *
 * Nothing here is destructive beyond the `TEST ONLY` rows, and those are matched
 * by an explicit name prefix rather than by book id, so a real company can never
 * be caught by it.
 */
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
);

const OLD_BOOK = '6acaa9a3d815a77f30c93b04';
const NEW_BOOK = env.DONNA_BOOK_ID;
const COMMIT = process.argv.includes('--commit');

if (!NEW_BOOK?.startsWith('user_')) {
  throw new Error(`DONNA_BOOK_ID must be a Clerk subject (user_...), got: ${NEW_BOOK}`);
}

const SCOPED = ['companies', 'deals', 'snapshots', 'changes', 'signals',
                'clusters', 'briefings', 'collector_runs', 'schedules', 'fetch_cache'];

const client = await new MongoClient(env.MONGODB_URI).connect();
const db = client.db(env.MONGODB_DATABASE || 'Donna');

try {
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'}  ${OLD_BOOK} -> ${NEW_BOOK}\n`);

  // 1. Re-key anything still under the old Base44 user id. book_id is now the
  //    Clerk subject, so documents under the old id are unreachable: nobody can
  //    authenticate as it any more.
  let rekeyed = 0;
  for (const name of SCOPED) {
    const n = await db.collection(name).countDocuments({ book_id: OLD_BOOK });
    if (!n) continue;
    if (COMMIT) await db.collection(name).updateMany({ book_id: OLD_BOOK }, { $set: { book_id: NEW_BOOK } });
    console.log(`  re-key ${name}: ${n}`);
    rekeyed += n;
  }
  console.log(`  total re-keyed: ${rekeyed}\n`);

  // 2. Drop the connectivity-test rows. Every one is named "TEST ONLY — ...";
  //    matching on that prefix rather than on book id means a real company
  //    cannot be removed by accident.
  const TEST = /^TEST ONLY/;
  const testCompanies = await db.collection('companies')
    .find({ book_id: NEW_BOOK, canonical_name: { $regex: TEST } }).toArray();
  const testDeals = await db.collection('deals')
    .find({ book_id: NEW_BOOK, counterparty_name: { $regex: TEST } }).toArray();

  for (const c of testCompanies) console.log(`  remove company: ${c.canonical_name}`);
  for (const d of testDeals) console.log(`  remove deal:    ${d.counterparty_name}`);

  if (COMMIT) {
    await db.collection('companies').deleteMany({ book_id: NEW_BOOK, canonical_name: { $regex: TEST } });
    await db.collection('deals').deleteMany({ book_id: NEW_BOOK, counterparty_name: { $regex: TEST } });
  }
  console.log(`  removed ${testCompanies.length} companies, ${testDeals.length} deals\n`);

  const remaining = await db.collection('companies').countDocuments({ book_id: NEW_BOOK });
  console.log(`companies now under ${NEW_BOOK}: ${remaining}`);
  if (!COMMIT) console.log('\nnothing written. re-run with --commit');
} finally {
  await client.close();
}
