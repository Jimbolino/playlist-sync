import type { Page } from "playwright";

export async function scrollUntilStable(
  page: Page,
  opts: { maxRounds: number; pauseMs: number; stableNeeded: number; sleep: (ms: number) => Promise<void> },
) {
  let lastHeight = 0;
  let stable = 0;
  for (let i = 0; i < opts.maxRounds; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await opts.sleep(opts.pauseMs);
    const next = await page.evaluate(() => document.body.scrollHeight);
    if (next <= lastHeight && next === height) {
      stable += 1;
      if (stable >= opts.stableNeeded) break;
    } else {
      stable = 0;
    }
    lastHeight = next;
  }
}
