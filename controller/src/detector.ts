import type { IssueClassification } from "@abo/ai";
import { eventSummary, findGroupForEvent, groupEvents } from "./grouper.js";
import type { ControllerEvent, DetectedCandidate, EventGroup } from "./types.js";

const NOISE_URL =
  /\/api\/events|\/api\/status|\/api\/extension|\/screenshots\/|\/ws|:3847\/(health)?$/i;

/**
 * Detect possible issues from a stream of events.
 * Not every error is a bug — classifications are hints for AI analysis.
 */
export function detectIssueCandidates(
  sessionEvents: ControllerEvent[],
  newEvents: ControllerEvent[],
): DetectedCandidate[] {
  const groups = groupEvents(sessionEvents);
  const candidates: DetectedCandidate[] = [];
  const fingerprints = new Map<string, number>();

  // Count repeats across session
  for (const event of sessionEvents) {
    if (event.type !== "console_error" && event.type !== "network_failure") {
      continue;
    }
    const fp = fingerprintFor(event);
    fingerprints.set(fp, (fingerprints.get(fp) ?? 0) + 1);
  }

  for (const event of newEvents) {
    if (event.type === "network_failure") {
      const url = String(event.payload.url ?? "");
      if (NOISE_URL.test(url)) continue;

      const status =
        typeof event.payload.status === "number"
          ? event.payload.status
          : undefined;
      const error =
        typeof event.payload.error === "string"
          ? event.payload.error
          : undefined;

      let hint: IssueClassification = "WARNING";
      let kind = "network_failure";
      if (status !== undefined && status >= 500) {
        hint = "POSSIBLE_ISSUE";
        kind = "http_5xx";
      } else if (status !== undefined && status >= 400) {
        hint = status === 404 ? "WARNING" : "POSSIBLE_ISSUE";
        kind = status === 404 ? "http_404" : "http_4xx";
      } else if (error) {
        hint = "POSSIBLE_ISSUE";
        kind = /timeout/i.test(error) ? "request_timeout" : "network_error";
      }

      const fp = fingerprintFor(event);
      const repeatCount = fingerprints.get(fp) ?? 1;
      if (repeatCount >= 3) hint = "CONFIRMED_ISSUE";

      candidates.push(
        buildCandidate({
          kind,
          classificationHint: hint,
          event,
          groups,
          sessionEvents,
          network: {
            url,
            method:
              typeof event.payload.method === "string"
                ? event.payload.method
                : undefined,
            status,
            error,
          },
          repeatCount,
          fingerprint: fp,
        }),
      );
    }

    if (event.type === "console_error") {
      const message = String(event.payload.message ?? "");
      if (!message.trim()) continue;
      // Ignore extension/observer noise
      if (/abo-observer|extension context invalidated/i.test(message)) continue;

      const crashLike =
        /uncaught|typeerror|referenceerror|is not a function|cannot read/i.test(
          message,
        ) || event.payload.level === "uncaught";

      let hint: IssueClassification = crashLike
        ? "CONFIRMED_ISSUE"
        : "POSSIBLE_ISSUE";
      const fp = fingerprintFor(event);
      const repeatCount = fingerprints.get(fp) ?? 1;
      if (repeatCount >= 3) hint = "CONFIRMED_ISSUE";

      candidates.push(
        buildCandidate({
          kind: crashLike ? "javascript_error" : "console_error",
          classificationHint: hint,
          event,
          groups,
          sessionEvents,
          consoleMessage: message,
          repeatCount,
          fingerprint: fp,
        }),
      );
    }

    // Unresponsive / broken button heuristic: click followed quickly by error in group
    if (event.type === "user_click") {
      const group = findGroupForEvent(groups, event);
      if (!group) continue;
      const after = group.events.filter(
        (e) =>
          timeOf(e) >= timeOf(event) &&
          (e.type === "console_error" || e.type === "network_failure"),
      );
      const label = `${event.payload.id ?? ""} ${event.payload.text ?? ""}`;
      if (/broken|fail|crash|error/i.test(label) && after.length > 0) {
        const fp = `broken-ui:${event.sessionId}:${event.payload.id ?? event.payload.text}`;
        candidates.push(
          buildCandidate({
            kind: "unresponsive_ui",
            classificationHint: "POSSIBLE_ISSUE",
            event,
            groups,
            sessionEvents,
            repeatCount: 1,
            fingerprint: fp,
          }),
        );
      }
    }
  }

  // Deduplicate by fingerprint within this batch (keep highest severity hint)
  return dedupeCandidates(candidates);
}

