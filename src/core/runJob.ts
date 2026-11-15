import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { chromium, type Browser } from "playwright";
import { items, scrapeRuns, sources } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { payloadHash } from "./hash.js";
import { matchAdapter } from "./router.js";
import type { ExtractedItem, ScrapeContext } from "./types.js";

export type RunJobOptions = {
  db: Db;
  seedUrl: string;
  delayMs: number;
  maxPages: number;
  storageStateDir?: string;
  headless?: boolean;
};

function storageStatePath(adapterId: string, dir?: string): string | undefined {
  if (!dir) return undefined;
  const p = path.join(dir, `${adapterId}.json`);
  return existsSync(p) ? p : undefined;
}

export async function saveStorageState(adapterId: string, dir: string | undefined, state: string) {
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${adapterId}.json`), state, "utf8");
}

export async function runJob(opts: RunJobOptions): Promise<number> {
  const { db, seedUrl, delayMs, maxPages, storageStateDir, headless = true } = opts;
  const adapter = matchAdapter(seedUrl);
  if (!adapter) {
    throw new Error(`No adapter registered for URL: ${seedUrl}`);
  }

  const now = new Date().toISOString();
  const basePattern = new URL(seedUrl).origin + new URL(seedUrl).pathname;
  const existingSource = await db
    .select()
    .from(sources)
    .where(eq(sources.adapterId, adapter.id))
    .limit(1);
  let sourceId = existingSource[0]?.id;
  if (sourceId === undefined) {
    const [row] = await db
      .insert(sources)
      .values({
        name: adapter.name,
        adapterId: adapter.id,
        baseUrlPattern: basePattern,
        createdAt: now,
      })
      .returning();
    sourceId = row?.id;
  }

  const [run] = await db
    .insert(scrapeRuns)
    .values({
      sourceId: sourceId ?? null,
      seedUrl,
      adapterId: adapter.id,
      status: "running",
      startedAt: now,
      itemCount: 0,
    })
    .returning();

  if (!run) {
    throw new Error("Failed to create scrape run");
  }

  const runId = run.id;
  let browser: Browser | undefined;
  let itemCount = 0;
  let newRowsThisRun = 0;

  const insertItems = async (batch: ExtractedItem[]) => {
    if (batch.length === 0) return;
    const rows = batch.map((item) => ({
      runId,
      sourceId: sourceId ?? null,
      externalId: item.externalId ?? null,
      canonicalUrl: item.canonicalUrl ?? null,
      payload: item.payload,
      payloadHash: payloadHash(item.payload),
      extractedAt: new Date().toISOString(),
    }));
    for (const row of rows) {
      let inserted: { id: number }[] = [];
      if (row.externalId != null && row.sourceId != null) {
        inserted = await db
          .insert(items)
          .values(row)
          .onConflictDoNothing({
            target: [items.sourceId, items.externalId],
          })
          .returning({ id: items.id });
      } else {
        inserted = await db
          .insert(items)
          .values(row)
          .onConflictDoNothing({
            target: [items.runId, items.payloadHash],
          })
          .returning({ id: items.id });
      }
      if (inserted.length > 0) newRowsThisRun += 1;
    }
  };

  const log = (msg: string) => {
    console.error(`[${adapter.id}] ${msg}`);
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  try {
    browser = await chromium.launch({ headless });
    const statePath = storageStatePath(adapter.id, storageStateDir);
    const context = await browser.newContext(
      statePath
        ? { storageState: statePath }
        : {
            userAgent:
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
    );
    const page = await context.newPage();
    await page.goto(seedUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

    const ctx: ScrapeContext = {
      page,
      seedUrl,
      adapterId: adapter.id,
      delayMs,
      maxPages,
      log,
      sleep,
      insertItems,
    };

    await adapter.run(ctx);

    if (storageStateDir) {
      const state = await context.storageState();
      await saveStorageState(adapter.id, storageStateDir, JSON.stringify(state, null, 2));
    }

    await context.close();
    await browser.close();
    browser = undefined;

    itemCount = newRowsThisRun;

    await db
      .update(scrapeRuns)
      .set({
        status: "ok",
        finishedAt: new Date().toISOString(),
        itemCount,
      })
      .where(eq(scrapeRuns.id, runId));

    return itemCount;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await db
      .update(scrapeRuns)
      .set({
        status: "error",
        finishedAt: new Date().toISOString(),
        itemCount,
        error: message,
      })
      .where(eq(scrapeRuns.id, runId));
    throw e;
  }
}
