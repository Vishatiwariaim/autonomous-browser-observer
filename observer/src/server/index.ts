import { createServer } from "node:http";
import { createController } from "@abo/controller";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { EventStore } from "./storage.js";
import { ObserverRealtime } from "./realtime.js";
import { createCursorBridge } from "./cursor-integration.js";
import { CheckBus } from "./checks.js";
import { Autopilot } from "./autopilot.js";

async function main(): Promise<void> {
  const store = new EventStore(config.dataDir);
  await store.init();

  const realtime = new ObserverRealtime();
  const controller = createController(store);
  const { bridge, mode } = createCursorBridge(store);
  const checkBus = new CheckBus(store);
  const autopilot = new Autopilot(store, bridge, checkBus, {
    observerBaseUrl: `http://${config.host}:${config.port}`,
    demoUrl: process.env.DEMO_APP_URL ?? "http://127.0.0.1:3000",
    enabled: process.env.ABO_AUTOPILOT === "1",
    maxAttempts: Number(process.env.ABO_AUTOPILOT_MAX ?? 3),
  });

  autopilot.onUpdate((state) => {
    realtime.broadcast({
      type: "status",
      ...store.getStats(),
      autopilot: state,
    } as never);
  });

  const app = createApp({
    store,
    realtime,
    controller,
    cursorBridge: bridge,
    acpMode: mode,
    checkBus,
    autopilot,
  });
  const server = createServer(app);
  realtime.attach(server);

  server.listen(config.port, config.host, () => {
    console.log(
      `[observer] Phase 4 listening on http://${config.host}:${config.port}`,
    );
    console.log(`[observer] Public URL ${config.publicUrl}`);
    console.log(`[observer] API token ${config.apiTokenConfigured ? "REQUIRED" : "disabled (open)"}`);
    console.log(`[observer] WebSocket ws://${config.host}:${config.port}/ws`);
    console.log(`[observer] ACP mode=${mode} sqlite=${store.getDbPath()}`);
    console.log(
      `[observer] Autopilot enabled=${autopilot.getState().enabled} max=${autopilot.getState().maxAttempts}`,
    );
    console.log(`[observer] See DEPLOY.md for LAN/VPS + extension-only clients`);
    if (mode === "mock") {
      console.log(
        "[observer] Using mock ACP (Cursor CLI not authenticated). Run `agent login` for real Cursor.",
      );
    }
  });

  const shutdown = async () => {
    console.log("[observer] shutting down");
    await bridge.close();
    realtime.close();
    store.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[observer] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
