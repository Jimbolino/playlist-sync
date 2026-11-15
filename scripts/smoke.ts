// CI smoke test: apply the migrations to a fresh database and store one track
// through Drizzle, so python/smoke_test.py can read it back.
// Usage: npx tsx scripts/smoke.ts data/smoke.db
import { rm } from "node:fs/promises";
import { listAdapters } from "../src/core/router.js";
import { createDb } from "../src/db/index.js";
import { items, scrapeRuns, sources } from "../src/db/schema.js";

const file = process.argv[2] ?? "data/smoke.db";
await rm(file, { force: true });

const db = await createDb(`file:${file}`);
const now = new Date().toISOString();
const adapterId = "nl538.house_article";

const [source] = await db
  .insert(sources)
  .values({ name: "smoke", adapterId, baseUrlPattern: "https://www.538.nl/", createdAt: now })
  .returning();
const [run] = await db
  .insert(scrapeRuns)
  .values({
    sourceId: source.id,
    seedUrl: "https://www.538.nl/",
    adapterId,
    status: "ok",
    startedAt: now,
    finishedAt: now,
    itemCount: 1,
  })
  .returning();
await db.insert(items).values({
  runId: run.id,
  sourceId: source.id,
  externalId: "smoke-1",
  payload: { kind: "nl538_house_csv", rank: 1, song: "Walking With Elephants", artist: "Ten Walls" },
  payloadHash: "smoke-1",
  extractedAt: now,
});

console.log(`node smoke ok: ${listAdapters().length} adapters, 1 track stored in ${file}`);
