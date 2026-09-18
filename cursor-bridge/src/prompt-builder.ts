import type { AgentTask } from "@abo/controller";

export function buildCursorPrompt(task: AgentTask, extras?: {
  issueId?: string;
  sessionId?: string;
  evidenceExtra?: string[];
  observerBaseUrl?: string;
}): string {
  const evidence = [...(task.evidence ?? []), ...(extras?.evidenceExtra ?? [])]
    .map((e) => `- ${e}`)
    .join("\n");

  return `You are investigating a browser-detected application issue via Autonomous Browser Observer (ABO).

TASK TYPE:
${task.task_type}

PRIORITY:
${task.priority}

PROBLEM:
${task.problem}

URL:
${task.url}

EXPECTED:
${task.expected_behavior}

ACTUAL:
${task.actual_behavior}

SUGGESTED AREA:
${task.suggested_area}

EVIDENCE:
${evidence || "- (see Observer MCP tools for more)"}

ISSUE ID: ${extras?.issueId ?? "unknown"}
BROWSER SESSION: ${extras?.sessionId ?? "unknown"}
OBSERVER: ${extras?.observerBaseUrl ?? "http://127.0.0.1:3847"}

INSTRUCTIONS:
1. Inspect the repository (cwd is the demo application).
2. Identify the likely root cause.
3. Explain the root cause before modifying files.
4. Do not make unrelated changes.
5. Make the smallest appropriate fix.
6. Run the relevant tests (npm test).
7. Run the application if necessary.
8. You may use Observer MCP tools for evidence:
   - get_issue, get_issue_evidence, get_console_errors, get_network_failures (read-only history)
   - request_browser_check — ask the extension to check the LIVE page (snapshot, find_element, screenshot, console_errors, network_failures)
   - await_browser_check — wait for a pending check result
9. If observation gaps block diagnosis (missing selectors, weak capture), you MAY improve files under extension/ with the smallest fix, then note that the user must rebuild/reload the extension.
10. Report exactly what changed.
11. Report test results.
12. Do not modify production systems.
13. Do not expose secrets.
14. When finished, call the Observer MCP tool report_cursor_result with a JSON object matching:
{
  "status": "INVESTIGATED|FIXED|FAILED|BLOCKED",
  "summary": "...",
  "root_cause": "...",
  "files_changed": [],
  "tests_run": [],
  "tests_passed": [],
  "tests_failed": [],
  "remaining_issue": "...",
  "requires_user_action": false
}

Also include that same JSON block in your final message inside a fenced code block labeled json.
`;
}
