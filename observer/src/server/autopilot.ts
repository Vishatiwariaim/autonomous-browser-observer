import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CursorBridge } from "@abo/cursor-bridge";
import type { AgentTaskRecord } from "@abo/controller";
import type { EventStore } from "./storage.js";
import { dispatchAgentTaskToCursor } from "./cursor-integration.js";
import type { CheckBus } from "./checks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

export type AutopilotStatus =
  | "idle"
  | "running"
  | "awaiting_checks"
  | "dispatching"
  | "verifying"
  | "retrying"
  | "succeeded"
  | "failed"
  | "exhausted";

export type AutopilotRun = {
  id: string;
  status: AutopilotStatus;
  enabled: boolean;
  maxAttempts: number;
  attempt: number;
  issueId?: string;
  taskId?: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  history: Array<{
    at: string;
    attempt: number;
    stage: string;
    detail: string;
  }>;
  verify?: { ok: boolean; detail: string };
  cursorStatus?: string;
};

function runCmd(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: true, env: { ...process.env } });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.stderr?.on("data", (d) => {
      out += String(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

/**
 * Phase 4 — keep fixing until verify PASS or max attempts.
 * Uses MCP-style checks (via CheckBus) before each dispatch so agent gets fresh evidence.
 */
export class Autopilot {
  private run: AutopilotRun;
  private busy = false;
  private listeners = new Set<(r: AutopilotRun) => void>();

  constructor(
    private store: EventStore,
    private bridge: CursorBridge | undefined,
    private checks: CheckBus,
    private opts: {
      observerBaseUrl: string;
      demoUrl?: string;
      maxAttempts?: number;
      enabled?: boolean;
    },
  ) {
    this.run = {
      id: `ap_${Date.now()}`,
      status: "idle",
      enabled: opts.enabled ?? process.env.ABO_AUTOPILOT === "1",
      maxAttempts: opts.maxAttempts ?? Number(process.env.ABO_AUTOPILOT_MAX ?? 3),
      attempt: 0,
      history: [],
    };
  }

  getState(): AutopilotRun {
    return { ...this.run, history: [...this.run.history] };
  }

  setEnabled(enabled: boolean): AutopilotRun {
    this.run.enabled = enabled;
    this.emit();
    return this.getState();
  }

  onUpdate(fn: (r: AutopilotRun) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.getState();
    for (const fn of this.listeners) fn(snap);
  }

  private log(stage: string, detail: string): void {
    this.run.history.push({
      at: new Date().toISOString(),
      attempt: this.run.attempt,
      stage,
      detail: detail.slice(0, 500),
    });
    if (this.run.history.length > 40) this.run.history.shift();
    this.emit();
  }

  /** Called when controller creates new issues/tasks */
  maybeStartFromLatest(): void {
    if (!this.run.enabled || this.busy) return;
    if (this.run.status === "running" || this.run.status === "dispatching") return;
    const tasks = this.store.listAgentTasks(5);
    const open = tasks.find((t) => t.status === "pending" || t.status === "ready");
    if (open) void this.start({ taskId: open.id, issueId: open.issueId });
  }

  async start(opts?: { taskId?: string; issueId?: string }): Promise<AutopilotRun> {
    if (this.busy) return this.getState();
    if (!this.bridge) {
      this.run.status = "failed";
      this.run.lastError = "Cursor bridge not available";
      this.emit();
      return this.getState();
    }

    this.busy = true;
    this.run = {
      ...this.run,
      id: `ap_${Date.now()}`,
      status: "running",
      attempt: 0,
      issueId: opts?.issueId,
      taskId: opts?.taskId,
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      lastError: undefined,
      history: [],
      verify: undefined,
      cursorStatus: undefined,
    };
    this.log("start", "Autopilot started");
    this.emit();

    try {
      while (this.run.attempt < this.run.maxAttempts) {
        this.run.attempt += 1;
        this.run.status = "awaiting_checks";
        this.emit();

        // Agent requirements: gather fresh browser evidence via check bus
        await this.gatherChecks();

        const task = this.resolveTask(opts?.taskId, opts?.issueId);
        if (!task) {
          this.run.status = "failed";
          this.run.lastError = "No agent task available";
          this.log("error", this.run.lastError);
          break;
        }
        this.run.taskId = task.id;
        this.run.issueId = task.issueId;

        this.run.status = "dispatching";
        this.log("dispatch", `ACP attempt ${this.run.attempt}/${this.run.maxAttempts}`);
        this.emit();

        const session = await dispatchAgentTaskToCursor(this.bridge, this.store, task, {
          observerBaseUrl: this.opts.observerBaseUrl,
        });
        const status = String(
          (session.result_json as { status?: string } | undefined)?.status ??
            session.status ??
            "",
        );
        this.run.cursorStatus = status;
        this.log("cursor", `result=${status}`);

        if (status === "BLOCKED") {
          this.run.status = "failed";
          this.run.lastError = "Cursor blocked — needs user approval";
          break;
        }

        this.run.status = "verifying";
        this.emit();
        const verify = await this.verifyFix();
        this.run.verify = verify;
        this.log("verify", verify.detail);

        if (verify.ok && (status === "FIXED" || status === "INVESTIGATED")) {
          this.run.status = "succeeded";
          this.log("done", "Verify PASS — loop stopped");
          break;
        }

        if (this.run.attempt >= this.run.maxAttempts) {
          this.run.status = "exhausted";
          this.run.lastError = "Max attempts reached without verify PASS";
          this.log("exhausted", this.run.lastError);
          break;
        }

        this.run.status = "retrying";
        this.log("retry", "Verify failed or not FIXED — retrying with fresh checks");
        this.emit();
        await sleep(800);
      }
    } catch (err) {
      this.run.status = "failed";
      this.run.lastError = err instanceof Error ? err.message : String(err);
      this.log("error", this.run.lastError);
    } finally {
      this.run.finishedAt = new Date().toISOString();
      if (
        this.run.status === "running" ||
        this.run.status === "dispatching" ||
        this.run.status === "verifying" ||
        this.run.status === "awaiting_checks" ||
        this.run.status === "retrying"
      ) {
        this.run.status = this.run.verify?.ok ? "succeeded" : "failed";
      }
      this.busy = false;
      this.emit();
    }

    return this.getState();
  }

  private resolveTask(taskId?: string, issueId?: string): AgentTaskRecord | undefined {
    if (taskId) {
      return this.store.listAgentTasks(100).find((t) => t.id === taskId);
    }
    if (issueId) {
      const forIssue = this.store.listTasksForIssue(issueId);
      if (forIssue[0]) return forIssue[0];
    }
    return this.store.listAgentTasks(10)[0];
  }

  private async gatherChecks(): Promise<void> {
    const types = ["console_errors", "network_failures", "snapshot", "extension_health"] as const;
    await Promise.all(
      types.map(async (type) => {
        const check = this.checks.create(type, {}, { source: "autopilot", timeoutMs: 1500 });
        await this.checks.waitFor(check.id, 2000);
        const done = this.checks.get(check.id);
        this.log(
          "check",
          `${type} → ${done?.status} via ${done?.fulfilledBy ?? "?"}`,
        );
      }),
    );
  }

  private async verifyFix(): Promise<{ ok: boolean; detail: string }> {
    const unit = await runCmd("npm", ["test", "--workspace=@abo/demo-app"], repoRoot);
    if (unit.code !== 0) {
      return { ok: false, detail: `unit tests failed: ${unit.out.slice(-400)}` };
    }

    const authPath = path.join(repoRoot, "demo-app/src/auth.ts");
    const src = await fs.readFile(authPath, "utf8");
    const looksFixed =
      /export const BUG_ENABLED\s*=\s*false/.test(src) &&
      !/INTENTIONAL BUG START/.test(src);
    if (!looksFixed) {
      return {
        ok: false,
        detail: "auth.ts still contains deliberate always-500 bug path",
      };
    }

    return {
      ok: true,
      detail: "unit OK + auth.ts fixed (BUG_ENABLED=false)",
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
