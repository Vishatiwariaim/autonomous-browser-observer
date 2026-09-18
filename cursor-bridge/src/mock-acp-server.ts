#!/usr/bin/env node
/**
 * Mock ACP server for local E2E when Cursor CLI is not authenticated.
 * Speaks the same JSON-RPC ACP surface as `agent acp` (stdio, NDJSON).
 */
import readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const authFile = path.join(repoRoot, "demo-app/src/auth.ts");

let sessionId: string | null = null;
let nextServerId = 10_000;
const pendingPermission = new Map<
  number,
  { resolve: (optionId: string) => void }
>();

function write(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id: number, result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function notifyUpdate(text: string): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function requestPermission(title: string): Promise<string> {
  const id = nextServerId++;
  write({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      toolCallId: `mock-${id}`,
      title,
      options: [
        { optionId: "allow-once", name: "Allow once" },
        { optionId: "reject-once", name: "Reject" },
      ],
      tool: { name: "Edit", kind: "edit", input: { path: authFile } },
    },
  });
  return new Promise((resolve) => {
    pendingPermission.set(id, { resolve });
  });
}

async function applyFix(): Promise<void> {
  const fixed = `/**
 * Login authentication for demo-app.
 * Phase 3 bug fixed: valid credentials succeed; invalid return 401.
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

export const BUG_ENABLED = false;

export function authenticate(input: LoginInput): LoginResult {
  if (input.username === VALID_USER && input.password === VALID_PASS) {
    return { ok: true, redirectTo: "/dashboard" };
  }
  return { ok: false, status: 401, error: "Invalid credentials" };
}
`;
  await fs.writeFile(authFile, fixed, "utf8");
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: true,
      env: { ...process.env, DEMO_BUG_FIXED: "1", DEMO_BUG_ENABLED: "0" },
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

async function handlePrompt(id: number): Promise<void> {
  notifyUpdate("Investigating demo-app login HTTP 500...\n");
  notifyUpdate(
    "Root cause: authenticate() always returns 500 while BUG_ENABLED is true.\n",
  );

  const decision = await requestPermission(`Edit ${authFile}`);
  if (decision !== "allow-once" && decision !== "allow-always") {
    const blocked = {
      status: "BLOCKED",
      summary: "Could not modify files without permission",
      root_cause: "BUG_ENABLED forces HTTP 500",
      files_changed: [],
      tests_run: [],
      tests_passed: [],
      tests_failed: [],
      remaining_issue: "Login still returns 500",
      requires_user_action: true,
    };
    notifyUpdate(`\`\`\`json\n${JSON.stringify(blocked, null, 2)}\n\`\`\`\n`);
    respond(id, { stopReason: "end_turn" });
    return;
  }

  await applyFix();
  notifyUpdate("Applied minimal fix to demo-app/src/auth.ts\n");
  const test = await run("npm", ["test", "--workspace=@abo/demo-app"], repoRoot);
  notifyUpdate(test.out.slice(0, 2000));

  const result = {
    status: test.code === 0 ? "FIXED" : "FAILED",
    summary:
      test.code === 0
        ? "Removed deliberate always-500 bug; valid demo/demo123 now succeeds"
        : "Fix applied but tests failed",
    root_cause:
      "authenticate() short-circuited all logins with HTTP 500 when BUG_ENABLED was true",
    files_changed: ["demo-app/src/auth.ts"],
    tests_run: ["npm test --workspace=@abo/demo-app"],
    tests_passed: test.code === 0 ? ["npm test --workspace=@abo/demo-app"] : [],
    tests_failed: test.code === 0 ? [] : ["npm test --workspace=@abo/demo-app"],
    remaining_issue: test.code === 0 ? "" : "Unit tests failed after fix",
    requires_user_action: false,
  };
  notifyUpdate(`\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  respond(id, { stopReason: "end_turn" });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg: {
    id?: number;
    method?: string;
    result?: { outcome?: { optionId?: string } };
    params?: Record<string, unknown>;
  };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Client → server responses to our permission requests
  if (msg.id !== undefined && msg.result && pendingPermission.has(msg.id)) {
    const waiter = pendingPermission.get(msg.id)!;
    pendingPermission.delete(msg.id);
    waiter.resolve(msg.result.outcome?.optionId ?? "reject-once");
    return;
  }

  if (!msg.method || msg.id === undefined) return;

  if (msg.method === "initialize") {
    respond(msg.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "abo-mock-acp", version: "0.3.0" },
    });
    return;
  }
  if (msg.method === "authenticate") {
    respond(msg.id, { authenticated: true });
    return;
  }
  if (msg.method === "session/new") {
    sessionId = randomUUID();
    respond(msg.id, { sessionId });
    return;
  }
  if (msg.method === "session/cancel") {
    respond(msg.id, {});
    return;
  }
  if (msg.method === "session/prompt") {
    void handlePrompt(msg.id);
    return;
  }
  respond(msg.id, {});
});
