/**
 * Playwright verification: login should succeed after Cursor fix.
 */
import { chromium } from "playwright";

const baseUrl = process.env.DEMO_APP_URL ?? "http://127.0.0.1:3000";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.fill("#username", "demo");
    await page.fill("#password", "demo123");
    await page.click("#login-btn");
    await page.waitForURL("**/dashboard", { timeout: 10_000 });
    const welcome = await page.locator("#welcome").textContent();
    if (!welcome?.includes("login succeeded")) {
      throw new Error(`Unexpected dashboard content: ${welcome}`);
    }
    console.log("PLAYWRIGHT_LOGIN_PASS");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("PLAYWRIGHT_LOGIN_FAIL", err instanceof Error ? err.message : err);
  process.exit(1);
});
