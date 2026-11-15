# Scraper subsystem — maintainer notes

This document captures how the scraper works today so future changes can start from an accurate picture. It complements [README.md](./README.md) (user-facing usage) and [DATABASE.md](./DATABASE.md) (DB portability).

## Purpose

- Input: one or more **seed URLs**.
- The CLI picks a **site adapter** by URL, opens **Playwright (Chromium)**, runs adapter logic (pagination, scroll, CSV fetch, etc.), and writes rows into **SQLite** via **Drizzle ORM** and **`@libsql/client`** (libSQL file driver).
- Every scrape creates a **`scrape_runs`** row; extracted rows live in **`items`**.

## Stack (why these choices)

| Piece   | Choice                      | Notes                                                                                                               |
|---------|-----------------------------|---------------------------------------------------------------------------------------------------------------------|
| Runtime | Node 20+, TypeScript, ESM   | `tsx` runs `src/index.ts` without a separate build.                                                                 |
| Browser | Playwright Chromium         | Needed for SPAs, cookie banners, client-rendered lists.                                                             |
| DB      | SQLite file + libSQL client | Avoids native `better-sqlite3` bindings on very new Node versions; same SQL/Drizzle schema as a normal SQLite file. |
| ORM     | Drizzle                     | Schema in `src/db/schema.ts`; migrations in `drizzle/`.                                                             |
| CLI     | Commander                   | Default action: scrape with `--url`; subcommands `list-adapters`, `match`.                                          |

## Directory layout

```
src/
  index.ts           # CLI entry, loads .env, createDb(), runJob() per URL
  db/
    schema.ts        # sources, scrape_runs, items
    index.ts         # createClient + drizzle + migrate() on startup
  core/
    types.ts         # SiteAdapter, ScrapeContext, ExtractedItem
    router.ts        # adapter registry + matchAdapter()
    runJob.ts        # orchestration: source, run, browser, insertItems
    hash.ts          # stable JSON + SHA-256 → payload_hash
  adapters/
    *.ts             # one module per site / pattern
    supermarket.ts   # shared scroll helper (AH, Jumbo)
    pagination.ts    # small Playwright helpers (e.g. “next” click)
drizzle/             # SQL migrations + meta (applied automatically in createDb)
data/                # default SQLite path (gitignored *.db)
```

## Data model (high level)

- **`sources`**: one row per **adapter id** (e.g. `nl538.house_article`), created or reused each job.
- **`scrape_runs`**: one row per **invocation** (seed URL, timestamps, status, `item_count` = **new rows inserted this run**).
- **`items`**: one row per extracted entity; holds `payload` (JSON), `payload_hash`, optional `external_id` / `canonical_url`, FK to `run_id` and optional `source_id`.

See `src/db/schema.ts` for exact columns and indexes.

## Deduplication / inserts

`runJob` builds `insertItems()` for adapters. Each row gets a **SHA-256** over a **stable JSON serialization** of `payload` (`core/hash.ts`).

Two conflict strategies (see `runJob.ts`):

1. **`source_id` + `external_id` both set**  
   - `INSERT ... ON CONFLICT(source_id, external_id) DO NOTHING`  
   - **Cross-run dedupe**: same logical entity (e.g. `538-house-11`) is not inserted again for that source.  
   - Re-scrapes typically yield **0 new rows**; `scrape_runs.item_count` reflects **new inserts only**.

2. **Missing `external_id` or `source_id`**  
   - `ON CONFLICT(run_id, payload_hash) DO NOTHING`  
   - Dedupes only **within the same run** (same `run_id`). **Re-running the job can still duplicate rows** across runs if the adapter does not set `external_id`.

**Important:** Do **not** add a `where:` clause to Drizzle’s `onConflictDoNothing` for SQLite/libSQL. That generates `ON CONFLICT … WHERE …`, which triggers **`SQLITE_ERROR: near "where"`** on this stack. Use a plain unique index on `(source_id, external_id)` and conflict **target** `[items.sourceId, items.externalId]` only.

**SQLite NULLs:** A unique index on `(source_id, external_id)` still allows **multiple rows with `external_id IS NULL`** (NULL ≠ NULL for uniqueness). Prefer setting `external_id` whenever the source has a stable id.

## Job lifecycle (`runJob`)

1. `matchAdapter(seedUrl)` → throws if none.
2. Get or create **`sources`** row for `adapter.id`.
3. Insert **`scrape_runs`** with `status: running`.
4. Launch Chromium; optional **`STORAGE_STATE_DIR/<adapterId>.json`** for `storageState`.
5. `page.goto(seedUrl)` (domcontentloaded, 120s timeout).
6. `adapter.run(ctx)` with `ScrapeContext` (page, limits, `insertItems`, `log`, `sleep`).
7. If `STORAGE_STATE_DIR` is set, **overwrite** storage state JSON after the run (updates cookies/session snapshot).
8. Close browser; set run `status`, `finishedAt`, `item_count` = **count of inserts that actually returned a row** (via `.returning({ id })`).

## Adapter contract (`SiteAdapter`)

```ts
{
  id: string;           // stable, used for storage state filename and sources.adapter_id
  name: string;
  match(url: string): boolean;  // first match in registry wins
  run(ctx: ScrapeContext): Promise<void>;
}
```

**`ExtractedItem`**: `{ externalId?, canonicalUrl?, payload: Record<string, unknown> }`.

**Router order** (`router.ts`): `imdb` → teatime playlist → teatime charts → 538 → AH → Jumbo. Keep more specific URL patterns before generic ones if you add overlaps.

