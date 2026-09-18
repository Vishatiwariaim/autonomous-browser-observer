import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentTaskRecord,
  AnalysisRecord,
  ControllerEvent,
  ControllerStore,
  EventGroup,
  IssueRecord,
} from "@abo/controller";
import type { CursorSessionRecord, CursorSessionStore } from "@abo/cursor-bridge";
import type { ObservationEvent, SessionSummary } from "../shared/types.js";
import { redactEventPayload } from "../shared/redact.js";

export type StoredEvent = ObservationEvent & {
  id: string;
  receivedAt: string;
};

export type IngestListener = (events: StoredEvent[]) => void;

export class EventStore implements ControllerStore, CursorSessionStore {
  private readonly rootDir: string;
  private readonly screenshotsDir: string;
  private readonly dbPath: string;
  private db: DatabaseSync | null = null;
  private ready = false;
  private listeners = new Set<IngestListener>();

  constructor(dataDir: string) {
    this.rootDir = dataDir;
    this.screenshotsDir = path.join(dataDir, "screenshots");
    this.dbPath = path.join(dataDir, "observer.sqlite");
  }

  onIngest(listener: IngestListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(events: StoredEvent[]): void {
    for (const listener of this.listeners) {
      try {
        listener(events);
      } catch (err) {
        console.error(
          "[observer] ingest listener error:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.rootDir, { recursive: true });
    await fsp.mkdir(this.screenshotsDir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        last_url TEXT,
        last_title TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        received_at TEXT NOT NULL,
        tab_id INTEGER,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at DESC);

      CREATE TABLE IF NOT EXISTS event_groups (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        primary_url TEXT,
        event_ids_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        classification TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        confidence REAL NOT NULL,
        url TEXT,
        page_title TEXT,
        timestamp TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        group_id TEXT,
        trigger_event_id TEXT NOT NULL,
        related_event_ids_json TEXT NOT NULL,
        screenshot_path TEXT,
        context_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_fingerprint
        ON issues(session_id, fingerprint);
      CREATE INDEX IF NOT EXISTS idx_issues_created ON issues(created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_analysis (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        analyzer TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (issue_id) REFERENCES issues(id)
      );
      CREATE INDEX IF NOT EXISTS idx_ai_issue ON ai_analysis(issue_id);

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        task_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (issue_id) REFERENCES issues(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_issue ON agent_tasks(issue_id);

      CREATE TABLE IF NOT EXISTS cursor_sessions (
        id TEXT PRIMARY KEY,
        cursor_session_id TEXT,
        task_id TEXT NOT NULL,
        issue_id TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        response TEXT,
        error TEXT,
        result_json TEXT,
        files_changed_json TEXT,
        workflow_stage TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cursor_created ON cursor_sessions(created_at DESC);
    `);

    this.ready = true;
  }

  private assertReady(): DatabaseSync {
    if (!this.ready || !this.db) {
      throw new Error("EventStore not initialized");
    }
    return this.db;
  }

  async ingest(
    events: ObservationEvent[],
    maxScreenshotBytes: number,
  ): Promise<StoredEvent[]> {
    const db = this.assertReady();
    const stored: StoredEvent[] = [];

    const insertEvent = db.prepare(`
      INSERT INTO events (id, session_id, type, timestamp, received_at, tab_id, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertSession = db.prepare(`
      INSERT INTO sessions (session_id, started_at, last_event_at, event_count, last_url, last_title)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_event_at = excluded.last_event_at,
        event_count = event_count + 1,
        last_url = COALESCE(excluded.last_url, sessions.last_url),
        last_title = COALESCE(excluded.last_title, sessions.last_title)
    `);

    for (const event of events) {
      const id = event.id ?? randomUUID();
      const receivedAt = new Date().toISOString();
      let payload = redactEventPayload({ ...event.payload });

      if (event.type === "screenshot" && typeof payload.dataBase64 === "string") {
        const saved = await this.saveScreenshot(
          id,
          payload.dataBase64,
          maxScreenshotBytes,
        );
        payload = {
          ...payload,
          path: saved.path,
          byteLength: saved.byteLength,
        };
        delete payload.dataBase64;
      }

      if (event.type === "user_input") {
        payload = {
          ...payload,
          valuePreview: "[REDACTED]",
          redacted: true,
        };
      }

      const record: StoredEvent = {
        ...event,
        id,
        payload,
        receivedAt,
      };

      const url = extractUrl(payload);
      const title = typeof payload.title === "string" ? payload.title : undefined;

      db.exec("BEGIN");
      try {
        upsertSession.run(
          event.sessionId,
          event.timestamp,
          event.timestamp,
          url ?? null,
          title ?? null,
        );
        insertEvent.run(
          id,
          event.sessionId,
          event.type,
          event.timestamp,
          receivedAt,
          event.tabId ?? null,
          JSON.stringify(payload),
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      stored.push(record);
    }

    this.notify(stored);
    return stored;
  }

  private async saveScreenshot(
    eventId: string,
    dataBase64: string,
    maxBytes: number,
  ): Promise<{ path: string; byteLength: number }> {
    const cleaned = dataBase64.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(cleaned, "base64");
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        `Screenshot exceeds max size (${buffer.byteLength} > ${maxBytes})`,
      );
    }
    const fileName = `${eventId}.png`;
    const abs = path.join(this.screenshotsDir, fileName);
    await fsp.writeFile(abs, buffer);
    return {
      path: path.join("screenshots", fileName),
      byteLength: buffer.byteLength,
    };
  }

  listEvents(limit = 100, sessionId?: string): StoredEvent[] {
    const db = this.assertReady();
    const rows = sessionId
      ? (db
          .prepare(
            `SELECT * FROM events WHERE session_id = ? ORDER BY received_at DESC LIMIT ?`,
          )
          .all(sessionId, limit) as EventRow[])
      : (db
          .prepare(`SELECT * FROM events ORDER BY received_at DESC LIMIT ?`)
          .all(limit) as EventRow[]);
    // Controller expects chronological when analyzing; API returns newest-first.
    return rows.map(rowToEvent);
  }

  getEvent(id: string): StoredEvent | undefined {
    const db = this.assertReady();
    const row = db
      .prepare(`SELECT * FROM events WHERE id = ?`)
      .get(id) as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  listSessions(): SessionSummary[] {
    const db = this.assertReady();
    const rows = db
      .prepare(
        `SELECT session_id, started_at, last_event_at, event_count, last_url, last_title
         FROM sessions ORDER BY last_event_at DESC`,
      )
      .all() as Array<{
      session_id: string;
      started_at: string;
      last_event_at: string;
      event_count: number;
      last_url: string | null;
      last_title: string | null;
    }>;

    return rows.map((r) => ({
      sessionId: r.session_id,
      startedAt: r.started_at,
      lastEventAt: r.last_event_at,
      eventCount: r.event_count,
      lastUrl: r.last_url ?? undefined,
      lastTitle: r.last_title ?? undefined,
    }));
  }

  saveEventGroup(group: EventGroup): void {
    const db = this.assertReady();
    db.prepare(
      `INSERT OR REPLACE INTO event_groups
       (id, session_id, started_at, ended_at, summary, primary_url, event_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      group.id,
      group.sessionId,
      group.startedAt,
      group.endedAt,
      group.summary,
      group.primaryUrl ?? null,
      JSON.stringify(group.eventIds),
    );
  }

  saveIssue(issue: IssueRecord): void {
    const db = this.assertReady();
    db.prepare(
      `INSERT INTO issues (
        id, session_id, classification, severity, title, summary, confidence,
        url, page_title, timestamp, fingerprint, group_id, trigger_event_id,
        related_event_ids_json, screenshot_path, context_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      issue.id,
      issue.sessionId,
      issue.classification,
      issue.severity,
      issue.title,
      issue.summary,
      issue.confidence,
      issue.url ?? null,
      issue.titlePage ?? null,
      issue.timestamp,
      issue.fingerprint,
      issue.groupId ?? null,
      issue.triggerEventId,
      JSON.stringify(issue.relatedEventIds),
      issue.screenshotPath ?? null,
      JSON.stringify(issue.contextJson),
      issue.createdAt,
    );
  }

  saveAnalysis(analysis: AnalysisRecord): void {
    const db = this.assertReady();
    db.prepare(
      `INSERT INTO ai_analysis (id, issue_id, analyzer, result_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      analysis.id,
      analysis.issueId,
      analysis.analyzer,
      JSON.stringify(analysis.result),
      analysis.createdAt,
    );
  }

  saveAgentTask(task: AgentTaskRecord): void {
    const db = this.assertReady();
    db.prepare(
      `INSERT INTO agent_tasks (id, issue_id, task_json, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      task.id,
      task.issueId,
      JSON.stringify(task.task),
      task.status,
      task.createdAt,
    );
  }

  findIssueByFingerprint(
    sessionId: string,
    fingerprint: string,
  ): IssueRecord | undefined {
    const db = this.assertReady();
    const row = db
      .prepare(
        `SELECT * FROM issues WHERE session_id = ? AND fingerprint = ? LIMIT 1`,
      )
      .get(sessionId, fingerprint) as IssueRow | undefined;
    return row ? rowToIssue(row) : undefined;
  }

  listIssues(limit = 50): IssueRecord[] {
    const db = this.assertReady();
    const rows = db
      .prepare(`SELECT * FROM issues ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as IssueRow[];
    return rows.map(rowToIssue);
  }

  getIssue(id: string): IssueRecord | undefined {
    const db = this.assertReady();
    const row = db
      .prepare(`SELECT * FROM issues WHERE id = ?`)
      .get(id) as IssueRow | undefined;
    return row ? rowToIssue(row) : undefined;
  }

  listAnalysesForIssue(issueId: string): AnalysisRecord[] {
    const db = this.assertReady();
    const rows = db
      .prepare(
        `SELECT * FROM ai_analysis WHERE issue_id = ? ORDER BY created_at DESC`,
      )
      .all(issueId) as AnalysisRow[];
    return rows.map((r) => ({
      id: r.id,
      issueId: r.issue_id,
      analyzer: r.analyzer,
      result: JSON.parse(r.result_json),
      createdAt: r.created_at,
    }));
  }

  listTasksForIssue(issueId: string): AgentTaskRecord[] {
    const db = this.assertReady();
    const rows = db
      .prepare(
        `SELECT * FROM agent_tasks WHERE issue_id = ? ORDER BY created_at DESC`,
      )
      .all(issueId) as TaskRow[];
    return rows.map((r) => ({
      id: r.id,
      issueId: r.issue_id,
      task: JSON.parse(r.task_json),
      status: r.status as AgentTaskRecord["status"],
      createdAt: r.created_at,
    }));
  }

  listAgentTasks(limit = 50): AgentTaskRecord[] {
    const db = this.assertReady();
    const rows = db
      .prepare(`SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as TaskRow[];
    return rows.map((r) => ({
      id: r.id,
      issueId: r.issue_id,
      task: JSON.parse(r.task_json),
      status: r.status as AgentTaskRecord["status"],
      createdAt: r.created_at,
    }));
  }

  listAnalyses(limit = 50): AnalysisRecord[] {
    const db = this.assertReady();
    const rows = db
      .prepare(`SELECT * FROM ai_analysis ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as AnalysisRow[];
    return rows.map((r) => ({
      id: r.id,
      issueId: r.issue_id,
      analyzer: r.analyzer,
      result: JSON.parse(r.result_json),
      createdAt: r.created_at,
    }));
  }

  saveCursorSession(record: CursorSessionRecord): void {
    const db = this.assertReady();
    db.prepare(
      `INSERT INTO cursor_sessions (
        id, cursor_session_id, task_id, issue_id, prompt, status,
        created_at, started_at, completed_at, response, error,
        result_json, files_changed_json, workflow_stage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.cursor_session_id,
      record.task_id,
      record.issue_id ?? null,
      record.prompt,
      record.status,
      record.created_at,
      record.started_at ?? null,
      record.completed_at ?? null,
      record.response ?? null,
      record.error ?? null,
      record.result_json ? JSON.stringify(record.result_json) : null,
      JSON.stringify(record.files_changed ?? []),
      record.workflow_stage ?? null,
    );
  }

  updateCursorSession(id: string, patch: Partial<CursorSessionRecord>): void {
    const existing = this.getCursorSession(id);
    if (!existing) return;
    const next = { ...existing, ...patch };
    const db = this.assertReady();
    db.prepare(
      `UPDATE cursor_sessions SET
        cursor_session_id = ?, task_id = ?, issue_id = ?, prompt = ?, status = ?,
        created_at = ?, started_at = ?, completed_at = ?, response = ?, error = ?,
        result_json = ?, files_changed_json = ?, workflow_stage = ?
       WHERE id = ?`,
    ).run(
      next.cursor_session_id,
      next.task_id,
      next.issue_id ?? null,
      next.prompt,
      next.status,
      next.created_at,
      next.started_at ?? null,
      next.completed_at ?? null,
      next.response ?? null,
      next.error ?? null,
      next.result_json ? JSON.stringify(next.result_json) : null,
      JSON.stringify(next.files_changed ?? []),
      next.workflow_stage ?? null,
      id,
    );
  }

  getCursorSession(id: string): CursorSessionRecord | undefined {
    const db = this.assertReady();
    const row = db
      .prepare(`SELECT * FROM cursor_sessions WHERE id = ?`)
      .get(id) as CursorSessionRow | undefined;
    return row ? rowToCursor(row) : undefined;
  }

  listCursorSessions(limit = 50): CursorSessionRecord[] {
    const db = this.assertReady();
    const rows = db
      .prepare(`SELECT * FROM cursor_sessions ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as CursorSessionRow[];
    return rows.map(rowToCursor);
  }

  getStats(): {
    totalEvents: number;
    byType: Record<string, number>;
    sessions: number;
    issues: number;
    agentTasks: number;
    cursorSessions: number;
  } {
    const db = this.assertReady();
    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }
    ).c;
    const sessions = (
      db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }
    ).c;
    const issues = (
      db.prepare(`SELECT COUNT(*) AS c FROM issues`).get() as { c: number }
    ).c;
    const agentTasks = (
      db.prepare(`SELECT COUNT(*) AS c FROM agent_tasks`).get() as { c: number }
    ).c;
    const cursorSessions = (
      db.prepare(`SELECT COUNT(*) AS c FROM cursor_sessions`).get() as {
        c: number;
      }
    ).c;
    const typeRows = db
      .prepare(`SELECT type, COUNT(*) AS c FROM events GROUP BY type`)
      .all() as Array<{ type: string; c: number }>;
    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[row.type] = row.c;
    }
    return {
      totalEvents: total,
      byType,
      sessions,
      issues,
      agentTasks,
      cursorSessions,
    };
  }

  getScreenshotsDir(): string {
    return this.screenshotsDir;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.ready = false;
    }
  }
}

type EventRow = {
  id: string;
  session_id: string;
  type: string;
  timestamp: string;
  received_at: string;
  tab_id: number | null;
  payload_json: string;
};

type IssueRow = {
  id: string;
  session_id: string;
  classification: string;
  severity: string;
  title: string;
  summary: string;
  confidence: number;
  url: string | null;
  page_title: string | null;
  timestamp: string;
  fingerprint: string;
  group_id: string | null;
  trigger_event_id: string;
  related_event_ids_json: string;
  screenshot_path: string | null;
  context_json: string;
  created_at: string;
};

type AnalysisRow = {
  id: string;
  issue_id: string;
  analyzer: string;
  result_json: string;
  created_at: string;
};

type TaskRow = {
  id: string;
  issue_id: string;
  task_json: string;
  status: string;
  created_at: string;
};

type CursorSessionRow = {
  id: string;
  cursor_session_id: string | null;
  task_id: string;
  issue_id: string | null;
  prompt: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  response: string | null;
  error: string | null;
  result_json: string | null;
  files_changed_json: string | null;
  workflow_stage: string | null;
};

function rowToCursor(row: CursorSessionRow): CursorSessionRecord {
  return {
    id: row.id,
    cursor_session_id: row.cursor_session_id,
    task_id: row.task_id,
    issue_id: row.issue_id ?? undefined,
    prompt: row.prompt,
    status: row.status as CursorSessionRecord["status"],
    created_at: row.created_at,
    started_at: row.started_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
    response: row.response ?? undefined,
    error: row.error ?? undefined,
    result_json: row.result_json ? JSON.parse(row.result_json) : null,
    files_changed: row.files_changed_json
      ? (JSON.parse(row.files_changed_json) as string[])
      : [],
    workflow_stage: row.workflow_stage ?? undefined,
  };
}

function rowToEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type as StoredEvent["type"],
    timestamp: row.timestamp,
    receivedAt: row.received_at,
    tabId: row.tab_id ?? undefined,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function rowToIssue(row: IssueRow): IssueRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    classification: row.classification as IssueRecord["classification"],
    severity: row.severity as IssueRecord["severity"],
    title: row.title,
    summary: row.summary,
    confidence: row.confidence,
    url: row.url ?? undefined,
    titlePage: row.page_title ?? undefined,
    timestamp: row.timestamp,
    fingerprint: row.fingerprint,
    groupId: row.group_id ?? undefined,
    triggerEventId: row.trigger_event_id,
    relatedEventIds: JSON.parse(row.related_event_ids_json) as string[],
    screenshotPath: row.screenshot_path ?? undefined,
    contextJson: JSON.parse(row.context_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function extractUrl(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.url === "string") return payload.url;
  if (typeof payload.toUrl === "string") return payload.toUrl;
  if (typeof payload.pageUrl === "string") return payload.pageUrl;
  return undefined;
}

export function ensureDataDir(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
}

export function asControllerEvents(events: StoredEvent[]): ControllerEvent[] {
  return events.map((e) => ({
    id: e.id!,
    sessionId: e.sessionId,
    type: e.type,
    timestamp: e.timestamp,
    receivedAt: e.receivedAt,
    tabId: e.tabId,
    payload: e.payload,
  }));
}
