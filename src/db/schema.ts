import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sources = sqliteTable(
  "sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    adapterId: text("adapter_id").notNull(),
    baseUrlPattern: text("base_url_pattern").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("sources_adapter_idx").on(t.adapterId)],
);

export const scrapeRuns = sqliteTable(
  "scrape_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id").references(() => sources.id),
    seedUrl: text("seed_url").notNull(),
    adapterId: text("adapter_id").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    itemCount: integer("item_count").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("scrape_runs_adapter_idx").on(t.adapterId)],
);

export const items = sqliteTable(
  "items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => scrapeRuns.id),
    sourceId: integer("source_id").references(() => sources.id),
    externalId: text("external_id"),
    canonicalUrl: text("canonical_url"),
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    payloadHash: text("payload_hash").notNull(),
    extractedAt: text("extracted_at").notNull(),
  },
  (t) => [
    index("items_run_idx").on(t.runId),
    index("items_hash_idx").on(t.payloadHash),
    uniqueIndex("items_run_payload_hash_uniq").on(t.runId, t.payloadHash),
    uniqueIndex("items_source_external_uniq").on(t.sourceId, t.externalId),
  ],
);
