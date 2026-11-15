# playlist-sync

TypeScript CLI that opens listing pages in **Playwright** (Chromium), walks pagination or infinite scroll where needed, and stores rows in **SQLite** via **Drizzle** and **libSQL**. Each site is handled by a small adapter matched from the URL.

## Requirements

- **Node.js 20+**
- Chromium for Playwright (install once after `npm install`)

## Setup

```bash
npm install
npm run playwright:install
cp .env.example .env
```

Optional: edit `.env` (see [Environment](#environment)).

## Usage

### Scrape one or more URLs

```bash
npm run scrape -- --url "https://example.com/listing"
```

Several URLs in one run:

```bash
npm run scrape -- --url "https://site-a.example/page" "https://site-b.example/page"
```

### Useful flags

| Flag              | Description                                                            |
|-------------------|------------------------------------------------------------------------|
| `--url <urls...>` | One or more seed URLs (required for the default scrape action).        |
| `--headful`       | Show the browser window (debugging).                                   |
| `--delay-ms <n>`  | Pause between pagination steps (default: `REQUEST_DELAY_MS` or `800`). |
| `--max-pages <n>` | Cap pages per job (default: `MAX_PAGES` or `500`).                     |

### Other commands

List registered adapters:

```bash
npm run scrape -- list-adapters
```

See which adapter would handle a URL:

```bash
npm run scrape -- match "https://www.ah.nl/producten"
```

## Example URLs

These match the built-in adapters (paths and hostnames must align with what each adapter expects).

| Site                                       | Example URL                                                                                                         |
|--------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| IMDb Top chart                             | `https://www.imdb.com/chart/top/`                                                                                   |
| Radio 538 — House Top 1000 article         | `https://www.538.nl/muziek/hitlijsten/artikelen/extra-lang-weekend-extra-lang-feesten-met-de-house-top-1000-op-538` |
| TeaTime.FM — trackliste (Wayback snapshot) | `https://web.archive.org/web/20251130024527/https://www.teatime.fm/trackliste`                                      |
| TeaTime.FM — charts (Wayback snapshot)     | `https://web.archive.org/web/20251130045002/https://www.teatime.fm/charts`                                          |
| Albert Heijn — products                    | `https://www.ah.nl/producten`                                                                                       |
| Jumbo — products                           | `https://www.jumbo.com/producten/`                                                                                  |

Live TeaTime pages under `https://www.teatime.fm/...` use the same adapters if the DOM still matches; Wayback URLs are stable for demos and tests.

The **538 House Top 1000** article does not expose Spotify track links in the HTML; the list is embedded as a Contentful **top-list** whose `csvUrl` points at a semicolon-separated file on `ctfassets.net`. The adapter downloads that CSV and stores one item per row (ranks 1–10 are placeholders in the feed and are skipped).

### Example commands

```bash
# TeaTime playlist (Wayback), first 3 pages only
npm run scrape -- --url "https://web.archive.org/web/20251130024527/https://www.teatime.fm/trackliste" --max-pages 3

# TeaTime charts (Wayback)
npm run scrape -- --url "https://web.archive.org/web/20251130045002/https://www.teatime.fm/charts"

# IMDb (may be flaky or blocked; use polite delays)
npm run scrape -- --url "https://www.imdb.com/chart/top/" --delay-ms 2000
```

## Environment

Defined in `.env` (see `.env.example`):

| Variable            | Purpose                                                                                           |
|---------------------|---------------------------------------------------------------------------------------------------|
| `DATABASE_URL`      | SQLite file, e.g. `file:./data/scraper.db`                                                        |
| `STORAGE_STATE_DIR` | If set, load/save Playwright storage state per adapter as `<adapterId>.json` (cookies / sessions) |
| `REQUEST_DELAY_MS`  | Default delay between pages when `--delay-ms` is omitted                                          |
| `MAX_PAGES`         | Default page cap when `--max-pages` is omitted                                                    |

## Data and migrations

- SQLite file path comes from `DATABASE_URL`.
- SQL migrations live in `drizzle/` and are applied when the app starts.
- For Postgres/MySQL later, see [DATABASE.md](./DATABASE.md).

## Notes

- Respect each site’s terms, robots policy, and rate limits. Use reasonable `--delay-ms` values on production sites.
- Supermarket and IMDb markup changes often; if a run returns few or no rows, update the matching file under `src/adapters/`.
