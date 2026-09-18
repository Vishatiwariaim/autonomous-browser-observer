import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HeuristicAiAnalyzer } from "@abo/ai";
import {
  detectIssueCandidates,
  generateAgentTask,
  groupEvents,
  type ControllerEvent,
} from "@abo/controller";
import { redactEventPayload, redactValuePreview } from "../src/shared/redact.js";

function ev(
  partial: Partial<ControllerEvent> & {
    type: string;
    payload: Record<string, unknown>;
  },
): ControllerEvent {
  return {
    id: partial.id ?? crypto.randomUUID(),
    sessionId: partial.sessionId ?? "sess-1",
    type: partial.type,
    timestamp: partial.timestamp ?? new Date().toISOString(),
    payload: partial.payload,
  };
}

describe("event grouping", () => {
  it("groups click + network failure + console into one interaction", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const events = [
      ev({
        type: "navigation",
        timestamp: new Date(t0).toISOString(),
        payload: { toUrl: "http://localhost/app" },
      }),
      ev({
        type: "user_click",
        timestamp: new Date(t0 + 100).toISOString(),
        payload: { url: "http://localhost/app", tag: "button", id: "go" },
      }),
      ev({
        type: "network_failure",
        timestamp: new Date(t0 + 200).toISOString(),
        payload: {
          url: "http://localhost/api/x",
          status: 500,
          method: "POST",
        },
      }),
      ev({
        type: "console_error",
        timestamp: new Date(t0 + 250).toISOString(),
        payload: { message: "request failed", level: "error" },
      }),
    ];
    const groups = groupEvents(events);
    assert.ok(groups.length >= 1);
    const g = groups[0]!;
    assert.ok(g.eventIds.length >= 3);
    assert.match(g.summary, /click|network|console/i);
  });

  it("treats isolated navigation as normal activity group", () => {
    const events = [
      ev({
        type: "navigation",
        payload: { toUrl: "http://localhost/ok" },
      }),
      ev({
        type: "page_snapshot",
        payload: {
          url: "http://localhost/ok",
          title: "OK",
          visibleText: "hello",
          domSummary: {
            elementCount: 1,
            headings: [],
            buttons: [],
            inputs: [],
            links: [],
          },
        },
      }),
    ];
    const groups = groupEvents(events);
    assert.equal(groups.length, 1);
    const candidates = detectIssueCandidates(events, events);
    assert.equal(candidates.length, 0);
  });
});

describe("issue classification", () => {
  it("detects HTTP 500 as possible/confirmed issue", () => {
    const events = [
      ev({
        type: "user_click",
        payload: { url: "http://localhost/login", tag: "button", id: "login" },
      }),
      ev({
        id: "net1",
        type: "network_failure",
        payload: {
          url: "http://localhost/api/login",
          method: "POST",
          status: 500,
        },
      }),
    ];
    const candidates = detectIssueCandidates(events, [events[1]!]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.kind, "http_5xx");
    assert.ok(
      candidates[0]!.classificationHint === "POSSIBLE_ISSUE" ||
        candidates[0]!.classificationHint === "CONFIRMED_ISSUE",
    );
  });

  it("detects HTTP 404", () => {
    const e = ev({
      type: "network_failure",
      payload: { url: "http://localhost/missing", status: 404, method: "GET" },
    });
    const candidates = detectIssueCandidates([e], [e]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.kind, "http_404");
  });

  it("detects console / JS errors", () => {
    const e = ev({
      type: "console_error",
      payload: {
        level: "uncaught",
        message: "TypeError: x is not a function",
      },
    });
    const candidates = detectIssueCandidates([e], [e]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.kind, "javascript_error");
  });

  it("detects network failure without status", () => {
    const e = ev({
      type: "network_failure",
      payload: {
        url: "http://127.0.0.1:9/x",
        error: "Failed to fetch",
        method: "GET",
      },
    });
    const candidates = detectIssueCandidates([e], [e]);
    assert.equal(candidates.length, 1);
    assert.ok(["network_error", "request_timeout"].includes(candidates[0]!.kind));
  });

  it("marks repeated errors as confirmed", () => {
    const make = (id: string) =>
      ev({
        id,
        type: "network_failure",
        payload: {
          url: "http://localhost/api/login",
          method: "POST",
          status: 500,
        },
      });
    const all = [make("a"), make("b"), make("c")];
    const candidates = detectIssueCandidates(all, [all[2]!]);
    assert.equal(candidates[0]!.classificationHint, "CONFIRMED_ISSUE");
    assert.ok((candidates[0]!.repeatCount ?? 0) >= 3);
  });
});

