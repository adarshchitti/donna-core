# Devin brief — Track A, the collectors

You are building **one repo**: the collector track for a counterparty-monitoring
system called Donna. Nobody else will touch this repo.

Your scope is deliberately narrow and hard-bounded: **envelope in, envelope out.**
You never touch a database, a UI, or an orchestrator. You are handed a canonical
company and you return a fixed-shape snapshot of what one source says about it.

---

## 1. The contract — the only thing that crosses your boundary

Every collector returns exactly this shape, always, including on failure:

```json
{
  "company_id": "7b040439-0ed6-4a4e-b3ae-6ab1161b4e98",
  "source": "registry",
  "fetched_at": "2026-10-10T19:42:11Z",
  "run_id": "run-nordvale-registry",
  "ok": true,
  "error": null,
  "items": [
    { "key": "officer:jane-doe:cfo", "type": "officer",
      "name": "Jane Doe", "role": "CFO", "since": "2024-02-01" }
  ],
  "raw_excerpt": "...Jane Doe, Chief Financial Officer, appointed 1 Feb 2024...",
  "source_url": "https://businesssearch.ohiosos.gov/...",
  "credits_spent": 1
}
```

Signature: `collect(company, deps) -> Promise<CollectorEnvelope>`

- `fetched_at`, full ISO instant. This is evidence metadata — it is shown to users.
- `raw_excerpt` is **the exact text a later claim will point to.** Not a summary.
  A user clicks through from a briefing sentence to this text. If it is vague or
  paraphrased, the whole product's trust story breaks.
- `source_url` must be the page a sceptical analyst can open themselves.
- `credits_spent` is what the fetch cost (0 on a cache hit).

### A collector NEVER throws

A failure becomes `{ok: false, error: "<what went wrong>", items: [], raw_excerpt: ""}`.
This is a product rule, not a style preference: **a failed run is never silent.**
It is recorded and shown to the user as a gap in coverage. A thrown exception
becomes silence, and silence reads as "nothing happened" — which is the single
failure mode this product exists to prevent.

---

## 2. The eight sources

| `source` id | What to fetch | What comes back | Trust |
|---|---|---|---|
| `registry` | Ohio SoS business search | status, officers/principals, filings list, registered address, prior names | primary |
| `court` | Franklin County Common Pleas docket | cases where the company is a party: docket no., role, date, status | primary |
| `regulator` | Ohio licence lookups + federal OFAC SDN list | enforcement actions, licence status, sanctions matches | primary |
| `layoffs` | Ohio JFS WARN notice listings | notice date, headcount affected, site | primary |
| `news` | SERP, then unlock the article | headline, outlet, date, body text | reported |
| `executives` | SERP + press releases | appointment or departure, role, date | reported |
| `jobs` | SERP or the careers page | count of open roles, titles | inferred |
| `domain` | WHOIS + homepage fetch | registrar, dates, nameservers, page hash, title | inferred |

The source id is **`executives`** — not `exec_moves`. The UI's label round-trip
depends on that exact string.

### Verified portal entry points
- Ohio SoS: `businesssearch.ohiosos.gov` — free, searchable by name / prior name /
  entity number. Returns status, principals, statutory agent, prior names, and
  filing PDFs.
- Franklin County: `fcdcfcjs.co.franklin.oh.us` — public Case Information Online,
  searchable **by party name**, which is what you need.
  **Known limitation: this docket lags real filings by 2–5 business days.** Do not
  hide that. Report the freshest date the portal itself states, so the system can
  say "court records current to <date>" rather than implying the docket is live.

---

## 3. Item keys — the part that is easy to get subtly wrong

A separate component (the differ) compares two snapshots by each item's `key`.
So keys are part of the contract, and two rules govern them:

**Rule A — a key identifies the RECORD, not its value.**
If you mint `registry:status:active`, then when the status changes the key changes,
and the differ sees one record removed and a different one added instead of one
record *altered* — losing the previous value, which is the whole point. Use
`registry:status` and put `active` in a `value` field.

**Rule B — keys are stable across runs.** Never include a row index, a timestamp,
or anything that varies between fetches of unchanged data.

| source | keys |
|---|---|
| `registry` | `officer:<name-slug>:<role>`, `filing:<filing_id>`, `status:current`, `address:registered` |
| `court` | `case:<docket_number>` |
| `regulator` | `action:<id>`, `licence:<id>`, `sanctions:<list>:<match>` |
| `layoffs` | `notice:<id>` |
| `news` | `article:<sha1(url)>` — **and set `headline_norm`** (see below) |
| `executives` | `move:<person-slug>:<role>:<date>` |
| `jobs` | `jobs:count`, `jobs:title:<slug>` |
| `domain` | `whois:<field>`, `home:hash`, `home:title` |

Fields the differ reads, so please emit them: `name`/`role` (officers),
`filing_id`, `docket_number`, `id`, `status`, `headline_norm`, `person`, `title`,
`open_roles`, `field`, `value`, `content_hash`, `employees_affected`,
`effective_date`.

**Syndicated news:** one story gets republished by a dozen outlets. Set
`headline_norm` — lowercase, punctuation stripped, whitespace collapsed — and the
differ collapses them into one item. Without it, one event becomes twelve alerts.

---

## 4. Bright Data is the ONLY fetch path

**No bare `fetch()` to a target site, anywhere, for any reason.** Every request
goes through Bright Data. This is an absolute architectural rule.

One endpoint, two zones:

```
POST https://api.brightdata.com/request
Authorization: Bearer $BRIGHTDATA_API_KEY
Content-Type: application/json

{"zone": "<zone>", "url": "<target>", "format": "raw"}
```

- Web Unlocker → `$BRIGHTDATA_UNLOCKER_ZONE`
- SERP → `$BRIGHTDATA_SERP_ZONE` (the `url` is a search-engine query URL)

### Budget discipline — read this twice
There are **300 credits for the entire event.** Therefore:
- **SERP first; only unlock result URLs you have not already seen.**
- Cache every fetch by **URL + UTC day**. A same-day re-run must cost zero.
- Nothing hourly. Nothing speculative. No crawling beyond the one page you need.
- Build and test against **saved HTML fixtures**, not live requests. Fetch live
  only to capture a fixture, then work offline against it. A test suite that hits
  the network will quietly drain the budget.

Make the fetch layer an injected dependency with a replay implementation, so the
whole suite runs offline and deterministically. `deps` in your signature exists
for this.

---

## 5. What done looks like

- Eight collectors, one per source, each independently testable.
- Every one returns a valid envelope for: a healthy page, an empty result, and a
  broken/blocked page. **All three are tests.** The empty and broken cases matter
  as much as the happy path, because they are what produce honest coverage.
- Saved HTML fixtures committed, suite runs with no network and no credentials.
- A short note per source: the URL pattern, the selectors, and anything the portal
  does that a future reader would not expect (rate limits, lag, pagination quirks).
- Zero imports of any database, ORM, or UI library. If you find yourself wanting
  one, the boundary has been crossed.

Start with **`registry` and `news`** — one primary source and one reported source
exercise the two different fetch patterns (direct unlock vs SERP-then-unlock) and
unblock everything downstream. Then do the rest.

---

## 6. One thing you may be blocked on

The Bright Data zones may not exist yet. `GET https://api.brightdata.com/zone/get_active_zones`
returns `[]` and the API key currently lacks permission to create them. If you hit
that, say so rather than working around it — and keep building against fixtures in
the meantime, which is the recommended path regardless.
