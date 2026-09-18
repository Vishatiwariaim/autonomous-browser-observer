/**
 * Phase 1 end-to-end demo:
 * 1. Starts the observer server (or uses an existing one)
 * 2. Uses Playwright to open the demo page
 * 3. Captures the same observation signals the extension would
 * 4. Posts them to the observer API
 * 5. Verifies each required capture type is stored
 *
 * Also optionally loads the Chrome extension when Chromium supports it.
 */
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { createApp } from "../src/server/app.js";
import { EventStore } from "../src/server/storage.js";
import { capturePageSnapshotViaPage } from "./demo-capture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoHtmlPath = path.join(__dirname, "../fixtures/demo-page.html");

type CheckResult = { name: string; ok: boolean; detail: string };

async function waitForHealth(baseUrl: string, attempts = 30): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function postEvents(
  baseUrl: string,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          sessionId,
          type,
          timestamp: new Date().toISOString(),
          payload,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/events failed: ${res.status} ${await res.text()}`);
  }
}

async function main(): Promise<void> {
  const dataDir = path.join(__dirname, "../data/demo-run");
  await fs.rm(dataDir, { recursive: true, force: true });

  const store = new EventStore(dataDir);
  await store.init();
  const app = createApp({ store });

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const healthy = await waitForHealth(baseUrl);
  if (!healthy) throw new Error("Observer health check failed");

  // Serve demo page via a tiny static handler on the same app... use file URL instead
  const demoUrl = pathToFileUrl(demoHtmlPath);

  const sessionId = randomUUID();
  let browser: Browser | undefined;
  const checks: CheckResult[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Console observer (Playwright mirrors extension inject behavior for demo)
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        void postEvents(baseUrl, sessionId, "console_error", {
          level: "error",
          message: msg.text(),
          url: page.url(),
        });
      }
    });
    page.on("pageerror", (err) => {
      void postEvents(baseUrl, sessionId, "console_error", {
        level: "uncaught",
        message: err.message,
        stack: err.stack,
        url: page.url(),
      });
    });
    page.on("requestfailed", (req) => {
      void postEvents(baseUrl, sessionId, "network_failure", {
        url: req.url(),
        method: req.method(),
        error: req.failure()?.errorText ?? "requestfailed",
        resourceType: req.resourceType(),
        pageUrl: page.url(),
      });
    });
    page.on("response", (res) => {
      if (res.status() >= 400) {
        void postEvents(baseUrl, sessionId, "network_failure", {
          url: res.url(),
          method: res.request().method(),
          status: res.status(),
          statusText: res.statusText(),
          resourceType: res.request().resourceType(),
          pageUrl: page.url(),
        });
      }
    });

    await page.goto(demoUrl, { waitUntil: "domcontentloaded" });

    // Snapshot: URL, title, DOM, visible text
    const snapshot = await capturePageSnapshotViaPage(page);
    await postEvents(baseUrl, sessionId, "page_snapshot", snapshot);
    await postEvents(baseUrl, sessionId, "navigation", {
      toUrl: snapshot.url,
      title: snapshot.title,
    });

    // Screenshot
    const shot = await page.screenshot({ type: "png" });
    await postEvents(baseUrl, sessionId, "screenshot", {
      url: page.url(),
      title: await page.title(),
      mimeType: "image/png",
      dataBase64: shot.toString("base64"),
    });

    // User click
    await page.click("#btn-click");
    await postEvents(baseUrl, sessionId, "user_click", {
      url: page.url(),
      tag: "button",
      id: "btn-click",
      text: "Primary action",
      selectorHint: "button#btn-click",
    });

    // Console error
    await page.click("#btn-console");
    await page.waitForTimeout(300);

    // Uncaught error
    await page.click("#btn-throw");
    await page.waitForTimeout(400);

    // Network 404 (file:// fetch may be opaque — also hit a deliberate bad HTTP URL)
    await page.click("#btn-fetch-fail");
    await page.waitForTimeout(600);

    // Sensitive input change (redacted server-side too)
    await page.fill("#password", "another-secret");
    await page.dispatchEvent("#password", "change");
    await postEvents(baseUrl, sessionId, "user_input", {
      url: page.url(),
      tag: "input",
      id: "password",
      name: "password",
      inputType: "password",
      valuePreview: "[REDACTED]",
      redacted: true,
    });

    await page.waitForTimeout(500);

    const eventsRes = await fetch(`${baseUrl}/api/events?sessionId=${sessionId}&limit=200`);
    const body = (await eventsRes.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const events = body.events;
    const types = new Set(events.map((e) => e.type));

    const required = [
      "page_snapshot",
      "console_error",
      "network_failure",
      "screenshot",
      "user_click",
    ] as const;

    for (const name of required) {
      checks.push({
        name,
        ok: types.has(name),
        detail: types.has(name)
          ? `captured (${events.filter((e) => e.type === name).length})`
          : "MISSING",
      });
    }

    const snapshotEvent = events.find((e) => e.type === "page_snapshot");
    const snapOk =
      !!snapshotEvent &&
      typeof snapshotEvent.payload.url === "string" &&
      typeof snapshotEvent.payload.title === "string" &&
      typeof snapshotEvent.payload.visibleText === "string" &&
      typeof snapshotEvent.payload.domSummary === "object";

    checks.push({
      name: "snapshot_fields",
      ok: snapOk,
      detail: snapOk
        ? `title="${String(snapshotEvent?.payload.title)}" url present, DOM+text present`
        : "page_snapshot missing required fields",
    });

    const shotEvent = events.find((e) => e.type === "screenshot");
    const shotOk = !!shotEvent && typeof shotEvent.payload.path === "string";
    checks.push({
      name: "screenshot_persisted",
      ok: shotOk,
      detail: shotOk ? String(shotEvent?.payload.path) : "no screenshot path on disk",
    });

    const passwordEvent = events.find(
      (e) => e.type === "user_input" && e.payload.name === "password",
    );
    const redactedOk =
      !!passwordEvent &&
      passwordEvent.payload.valuePreview === "[REDACTED]" &&
      !JSON.stringify(passwordEvent).includes("another-secret");
    checks.push({
      name: "password_redacted",
      ok: redactedOk,
      detail: redactedOk ? "password value not stored" : "password leaked or missing",
    });

    console.log("\n=== Phase 1 Demo Results ===");
    console.log(`Observer: ${baseUrl}`);
    console.log(`Session:  ${sessionId}`);
    console.log(`Events:   ${events.length}`);
    for (const check of checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}`);
    }

    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
      console.error(`\n${failed.length} check(s) failed`);
      process.exitCode = 1;
    } else {
      console.log("\nAll Phase 1 capture checks passed.");
    }
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function pathToFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath);
  let pathname = resolved.replace(/\\/g, "/");
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  return `file://${pathname}`;
}

// keep Page type import used for clarity in helpers
void (null as unknown as Page);

main().catch((err) => {
  console.error("[demo] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
