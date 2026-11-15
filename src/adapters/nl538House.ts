import type { SiteAdapter } from "../core/types.js";

type CsvRow = { rank: string; song: string; artist: string; isrc: string };

function findTopListCsvUrl(data: unknown): string | undefined {
  let found: string | undefined;
  const visit = (node: unknown) => {
    if (found !== undefined) return;
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const o = node as Record<string, unknown>;
    if (o.nodeType === "top-list" && o.data && typeof o.data === "object") {
      const d = o.data as Record<string, unknown>;
      if (typeof d.csvUrl === "string" && d.csvUrl.length > 0) {
        found = d.csvUrl;
        return;
      }
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(data);
  return found;
}

/** Semicolon CSV: Vandaag;Vw;Aw;Artiest;Titel;ISRC;no-preview — data uses col 3 as track title, 4 as artist. */
function parse538HouseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const out: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    const rank = (parts[0] ?? "").trim();
    const song = (parts[3] ?? "").trim();
    const artist = (parts[4] ?? "").trim();
    const isrc = (parts[5] ?? "").trim();
    if (!rank || !song || song === "?") continue;
    out.push({ rank, song, artist, isrc });
  }
  return out;
}

function collectFromNextData(data: unknown): { title?: string; url?: string; rank?: string }[] {
  const out: { title?: string; url?: string; rank?: string }[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (node.includes("open.spotify.com/track")) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push({ url: node });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o.spotifyUrl === "string" && o.spotifyUrl.includes("open.spotify.com")) {
        if (!seen.has(o.spotifyUrl)) {
          seen.add(o.spotifyUrl);
          out.push({
            title: typeof o.title === "string" ? o.title : undefined,
            url: o.spotifyUrl,
            rank: typeof o.rank === "string" ? o.rank : typeof o.position === "string" ? o.position : undefined,
          });
        }
      }
      for (const v of Object.values(o)) visit(v);
    }
  };

  visit(data);
  return out;
}

export const nl538HouseAdapter: SiteAdapter = {
  id: "nl538.house_article",
  name: "Radio 538 House Top article",
  match(url: string) {
    try {
      const u = new URL(url);
      return u.hostname.includes("538.nl") && u.pathname.includes("house-top-1000");
    } catch {
      return false;
    }
  },
  async run(ctx) {
    const { page, insertItems, log, sleep, delayMs } = ctx;
    await sleep(delayMs);
    await page.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => undefined);

    const nextData = await page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el?.textContent) return null;
      try {
        return JSON.parse(el.textContent) as unknown;
      } catch {
        return null;
      }
    });

    const csvUrl = nextData ? findTopListCsvUrl(nextData) : undefined;
    if (csvUrl) {
      const resp = await page.request.get(csvUrl);
      if (!resp.ok()) {
        log(`CSV fetch failed ${resp.status()}: ${csvUrl}`);
      } else {
        const text = await resp.text();
        const rows = parse538HouseCsv(text);
        log(`538: ${rows.length} rows from top-list CSV`);
        await insertItems(
          rows.map((r) => ({
            externalId: `538-house-${r.rank}`,
            payload: {
              kind: "nl538_house_csv",
              rank: r.rank,
              song: r.song,
              artist: r.artist,
              isrc: r.isrc || undefined,
              csvUrl,
            },
          })),
        );
        return;
      }
    }

    let tracks: { title?: string; url?: string; rank?: string }[] = [];
    if (nextData) {
      try {
        tracks = collectFromNextData(nextData);
      } catch {
        tracks = [];
      }
    }

    if (tracks.length === 0) {
      tracks = await page.$$eval('article a[href*="open.spotify.com/track"]', (anchors) => {
        const list: { title?: string; url?: string }[] = [];
        const seen = new Set<string>();
        anchors.forEach((a) => {
          const href = a.getAttribute("href");
          if (!href || seen.has(href)) return;
          seen.add(href);
          list.push({ title: a.textContent?.trim(), url: href });
        });
        return list;
      });
    }

    log(`538: ${tracks.length} spotify/track rows`);
    await insertItems(
      tracks.map((t, i) => ({
        externalId: t.url?.split("/").pop(),
        canonicalUrl: t.url,
        payload: { kind: "nl538_house", index: i + 1, title: t.title, rank: t.rank, spotifyUrl: t.url },
      })),
    );
  },
};
