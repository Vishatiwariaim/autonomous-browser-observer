import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { EventStore } from "../src/server/storage.js";
import { ObserverRealtime } from "../src/server/realtime.js";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("observer API (sqlite + ws)", () => {
  let server: Server;
  let baseUrl: string;
  let dataDir: string;
  let store: EventStore;
  let realtime: ObserverRealtime;

  before(async () => {
    dataDir = path.join(__dirname, "../data/test-run", randomUUID());
    await fs.mkdir(dataDir, { recursive: true });
    store = new EventStore(dataDir);
    await store.init();
    realtime = new ObserverRealtime();
    const app = createApp({ store, realtime });
    server = createServer(app);
    realtime.attach(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    realtime.close();
    store.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("health check works", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; storage: string };
    assert.equal(body.ok, true);
    assert.equal(body.storage, "sqlite");
    assert.ok(body.phase === 1 || body.phase === 2 || body.phase === 3);
  });

  it("extension ping works", async () => {
    const res = await fetch(`${baseUrl}/api/extension/ping`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("ingests page snapshot into sqlite", async () => {
    const sessionId = randomUUID();
    const res = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            sessionId,
            type: "page_snapshot",
            timestamp: new Date().toISOString(),
            payload: {
              url: "https://example.com/app",
              title: "Example App",
              visibleText: "Hello world",
              domSummary: {
                elementCount: 10,
                headings: ["Hello"],
                buttons: [{ tag: "button", text: "Go" }],
                inputs: [{ tag: "input", name: "q", type: "text" }],
                links: [],
              },
            },
          },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const list = await fetch(`${baseUrl}/api/events?sessionId=${sessionId}`);
    const body = (await list.json()) as { events: Array<{ type: string }> };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]?.type, "page_snapshot");

    const dbStat = await fs.stat(path.join(dataDir, "observer.sqlite"));
    assert.ok(dbStat.size > 0);
  });

  it("persists screenshots and redacts user_input values", async () => {
    const sessionId = randomUUID();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            sessionId,
            type: "screenshot",
            timestamp: new Date().toISOString(),
            payload: {
              url: "https://example.com",
              title: "Example",
              mimeType: "image/png",
              dataBase64: pngBase64,
            },
          },
          {
            sessionId,
            type: "user_input",
            timestamp: new Date().toISOString(),
            payload: {
              url: "https://example.com",
              tag: "input",
              name: "password",
              inputType: "password",
              valuePreview: "should-not-remain",
              redacted: true,
            },
          },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const list = await fetch(`${baseUrl}/api/events?sessionId=${sessionId}`);
    const body = (await list.json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const shot = body.events.find((e) => e.type === "screenshot");
    const input = body.events.find((e) => e.type === "user_input");
    assert.ok(shot?.payload.path);
    assert.equal(shot?.payload.dataBase64, undefined);
    assert.equal(input?.payload.valuePreview, "[REDACTED]");
    assert.equal(JSON.stringify(input).includes("should-not-remain"), false);
  });

  it("broadcasts over websocket on ingest", async () => {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const wsUrl = `ws://127.0.0.1:${addr.port}/ws`;

    const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        if (msg.type === "hello") return;
        if (msg.type === "events") {
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        }
      });
      ws.on("open", async () => {
        await fetch(`${baseUrl}/api/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            events: [
              {
                sessionId: randomUUID(),
                type: "user_click",
                timestamp: new Date().toISOString(),
                payload: { url: "https://example.com", tag: "button", id: "x" },
              },
            ],
          }),
        });
      });
      ws.on("error", reject);
    });

    assert.equal(message.type, "events");
  });

  it("serves demo pages", async () => {
    const a = await fetch(`${baseUrl}/demo`);
    const b = await fetch(`${baseUrl}/demo/page-b`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.match(await a.text(), /ABO Demo Page/);
    assert.match(await b.text(), /Page B/);
  });

  it("rejects invalid payloads", async () => {
    const res = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ type: "nope" }] }),
    });
    assert.equal(res.status, 400);
  });
});
