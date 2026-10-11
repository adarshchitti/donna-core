# Donna — handoff

Written 2026-10-11 ~02:00Z. Read this before touching anything.

## Live right now

Two **orchestrator loops** (60s ticks, resolution + schedule backfill, collection
NOT enabled) and possibly a **Devin** run. Check and stop before changing code:

```bash
pgrep -fl "run-orchestrator|onboard-book|devin -p"
pkill -f run-orchestrator        # safe; restart below
```

Restart a loop:
```bash
cd ~/Desktop/donna-core
set -a; MONGODB_URI="$(grep '^MONGODB_URI=' .env.local|cut -d= -f2-)"; set +a
export MONGODB_DATABASE=Donna DONNA_CREDIT_CEILING=250 DONNA_FETCH_MODE=live
export BRIGHTDATA_API_KEY="$(grep '^BRIGHTDATA_API_KEY=' .env.local|cut -d= -f2-)"
export ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' .env.local|cut -d= -f2-)"
export BRIGHTDATA_SERP_ZONE=serp_api1 BRIGHTDATA_UNLOCKER_ZONE=web_unlocker1
DONNA_BOOK_ID=user_3KWgWJHsd1sfbdd4jx0Fet4IsAZ npx vite-node scripts/run-orchestrator.ts
```

## Facts

| | |
|---|---|
| Repos | `~/Desktop/donna-core` (A2+B, 478 tests) · `~/Desktop/donna-collectors` (A, 52) — both pushed, private, under `adarshchitti` |
| Base44 app | id `6acaa99dd815a77f30c93b02`, deployed **https://donna-build-path.base44.app**. Not a local repo; edit via base44 MCP, then `create_checkpoint` AND deploy. |
| Mongo | Atlas `Cluster0`, project Donna, db **`Donna`**. Creds in `.env.local` (gitignored). `0.0.0.0/0` allowlisted. |
| Demo book | `user_3KWgWJHsd1sfbdd4jx0Fet4IsAZ` (Bhagyesh) — 34 companies, 8 agreements, 81 snapshots, 13 signals, 10 briefings |
| Second book | `user_3KWnDbnT8Eeh1p8pzPJRVsNwbq1` (Adarsh) — 2 deals, 0 companies |
| `book_id` | **is the Clerk `sub`**. Base44 auth was removed; Clerk is the only sign-in. |
| Bright Data | 3 keys, use order **1, 3, 2** (in `BRIGHTDATA_API_KEYS`). All carry `web_unlocker1` + `serp_api1`. Only key 2 (`ed7ae4cf`) reports a balance. ~121 credits recorded spent. |
| Narrator/judge model | `claude-haiku-4-5-20251001`, **thinking disabled**. Haiku 5.5 said "breach" and burned its budget thinking. |

## Verified by running it, not assumed

- Clerk end-to-end **works**, including `azp !== origin` — `donna_books` has rows.
- Daytona: sandbox created, 2.3MB bundle uploaded, collector ran inside, deleted. **No egress on this account** (TLS reset even with `0.0.0.0/0`), so the design is: orchestrator fetches, sandbox parses, sandbox holds no credential.
- Bright Data **refuses every government domain** as HTTP 200 with an EMPTY BODY and the real status in `x-brd-error`. Our client now throws `POLICY_REFUSED`.
- Registry search needs **`&order=score&inactive=false`** — default is alphabetical over 5,093 matches, so the real company is not on page 1.
- OFAC SDN downloads fine **directly** (5.7MB, 19,416 entities).

## Open items

1. **`opendata.ts` is dead code.** Built and tested in donna-collectors, imported by nothing. `regulator.ts` and `layoffs.ts` deliberately report UNAVAILABLE because the architecture says Bright Data only. **This is a decision, not a bug**: wire the direct path (and state the exception on stage), or keep the honest gaps.
2. **`domain` failed 20/20.** The captcha false-positive fix landed and is reachable, but these still fail. Undiagnosed.
3. **No real change-driven briefing exists.** Two passes found `changes: 0` — correct, these companies didn't change in an hour. The only `mode:'briefing'` records are the 2 seeded demonstration ones. A real one needs a company that actually changed.
4. **Devin may be mid-task** on an LLM-backed Ask module + eval suite in `packages/logic/src/ask/`. Needs porting into the Base44 app afterwards (`src/components/donna/live/`).
5. **22 of 30 companies are paused** (`enabled:false`) to fit the budget. `scripts/pick-universe.mjs` changes the set.

## Rules that must not be broken

- Every document carries `book_id` or Track C renders blank **with no error**.
- Create Mongo indexes with specs byte-identical to Track C's, else `IndexOptionsConflict` 503s all its writes.
- Coverage is written with `$set`, never inside `$setOnInsert`.
- Never fabricate observations about a real company. The demo seeder throws unless the name says "Demonstration".
- First run is a baseline, never an alert.
- A failed source is a recorded gap, never silence.

## Three writers in donna-core

Me, Devin, and another Claude session. I broke a push today by overwriting
Devin's `inactive=false`. Check `git log` and `pgrep devin` before editing.
