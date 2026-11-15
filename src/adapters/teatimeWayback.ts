import type { SiteAdapter } from "../core/types.js";
import { clickIfVisible } from "./pagination.js";

async function extractPlaylistPage(ctx: Parameters<SiteAdapter["run"]>[0]) {
  const { page } = ctx;
  return page.$$eval("#playlist [itemprop='itemListElement']", (nodes) =>
    nodes.map((el) => {
      const title =
        el.querySelector("h2.title[itemprop='name']")?.textContent?.trim() ?? "";
      const date = el.querySelector(".date-box .date")?.textContent?.trim() ?? "";
      const time = el.querySelector(".date-box .time")?.textContent?.trim() ?? "";
      const position = el.querySelector('meta[itemprop="position"]')?.getAttribute("content") ?? "";
      const genre = el.querySelector('meta[itemprop="genre"]')?.getAttribute("content") ?? "";
      return { title, date, time, position, genre };
    }),
  );
}

export const teatimePlaylistAdapter: SiteAdapter = {
  id: "teatime.wayback.playlist",
  name: "TeaTime.FM trackliste (Wayback or live)",
  match(url: string) {
    const u = url.toLowerCase();
    return u.includes("teatime.fm") && u.includes("trackliste");
  },
  async run(ctx) {
    const { page, insertItems, delayMs, maxPages, log, sleep } = ctx;
    await page.waitForSelector("#playlist", { timeout: 60_000 });
    let pageNum = 0;
    while (pageNum < maxPages) {
      pageNum += 1;
      const rows = await extractPlaylistPage(ctx);
      log(`page ${pageNum}: ${rows.length} tracks`);
      await insertItems(
        rows
          .filter((r) => r.title)
          .map((r) => ({
            externalId: r.position ? `pos:${r.position}:${r.title}` : undefined,
            payload: { kind: "teatime_playlist", ...r },
          })),
      );
      const nextClicked = await clickIfVisible(page, 'a.pagenav[title="Weiter"]');
      if (!nextClicked) break;
      await sleep(delayMs);
      await page.waitForLoadState("domcontentloaded");
    }
  },
};

async function extractChartsPage(ctx: Parameters<SiteAdapter["run"]>[0]) {
  const { page } = ctx;
  return page.$$eval("li.airchart-track-item", (nodes) =>
    nodes
      .map((el) => {
        const nr = el.querySelector(".prev-position .nr")?.textContent?.trim() ?? "";
        const title =
          el.querySelector('.box-title span[itemprop="name"]')?.textContent?.trim() ?? "";
        const artist =
          el.querySelector('.box-title span[itemprop="byArtist"]')?.textContent?.trim() ?? "";
        const published =
          el.querySelector('[itemprop="datePublished"]')?.textContent?.trim() ?? "";
        const label = el.querySelector(".label-box")?.textContent?.trim() ?? "";
        const genre = el.querySelector(".genre")?.textContent?.trim() ?? "";
        const releaseHref = el.querySelector("figure.image a")?.getAttribute("href") ?? "";
        return { chartPosition: nr, title, artist, published, label, genre, releaseHref };
      })
      .filter((r) => r.title || r.artist),
  );
}

export const teatimeChartsAdapter: SiteAdapter = {
  id: "teatime.wayback.charts",
  name: "TeaTime.FM charts (Wayback or live)",
  match(url: string) {
    const u = url.toLowerCase();
    return u.includes("teatime.fm") && u.includes("/charts");
  },
  async run(ctx) {
    const { page, insertItems, log } = ctx;
    await page.waitForSelector("li.airchart-track-item", { timeout: 120_000 });
    const rows = await extractChartsPage(ctx);
    log(`charts: ${rows.length} entries`);
    await insertItems(
      rows.map((r) => ({
        externalId: r.chartPosition ? `chart:${r.chartPosition}` : undefined,
        canonicalUrl: r.releaseHref || undefined,
        payload: { kind: "teatime_charts", ...r },
      })),
    );
  },
};
