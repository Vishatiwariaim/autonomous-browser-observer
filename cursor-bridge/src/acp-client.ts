import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { PermissionPolicy, type PermissionDecision, type PermissionRequest } from "./permissions.js";

export type AcpUpdate = {
  sessionId?: string;
  update?: Record<string, unknown>;
  raw: unknown;
};

export type AcpClientOptions = {
  cwd: string;
  agentCommand?: string;
  agentArgs?: string[];
  apiKey?: string;
  authToken?: string;
  permissionPolicy?: PermissionPolicy;
  onUpdate?: (update: AcpUpdate) => void;
  onPermission?: (req: PermissionRequest) => void;
  mcpServers?: unknown[];
  env?: Record<string, string | undefined>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

/**
 * Official Cursor ACP client — JSON-RPC 2.0 over stdio via `agent acp`.
 * Does not reverse-engineer Cursor or automate the GUI.
 */
export class AcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private bufferLines = "";
  private sessionId: string | null = null;
  private started = false;
  private readonly policy: PermissionPolicy;
  private messageLog: string[] = [];
  private connectionStatus: "disconnected" | "connecting" | "ready" | "error" =
    "disconnected";
  private lastError: string | null = null;

  constructor(private readonly options: AcpClientOptions) {
    this.policy =
      options.permissionPolicy ??
      new PermissionPolicy({
        autoAllowReadonly: true,
        autoApproveWritesInCwd: options.cwd,
        rejectDestructive: true,
      });
  }

  getStatus(): {
    connection: string;
    sessionId: string | null;
    lastError: string | null;
    pendingPermissions: number;
  } {
    return {
      connection: this.connectionStatus,
      sessionId: this.sessionId,
      lastError: this.lastError,
      pendingPermissions: this.policy.listPending().length,
    };
  }

  getMessageLog(): string[] {
    return [...this.messageLog];
  }

  getPermissionPolicy(): PermissionPolicy {
    return this.policy;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.connectionStatus = "connecting";

    const command = this.options.agentCommand ?? process.env.ABO_AGENT_COMMAND ?? "agent";
    const args = this.options.agentArgs ?? ["acp"];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
    };
    if (this.options.apiKey) env.CURSOR_API_KEY = this.options.apiKey;
    if (this.options.authToken) env.CURSOR_AUTH_TOKEN = this.options.authToken;

    this.proc = spawn(command, args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: process.platform === "win32" && command === "agent",
    });

    this.proc.on("error", (err) => {
      this.connectionStatus = "error";
      this.lastError = err.message;
    });
    this.proc.on("exit", (code) => {
      this.started = false;
      this.connectionStatus = "disconnected";
      if (code && code !== 0) {
        this.lastError = `agent acp exited with code ${code}`;
      }
      for (const [, p] of this.pending) {
        p.reject(new Error(this.lastError ?? "ACP process exited"));
      }
      this.pending.clear();
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onLine(line));

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text.trim()) this.messageLog.push(`[stderr] ${text.trim().slice(0, 500)}`);
    });

    this.started = true;

    await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "abo-cursor-bridge", version: "0.3.0" },
    });

    await this.send("authenticate", { methodId: "cursor_login" });

    const session = (await this.send("session/new", {
      cwd: this.options.cwd,
      mcpServers: this.options.mcpServers ?? [],
    })) as { sessionId: string };

    this.sessionId = session.sessionId;
    this.connectionStatus = "ready";
  }

  async ensureSession(): Promise<string> {
    if (!this.started || !this.sessionId) {
      await this.start();
    }
    return this.sessionId!;
  }

  async prompt(text: string): Promise<{
    stopReason?: string;
    raw: unknown;
    transcript: string;
  }> {
    const sessionId = await this.ensureSession();
    const before = this.messageLog.length;
    const result = await this.send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    const transcript = this.messageLog
      .slice(before)
      .filter((l) => l.startsWith("[agent]"))
      .map((l) => l.replace(/^\[agent\]\s*/, ""))
      .join("");
    return {
      stopReason: (result as { stopReason?: string })?.stopReason,
      raw: result,
      transcript,
    };
  }

  async cancel(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.send("session/cancel", { sessionId: this.sessionId });
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    try {
      await this.cancel();
    } catch {
      /* ignore */
    }
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
    this.started = false;
    this.connectionStatus = "disconnected";
  }

  approvePermission(id: string, decision: PermissionDecision = "allow-once"): boolean {
    return this.policy.resolvePending(id, decision);
  }

  private send(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error("ACP not started"));
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Long timeout for agent turns
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP timeout waiting for ${method}`));
        }
      }, 15 * 60_000);
    });
  }

  private respond(id: number, result: unknown): void {
    if (!this.proc) return;
    this.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`,
    );
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.messageLog.push(`[parse-error] ${trimmed.slice(0, 200)}`);
      return;
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const id = Number(msg.id);
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (msg.error) waiter.reject(msg.error);
      else waiter.resolve(msg.result);
      return;
    }

    if (msg.method === "session/update") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const update = (params.update ?? params) as Record<string, unknown>;
      this.options.onUpdate?.({
        sessionId: (params.sessionId as string) ?? this.sessionId ?? undefined,
        update,
        raw: msg,
      });
      const content = update.content as { text?: string } | undefined;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        content?.text
      ) {
        this.messageLog.push(`[agent] ${content.text}`);
      }
      return;
    }

    if (msg.method === "session/request_permission") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const request: PermissionRequest = {
        toolCallId: params.toolCallId as string | undefined,
        title: params.title as string | undefined,
        options: params.options as PermissionRequest["options"],
        tool: params.tool as PermissionRequest["tool"],
        raw: params,
      };
      this.options.onPermission?.(request);
      const id = Number(msg.id);
      void this.policy.decide(request).then((decision) => {
        this.respond(id, {
          outcome: { outcome: "selected", optionId: decision },
        });
      });
      return;
    }

    // Cursor extension methods
    if (msg.method === "cursor/ask_question") {
      const id = Number(msg.id);
      this.respond(id, { outcome: { outcome: "skipped", reason: "Phase 3 bridge auto-skip" } });
      return;
    }
    if (msg.method === "cursor/create_plan") {
      const id = Number(msg.id);
      // Plans that only investigate can be accepted; modifying plans still go through permissions
      this.respond(id, { outcome: { outcome: "accepted" } });
      return;
    }
    // Notifications: cursor/update_todos, cursor/task, cursor/generate_image — no response
  }
}
