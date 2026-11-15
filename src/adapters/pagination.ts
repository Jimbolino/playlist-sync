import type { Page } from "playwright";

export async function clickIfVisible(page: Page, selector: string): Promise<boolean> {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return false;
  if (!(await loc.isVisible().catch(() => false))) return false;
  await loc.click();
  return true;
}
