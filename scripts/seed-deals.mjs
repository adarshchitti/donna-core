/**
 * Seed agreements against the collected companies.
 *
 * Without deals the product has nothing to be about: watch terms live on a
 * deal, so "this touches a term you signed" can never fire; `why_it_matters` is
 * specified to tie an observation to the deal's value, share, notice window and
 * class; and the exposure join has nothing to join to. Monitoring a
 * counterparty you have no agreement with is pointless.
 *
 * A note on honesty, since these are invented agreements against REAL
 * companies. A deal is a statement about OUR OWN commercial relationship, not a
 * claim about the counterparty -- unlike a fabricated bankruptcy filing, which
 * is why that is refused elsewhere. The figures are still illustrative, so each
 * deal says so in its title.
 *
 * Shapes match Track C's own writer exactly (donnaDealWrites.ts): the compound
 * `_id`, the `<request_id>-<index>` deal_id, and the resolution subdocument.
 * dealPage() pages on {created_date, deal_id} as a compound cursor, so a
 * differently-shaped id silently corrupts pagination.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const BOOK = env.DONNA_BOOK_ID;
const COMMIT = process.argv.includes('--commit');
if (!BOOK?.startsWith('user_')) throw new Error(`DONNA_BOOK_ID must be a Clerk subject, got ${BOOK}`);

/**
 * One agreement per collected company, each exercising a different combination
 * of the fields exposure is computed from, and each carrying watch terms so the
 * validator has something to match a signal against.
 */
const TERMS = {
  'Big Lots, Inc.':
    { v: 2_400_000, share: 18, notice: 90, sub: 'hard',    cls: 'they_pay_us',
      watch: 'change_of_control; litigation_cap_usd: 500000' },
  'Diebold Nixdorf, Incorporated':
    { v: 1_750_000, share: 12, notice: 60, sub: 'quarter', cls: 'they_pay_us',
      watch: 'change_of_control; key_person: Chief Financial Officer' },
  'Designer Brands Inc.':
    { v: 940_000,   share: 9,  notice: 90, sub: 'quarter', cls: 'we_pay_them',
      watch: 'litigation_cap_usd: 250000' },
  "The Wendy's Company":
    { v: 1_200_000, share: 14, notice: 120, sub: 'week',   cls: 'they_pay_us',
      watch: 'key_person: Chief Executive Officer' },
  'Cardinal Health, Inc.':
    { v: 3_100_000, share: 22, notice: 180, sub: 'hard',   cls: 'tied',
      watch: 'change_of_control; litigation_cap_usd: 1000000' },
  'FirstEnergy Corp.':
    { v: 2_050_000, share: 16, notice: 90, sub: 'hard',    cls: 'we_pay_them',
      watch: 'change_of_control' },
  'The Goodyear Tire & Rubber Company':
    { v: 680_000,   share: 7,  notice: 30, sub: 'quarter', cls: 'they_pay_us',
      watch: 'litigation_cap_usd: 500000' },
  'Worthington Industries, Inc.':
    { v: 410_000,   share: 5,  notice: 45, sub: 'week',    cls: 'they_pay_us',
      watch: '' },
};

const client = await new MongoClient(env.MONGODB_URI).connect();
try {
  const db = client.db(env.MONGODB_DATABASE || 'Donna');
  const names = Object.keys(TERMS);
  const companies = await db.collection('companies')
    .find({ book_id: BOOK, canonical_name: { $in: names } }).toArray();

  const missing = names.filter((n) => !companies.some((c) => c.canonical_name === n));
  if (missing.length) console.log(`NOT IN BOOK (skipping): ${missing.join(', ')}\n`);

  const requestId = randomUUID();
  const now = new Date().toISOString();
  const docs = companies.map((c, i) => {
    const t = TERMS[c.canonical_name];
    return {
      _id: `${BOOK}:${requestId}:${i}`,
      book_id: BOOK,
      created_by_id: BOOK,
      deal_id: `${requestId}-${i}`,
      company_id: c.company_id,
      title: `${c.canonical_name} supply agreement (illustrative terms)`,
      description: 'Agreement terms are illustrative. The counterparty is a real company; the commercial terms are not a real contract.',
      counterparty_name: c.canonical_name,
      country: c.jurisdiction,
      deal_class: t.cls,
      annual_value_usd: t.v,
      share_pct: t.share,
      notice_days: t.notice,
      substitutability: t.sub,
      start_date: '2024-07-01',
      end_date: '2027-06-30',
      owner_email: 'jethwani.bhagyesh@gmail.com',
      watch_terms: t.watch,
      status: 'resolved',
      resolution: {
        confidence: null,
        reason: 'Seeded agreement linked to a company already recorded in this book. Terms are illustrative.',
        resolved_by: 'seeded_demo',
        resolved_at: now,
        candidates_seen: [],
      },
      created_date: now,
      updated_date: now,
    };
  });

  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'}  book=${BOOK}\n`);
  for (const d of docs) {
    console.log(`  ${d.counterparty_name}`);
    console.log(`    $${d.annual_value_usd.toLocaleString()} | ${d.share_pct}% share | ${d.notice_days}d notice | ${d.substitutability} | ${d.deal_class}`);
    console.log(`    watch: ${d.watch_terms || '(none)'}`);
  }
  console.log(`\n${docs.length} agreements`);

  if (!COMMIT) { console.log('\nnothing written. re-run with --commit'); process.exit(0); }

  // Track C's indexes, byte-identical specs so createIndex stays a no-op there.
  await db.collection('deals').createIndex({ book_id: 1, created_date: -1, deal_id: -1 });
  await db.collection('deals').createIndex({ book_id: 1, status: 1, company_id: 1 });
  const r = await db.collection('deals').bulkWrite(
    docs.map((doc) => ({ updateOne: { filter: { _id: doc._id, book_id: BOOK }, update: { $setOnInsert: doc }, upsert: true } })),
    { ordered: true },
  );
  console.log(`\nwritten: ${r.upsertedCount} agreements`);
} finally { await client.close(); }
