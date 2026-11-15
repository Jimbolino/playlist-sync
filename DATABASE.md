# Database setup and portability

## Current stack

- **SQLite** via [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts) and **Drizzle ORM**.
- The app applies SQL migrations from the `drizzle/` folder on startup (`createDb()`), so you do not need to run `db:migrate` manually for normal use.

## Environment

- `DATABASE_URL` — default `file:./data/scraper.db`. For libSQL file databases use a `file:` URL (relative paths are resolved from the process working directory).

## Moving to PostgreSQL or MySQL

1. Keep `src/db/schema.ts` as the source of truth; add a second Drizzle config (or change `dialect`) targeting `postgresql` or `mysql`.
2. Replace `drizzle-orm/libsql` with `drizzle-orm/node-postgres` / `drizzle-orm/mysql2` in `src/db/index.ts`, and swap `createClient` for a `pg.Pool` or `mysql2` connection.
3. Run `drizzle-kit generate` against the new dialect and adjust types if needed:
   - Prefer `text` + ISO timestamps and JSON columns that map cleanly (Postgres `jsonb`, MySQL `json`).
4. Re-export the same table shapes (`sources`, `scrape_runs`, `items`) so adapters and `runJob` stay unchanged.

## Why `@libsql/client` instead of `better-sqlite3`

`better-sqlite3` ships native bindings per Node ABI; on very new Node versions a prebuild may be missing until the package catches up. `@libsql/client` talks to a SQLite file without that coupling. The schema and migrations stay standard SQLite.

## Optional: switch to `better-sqlite3`

On **Node 20 LTS**, `better-sqlite3` usually installs cleanly. You can swap the driver to `drizzle-orm/better-sqlite3` and keep the same schema and `drizzle/` migrations.