describe("AI analysis + agent task", () => {
  it("produces structured JSON analysis for 500", async () => {
    const analyzer = new HeuristicAiAnalyzer();
    const result = await analyzer.analyze({
      sessionId: "s1",
      url: "http://localhost/login",
      title: "Login",
      timestamp: new Date().toISOString(),
      triggerEventType: "network_failure",
      triggerSummary: "POST /api/login → 500",
      recentActions: ["Click #login", "POST /api/login → 500"],
      consoleErrors: ["Login failed"],
      networkFailures: [
        { url: "http://localhost/api/login", method: "POST", status: 500 },
      ],
      eventsBefore: [
        { type: "user_click", summary: "Click login", timestamp: new Date().toISOString() },
      ],
      eventsAfter: [],
    });
    assert.ok(
      result.classification === "POSSIBLE_ISSUE" ||
        result.classification === "CONFIRMED_ISSUE",
    );
    assert.ok(result.confidence > 0.5);
    assert.ok(result.evidence.length > 0);
    assert.equal(result.requires_cursor, true);
  });

  it("generates agent task for significant issues", async () => {
    const analyzer = new HeuristicAiAnalyzer();
    const analysis = await analyzer.analyze({
      sessionId: "s1",
      url: "http://localhost/login",
      timestamp: new Date().toISOString(),
      triggerEventType: "network_failure",
      triggerSummary: "500",
      recentActions: [],
      consoleErrors: [],
      networkFailures: [
        { url: "http://localhost/api/login", method: "POST", status: 500 },
      ],
      eventsBefore: [],
      eventsAfter: [],
    });
    const candidate = detectIssueCandidates(
      [
        ev({
          type: "network_failure",
          payload: {
            url: "http://localhost/api/login",
            status: 500,
            method: "POST",
          },
        }),
      ],
      [
        ev({
          type: "network_failure",
          payload: {
            url: "http://localhost/api/login",
            status: 500,
            method: "POST",
          },
        }),
      ],
    )[0]!;
    const task = generateAgentTask(candidate, analysis);
    assert.ok(task);
    assert.equal(task!.task_type, "BUG_INVESTIGATION");
    assert.equal(task!.verification_required, true);
  });

  it("does not treat successful API as an issue", () => {
    const events = [
      ev({
        type: "navigation",
        payload: { toUrl: "http://localhost/" },
      }),
      ev({
        type: "page_snapshot",
        payload: {
          url: "http://localhost/",
          title: "Home",
          visibleText: "ok",
          domSummary: {
            elementCount: 1,
            headings: [],
            buttons: [],
            inputs: [],
            links: [],
          },
        },
      }),
    ];
    assert.equal(detectIssueCandidates(events, events).length, 0);
  });
});

describe("sensitive-data redaction", () => {
  it("redacts passwords and tokens before analysis storage shapes", () => {
    const payload = redactEventPayload({
      password: "hunter2",
      authorization: "Bearer abc.def.ghi",
      cookie: "session=abc",
      api_token: "sk-secret",
      note: "ok",
    });
    assert.equal(payload.password, "[REDACTED]");
    assert.equal(payload.authorization, "[REDACTED]");
    assert.equal(payload.cookie, "[REDACTED]");
    assert.equal(payload.api_token, "[REDACTED]");
    assert.equal(payload.note, "ok");

    const preview = redactValuePreview("password", "password", "hunter2");
    assert.equal(preview.valuePreview, "[REDACTED]");
  });
});
