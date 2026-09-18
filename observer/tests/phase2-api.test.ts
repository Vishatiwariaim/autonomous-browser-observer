import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createController } from "@abo/controller";
import { createApp } from "../src/server/app.js";
import { EventStore } from "../src/server/storage.js";
import { ObserverRealtime } from "../src/server/realtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("phase2 pipeline API", () => {
  let server: Server;
  let baseUrl: string;
  let dataDir: string;
  let store: EventStore;
  let realtime: ObserverRealtime;

  before(async () => {
    dataDir = path.join(__dirname, "../data/test-phase2", randomUUID());
    await fs.mkdir(dataDir, { recursive: true });
    store = new EventStore(dataDir);
    await store.init();
    realtime = new ObserverRealtime();
    const controller = createController(store);
    const app = createApp({ store, realtime, controller });
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

  it("serves phase2 demo app and intentional endpoints", async () => {
    const page = await fetch(`${baseUrl}/phase2-demo`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Phase 2 Demo/);

    assert.equal((await fetch(`${baseUrl}/phase2-demo/api/ok`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/phase2-demo/api/missing`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/phase2-demo/api/crash`)).status, 500);
    assert.equal(
      (
        await fetch(`${baseUrl}/phase2-demo/api/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "x" }),
        })
      ).status,
      500,
    );
  });

  it("creates issue + ai analysis + agent task from 500 evidence", async () => {
    const sessionId = randomUUID();
    const ingest = async (type: string, payload: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              id: randomUUID(),
              sessionId,
              type,
              timestamp: new Date().toISOString(),
              payload,
            },
          ],
        }),
      });
      assert.equal(res.status, 201);
      return res.json() as Promise<{ issuesCreated: number; tasksCreated: number }>;
    };

    await ingest("user_click", {
      url: `${baseUrl}/phase2-demo`,
      tag: "button",
      id: "btn-login-500",
      text: "Fake login",
    });
    const result = await ingest("network_failure", {
      url: `${baseUrl}/phase2-demo/api/login`,
      method: "POST",
      status: 500,
    });
    assert.ok(result.issuesCreated >= 1);
    assert.ok(result.tasksCreated >= 1);

    const issues = (await fetch(`${baseUrl}/api/issues`).then((r) => r.json())) as {
      issues: Array<{ classification: string; analysis: { result: { title: string } } }>;
    };
    assert.ok(issues.issues.length >= 1);
    assert.ok(
      issues.issues.some(
        (i) =>
          i.classification === "POSSIBLE_ISSUE" ||
          i.classification === "CONFIRMED_ISSUE",
      ),
    );

    const status = (await fetch(`${baseUrl}/api/status`).then((r) => r.json())) as {
      issues: number;
      agentTasks: number;
      phase: number;
    };
    assert.ok(status.phase === 2 || status.phase === 3);
    assert.ok(status.issues >= 1);
    assert.ok(status.agentTasks >= 1);
  });
});
