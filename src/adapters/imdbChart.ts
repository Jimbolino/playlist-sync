import type { SiteAdapter } from "../core/types.js";

export const imdbChartAdapter: SiteAdapter = {
  id: "imdb.chart_top",
  name: "IMDb chart top",
  match(url: string) {
    try {
      const u = new URL(url);
      return u.hostname.includes("imdb.com") && u.pathname.includes("/chart/top");
    } catch {
      return false;
    }
  },
  async run(ctx) {
    const { page, insertItems, log, sleep, delayMs } = ctx;
    await sleep(delayMs);
    await page.waitForSelector("ul.ipc-metadata-list, tbody.lister-list, [data-testid='chart-page-horizontal-list']", {
      timeout: 120_000,
    });

    const extracted = await page.evaluate(() => {
      const out: {
        rank?: string;
        title?: string;
        year?: string;
        rating?: string;
        href?: string;
      }[] = [];

      const ipcItems = document.querySelectorAll("li.ipc-metadata-list-summary-item");
      if (ipcItems.length) {
        ipcItems.forEach((li) => {
          const link = li.querySelector("a.ipc-title-link-wrapper, a[href*='/title/tt']");
          const href = link?.getAttribute("href") ?? "";
          const title =
            link?.querySelector("h3, .ipc-title__text")?.textContent?.trim() ??
            link?.textContent?.trim() ??
            "";
          const rank =
            li.querySelector('[data-testid="hero-title-block-text"]')?.textContent?.trim() ??
            title.match(/^(\d+)\./)?.[1];
          const meta = li.textContent ?? "";
          const year = meta.match(/\((\d{4})\)/)?.[1];
          const rating = li.querySelector('[data-testid="ratingGroup--imdb-rating"] span')?.textContent?.trim();
          if (title) out.push({ rank, title, year, rating, href });
        });
        return out;
      }

      const rows = document.querySelectorAll("tbody.lister-list tr");
      rows.forEach((tr) => {
        const titleCell = tr.querySelector("td.titleColumn");
        const link = titleCell?.querySelector("a");
        const href = link?.getAttribute("href") ?? "";
        const title = link?.textContent?.trim() ?? "";
        const rank = titleCell?.textContent?.trim().match(/^(\d+)\./)?.[1];
        const year = titleCell?.querySelector(".secondaryInfo")?.textContent?.replace(/[^\d]/g, "");
        const rating = tr.querySelector("td.ratingColumn strong")?.textContent?.trim();
        if (title) out.push({ rank, title, year, rating, href });
      });

      return out;
    });

    log(`IMDb: ${extracted.length} titles`);
    await insertItems(
      extracted.map((row) => {
        const idMatch = row.href?.match(/\/title\/(tt\d+)/);
        return {
          externalId: idMatch?.[1],
          canonicalUrl: row.href ? new URL(row.href, "https://www.imdb.com").toString() : undefined,
          payload: { kind: "imdb_chart_top", ...row },
        };
      }),
    );
  },
};
