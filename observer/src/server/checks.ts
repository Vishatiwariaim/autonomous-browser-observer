import { randomUUID } from "node:crypto";
import type { EventStore } from "./storage.js";

export type CheckType =
  | "snapshot"
  | "console_errors"
  | "network_failures"
  | "screenshot"
  | "find_element"
  | "dom_summary"
  | "recent_events"
  | "extension_health";

export type CheckStatus = "pending" | "fulfilled" | "timeout" | "failed" | "cancelled";

export type BrowserCheck = {
  id: string;
  type: CheckType;
  params: Record<string, unknown>;
  status: CheckStatus;
  source: "agent" | "mcp" | "autopilot" | "dashboard";
  createdAt: string;
  updatedAt: string;
  fulfilledAt?: string;
  timeoutMs: number;
  result?: Record<string, unknown>;
  error?: string;
  fulfilledBy?: "extension" | "server_fallback";
};

/**
 * Agent → Observer → Extension check bus.
 * Extension polls pending checks; if none respond in time, server fulfills from SQLite.
 */
export class CheckBus {
  private checks = new Map<string, BrowserCheck>();
  private waiters = new Map<
    string,
    { resolve: (c: BrowserCheck) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private store: EventStore) {}

  create(
    type: CheckType,
    params: Record<string, unknown> = {},
    opts?: { source?: BrowserCheck["source"]; timeoutMs?: number },
  ): BrowserCheck {
    const now = new Date().toISOString();
    const check: BrowserCheck = {
      id: randomUUID(),
      type,
      params,
      status: "pending",
      source: opts?.source ?? "agent",
      createdAt: now,
      updatedAt: now,
      timeoutMs: opts?.timeoutMs ?? 12_000,
    };
    this.checks.set(check.id, check);
    // Auto-timeout + server fallback
    setTimeout(() => {
      const current = this.checks.get(check.id);
      if (!current || current.status !== "pending") return;
      this.fulfillFromStore(current);
    }, check.timeoutMs);
    return check;
  }

  list(limit = 50): BrowserCheck[] {
    return [...this.checks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  get(id: string): BrowserCheck | undefined {
    return this.checks.get(id);
  }

  pendingForExtension(limit = 10): BrowserCheck[] {
    return [...this.checks.values()]
      .filter((c) => c.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  complete(
    id: string,
    result: Record<string, unknown>,
    fulfilledBy: "extension" | "server_fallback" = "extension",
  ): BrowserCheck | undefined {
    const check = this.checks.get(id);
    if (!check || check.status !== "pending") return check;
    check.status = "fulfilled";
    check.result = result;
    check.fulfilledBy = fulfilledBy;
    check.fulfilledAt = new Date().toISOString();
    check.updatedAt = check.fulfilledAt;
    this.notify(check);
    return check;
  }

  fail(id: string, error: string): BrowserCheck | undefined {
    const check = this.checks.get(id);
    if (!check || check.status !== "pending") return check;
    check.status = "failed";
    check.error = error;
    check.updatedAt = new Date().toISOString();
    this.notify(check);
    return check;
  }

  waitFor(id: string, timeoutMs?: number): Promise<BrowserCheck> {
    const existing = this.checks.get(id);
    if (!existing) return Promise.reject(new Error("check not found"));
    if (existing.status !== "pending") return Promise.resolve(existing);

    return new Promise((resolve) => {
      const ms = timeoutMs ?? existing.timeoutMs + 2000;
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        const c = this.checks.get(id);
        if (c && c.status === "pending") this.fulfillFromStore(c);
        resolve(this.checks.get(id) ?? existing);
      }, ms);
      this.waiters.set(id, { resolve, timer });
    });
  }

  private notify(check: BrowserCheck): void {
    const w = this.waiters.get(check.id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(check.id);
    w.resolve(check);
  }

  /** Fulfill from Observer SQLite when extension is offline / slow */
  fulfillFromStore(check: BrowserCheck): BrowserCheck {
    if (check.status !== "pending") return check;
    const sessionId =
      typeof check.params.sessionId === "string" ? check.params.sessionId : undefined;
    const events = this.store.listEvents(80, sessionId);
    let result: Record<string, unknown>;

    switch (check.type) {
      case "console_errors":
        result = {
          events: events.filter((e) => e.type === "console_error").slice(0, 20),
          note: "server_fallback from stored events",
        };
        break;
      case "network_failures":
        result = {
          events: events.filter((e) => e.type === "network_failure").slice(0, 20),
          note: "server_fallback from stored events",
        };
        break;
      case "screenshot": {
        const shot = events.find((e) => e.type === "screenshot");
        result = shot
          ? { event: shot, note: "server_fallback" }
          : { event: null, note: "no screenshot in store" };
        break;
      }
      case "snapshot":
      case "dom_summary": {
        const snap = events.find((e) => e.type === "page_snapshot");
        result = snap
          ? { event: snap, note: "server_fallback latest page_snapshot" }
          : { event: null, note: "no page_snapshot in store — load extension and browse" };
        break;
      }
      case "find_element": {
        const needle = String(check.params.selector ?? check.params.text ?? "");
        const snap = events.find((e) => e.type === "page_snapshot");
        const blob = JSON.stringify(snap?.payload ?? {});
        result = {
          found: needle ? blob.includes(needle) : false,
          needle,
          fromSnapshot: Boolean(snap),
          note: "server_fallback text search in last snapshot",
        };
        break;
      }
      case "recent_events":
        result = { events: events.slice(0, Number(check.params.limit ?? 30)) };
        break;
      case "extension_health":
        result = {
          note: "server_fallback — see /api/extension/status for live extension",
          eventCount: events.length,
        };
        break;
      default:
        result = { events: events.slice(0, 10), note: "server_fallback generic" };
    }

    return this.complete(check.id, result, "server_fallback")!;
  }
}
