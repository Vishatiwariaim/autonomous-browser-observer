import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Controller } from "@abo/controller";
import type { CursorBridge } from "@abo/cursor-bridge";
import { IngestBodySchema } from "../shared/types.js";
import { asControllerEvents, type EventStore } from "./storage.js";
import type { ObserverRealtime } from "./realtime.js";
import { config } from "./config.js";
import { dispatchAgentTaskToCursor } from "./cursor-integration.js";
import type { Autopilot } from "./autopilot.js";
import type { CheckBus, CheckType } from "./checks.js";
import { mountTokenGate } from "./auth-token.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../fixtures");

export type CreateAppOptions = {
  store: EventStore;
  realtime?: ObserverRealtime;
  controller?: Controller;
  cursorBridge?: CursorBridge;
  acpMode?: "real" | "mock";
  checkBus?: CheckBus;
  autopilot?: Autopilot;
};

export function createApp(options: CreateAppOptions | EventStore): Express {
  const store = "store" in options ? options.store : options;
  const realtime = "realtime" in options ? options.realtime : undefined;
  const controller = "controller" in options ? options.controller : undefined;
  const cursorBridge = "cursorBridge" in options ? options.cursorBridge : undefined;
  const acpMode = "acpMode" in options ? options.acpMode : undefined;
  const checkBus = "checkBus" in options ? options.checkBus : undefined;
  const autopilot = "autopilot" in options ? options.autopilot : undefined;
  const app = express();

  /** In-memory extension heartbeats (Phase 3A) */
  const extensionConnections = new Map<
    string,
    {
      extensionId: string;
      version: string;
      eventsSent: number;
      queueDepth: number;
      sessionId?: string;
      connected: boolean;
      lastSeenAt: string;
    }
  >();

  function getExtensionStatus() {
    const now = Date.now();
    const list = [...extensionConnections.values()].map((c) => ({
      ...c,
      stale: now - Date.parse(c.lastSeenAt) > 90_000,
      live: c.connected && now - Date.parse(c.lastSeenAt) <= 90_000,
    }));
    const live = list.filter((c) => c.live);
    return {
      connected: live.length > 0,
      liveCount: live.length,
      extensions: list.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    };
  }

  app.use(
    cors({
      origin: true,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-ABO-Token"],
    }),
  );
  app.use(express.json({ limit: "4mb" }));
  const tokenConfigured = mountTokenGate(app);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "observer",
      phase: 4,
      mode: config.mode,
      storage: "sqlite",
      websocket: "/ws",
      controller: Boolean(controller),
      cursorBridge: Boolean(cursorBridge),
      acpMode: acpMode ?? null,
      autopilot: autopilot?.getState()?.status ?? null,
      publicUrl: config.publicUrl,
      apiTokenRequired: tokenConfigured,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/status", (_req, res) => {
    const stats = store.getStats();
    const cursorStatus = cursorBridge?.getClient()?.getStatus() ?? null;
    res.json({
      phase: 4,
      mode: config.mode,
      host: config.host,
      port: config.port,
      publicUrl: config.publicUrl,
      apiTokenRequired: tokenConfigured,
      storage: "sqlite",
      dbPath: store.getDbPath(),
      wsClients: realtime?.clientCount() ?? 0,
      controller: Boolean(controller),
      cursorBridge: Boolean(cursorBridge),
      acpMode: acpMode ?? null,
      cursor: cursorStatus,
      currentCursorSession: cursorBridge?.getCurrent() ?? store.listCursorSessions(1)[0] ?? null,
      extension: getExtensionStatus(),
      autopilot: autopilot?.getState() ?? null,
      checks: checkBus?.list(10) ?? [],
      workflow: ["OBSERVE", "ANALYZE", "TASK", "CURSOR", "FIX", "TEST", "VERIFY"],
      ...stats,
    });
  });

  app.get("/api/extension/ping", (_req, res) => {
    res.json({
      ok: true,
      endpoint: `http://${config.host}:${config.port}`,
      mode: config.mode,
      phase: 3,
      message: "Observer reachable — extension can post events here",
      extension: getExtensionStatus(),
    });
  });

  app.get("/api/extension/status", (_req, res) => {
    res.json({ ok: true, ...getExtensionStatus() });
  });

  app.post("/api/extension/heartbeat", (req, res) => {
    const body = req.body as {
      extensionId?: string;
      version?: string;
      eventsSent?: number;
      queueDepth?: number;
      sessionId?: string;
      connected?: boolean;
    };
    const extensionId = String(body.extensionId || "unknown");
    extensionConnections.set(extensionId, {
      extensionId,
      version: String(body.version || "?"),
      eventsSent: Number(body.eventsSent || 0),
      queueDepth: Number(body.queueDepth || 0),
      sessionId: body.sessionId ? String(body.sessionId) : undefined,
      connected: body.connected !== false,
      lastSeenAt: new Date().toISOString(),
    });
    if (realtime) {
      realtime.broadcast({ type: "status", ...store.getStats(), extension: getExtensionStatus() });
    }
    res.json({ ok: true, ...getExtensionStatus() });
  });

  app.get("/api/extension/checks/pending", (_req, res) => {
    if (!checkBus) {
      res.json({ checks: [] });
      return;
    }
    res.json({ checks: checkBus.pendingForExtension(10) });
  });

  app.post("/api/extension/checks/:id/complete", (req, res) => {
    if (!checkBus) {
      res.status(503).json({ error: "check bus unavailable" });
      return;
    }
    const result = (req.body?.result ?? req.body ?? {}) as Record<string, unknown>;
    const done = checkBus.complete(req.params.id, result, "extension");
    if (!done) {
      res.status(404).json({ error: "check not found or already completed" });
      return;
    }
    if (realtime) realtime.broadcast({ type: "status", ...store.getStats() });
    res.json({ ok: true, check: done });
  });

  app.post("/api/checks", async (req, res) => {
    if (!checkBus) {
      res.status(503).json({ error: "check bus unavailable" });
      return;
    }
    const type = String(req.body?.type ?? "recent_events") as CheckType;
    const params = (req.body?.params ?? {}) as Record<string, unknown>;
    const wait = req.body?.wait !== false;
    const source =
      (req.body?.source as "agent" | "mcp" | "autopilot" | "dashboard") ?? "agent";
    const check = checkBus.create(type, params, {
      source,
      timeoutMs: Number(req.body?.timeoutMs ?? 12_000),
    });
    if (wait) {
      const done = await checkBus.waitFor(check.id);
      res.status(201).json({ ok: true, check: done });
      return;
    }
    res.status(201).json({ ok: true, check });
  });

  app.get("/api/checks", (_req, res) => {
    res.json({ checks: checkBus?.list(50) ?? [] });
  });

  app.get("/api/checks/:id", async (req, res) => {
    if (!checkBus) {
      res.status(503).json({ error: "check bus unavailable" });
      return;
    }
    const wait = String(req.query.wait ?? "") === "1";
    if (wait) {
      try {
        const done = await checkBus.waitFor(req.params.id);
        res.json({ check: done });
      } catch {
        res.status(404).json({ error: "not found" });
      }
      return;
    }
    const check = checkBus.get(req.params.id);
    if (!check) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ check });
  });

  app.get("/api/autopilot", (_req, res) => {
    res.json({
      autopilot: autopilot?.getState() ?? { status: "unavailable", enabled: false },
    });
  });

  app.post("/api/autopilot/enable", (req, res) => {
    if (!autopilot) {
      res.status(503).json({ error: "autopilot unavailable" });
      return;
    }
    const enabled = req.body?.enabled !== false;
    res.json({ ok: true, autopilot: autopilot.setEnabled(enabled) });
  });

  app.post("/api/autopilot/start", async (req, res, next) => {
    try {
      if (!autopilot) {
        res.status(503).json({ error: "autopilot unavailable" });
        return;
      }
      autopilot.setEnabled(true);
      const state = await autopilot.start({
        taskId: typeof req.body?.taskId === "string" ? req.body.taskId : undefined,
        issueId: typeof req.body?.issueId === "string" ? req.body.issueId : undefined,
      });
      res.json({ ok: true, autopilot: state });
    } catch (err) {
      next(err);
    }
  });

  // placeholder removed — old ping handler replaced above
  app.post("/api/events", async (req, res, next) => {
    try {
      const parsed = IngestBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid event payload",
          details: parsed.error.flatten(),
        });
        return;
      }

      const stored = await store.ingest(
        parsed.data.events,
        config.maxScreenshotBytes,
      );

      let controllerResult:
        | Awaited<ReturnType<NonNullable<typeof controller>["onEvents"]>>
        | undefined;

      if (controller) {
        const forController = asControllerEvents(
          stored.filter((e) => e.type !== "extension_heartbeat"),
        );
        if (forController.length > 0) {
          controllerResult = await controller.onEvents(forController);
        }
      }

      if (realtime) {
        realtime.broadcast({ type: "events", events: stored });
        realtime.broadcast({ type: "status", ...store.getStats() });
        if (
          controllerResult &&
          (controllerResult.issues.length > 0 ||
            controllerResult.analyses.length > 0)
        ) {
          realtime.broadcast({
            type: "issues",
            issues: controllerResult.issues,
            analyses: controllerResult.analyses,
            tasks: controllerResult.tasks,
          });
        }
      }

      if (
        autopilot &&
        controllerResult &&
        controllerResult.tasks.length > 0
      ) {
        // Fire-and-forget — do not block ingest
        setTimeout(() => autopilot.maybeStartFromLatest(), 50);
      }

      res.status(201).json({
        accepted: stored.length,
        ids: stored.map((e) => e.id),
        issuesCreated: controllerResult?.issues.length ?? 0,
        tasksCreated: controllerResult?.tasks.length ?? 0,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/events", (req, res) => {
    const limit = Math.min(
      Number.parseInt(String(req.query.limit ?? "50"), 10) || 50,
      500,
    );
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    res.json({ events: store.listEvents(limit, sessionId) });
  });

  app.get("/api/events/:id", (req, res) => {
    const event = store.getEvent(req.params.id);
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    res.json(event);
  });

  app.get("/api/sessions", (_req, res) => {
    res.json({ sessions: store.listSessions() });
  });

  app.get("/api/issues", (req, res) => {
    const limit = Math.min(
      Number.parseInt(String(req.query.limit ?? "50"), 10) || 50,
      200,
    );
    const issues = store.listIssues(limit).map((issue) => ({
      ...issue,
      analysis: store.listAnalysesForIssue(issue.id)[0] ?? null,
      task: store.listTasksForIssue(issue.id)[0] ?? null,
    }));
    res.json({ issues });
  });

  app.get("/api/issues/:id", (req, res) => {
    const issue = store.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json({
      issue,
      analyses: store.listAnalysesForIssue(issue.id),
      tasks: store.listTasksForIssue(issue.id),
      relatedEvents: issue.relatedEventIds
        .map((id) => store.getEvent(id))
        .filter(Boolean),
    });
  });

  app.get("/api/analyses", (req, res) => {
    const limit = Math.min(
      Number.parseInt(String(req.query.limit ?? "50"), 10) || 50,
      200,
    );
    res.json({ analyses: store.listAnalyses(limit) });
  });

  app.get("/api/agent-tasks", (req, res) => {
    const limit = Math.min(
      Number.parseInt(String(req.query.limit ?? "50"), 10) || 50,
      200,
    );
    res.json({ tasks: store.listAgentTasks(limit) });
  });

  app.get("/api/cursor/status", (_req, res) => {
    res.json({
      acpMode: acpMode ?? null,
      connected: Boolean(cursorBridge?.getClient()),
      client: cursorBridge?.getClient()?.getStatus() ?? null,
      current: cursorBridge?.getCurrent() ?? null,
      sessions: store.listCursorSessions(20),
      pendingPermissions:
        cursorBridge?.getClient()?.getPermissionPolicy().listPending() ?? [],
      workflow: ["OBSERVE", "ANALYZE", "TASK", "CURSOR", "FIX", "TEST", "VERIFY"],
    });
  });

  app.get("/api/cursor/sessions", (req, res) => {
    const limit = Math.min(
      Number.parseInt(String(req.query.limit ?? "50"), 10) || 50,
      200,
    );
    res.json({ sessions: store.listCursorSessions(limit) });
  });

  app.post("/api/cursor/dispatch", async (req, res, next) => {
    try {
      if (!cursorBridge) {
        res.status(503).json({ error: "Cursor bridge not enabled" });
        return;
      }
      const taskId =
        typeof req.body?.taskId === "string" ? req.body.taskId : undefined;
      const tasks = store.listAgentTasks(50);
      const task = taskId
        ? tasks.find((t) => t.id === taskId)
        : tasks[0];
      if (!task) {
        res.status(404).json({ error: "No agent task available to dispatch" });
        return;
      }
      const record = await dispatchAgentTaskToCursor(cursorBridge, store, task, {
        observerBaseUrl: `http://${config.host}:${config.port}`,
      });
      realtime?.broadcast({ type: "status", ...store.getStats() });
      res.status(201).json({ session: record });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/cursor/permissions/:id", (req, res) => {
    if (!cursorBridge?.getClient()) {
      res.status(503).json({ error: "No ACP client" });
      return;
    }
    const decision =
      req.body?.decision === "allow-always"
        ? "allow-always"
        : req.body?.decision === "reject-once"
          ? "reject-once"
          : "allow-once";
    const ok = cursorBridge
      .getClient()!
      .approvePermission(req.params.id, decision);
    res.json({ ok, decision });
  });

  app.post("/api/cursor/results", (req, res) => {
    const result = req.body?.result ?? req.body;
    const sessions = store.listCursorSessions(10);
    const current = sessions[0];
    if (current) {
      store.updateCursorSession(current.id, {
        result_json: result,
        status:
          result?.status === "FIXED"
            ? "completed"
            : result?.status === "FAILED"
              ? "failed"
              : result?.status === "BLOCKED"
                ? "blocked"
                : "completed",
        response: `${current.response ?? ""}\n\n[MCP report_cursor_result]\n${JSON.stringify(result)}`,
        files_changed: result?.files_changed,
        completed_at: new Date().toISOString(),
        workflow_stage: result?.status === "FIXED" ? "VERIFY" : "TEST",
      });
    }
    res.status(201).json({ ok: true, stored: Boolean(current) });
  });

  // --- Phase 2 intentional demo application ---
  app.get("/phase2-demo", (_req, res) => {
    res.type("html").send(readFixture("phase2-demo.html"));
  });

  app.get("/extension-test", (_req, res) => {
    res.type("html").send(readFixture("extension-test.html"));
  });

  app.get("/phase2-demo/api/ok", (_req, res) => {
    res.json({ ok: true, message: "working endpoint" });
  });

  app.get("/phase2-demo/api/missing", (_req, res) => {
    res.status(404).json({ error: "deliberate 404 for Phase 2 demo" });
  });

  app.get("/phase2-demo/api/crash", (_req, res) => {
    res.status(500).json({ error: "deliberate HTTP 500 for Phase 2 demo" });
  });

  app.post("/phase2-demo/api/login", (_req, res) => {
    // Never echo body (may contain password) — always fail with 500 for demo
    res.status(500).json({ error: "deliberate login API failure" });
  });

  app.get("/demo", (_req, res) => {
    res.type("html").send(readFixture("demo-page.html"));
  });

  app.get("/demo/page-b", (_req, res) => {
    res.type("html").send(readFixture("demo-page-b.html"));
  });

  app.get("/abo-demo-missing-endpoint-:id", (_req, res) => {
    res.status(404).json({ error: "deliberate missing endpoint for observation test" });
  });

  app.use(
    "/screenshots",
    express.static(store.getScreenshotsDir(), {
      fallthrough: true,
      maxAge: 0,
    }),
  );

  app.get("/", (_req, res) => {
    res.type("html").send(statusPageHtml());
  });

  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[observer] error:", message);
      res.status(500).json({ error: message });
    },
  );

  return app;
}

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function statusPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ABO Observer — Phase 3</title>
  <style>
    :root { color-scheme: light; --bg:#0f1419; --panel:#1a2332; --text:#e7ecf3; --muted:#8b9bb4; --accent:#3d9cf0; --ok:#3ecf8e; --warn:#f0c14d; --bad:#ff7b72; }
    body { margin:0; font-family: "Segoe UI", system-ui, sans-serif; background: radial-gradient(1200px 600px at 10% -10%, #1e3a5f, var(--bg)); color: var(--text); min-height:100vh; }
    main { max-width: 1100px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.6rem; margin: 0 0 .35rem; }
    h2 { font-size: 1.05rem; margin: 1.5rem 0 .6rem; color: #c5d4e8; }
    p.lead { color: var(--muted); margin: 0 0 1rem; }
    .grid { display:grid; gap:1rem; grid-template-columns: repeat(auto-fit,minmax(130px,1fr)); margin-bottom:1.25rem; }
    .card { background: var(--panel); border:1px solid #2a3a50; border-radius:10px; padding:1rem; margin-bottom:1rem; }
    .card .label { color: var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; }
    .card .value { font-size:1.35rem; margin-top:.35rem; font-variant-numeric: tabular-nums; }
    table { width:100%; border-collapse: collapse; font-size:.88rem; }
    th, td { text-align:left; padding:.5rem .35rem; border-bottom:1px solid #2a3a50; vertical-align:top; }
    th { color: var(--muted); font-weight:600; font-size:.72rem; text-transform:uppercase; }
    code, pre { font-size:.78rem; color:#b8d4f0; word-break:break-word; white-space:pre-wrap; }
    .badge { display:inline-block; padding:.15rem .45rem; border-radius:4px; background:#243447; color:var(--accent); font-size:.72rem; margin-right:.25rem; }
    .sev-HIGH,.sev-CRITICAL { color: var(--bad); }
    .sev-MEDIUM { color: var(--warn); }
    .ok { color: var(--ok); } .warn { color: var(--warn); }
    button { background:var(--accent); color:#041018; border:0; border-radius:6px; padding:.45rem .8rem; font-weight:600; cursor:pointer; }
    a { color: var(--accent); }
    .hint { font-size:.85rem; color: var(--muted); margin: 0 0 1rem; }
    .flow { display:flex; flex-wrap:wrap; gap:.4rem; margin: 0 0 1.25rem; }
    .flow span { background:#243447; border:1px solid #3a4f6a; padding:.35rem .55rem; border-radius:999px; font-size:.72rem; letter-spacing:.04em; }
    .flow span.active { background:#3d9cf0; color:#041018; font-weight:700; }
  </style>
</head>
<body>
  <main>
    <h1>Autonomous Browser Observer</h1>
    <p class="lead">Phase 4 — Agent checks via extension → Autopilot fix loop until verify PASS.</p>
    <p class="hint">Login demo: <a href="http://127.0.0.1:3000/">http://127.0.0.1:3000/</a> · <a href="/extension-test">/extension-test</a> · <a href="/phase2-demo">/phase2-demo</a></p>
    <div class="flow" id="workflow"></div>
    <div class="grid" id="stats"></div>
    <p>
      <button type="button" id="refresh">Refresh</button>
      <button type="button" id="dispatch">Dispatch to Cursor</button>
      <button type="button" id="autopilotBtn">Start Autopilot</button>
      <span id="health" class="ok"></span> <span id="ws" class="warn"></span>
    </p>

    <h2>AUTOPILOT</h2>
    <div class="card" id="autopilot"><em class="hint">Idle. Enable autopilot to keep checking + fixing until verify PASS.</em></div>

    <h2>AGENT CHECKS</h2>
    <div class="card" id="checks"><em class="hint">No agent check requests yet.</em></div>

    <h2>EXTENSION CONNECTION</h2>
    <div class="card" id="extension"><em class="hint">No extension connected yet. Load unpacked from extension/dist and open any http page.</em></div>

    <h2>CURSOR AGENT</h2>
    <div class="card" id="cursor"><em class="hint">No Cursor session yet.</em></div>

    <h2>Detected Issues</h2>
    <div class="card" id="issues"><em class="hint">No issues yet.</em></div>

    <h2>AI Analysis</h2>
    <div class="card" id="analyses"><em class="hint">No analyses yet.</em></div>

    <h2>Generated Agent Tasks</h2>
    <div class="card" id="tasks"><em class="hint">No tasks yet.</em></div>

    <h2>Recent Events</h2>
    <div class="card">
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Session</th><th>Summary</th></tr></thead>
        <tbody id="events"></tbody>
      </table>
    </div>
  </main>
  <script>
    let lastEvents = [];
    async function load() {
      const [status, events, issues, analyses, tasks, cursor, ext, checks, ap] = await Promise.all([
        fetch('/api/status').then(r => r.json()),
        fetch('/api/events?limit=40').then(r => r.json()),
        fetch('/api/issues?limit=20').then(r => r.json()),
        fetch('/api/analyses?limit=20').then(r => r.json()),
        fetch('/api/agent-tasks?limit=20').then(r => r.json()),
        fetch('/api/cursor/status').then(r => r.json()).catch(() => ({})),
        fetch('/api/extension/status').then(r => r.json()).catch(() => ({ connected: false, extensions: [] })),
        fetch('/api/checks').then(r => r.json()).catch(() => ({ checks: [] })),
        fetch('/api/autopilot').then(r => r.json()).catch(() => ({ autopilot: null })),
      ]);
      lastEvents = events.events || [];
      render(status, lastEvents, issues.issues || [], analyses.analyses || [], tasks.tasks || [], cursor, ext, checks.checks || status.checks || [], ap.autopilot || status.autopilot);
    }
    function esc(s) { return String(s ?? '').replace(/</g,'&lt;'); }
    function render(status, events, issues, analyses, tasks, cursor, ext, checks, ap) {
      document.getElementById('health').textContent = 'Healthy · phase ' + status.phase + ' · acp=' + (status.acpMode || 'n/a');
      const stages = status.workflow || ['OBSERVE','ANALYZE','TASK','CURSOR','FIX','TEST','VERIFY'];
      const active = (ap && ap.status === 'succeeded') ? 'VERIFY' : ((cursor && cursor.current && cursor.current.workflow_stage) || (ap && ap.status && ap.status !== 'idle' ? 'CURSOR' : 'OBSERVE'));
      document.getElementById('workflow').innerHTML = stages.map(s => '<span class="'+(s===active?'active':'')+'">'+s+'</span>').join('');
      const extInfo = ext || status.extension || { connected: false, extensions: [] };
      document.getElementById('stats').innerHTML = [
        ['Events', status.totalEvents],
        ['Sessions', status.sessions],
        ['Issues', status.issues || 0],
        ['Agent tasks', status.agentTasks || 0],
        ['Extension', extInfo.connected ? 'Connected' : 'Offline'],
        ['Autopilot', (ap && ap.status) || 'idle'],
      ].map(([l,v]) => '<div class="card"><div class="label">'+l+'</div><div class="value">'+v+'</div></div>').join('');

      if (ap) {
        document.getElementById('autopilot').innerHTML =
          '<div><span class="badge">' + esc(ap.status) + '</span>'
          + '<span class="badge">enabled=' + esc(ap.enabled) + '</span>'
          + '<span class="badge">attempt ' + esc(ap.attempt) + '/' + esc(ap.maxAttempts) + '</span></div>'
          + (ap.verify ? '<div class="hint">verify: ' + esc(ap.verify.detail) + '</div>' : '')
          + (ap.lastError ? '<div class="warn">' + esc(ap.lastError) + '</div>' : '')
          + '<div style="margin-top:.5rem"><strong>History</strong><pre>' + esc(JSON.stringify(ap.history||[],null,2).slice(0,3000)) + '</pre></div>';
      }

      document.getElementById('checks').innerHTML = (checks && checks.length) ? checks.slice(0,12).map(c =>
        '<div style="margin-bottom:.5rem"><span class="badge">'+esc(c.type)+'</span><span class="badge">'+esc(c.status)+'</span>'
        + '<span class="badge">'+esc(c.fulfilledBy||c.source)+'</span>'
        + '<div class="hint">'+esc(c.id)+' · '+esc(c.createdAt)+'</div></div>'
      ).join('') : '<em class="hint">No agent check requests yet. MCP tool request_browser_check creates these.</em>';

      const exts = extInfo.extensions || [];
      document.getElementById('extension').innerHTML = exts.length ? (
        '<div><span class="badge '+(extInfo.connected?'ok':'warn')+'">'+(extInfo.connected?'Connected':'Stale / offline')+'</span>'
        + '<span class="badge">live '+esc(extInfo.liveCount||0)+'</span></div>'
        + exts.map(e => '<div style="margin-top:.6rem">'
          + '<div><code>'+esc(e.extensionId)+'</code> · v'+esc(e.version)+'</div>'
          + '<div class="hint">last seen '+esc(e.lastSeenAt)+' · events sent '+esc(e.eventsSent)+' · queue '+esc(e.queueDepth)
          + (e.sessionId ? ' · session '+esc(String(e.sessionId).slice(0,8)) : '')
          + (e.stale ? ' · STALE' : '')
          + '</div></div>').join('')
      ) : '<em class="hint">No extension heartbeat yet. Load <code>extension/dist</code> unpacked and browse any http(s) page.</em>';

      const cur = cursor.current || (cursor.sessions && cursor.sessions[0]);
      const client = cursor.client || {};
      document.getElementById('cursor').innerHTML = cur || client.connection ? (
        '<div><span class="badge">ACP ' + esc(cursor.acpMode || status.acpMode) + '</span>'
        + '<span class="badge">' + esc(client.connection || 'unknown') + '</span>'
        + (cur ? '<span class="badge">' + esc(cur.status) + '</span>' : '')
        + '</div>'
        + (cur ? '<div class="hint">session ' + esc(cur.cursor_session_id || cur.id) + ' · task ' + esc(cur.task_id) + '</div>' : '')
        + (cur && cur.result_json ? '<div><strong>Final result</strong><pre>' + esc(JSON.stringify(cur.result_json,null,2)) + '</pre></div>' : '')
        + (cur && cur.files_changed && cur.files_changed.length ? '<div><strong>Files changed</strong><pre>' + esc(cur.files_changed.join('\\n')) + '</pre></div>' : '')
        + (cur && cur.response ? '<div><strong>Cursor response</strong><pre>' + esc(String(cur.response).slice(0,4000)) + '</pre></div>' : '')
        + (cur && cur.error ? '<div class="warn">Error: ' + esc(cur.error) + '</div>' : '')
        + ((cursor.pendingPermissions||[]).length ? '<div><strong>Approval requests</strong><pre>' + esc(JSON.stringify(cursor.pendingPermissions,null,2)) + '</pre></div>' : '<div class="hint">No pending approval requests</div>')
      ) : '<em class="hint">No Cursor ACP activity yet. Click Dispatch after an issue/task exists.</em>';

      document.getElementById('issues').innerHTML = issues.length ? issues.map(i => {
        const a = i.analysis && i.analysis.result ? i.analysis.result : null;
        const t = i.task && i.task.task ? i.task.task : null;
        return '<div style="margin-bottom:1rem;padding-bottom:1rem;border-bottom:1px solid #2a3a50">'
          + '<span class="badge">'+esc(i.classification)+'</span>'
          + '<span class="badge sev-'+esc(i.severity)+'">'+esc(i.severity)+'</span>'
          + '<span class="badge">conf '+(Math.round((i.confidence||0)*100))+'%</span>'
          + '<div style="margin-top:.4rem;font-weight:600">'+esc(i.title)+'</div>'
          + '<div class="hint">'+esc(i.summary)+'</div>'
          + '<div><code>'+esc(i.url||'')+'</code></div>'
          + '<div class="hint">session '+esc((i.sessionId||'').slice(0,8))+' · '+esc(i.createdAt)+'</div>'
          + (a ? '<div style="margin-top:.4rem"><strong>Evidence</strong><pre>'+esc((a.evidence||[]).join('\\n'))+'</pre></div>' : '')
          + (t ? '<div><strong>Agent task</strong><pre>'+esc(JSON.stringify(t,null,2))+'</pre></div>' : '')
          + '</div>';
      }).join('') : '<em class="hint">No issues yet.</em>';

      document.getElementById('analyses').innerHTML = analyses.length ? analyses.map(a => {
        const r = a.result || {};
        return '<div style="margin-bottom:.8rem"><span class="badge">'+esc(r.classification)+'</span> '
          + '<strong>'+esc(r.title)+'</strong>'
          + '<div class="hint">'+esc(a.analyzer)+' · '+esc(a.createdAt)+' · confidence '+esc(r.confidence)+'</div>'
          + '<pre>'+esc(JSON.stringify(r,null,2))+'</pre></div>';
      }).join('') : '<em class="hint">No AI analyses yet.</em>';

      document.getElementById('tasks').innerHTML = tasks.length ? tasks.map(t => {
        return '<div style="margin-bottom:.8rem"><span class="badge">'+esc(t.status)+'</span>'
          + '<pre>'+esc(JSON.stringify(t.task,null,2))+'</pre></div>';
      }).join('') : '<em class="hint">No agent tasks generated yet.</em>';

      document.getElementById('events').innerHTML = (events || []).map(e => {
        const p = e.payload || {};
        const summary = p.url || p.toUrl || p.message || p.path || p.id || JSON.stringify(p).slice(0,120);
        return '<tr><td>'+esc(e.timestamp)+'</td><td><span class="badge">'+esc(e.type)+'</span></td><td><code>'+esc(e.sessionId.slice(0,8))+'</code></td><td><code>'+esc(summary)+'</code></td></tr>';
      }).join('') || '<tr><td colspan="4">No events yet.</td></tr>';
    }
    function connectWs() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/ws');
      const el = document.getElementById('ws');
      ws.onopen = () => { el.textContent = ' · live WS connected'; el.className = 'ok'; };
      ws.onclose = () => { el.textContent = ' · WS disconnected (polling)'; el.className = 'warn'; setTimeout(connectWs, 2000); };
      ws.onerror = () => { el.textContent = ' · WS error (polling)'; el.className = 'warn'; };
      ws.onmessage = () => { load(); };
    }
    document.getElementById('refresh').onclick = load;
    document.getElementById('dispatch').onclick = async () => {
      const res = await fetch('/api/cursor/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await res.json();
      alert(res.ok ? ('Dispatched: ' + (body.session && body.session.status)) : (body.error || 'dispatch failed'));
      load();
    };
    document.getElementById('autopilotBtn').onclick = async () => {
      const res = await fetch('/api/autopilot/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await res.json();
      alert(res.ok ? ('Autopilot: ' + (body.autopilot && body.autopilot.status)) : (body.error || 'failed'));
      load();
    };
    load();
    connectWs();
    setInterval(load, 8000);
  </script>
</body>
</html>`;
}
