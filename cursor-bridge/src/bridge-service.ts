import { randomUUID } from "node:crypto";
import type { AgentTask } from "@abo/controller";
import { AcpClient, type AcpClientOptions } from "./acp-client.js";
import { PermissionPolicy } from "./permissions.js";
import { buildCursorPrompt } from "./prompt-builder.js";
import { parseCursorResult, type CursorResult } from "./result-parser.js";

export type CursorSessionRecord = {
  id: string;
  cursor_session_id: string | null;
  task_id: string;
  issue_id?: string;
  prompt: string;
  status:
    | "pending"
    | "starting"
    | "running"
    | "awaiting_permission"
    | "completed"
    | "failed"
    | "blocked";
  created_at: string;
  started_at?: string;
  completed_at?: string;
  response?: string;
  error?: string;
  result_json?: CursorResult | null;
  files_changed?: string[];
  workflow_stage?: string;
};

export type CursorSessionStore = {
  saveCursorSession(record: CursorSessionRecord): void;
  updateCursorSession(
    id: string,
    patch: Partial<CursorSessionRecord>,
  ): void;
  getCursorSession(id: string): CursorSessionRecord | undefined;
  listCursorSessions(limit?: number): CursorSessionRecord[];
  listPendingPermissions?(): unknown[];
};

export type BridgeRunInput = {
  task: AgentTask;
  taskId: string;
  issueId?: string;
  browserSessionId?: string;
  observerBaseUrl?: string;
  evidenceExtra?: string[];
};

/**
 * High-level bridge: create ACP session, send investigation prompt, parse result.
 */
export class CursorBridge {
  private client: AcpClient | null = null;
  private current: CursorSessionRecord | null = null;

  constructor(
    private readonly store: CursorSessionStore,
    private readonly acpOptions: AcpClientOptions,
  ) {}

  getClient(): AcpClient | null {
    return this.client;
  }

  getCurrent(): CursorSessionRecord | null {
    return this.current;
  }

  async connect(): Promise<{ connection: string; sessionId: string | null }> {
    if (!this.client) {
      const policy =
        this.acpOptions.permissionPolicy ??
        new PermissionPolicy({
          autoAllowReadonly: true,
          autoApproveWritesInCwd: this.acpOptions.cwd,
          rejectDestructive: true,
        });
      this.client = new AcpClient({
        ...this.acpOptions,
        permissionPolicy: policy,
        onPermission: () => {
          if (this.current) {
            this.store.updateCursorSession(this.current.id, {
              status: "awaiting_permission",
              workflow_stage: "CURSOR",
            });
          }
        },
      });
    }
    await this.client.start();
    return this.client.getStatus();
  }

  async runTask(input: BridgeRunInput): Promise<CursorSessionRecord> {
    const prompt = buildCursorPrompt(input.task, {
      issueId: input.issueId,
      sessionId: input.browserSessionId,
      observerBaseUrl: input.observerBaseUrl,
      evidenceExtra: input.evidenceExtra,
    });

    const record: CursorSessionRecord = {
      id: randomUUID(),
      cursor_session_id: null,
      task_id: input.taskId,
      issue_id: input.issueId,
      prompt,
      status: "starting",
      created_at: new Date().toISOString(),
      workflow_stage: "TASK",
    };
    this.store.saveCursorSession(record);
    this.current = record;

    try {
      await this.connect();
      const status = this.client!.getStatus();
      record.cursor_session_id = status.sessionId;
      record.status = "running";
      record.started_at = new Date().toISOString();
      record.workflow_stage = "CURSOR";
      this.store.updateCursorSession(record.id, {
        cursor_session_id: record.cursor_session_id,
        status: record.status,
        started_at: record.started_at,
        workflow_stage: record.workflow_stage,
      });

      const { transcript, stopReason, raw } = await this.client!.prompt(prompt);
      const parsed = parseCursorResult(transcript);
      record.response = transcript.slice(0, 100_000);
      record.result_json = parsed;
      record.files_changed = parsed?.files_changed ?? [];
      record.completed_at = new Date().toISOString();
      record.workflow_stage =
        parsed?.status === "FIXED"
          ? "VERIFY"
          : parsed?.status === "BLOCKED"
            ? "CURSOR"
            : "TEST";
      record.status =
        parsed?.status === "FIXED"
          ? "completed"
          : parsed?.status === "BLOCKED"
            ? "blocked"
            : parsed?.status === "FAILED"
              ? "failed"
              : "completed";

      this.store.updateCursorSession(record.id, {
        response: record.response,
        result_json: record.result_json,
        files_changed: record.files_changed,
        completed_at: record.completed_at,
        status: record.status,
        workflow_stage: record.workflow_stage,
        error: stopReason ? `stopReason=${stopReason}` : undefined,
      });

      // Keep raw stop info in response meta if no parsed JSON
      if (!parsed) {
        record.error = `Could not parse structured result (stopReason=${stopReason ?? "unknown"})`;
        this.store.updateCursorSession(record.id, {
          error: record.error,
          status: "failed",
          response: `${record.response}\n\n[raw]=${JSON.stringify(raw).slice(0, 2000)}`,
        });
      }

      this.current = this.store.getCursorSession(record.id) ?? record;
      return this.current;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.status = "failed";
      record.error = message;
      record.completed_at = new Date().toISOString();
      this.store.updateCursorSession(record.id, {
        status: "failed",
        error: message,
        completed_at: record.completed_at,
      });
      this.current = record;
      return record;
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
