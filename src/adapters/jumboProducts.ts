import type { SiteAdapter } from "../core/types.js";
import { scrollUntilStable } from "./supermarket.js";

export const jumboProductsAdapter: SiteAdapter = {
  id: "jumbo.com.products",
  name: "Jumbo product listing",
  match(url: string) {
    try {
      const u = new URL(url);
      return u.hostname.includes("jumbo.com") && u.pathname.startsWith("/producten");
    } catch {
      return false;
    }
  },
  async run(ctx) {
    const { page, insertItems, log, sleep, delayMs } = ctx;
    await sleep(delayMs);
    await page.waitForLoadState("domcontentloaded");
    const accept = page.locator('button:has-text("Accepteren"), button:has-text("Alles accepteren")').first();
    if (await accept.isVisible().catch(() => false)) {
      await accept.click().catch(() => undefined);
      await sleep(500);
    }
    await scrollUntilStable(page, {
      maxRounds: 80,
      pauseMs: 600,
      stableNeeded: 3,
      sleep,
    });

    const products = await page.evaluate(() => {
      type Row = { title: string; href?: string; price?: string };
      const rows: Row[] = [];
      const seen = new Set<string>();

      const tryAdd = (title: string, href?: string | null, price?: string | null) => {
        const t = title.trim();
        if (!t || t.length < 2) return;
        const key = href ?? t;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ title: t, href: href ?? undefined, price: price ?? undefined });
      };

      document.querySelectorAll('[data-testid="product-card"], article[class*="product"], .jum-product-tile').forEach((root) => {
        const link = root.querySelector("a[href*='/producten/']") as HTMLAnchorElement | null;
        const title =
          root.querySelector("h3, .title, [class*='title']")?.textContent?.trim() ??
          link?.getAttribute("aria-label") ??
          "";
        const price = root.querySelector('[class*="price"], [data-testid*="price"]')?.textContent?.trim();
        tryAdd(title, link?.href, price);
      });

      if (rows.length === 0) {
        document.querySelectorAll('a[href*="/producten/jumbo-"]').forEach((a) => {
          const title = a.textContent?.trim() ?? a.getAttribute("aria-label") ?? "";
          tryAdd(title, (a as HTMLAnchorElement).href);
        });
      }

      return rows;
    });

    log(`Jumbo: ${products.length} products`);
    await insertItems(
      products.map((p, i) => ({
        externalId: p.href?.split("/").filter(Boolean).pop(),
        canonicalUrl: p.href,
        payload: { kind: "jumbo_product", index: i + 1, ...p },
      })),
    );
  },
};
