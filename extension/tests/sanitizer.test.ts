import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPasswordInput,
  isSensitiveFieldName,
  redactString,
  redactUrl,
  sanitizeHeaders,
  sanitizePayload,
  sanitizeValueForField,
} from "../src/shared/sanitizer.ts";
import { toObserverIngestBody } from "../src/shared/mapper.ts";
import type { ObservationEvent } from "../src/shared/types.ts";

describe("sanitizer", () => {
  it("detects password fields", () => {
    assert.equal(isPasswordInput({ type: "password", name: "x" }), true);
    assert.equal(isSensitiveFieldName("api_key"), true);
    assert.equal(isSensitiveFieldName("username"), false);
  });

  it("redacts tokens and cookies from strings", () => {
    const s = redactString("Authorization: Bearer abc.def.ghi Cookie: a=1");
    assert.match(s, /REDACTED/);
    assert.doesNotMatch(s, /abc\.def/);
  });

  it("redacts sensitive query params in URLs", () => {
    const u = redactUrl("https://app.test/login?token=sekrit&ok=1");
    assert.match(u, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
    assert.match(u, /ok=1/);
  });

  it("never returns raw password values", () => {
    assert.equal(sanitizeValueForField("password", "hunter2", true), "[REDACTED]");
    assert.equal(sanitizeValueForField("apiKey", "sk_live_abc", true), "[REDACTED]");
  });

  it("sanitizes nested payloads", () => {
    const out = sanitizePayload(
      { password: "x", nested: { token: "y", safe: "ok" } },
      true,
    ) as Record<string, unknown>;
    assert.equal(out.password, "[REDACTED]");
    assert.equal((out.nested as Record<string, unknown>).token, "[REDACTED]");
    assert.equal((out.nested as Record<string, unknown>).safe, "ok");
  });

  it("redacts auth headers", () => {
    const h = sanitizeHeaders({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    });
    assert.equal(h?.Authorization, "[REDACTED]");
    assert.equal(h?.["Content-Type"], "application/json");
  });
});

describe("mapper", () => {
  it("maps CLICK to user_click with url/tag", () => {
    const ev: ObservationEvent = {
      event_id: "evt_1",
      session_id: "sess_1",
      timestamp: new Date().toISOString(),
      type: "CLICK",
      url: "http://127.0.0.1:3000/",
      title: "Login",
      payload: {
        target: { tag: "button", id: "login", text: "Sign in", selectorHint: "button#login" },
        x: 10,
        y: 20,
      },
    };
    const body = toObserverIngestBody([ev]);
    assert.equal(body.events[0]?.type, "user_click");
    assert.equal(body.events[0]?.payload.tag, "button");
    assert.equal(body.events[0]?.payload.url, "http://127.0.0.1:3000/");
  });

  it("maps PAGE_LOAD to page_snapshot", () => {
    const ev: ObservationEvent = {
      event_id: "evt_2",
      session_id: "sess_1",
      timestamp: new Date().toISOString(),
      type: "PAGE_LOAD",
      url: "http://127.0.0.1:3847/extension-test",
      title: "ABO Extension Test",
      payload: {
        url: "http://127.0.0.1:3847/extension-test",
        title: "ABO Extension Test",
        visibleText: "hello",
        domSummary: { elementCount: 3, headings: ["ABO"], buttons: [], inputs: [], links: [] },
      },
    };
    const body = toObserverIngestBody([ev]);
    assert.equal(body.events[0]?.type, "page_snapshot");
    assert.equal(body.events[0]?.payload.visibleText, "hello");
  });
});
