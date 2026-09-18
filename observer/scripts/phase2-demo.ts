/**
 * Phase 2 end-to-end demo: drive intentional failures through Observer → Controller → AI.
 */
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createController } from "@abo/controller";
import { createApp } from "../src/server/app.js";
import { EventStore } from "../src/server/storage.js";
import { ObserverRealtime } from "../src/server/realtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function postEvent(
  baseUrl: string,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}

async function main(): Promise<void> {
  const dataDir = path.join(__dirname, "../data/phase2-demo-run");
  await fs.rm(dataDir, { recursive: true, force: true });

  const store = new EventStore(dataDir);
  await store.init();
  const realtime = new ObserverRealtime();
  const controller = createController(store);
  const app = createApp({ store, realtime, controller });
  const server = createServer(app);
  realtime.attach(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const sessionId = randomUUID();
  const pageUrl = `${baseUrl}/phase2-demo`;

  console.log(`[phase2-demo] observer ${baseUrl}`);
  console.log(`[phase2-demo] session ${sessionId}`);

  const ev = (type: string, payload: Record<string, unknown>) =>
    postEvent(baseUrl, sessionId, type, payload);

  await ev("navigation", { toUrl: pageUrl, title: "Phase 2 Demo App" });
  await ev("page_snapshot", {
    url: pageUrl,
    title: "Phase 2 Demo App",
    visibleText: "Phase 2 Demo Application working page",
    domSummary: {
      elementCount: 20,
      headings: ["Phase 2 Demo Application"],
      buttons: [
        { tag: "button", id: "btn-login-500", text: "Fake login (500)" },
        { tag: "button", id: "btn-broken", text: "Broken action" },
      ],
      inputs: [{ tag: "input", name: "password", type: "password" }],
      links: [],
    },
  });
  await ev("user_click", {
    url: pageUrl,
    tag: "button",
    id: "btn-login-500",
    text: "Fake login (500)",
  });
  await ev("user_input", {
    url: pageUrl,
    tag: "input",
    name: "password",
    inputType: "password",
    valuePreview: "secret-should-never-appear",
    redacted: true,
  });
  await ev("network_failure", {
    url: `${pageUrl}/api/login`,
    method: "POST",
    status: 500,
    statusText: "Internal Server Error",
    pageUrl,
  });
  await ev("console_error", {
    level: "error",
    message: "Login failed with HTTP 500",
    url: pageUrl,
  });

  await ev("user_click", {
    url: pageUrl,
    tag: "button",
    id: "btn-throw",
    text: "Trigger uncaught TypeError",
  });
  await ev("console_error", {
    level: "uncaught",
    message: "TypeError: Cannot read properties of null (reading 'doesNotExist')",
    url: pageUrl,
  });

  const issues = (await fetch(`${baseUrl}/api/issues`).then((r) => r.json())) as {
    issues: Array<Record<string, unknown>>;
  };
  const tasks = (await fetch(`${baseUrl}/api/agent-tasks`).then((r) =>
    r.json(),
  )) as { tasks: Array<Record<string, unknown>> };
  const analyses = (await fetch(`${baseUrl}/api/analyses`).then((r) =>
    r.json(),
  )) as { analyses: Array<Record<string, unknown>> };

  const blob = JSON.stringify({ issues, tasks, analyses, events: store.listEvents(100) });
  const leaked = blob.includes("secret-should-never-appear");

  console.log("\n=== Phase 2 Demo Results ===");
  console.log(`Issues:    ${issues.issues.length}`);
  console.log(`Analyses:  ${analyses.analyses.length}`);
  console.log(`Tasks:     ${tasks.tasks.length}`);
  console.log(`Redaction: ${leaked ? "FAIL (secret leaked)" : "PASS"}`);

  if (issues.issues[0]) {
    console.log("\n--- Example detected issue ---");
    console.log(JSON.stringify(issues.issues[0], null, 2));
  }
  if (analyses.analyses[0]) {
    console.log("\n--- Example AI analysis ---");
    console.log(JSON.stringify(analyses.analyses[0].result, null, 2));
  }
  if (tasks.tasks[0]) {
    console.log("\n--- Example agent task ---");
    console.log(JSON.stringify(tasks.tasks[0].task, null, 2));
  }

  const ok =
    issues.issues.length >= 1 &&
    analyses.analyses.length >= 1 &&
    tasks.tasks.length >= 1 &&
    !leaked;

  realtime.close();
  store.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (!ok) {
    console.error("\nPhase 2 demo FAILED");
    process.exit(1);
  }
  console.log("\nPhase 2 demo PASSED");
}

main().catch((err) => {
  console.error("[phase2-demo] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
