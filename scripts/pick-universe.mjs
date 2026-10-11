/**
 * Cut the monitored universe to a set we can actually afford to collect.
 *
 * measure-credits put one full pass at 13 credits, and a BRIEFING costs two
 * passes -- first run is a baseline by design, so one pass can never produce
 * one. At ~26 credits per briefed company, 30 companies is roughly 780 credits
 * against a 300-credit event budget.
 *
 * So a chosen few stay enabled and the rest keep their companies and schedules
 * but with `enabled: false`. They still demonstrate the fixed universe on the
 * book page; they simply are not collected. Nothing is deleted, so widening the
 * set later is a one-line change rather than a re-seed.
 */
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const BOOK = env.DONNA_BOOK_ID;
const COMMIT = process.argv.includes('--commit');

/**
 * Eight real Ohio companies, chosen for data availability rather than name
 * recognition -- large enough to appear in a registry and a court docket, and
 * spread across sectors so the sources differ.
 */
const KEEP = [
  'Big Lots, Inc.',
  'Diebold Nixdorf, Incorporated',
  'Designer Brands Inc.',
  'The Wendy\'s Company',
  'Cardinal Health, Inc.',
  'FirstEnergy Corp.',
  'The Goodyear Tire & Rubber Company',
  'Worthington Industries, Inc.',
];

const client = await new MongoClient(env.MONGODB_URI).connect();
try {
  const db = client.db(env.MONGODB_DATABASE || 'Donna');
  const companies = await db.collection('companies')
    .find({ book_id: BOOK, canonical_name: { $not: /Demonstration/ } }).toArray();

  const keep = companies.filter((c) => KEEP.includes(c.canonical_name));
  const pause = companies.filter((c) => !KEEP.includes(c.canonical_name));

  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);
  console.log(`collecting (${keep.length}):`);
  for (const c of keep) console.log(`  + ${c.canonical_name}`);
  const missing = KEEP.filter((n) => !companies.some((c) => c.canonical_name === n));
  if (missing.length) console.log(`\nNOT FOUND in the book (check the name): ${missing.join(', ')}`);
  console.log(`\npausing (${pause.length}) -- still seeded and listed, schedules disabled`);

  const perPass = 13;
  console.log(`\nbudget: ${keep.length} x 2 passes x ${perPass} = ~${keep.length * 2 * perPass} credits for briefings`);

  if (!COMMIT) { console.log('\nnothing written. re-run with --commit'); process.exit(0); }

  const ids = (list) => list.map((c) => c.company_id);
  const on = await db.collection('schedules').updateMany(
    { book_id: BOOK, company_id: { $in: ids(keep) } }, { $set: { enabled: true } });
  const off = await db.collection('schedules').updateMany(
    { book_id: BOOK, company_id: { $in: ids(pause) } }, { $set: { enabled: false } });
  console.log(`\nschedules enabled: ${on.modifiedCount}  disabled: ${off.modifiedCount}`);
} finally { await client.close(); }
