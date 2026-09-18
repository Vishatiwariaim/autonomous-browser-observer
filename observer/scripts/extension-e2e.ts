/**
 * Real extension E2E: load MV3 extension in Chromium, drive the demo page,
 * verify Observer API counters contain live observation data.
 */
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createApp } from "../src/server/app.js";
import { EventStore } from "../src/server/storage.js";
import { ObserverRealtime } from "../src/server/realtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "../../extension/dist");
const dataDir = path.resolve(__dirname, "../data/extension-e2e");

type Check = { name: string; ok: boolean; detail: string };

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function getExtensionId(context: BrowserContext): Promise<string> {
  // Wait for service worker
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  }
  const url = sw.url(); // chrome-extension://<id>/background.js
  const match = url.match(/chrome-extension:\/\/([^/]+)\//);
  if (!match) throw new Error(`Could not parse extension id from ${url}`);
  return match[1]!;
}

async function main(): Promise<void> {
  console.log("[e2e] starting extension observation test…");
  // Ensure extension is built
  try {
    await fs.access(path.join(extensionPath, "manifest.json"));
  } catch {
    throw new Error("extension-dist missing — run npm run build first");
  }

  console.log(`[e2e] extension path: ${extensionPath}`);
  console.log(`[e2e] data dir: ${dataDir}`);

  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });

  const store = new EventStore(dataDir);
  await store.init();
  const realtime = new ObserverRealtime();
  const app = createApp({ store, realtime });
  const server: Server = createServer(app);
  realtime.attach(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(3847, "127.0.0.1", () => resolve());
  });
  console.log("[e2e] observer listening on http://127.0.0.1:3847");

  const baseUrl = "http://127.0.0.1:3847";
  const userDataDir = path.join(dataDir, "chrome-profile");
  await fs.mkdir(userDataDir, { recursive: true });

  let context: BrowserContext | undefined;
  const checks: Check[] = [];

  try {
    // Extensions require a persistent context; headed is most reliable on Windows
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      viewport: { width: 1280, height: 800 },
    });

    const extensionId = await getExtensionId(context);
    console.log(`[e2e] extension id: ${extensionId}`);

    // Open extension-test + demo pages
    const page = await context.newPage();

    await page.goto(`${baseUrl}/extension-test`, { waitUntil: "domcontentloaded" });
    await wait(1500);
    await page.click("#btn");
    await wait(300);
    await page.fill("#email", "user@example.com");
    await page.click("#password");
    await page.fill("#password", "SuperSecret123!");
    await wait(300);
    await page.click("#consoleErr");
    await wait(400);
    await page.click("#netFail");
    await wait(600);
    await page.click("#mutate");
    await wait(1800);

    await page.goto(`${baseUrl}/demo`, { waitUntil: "domcontentloaded" });
    await wait(1500);
    await page.click("#btn-click");
    await wait(300);
    await page.click("#btn-secondary");
    await wait(300);
    await page.click("#btn-console");
    await wait(400);
    await page.click("#btn-network");
    await wait(600);
    await page.click("#link-page-b");
    await page.waitForURL("**/demo/page-b");
    await wait(1500);
    await page.click("#btn-page-b-click");
    await wait(400);
    await page.goto(`${baseUrl}/demo`, { waitUntil: "domcontentloaded" });
    await wait(1500);

    // Manual screenshot via new popup
    const extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await wait(800);
    await page.bringToFront();
    await wait(300);
    await extPage.bringToFront();
    try {
      await extPage.click("#btnPing");
      await wait(500);
      await page.bringToFront();
      await wait(200);
      await extPage.bringToFront();
      await extPage.click("#btnShot");
      await wait(1500);
    } catch (err) {
      console.warn("[e2e] popup action issue:", err);
    }

    await wait(2500);

    // 6) Verify dashboard API
    const status = (await fetch(`${baseUrl}/api/status`).then((r) => r.json())) as {
      totalEvents: number;
      sessions: number;
      byType: Record<string, number>;
      extension?: { connected?: boolean; liveCount?: number };
    };
    const extStatus = (await fetch(`${baseUrl}/api/extension/status`).then((r) =>
      r.json(),
    )) as { connected: boolean; liveCount: number };
    const eventsBody = (await fetch(`${baseUrl}/api/events?limit=100`).then((r) =>
      r.json(),
    )) as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    const events = eventsBody.events;
    const types = new Set(events.map((e) => e.type));

    console.log("\n=== Extension E2E Status ===");
    console.log(JSON.stringify(status, null, 2));
    console.log(`Extension status: ${JSON.stringify(extStatus)}`);
    console.log(`Recent event types: ${[...types].join(", ")}`);

    const requireType = (name: string, min = 1) => {
      const count = events.filter((e) => e.type === name).length;
      checks.push({
        name,
        ok: count >= min,
        detail: `count=${count} (need >= ${min})`,
      });
    };

    checks.push({
      name: "total_events_gt_0",
      ok: status.totalEvents > 0,
      detail: `totalEvents=${status.totalEvents}`,
    });
    checks.push({
      name: "sessions_gt_0",
      ok: status.sessions > 0,
      detail: `sessions=${status.sessions}`,
    });
    checks.push({
      name: "extension_connected",
      ok: extStatus.connected === true || status.extension?.connected === true,
      detail: `connected=${extStatus.connected} live=${extStatus.liveCount}`,
    });

    requireType("page_snapshot");
    requireType("user_click", 2);
    requireType("console_error");
    requireType("network_failure");
    requireType("screenshot");
    requireType("dom_mutation");

    const snap = events.find((e) => e.type === "page_snapshot");
    const snapOk =
      !!snap &&
      typeof snap.payload.url === "string" &&
      typeof snap.payload.title === "string" &&
      typeof snap.payload.visibleText === "string" &&
      typeof snap.payload.domSummary === "object";
    checks.push({
      name: "snapshot_fields",
      ok: snapOk,
      detail: snapOk
        ? `title=${String(snap?.payload.title)}`
        : "missing snapshot fields",
    });

    const shot = events.find((e) => e.type === "screenshot");
    checks.push({
      name: "screenshot_stored",
      ok: !!shot && (typeof shot.payload.path === "string" || typeof shot.payload.dataBase64 === "string"),
      detail: shot ? JSON.stringify(Object.keys(shot.payload)) : "missing",
    });

    const leaked = events.some((e) => JSON.stringify(e.payload).includes("SuperSecret123"));
    checks.push({
      name: "password_redacted",
      ok: !leaked,
      detail: leaked ? "password found in payload" : "no raw password in events",
    });

    // Dashboard HTML should show extension section
    const dash = await context.newPage();
    await dash.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await wait(1000);
    const eventsText = await dash.locator("#stats").innerText();
    const extText = await dash.locator("#extension").innerText();
    checks.push({
      name: "dashboard_shows_data",
      ok: /Events/i.test(eventsText) && status.totalEvents > 0,
      detail: eventsText.replace(/\s+/g, " ").slice(0, 200),
    });
    checks.push({
      name: "dashboard_extension_section",
      ok: /Connected|heartbeat|extension/i.test(extText),
      detail: extText.replace(/\s+/g, " ").slice(0, 200),
    });

    // SQLite file exists
    const dbStat = await fs.stat(path.join(dataDir, "observer.sqlite"));
    checks.push({
      name: "sqlite_file",
      ok: dbStat.size > 0,
      detail: `observer.sqlite ${dbStat.size} bytes`,
    });

    console.log("\n=== Extension E2E Results ===");
    for (const c of checks) {
      console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
    }

    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
      console.error(`\n${failed.length} check(s) failed`);
      // Dump sample events for debugging
      console.error(
        "Sample events:",
        JSON.stringify(events.slice(0, 15), null, 2),
      );
      process.exitCode = 1;
    } else {
      console.log("\nAll extension observation checks passed.");
      console.log(`Dashboard: ${baseUrl}`);
      console.log(`Demo:      ${baseUrl}/demo`);
      console.log(`Extension: ${baseUrl}/extension-test`);
    }
  } finally {
    try {
      await context?.close();
    } catch {
      /* ignore */
    }
    await wait(500);
    realtime.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    store.close();
  }
}

// silence unused Page import warning via type-only already
void (null as unknown as Page);

main().catch((err) => {
  console.error("[e2e] failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