## Built-in adapters (current behavior)

### `imdb.chart_top` — `imdbChart.ts`

- **Match:** host contains `imdb.com`, path contains `/chart/top`.
- **Strategy:** Wait for list markup; `page.evaluate` with fallbacks (`li.ipc-metadata-list-summary-item`, `tbody.lister-list tr`, etc.).
- **externalId:** IMDb `tt…` from link href when present.
- **Notes:** Often flaky or blocked; increase `--delay-ms`; site DOM changes frequently.

### `teatime.wayback.playlist` — `teatimeWayback.ts`

- **Match:** URL contains `teatime.fm` and `trackliste`.
- **Strategy:** `#playlist` rows with `itemprop="itemListElement"`; paginate via `a.pagenav[title="Weiter"]` until gone or `maxPages`.
- **externalId:** `pos:{position}:{title}` when position meta exists.

### `teatime.wayback.charts` — `teatimeWayback.ts`

- **Match:** URL contains `teatime.fm` and `/charts`.
- **Strategy:** `li.airchart-track-item`; single large page in archived snapshots (no pagination in adapter).
- **externalId:** `chart:{nr}` from `.prev-position .nr` when present.

### `nl538.house_article` — `nl538House.ts`

- **Match:** host `538.nl`, path contains `house-top-1000`.
- **Primary strategy (required for real data):**  
  - Parse **`__NEXT_DATA__`** JSON (Next.js).  
  - Recursively find Contentful node **`nodeType === "top-list"`** → **`data.csvUrl`**.  
  - That URL is usually on **`assets.ctfassets.net`** (Contentful CDN). It is **not** discovered externally; it is **embedded in the page payload**.  
  - **`page.request.get(csvUrl)`** downloads the CSV (semicolon-separated).  
  - **Column mapping:** header row `Vandaag;Vw;Aw;Artiest;Titel;ISRC;…` — **data rows use index 3 as track title and 4 as artist** (header names are swapped vs. typical meaning). Skip rows where title is `?` (hidden top 10 placeholders) → **990 rows** for a “1000 without top 10” file.  
  - **Payload kind:** `nl538_house_csv`; **externalId:** `538-house-{rank}`.
- **Fallbacks:** Walk `__NEXT_DATA__` for Spotify URLs / `spotifyUrl`; then `article a[href*="open.spotify.com/track"]`. Usually **empty** on current House Top articles (no track links in HTML).
- **Notes:** If 538 changes CMS shape, re-check `top-list` / `csvUrl` and CSV column indices.

### `ah.nl.products` — `ahProducts.ts`

- **Match:** `www.ah.nl`, path starts with `/producten`.
- **Strategy:** Try to dismiss cookie banner; **`scrollUntilStable`**; `page.evaluate` for product cards / product links.
- **externalId:** last path segment from product URL when present.
- **Notes:** SPA; selectors drift; may get 0 rows after site updates.

### `jumbo.com.products` — `jumboProducts.ts`

- **Match:** host contains `jumbo.com`, path starts with `/producten`.
- **Strategy:** Similar to AH (cookies + scroll + generic card selectors).
- **Notes:** Same fragility as AH.

## Migrations

- Applied in **`createDb()`** via `migrate()` from `drizzle-orm/libsql/migrator` and `drizzle/meta/_journal.json`.
- Generate new SQL: `npm run db:generate` after editing `schema.ts`.
- **`0001`**-era migration may include dedupe `DELETE` before adding **`items_source_external_uniq`** on `(source_id, external_id)`; **`0002`** in some trees was a no-op drop/recreate of the same index—check `drizzle/` on your branch.

## Environment variables

| Variable            | Role                                                                        |
|---------------------|-----------------------------------------------------------------------------|
| `DATABASE_URL`      | Default `file:./data/scraper.db`                                            |
| `STORAGE_STATE_DIR` | If set, load/save `storageState` as `<adapterId>.json` under this directory |
| `REQUEST_DELAY_MS`  | Default `--delay-ms` when flag omitted                                      |
| `MAX_PAGES`         | Default `--max-pages` when flag omitted                                     |

## CLI recap

```bash
npm run scrape -- --url "https://…" [--headful] [--delay-ms N] [--max-pages N]
npm run scrape -- list-adapters
npm run scrape -- match "https://…"
npm run playwright:install   # Chromium, once per machine
```

## Resetting data

- **Wipe file:** `rm -f data/scraper.db` (migrations re-run on next scrape).
- **Truncate tables:** delete `items` → `scrape_runs` → `sources` (respect FKs), or use `sqlite3` as in README.

## Adding a new adapter

1. Add `src/adapters/yourSite.ts` implementing `SiteAdapter`.
2. Register it in `src/core/router.ts` (mind **order** vs. other `match()` rules).
3. Prefer setting **`externalId`** for stable cross-run dedupe.
4. Use **`ctx.insertItems`** in batches or once at the end.
5. Run against a real URL; if the site is SPA-only, inspect **`__NEXT_DATA__`**, network XHR, or embedded JSON (538 pattern).

## Operational / policy reminders

- Respect site terms, robots, and rate limits; use sensible `--delay-ms` on production sites.
- Wayback URLs are useful for **stable** demos (TeaTime).
- Retail and chart sites change markup often—expect to touch adapters when they ship new frontends.

## Related files

- [README.md](./README.md) — install, examples, example URLs table  
- [DATABASE.md](./DATABASE.md) — moving to Postgres/MySQL, driver notes  
