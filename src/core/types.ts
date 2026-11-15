import type { Page } from "playwright";

export type ExtractedItem = {
  externalId?: string;
  canonicalUrl?: string;
  payload: Record<string, unknown>;
};

export type InsertItemFn = (items: ExtractedItem[]) => Promise<void>;

export type ScrapeContext = {
  page: Page;
  seedUrl: string;
  adapterId: string;
  delayMs: number;
  maxPages: number;
  log: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  insertItems: InsertItemFn;
};

export type SiteAdapter = {
  id: string;
  name: string;
  match(url: string): boolean;
  run(ctx: ScrapeContext): Promise<void>;
};
