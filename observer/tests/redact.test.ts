import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSensitiveFieldName,
  redactEventPayload,
  redactString,
  redactValuePreview,
  REDACTED_PLACEHOLDER,
} from "../src/shared/redact.js";

describe("redact", () => {
  it("detects sensitive field names", () => {
    assert.equal(isSensitiveFieldName("password"), true);
    assert.equal(isSensitiveFieldName("api_key"), true);
    assert.equal(isSensitiveFieldName("Authorization"), true);
    assert.equal(isSensitiveFieldName("username"), false);
  });

  it("redacts bearer tokens and jwt-like strings", () => {
    const input = "Authorization Bearer abcdef1234567890token";
    const out = redactString(input);
    assert.match(out, /\[REDACTED\]/);
    assert.equal(out.includes("abcdef1234567890token"), false);
  });

  it("redacts password value previews", () => {
    const result = redactValuePreview("password", "password", "hunter2");
    assert.equal(result.valuePreview, REDACTED_PLACEHOLDER);
    assert.equal(result.redacted, true);
  });

  it("deep-redacts event payloads", () => {
    const payload = redactEventPayload({
      url: "https://example.com",
      password: "secret",
      nested: { apiKey: "sk-abcdefghijklmnopqr", note: "ok" },
      message: "token Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb",
    });

    assert.equal(payload.password, REDACTED_PLACEHOLDER);
    assert.equal((payload.nested as Record<string, unknown>).apiKey, REDACTED_PLACEHOLDER);
    assert.equal((payload.nested as Record<string, unknown>).note, "ok");
    assert.match(String(payload.message), /\[REDACTED\]/);
  });
});