function buildCandidate(args: {
  kind: string;
  classificationHint: IssueClassification;
  event: ControllerEvent;
  groups: EventGroup[];
  sessionEvents: ControllerEvent[];
  network?: DetectedCandidate["network"];
  consoleMessage?: string;
  repeatCount: number;
  fingerprint: string;
}): DetectedCandidate {
  const group =
    findGroupForEvent(args.groups, args.event) ??
    ({
      id: "ungrouped",
      sessionId: args.event.sessionId,
      startedAt: args.event.timestamp,
      endedAt: args.event.timestamp,
      eventIds: [args.event.id],
      events: [args.event],
      primaryUrl: extractUrl(args.event),
      summary: eventSummary(args.event),
    } satisfies EventGroup);

  const idx = args.sessionEvents.findIndex((e) => e.id === args.event.id);
  const before =
    idx >= 0
      ? args.sessionEvents.slice(Math.max(0, idx - 5), idx)
      : group.events.slice(0, -1).slice(-5);
  const after =
    idx >= 0
      ? args.sessionEvents.slice(idx + 1, idx + 4)
      : [];

  const screenshot = [...group.events]
    .reverse()
    .find((e) => e.type === "screenshot");
  const snapshot = [...group.events]
    .reverse()
    .find((e) => e.type === "page_snapshot");

  const title =
    (typeof snapshot?.payload.title === "string"
      ? snapshot.payload.title
      : undefined) ??
    (typeof args.event.payload.title === "string"
      ? args.event.payload.title
      : undefined);

  const domHints: string[] = [];
  const dom = snapshot?.payload.domSummary as
    | { buttons?: Array<{ id?: string; text?: string }>; headings?: string[] }
    | undefined;
  if (dom?.headings) domHints.push(...dom.headings.slice(0, 5));
  if (dom?.buttons) {
    for (const b of dom.buttons.slice(0, 5)) {
      domHints.push(`button:${b.id ?? b.text ?? "?"}`);
    }
  }

  return {
    kind: args.kind,
    classificationHint: args.classificationHint,
    sessionId: args.event.sessionId,
    url: extractUrl(args.event) ?? group.primaryUrl,
    title,
    timestamp: args.event.timestamp,
    triggerEvent: args.event,
    group,
    network: args.network,
    consoleMessage: args.consoleMessage,
    screenshotPath:
      typeof screenshot?.payload.path === "string"
        ? screenshot.payload.path
        : undefined,
    eventsBefore: before,
    eventsAfter: after,
    recentActions: group.events.map(eventSummary).slice(0, 8),
    repeatCount: args.repeatCount,
    domHints,
    fingerprint: args.fingerprint,
  };
}

function fingerprintFor(event: ControllerEvent): string {
  if (event.type === "network_failure") {
    const url = String(event.payload.url ?? "").split("?")[0];
    const status = event.payload.status ?? event.payload.error ?? "";
    return `net:${event.payload.method ?? "GET"}:${url}:${status}`;
  }
  if (event.type === "console_error") {
    const msg = String(event.payload.message ?? "")
      .replace(/\d+/g, "#")
      .slice(0, 120);
    return `console:${msg}`;
  }
  return `${event.type}:${event.id}`;
}

function extractUrl(event: ControllerEvent): string | undefined {
  const p = event.payload;
  if (typeof p.url === "string") return p.url;
  if (typeof p.toUrl === "string") return p.toUrl;
  if (typeof p.pageUrl === "string") return p.pageUrl;
  return undefined;
}

function timeOf(event: ControllerEvent): number {
  return Date.parse(event.timestamp) || 0;
}

function severityRank(c: IssueClassification): number {
  switch (c) {
    case "CONFIRMED_ISSUE":
      return 3;
    case "POSSIBLE_ISSUE":
      return 2;
    case "WARNING":
      return 1;
    default:
      return 0;
  }
}

function dedupeCandidates(list: DetectedCandidate[]): DetectedCandidate[] {
  const map = new Map<string, DetectedCandidate>();
  for (const c of list) {
    const existing = map.get(c.fingerprint);
    if (
      !existing ||
      severityRank(c.classificationHint) >
        severityRank(existing.classificationHint)
    ) {
      map.set(c.fingerprint, c);
    }
  }
  return [...map.values()];
}
