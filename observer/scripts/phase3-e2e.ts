/**
 * Phase 3 end-to-end:
 * Observer detects login 500 → issue/task → ACP Cursor (or mock) fixes demo-app → Playwright verifies.
 */
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createController } from "@abo/controller";
import { chromium } from "playwright";
import { createApp } from "../src/server/app.js";
import { EventStore } from "../src/server/storage.js";
import { ObserverRealtime } from "../src/server/realtime.js";
import {
  createCursorBridge,
  dispatchAgentTaskToCursor,
} from "../src/server/cursor-integration.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const authPath = path.join(repoRoot, "demo-app/src/auth.ts");

async function resetBuggyAuth(): Promise<void> {
  const buggy = `/**
 * INTENTIONAL BUG for Phase 3:
 * When BUG_ENABLED is true (default), /api/login always returns HTTP 500.
 * Cursor Agent is expected to fix authenticate() so valid credentials succeed.
 */
export type LoginInput = {
  username: string;
  password: string;
};

export type LoginResult =
  | { ok: true; redirectTo: string }
  | { ok: false; status: number; error: string };

const VALID_USER = "demo";
const VALID_PASS = "demo123";

/** Feature flag — Cursor should remove/fix the always-500 path. */
export const BUG_ENABLED =
  process.env.DEMO_BUG_ENABLED !== "0" && process.env.DEMO_BUG_FIXED !== "1";

export function authenticate(input: LoginInput): LoginResult {
  // --- INTENTIONAL BUG START ---
  if (BUG_ENABLED) {
    return {
      ok: false,
      status: 500,
      error: "Internal Server Error (deliberate Phase 3 demo bug)",
    };
  }
  // --- INTENTIONAL BUG END ---

  if (input.username === VALID_USER && input.password === VALID_PASS) {
    return { ok: true, redirectTo: "/dashboard" };
  }
  return { ok: false, status: 401, error: "Invalid credentials" };
}
`;
  await fs.writeFile(authPath, buggy, "utf8");
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: true,
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      out += String(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function postEvent(
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
          id: randomUUID(),
          sessionId,
          type,
          timestamp: new Date().toISOString(),
          payload,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function main(): Promise<void> {
  process.env.ABO_ACP_MODE = process.env.ABO_ACP_MODE ?? "mock";
  await resetBuggyAuth();

  const dataDir = path.join(__dirname, "../data/phase3-e2e");
  await fs.rm(dataDir, { recursive: true, force: true });
  const store = new EventStore(dataDir);
  await store.init();
  const realtime = new ObserverRealtime();
  const controller = createController(store);
  const { bridge, mode } = createCursorBridge(store);
  const app = createApp({
    store,
    realtime,
    controller,
    cursorBridge: bridge,
    acpMode: mode,
  });
  const server = createServer(app);
  realtime.attach(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(3847, "127.0.0.1", () => resolve());
  });
  const observerUrl = "http://127.0.0.1:3847";

  // Start demo-app on 3000
  const demo = spawn(
    process.execPath,
    [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), "src/server.ts"],
    {
      cwd: path.join(repoRoot, "demo-app"),
      env: { ...process.env, DEMO_APP_PORT: "3000", DEMO_BUG_FIXED: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((r) => setTimeout(r, 1200));

  console.log(`[phase3-e2e] observer ${observerUrl} acpMode=${mode}`);

  // Prove login fails before fix
  const failRes = await fetch("http://127.0.0.1:3000/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "demo", password: "demo123" }),
  });
  console.log(`[phase3-e2e] pre-fix login status=${failRes.status}`);
  if (failRes.status !== 500) {
    throw new Error(`Expected pre-fix 500, got ${failRes.status}`);
  }

  const sessionId = randomUUID();
  const pageUrl = "http://127.0.0.1:3000/";
  await postEvent(observerUrl, sessionId, "navigation", {
    toUrl: pageUrl,
    title: "Demo Login",
  });
  await postEvent(observerUrl, sessionId, "user_click", {
    url: pageUrl,
    tag: "button",
    id: "login-btn",
    text: "Login",
  });
  await postEvent(observerUrl, sessionId, "network_failure", {
    url: "http://127.0.0.1:3000/api/login",
    method: "POST",
    status: 500,
    pageUrl,
  });
  await postEvent(observerUrl, sessionId, "console_error", {
    level: "error",
    message: "Login API error 500",
    url: pageUrl,
  });

  const issues = (await fetch(`${observerUrl}/api/issues`).then((r) =>
    r.json(),
  )) as { issues: unknown[] };
  const tasks = (await fetch(`${observerUrl}/api/agent-tasks`).then((r) =>
    r.json(),
  )) as { tasks: Array<{ id: string; issueId: string; task: unknown }> };
  console.log(
    `[phase3-e2e] issues=${issues.issues.length} tasks=${tasks.tasks.length}`,
  );
  if (!tasks.tasks[0]) throw new Error("No agent task generated");

  const cursorSession = await dispatchAgentTaskToCursor(
    bridge,
    store,
    tasks.tasks[0] as never,
    { observerBaseUrl: observerUrl },
  );
  console.log(
    `[phase3-e2e] cursor status=${cursorSession.status} result=${cursorSession.result_json?.status}`,
  );

  // Restart demo-app with fixed code (module already loaded buggy server — kill & restart)
  demo.kill();
  await new Promise((r) => setTimeout(r, 500));
  const demo2 = spawn(
    process.execPath,
    [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), "src/server.ts"],
    {
      cwd: path.join(repoRoot, "demo-app"),
      env: { ...process.env, DEMO_APP_PORT: "3000", DEMO_BUG_FIXED: "1", DEMO_BUG_ENABLED: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((r) => setTimeout(r, 1200));

  const unit = await run("npm", ["test", "--workspace=@abo/demo-app"], repoRoot, {
    DEMO_BUG_FIXED: "1",
    DEMO_BUG_ENABLED: "0",
  });
  console.log(`[phase3-e2e] unit tests exit=${unit.code}`);

  // Playwright verify
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded" });
  await page.fill("#username", "demo");
  await page.fill("#password", "demo123");
  await page.click("#login-btn");
  await page.waitForURL("**/dashboard", { timeout: 10_000 });
  const welcome = await page.locator("#welcome").textContent();
  await browser.close();
  console.log(`[phase3-e2e] playwright welcome=${welcome}`);

  const okLogin = await fetch("http://127.0.0.1:3000/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "demo", password: "demo123" }),
  });
  console.log(`[phase3-e2e] post-fix login status=${okLogin.status}`);

  const dash = await fetch(`${observerUrl}/api/cursor/status`).then((r) => r.json());
  console.log("\n=== Phase 3 E2E Summary ===");
  console.log(JSON.stringify({
    acpMode: mode,
    cursorSession: {
      status: cursorSession.status,
      result: cursorSession.result_json,
      files: cursorSession.files_changed,
    },
    unitExit: unit.code,
    postFixLogin: okLogin.status,
    playwright: welcome,
    dashboardCursor: dash.current?.status ?? dash.sessions?.[0]?.status,
  }, null, 2));

  const passed =
    cursorSession.result_json?.status === "FIXED" &&
    unit.code === 0 &&
    okLogin.status === 200 &&
    Boolean(welcome?.includes("succeeded"));

  demo2.kill();
  await bridge.close();
  realtime.close();
  store.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (!passed) {
    console.error("Phase 3 E2E FAILED");
    process.exit(1);
  }
  console.log("Phase 3 E2E PASSED");
}

main().catch(async (err) => {
  console.error("[phase3-e2e] failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
