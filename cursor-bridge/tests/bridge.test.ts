import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCursorPrompt } from "../src/prompt-builder.js";
import { parseCursorResult } from "../src/result-parser.js";
import { PermissionPolicy } from "../src/permissions.js";

describe("prompt builder", () => {
  it("includes task fields and safety instructions", () => {
    const prompt = buildCursorPrompt({
      task_type: "BUG_INVESTIGATION",
      priority: "HIGH",
      url: "http://localhost:3000/login",
      problem: "Login API returns HTTP 500",
      evidence: ["POST /api/login → 500"],
      expected_behavior: "Successful login redirects to dashboard",
      actual_behavior: "Login request fails",
      suggested_area: "authentication API",
      verification_required: true,
    });
    assert.match(prompt, /BUG_INVESTIGATION/);
    assert.match(prompt, /HTTP 500/);
    assert.match(prompt, /Do not expose secrets/);
    assert.match(prompt, /report_cursor_result/);
  });
});

describe("result parser", () => {
  it("parses fenced JSON result", () => {
    const text = `Done.\n\`\`\`json\n{"status":"FIXED","summary":"Fixed login","root_cause":"throw","files_changed":["src/auth.ts"],"tests_run":["npm test"],"tests_passed":["npm test"],"tests_failed":[],"remaining_issue":"","requires_user_action":false}\n\`\`\``;
    const parsed = parseCursorResult(text);
    assert.ok(parsed);
    assert.equal(parsed!.status, "FIXED");
    assert.deepEqual(parsed!.files_changed, ["src/auth.ts"]);
  });
});

describe("permission policy", () => {
  it("allows read-only and rejects destructive", async () => {
    const policy = new PermissionPolicy({
      autoAllowReadonly: true,
      rejectDestructive: true,
    });
    assert.equal(
      await policy.decide({ title: "Read file src/auth.ts", tool: { name: "Read" } }),
      "allow-once",
    );
    assert.equal(
      await policy.decide({
        title: "Shell rm -rf /",
        tool: { name: "Shell", input: { command: "rm -rf /" } },
      }),
      "reject-once",
    );
  });
});
