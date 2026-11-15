import type { SiteAdapter } from "../core/types.js";
import { scrollUntilStable } from "./supermarket.js";

export const ahProductsAdapter: SiteAdapter = {
  id: "ah.nl.products",
  name: "Albert Heijn product listing",
  match(url: string) {
    try {
      const u = new URL(url);
      return u.hostname === "www.ah.nl" && u.pathname.startsWith("/producten");
    } catch {
      return false;
    }
  },
  async run(ctx) {
    const { page, insertItems, log, sleep, delayMs } = ctx;
    await sleep(delayMs);
    await page.waitForLoadState("domcontentloaded");
    const accept = page.getByRole("button", { name: /accept|akkoord|alles accepteren/i }).first();
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

      document.querySelectorAll('article[data-testhook*="product-card"], article[class*="product-card"]').forEach((art) => {
        const link = art.querySelector("a[href*='/productwi/'], a[href*='/producten/product/']") as HTMLAnchorElement | null;
        const title =
          art.querySelector("h3, [data-testhook='product-card-title'], .title")?.textContent?.trim() ?? link?.title ?? "";
        const price = art.querySelector('[class*="price"], [data-testhook*="price"]')?.textContent?.trim();
        tryAdd(title, link?.href, price);
      });

      if (rows.length === 0) {
        document.querySelectorAll("a[href*='/productwi/']").forEach((a) => {
          const title = a.textContent?.trim() ?? a.getAttribute("aria-label") ?? "";
          tryAdd(title, (a as HTMLAnchorElement).href);
        });
      }

      return rows;
    });

    log(`AH: ${products.length} products`);
    await insertItems(
      products.map((p, i) => ({
        externalId: p.href?.split("/").filter(Boolean).pop(),
        canonicalUrl: p.href,
        payload: { kind: "ah_product", index: i + 1, ...p },
      })),
    );
  },
};
