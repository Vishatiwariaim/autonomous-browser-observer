/**
 * Phase 3A — simulate extension ingest + heartbeat against a running Observer
 * (or start one briefly). Does not require Chrome load-unpacked.
 */
import { randomUUID } from "node:crypto";
import { toObserverIngestBody } from "../src/shared/mapper.ts";
import type { ObservationEvent } from "../src/shared/types.ts";
import { sanitizePayload, sanitizeValueForField } from "../src/shared/sanitizer.ts";

const OBSERVER = process.env.ABO_OBSERVER_URL ?? "http://127.0.0.1:3847";

async function main() {
  const ping = await fetch(`${OBSERVER}/api/extension/ping`);
  if (!ping.ok) throw new Error(`Observer not reachable at ${OBSERVER}`);

  const session_id = `sess_${randomUUID()}`;
  const extensionId = `ext_verify_${randomUUID().slice(0, 8)}`;

  const hb = await fetch(`${OBSERVER}/api/extension/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      extensionId,
      version: "0.3.1",
      eventsSent: 0,
      queueDepth: 0,
      sessionId: session_id,
      connected: true,
    }),
  });
  if (!hb.ok) throw new Error("heartbeat failed");

  const passwordCheck = sanitizeValueForField("password", "SuperSecret123!", true);
  if (passwordCheck !== "[REDACTED]") throw new Error("password not redacted");

  const events: ObservationEvent[] = [
    {
      event_id: `evt_${randomUUID()}`,
      session_id,
      timestamp: new Date().toISOString(),
      type: "PAGE_LOAD",
      url: `${OBSERVER}/extension-test`,
      title: "ABO Extension Test",
      payload: sanitizePayload(
        {
          url: `${OBSERVER}/extension-test`,
          title: "ABO Extension Test",
          visibleText: "ABO Extension Test Click me Password",
          domSummary: {
            elementCount: 20,
            headings: ["ABO Extension Test"],
            buttons: [{ tag: "button", text: "Click me" }],
            inputs: [
              { tag: "input", name: "password", type: "password", text: "[REDACTED]" },
              { tag: "input", name: "api_key", type: "text" },
            ],
            links: [],
          },
          viewport: { width: 1280, height: 720 },
        },
        true,
      ),
    },
    {
      event_id: `evt_${randomUUID()}`,
      session_id,
      timestamp: new Date().toISOString(),
      type: "CLICK",
      url: `${OBSERVER}/extension-test`,
      title: "ABO Extension Test",
      payload: {
        target: { tag: "button", id: "btn", text: "Click me", selectorHint: "button#btn" },
        x: 40,
        y: 80,
      },
    },
    {
      event_id: `evt_${randomUUID()}`,
      session_id,
      timestamp: new Date().toISOString(),
      type: "INPUT",
      url: `${OBSERVER}/extension-test`,
      title: "ABO Extension Test",
      payload: {
        target: { tag: "input", name: "password", type: "password", id: "password" },
        value: sanitizeValueForField("password", "SuperSecret123!", true),
        redacted: true,
      },
    },
    {
      event_id: `evt_${randomUUID()}`,
      session_id,
      timestamp: new Date().toISOString(),
      type: "CONSOLE_ERROR",
      url: `${OBSERVER}/extension-test`,
      title: "ABO Extension Test",
      payload: { level: "error", message: "ABO test intentional error" },
    },
    {
      event_id: `evt_${randomUUID()}`,
      session_id,
      timestamp: new Date().toISOString(),
      type: "NETWORK_ERROR",
      url: `${OBSERVER}/extension-test`,
      title: "ABO Extension Test",
      payload: {
        url: `${OBSERVER}/abo-demo-missing-endpoint-1`,
        method: "GET",
        status: 404,
        statusText: "Not Found",
        resourceType: "xmlhttprequest",
      },
    },
    {
      event_id: `evt_${randomUUID()}`,
      session_id,
      timestamp: new Date().toISOString(),
      type: "DOM_MUTATION",
      url: `${OBSERVER}/extension-test`,
      title: "ABO Extension Test",
      payload: { addedNodes: 3, removedNodes: 0, note: "test batch" },
    },
  ];

  const body = toObserverIngestBody(events);
  const ingest = await fetch(`${OBSERVER}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!ingest.ok) {
    throw new Error(`ingest failed: ${ingest.status} ${await ingest.text()}`);
  }
  const ingested = (await ingest.json()) as { accepted: number };

  await fetch(`${OBSERVER}/api/extension/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      extensionId,
      version: "0.3.1",
      eventsSent: events.length,
      queueDepth: 0,
      sessionId: session_id,
      connected: true,
    }),
  });

  const list = await fetch(`${OBSERVER}/api/events?sessionId=${session_id}&limit=50`);
  const { events: stored } = (await list.json()) as {
    events: Array<{ type: string; payload: Record<string, unknown> }>;
  };

  const types = new Set(stored.map((e) => e.type));
  const input = stored.find((e) => e.type === "user_input");
  const inputBlob = JSON.stringify(input?.payload ?? {});
  if (inputBlob.includes("SuperSecret123")) {
    throw new Error("FAIL: password leaked in stored payload");
  }

  const extStatus = await fetch(`${OBSERVER}/api/extension/status`).then((r) => r.json()) as {
    connected: boolean;
    liveCount: number;
  };

  console.log("PHASE 3A VERIFY");
  console.log(`  Observer:     ${OBSERVER}`);
  console.log(`  Session:      ${session_id}`);
  console.log(`  Accepted:     ${ingested.accepted}`);
  console.log(`  Stored types: ${[...types].sort().join(", ")}`);
  console.log(`  Extension:    connected=${extStatus.connected} live=${extStatus.liveCount}`);
  console.log(`  Password redaction: OK`);
  console.log("RESULT: PASS");
}

main().catch((err) => {
  console.error("RESULT: FAIL", err);
  process.exit(1);
});
