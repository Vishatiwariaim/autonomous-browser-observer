import { randomUUID } from "node:crypto";
import type { ControllerEvent, EventGroup } from "./types.js";

const GROUP_WINDOW_MS = 8_000;

/**
 * Group related events into interaction windows.
 * PAGE_LOAD/navigation → click → network → console within a short window
 * become one EventGroup.
 */
export function groupEvents(
  events: ControllerEvent[],
  windowMs = GROUP_WINDOW_MS,
): EventGroup[] {
  if (events.length === 0) return [];

  const sorted = [...events].sort(
    (a, b) => timeOf(a) - timeOf(b),
  );

  const groups: EventGroup[] = [];
  let current: ControllerEvent[] = [];
  let windowStart = 0;

  const flush = () => {
    if (current.length === 0) return;
    const startedAt = current[0]!.timestamp;
    const endedAt = current[current.length - 1]!.timestamp;
    const primaryUrl = findUrl(current);
    groups.push({
      id: randomUUID(),
      sessionId: current[0]!.sessionId,
      startedAt,
      endedAt,
      eventIds: current.map((e) => e.id),
      events: [...current],
      primaryUrl,
      summary: summarizeGroup(current),
    });
    current = [];
  };

  for (const event of sorted) {
    const t = timeOf(event);
    if (current.length === 0) {
      current.push(event);
      windowStart = t;
      continue;
    }

    const shouldSplit =
      t - windowStart > windowMs &&
      isBoundaryEvent(event) &&
      !isErrorSignal(event);

    // Keep error signals attached to the active interaction window
    if (shouldSplit && !isErrorSignal(current[current.length - 1]!)) {
      flush();
      current.push(event);
      windowStart = t;
    } else {
      current.push(event);
      if (isErrorSignal(event)) {
        // extend window to absorb related follow-up
        windowStart = Math.max(windowStart, t - windowMs / 2);
      }
    }
  }
  flush();
  return groups;
}

/**
 * Find the group that best contains a trigger event (by id or proximity).
 */
export function findGroupForEvent(
  groups: EventGroup[],
  event: ControllerEvent,
): EventGroup | undefined {
  const direct = groups.find((g) => g.eventIds.includes(event.id));
  if (direct) return direct;

  const t = timeOf(event);
  let best: EventGroup | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const g of groups) {
    if (g.sessionId !== event.sessionId) continue;
    const mid = (timeOfIso(g.startedAt) + timeOfIso(g.endedAt)) / 2;
    const dist = Math.abs(mid - t);
    if (dist < bestDist) {
      bestDist = dist;
      best = g;
    }
  }
  return best;
}

function isBoundaryEvent(event: ControllerEvent): boolean {
  return event.type === "navigation" || event.type === "session_start";
}

function isErrorSignal(event: ControllerEvent): boolean {
  return (
    event.type === "console_error" ||
    event.type === "network_failure"
  );
}

function timeOf(event: ControllerEvent): number {
  return timeOfIso(event.timestamp || event.receivedAt || "");
}

function timeOfIso(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

function findUrl(events: ControllerEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i]!.payload;
    if (typeof p.url === "string") return p.url;
    if (typeof p.toUrl === "string") return p.toUrl;
    if (typeof p.pageUrl === "string") return p.pageUrl;
  }
  return undefined;
}

function summarizeGroup(events: ControllerEvent[]): string {
  const types = events.map((e) => e.type);
  const hasClick = types.includes("user_click");
  const hasNet = types.includes("network_failure");
  const hasConsole = types.includes("console_error");
  const hasNav = types.includes("navigation");
  const parts: string[] = [];
  if (hasNav) parts.push("navigation");
  if (hasClick) parts.push("click");
  if (hasNet) parts.push("network-failure");
  if (hasConsole) parts.push("console-error");
  if (parts.length === 0) parts.push(types.join("+") || "activity");
  return parts.join(" → ");
}

export function eventSummary(event: ControllerEvent): string {
  const p = event.payload;
  switch (event.type) {
    case "user_click":
      return `Click ${p.tag ?? "element"}${p.id ? `#${p.id}` : ""}${p.text ? ` "${String(p.text).slice(0, 40)}"` : ""}`;
    case "navigation":
      return `Navigate to ${p.toUrl ?? p.url ?? "?"}`;
    case "console_error":
      return `Console ${p.level ?? "error"}: ${String(p.message ?? "").slice(0, 80)}`;
    case "network_failure":
      return `Network ${(p.method as string) ?? "GET"} ${String(p.url ?? "").slice(0, 60)} → ${p.status ?? p.error ?? "fail"}`;
    case "page_snapshot":
      return `Snapshot ${p.title ?? p.url ?? ""}`;
    case "screenshot":
      return `Screenshot ${p.path ?? p.url ?? ""}`;
    default:
      return event.type;
  }
}
