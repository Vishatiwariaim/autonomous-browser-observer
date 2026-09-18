import {
  AiAnalysisResultSchema,
  type AiAnalysisResult,
  type AiAnalyzer,
  type AnalysisEvidenceBundle,
  type IssueClassification,
} from "./types.js";

/**
 * Local heuristic analyzer — deterministic Phase 2 default.
 * Produces the required structured JSON without calling external APIs
 * and without any ability to execute commands or modify files.
 */
export class HeuristicAiAnalyzer implements AiAnalyzer {
  readonly name = "heuristic-local-v1";

  async analyze(evidence: AnalysisEvidenceBundle): Promise<AiAnalysisResult> {
    const result = buildHeuristicResult(evidence);
    return AiAnalysisResultSchema.parse(result);
  }
}

function buildHeuristicResult(evidence: AnalysisEvidenceBundle): AiAnalysisResult {
  const failures = evidence.networkFailures;
  const status5xx = failures.find((f) => (f.status ?? 0) >= 500);
  const status4xx = failures.find(
    (f) => (f.status ?? 0) >= 400 && (f.status ?? 0) < 500,
  );
  const networkError = failures.find((f) => !f.status && f.error);
  const hasConsole = evidence.consoleErrors.length > 0;
  const repeated = (evidence.repeatCount ?? 1) >= 3;
  const triggerIsConsole =
    evidence.triggerEventType === "console_error" ||
    /console|javascript/i.test(evidence.triggerEventType);
  const triggerIsNetwork = evidence.triggerEventType === "network_failure";
  const brokenButton =
    /broken|fail|error|crash/i.test(evidence.triggerSummary) &&
    evidence.triggerEventType === "user_click" &&
    (hasConsole || failures.length > 0);

  let classification: IssueClassification = "NORMAL";
  let title = "No significant issue detected";
  let confidence = 0.55;
  let summary = "Observed activity appears within normal bounds.";
  let likely_area = "unknown";
  let recommended_next_step = "Continue monitoring";
  let requires_cursor = false;
  const evidenceLines: string[] = [];

  // Prefer signal that triggered detection so group context does not mis-label issues
  if (triggerIsConsole && hasConsole) {
    const msg = evidence.consoleErrors[0] ?? "console error";
    const crashLike = /uncaught|typeerror|referenceerror|is not a function|cannot read/i.test(
      msg,
    );
    classification = crashLike || repeated ? "CONFIRMED_ISSUE" : "POSSIBLE_ISSUE";
    title = crashLike ? "JavaScript runtime error" : "Console error observed";
    confidence = crashLike ? 0.9 : repeated ? 0.88 : 0.75;
    summary = `A console error was observed on ${evidence.url ?? "the page"}: ${truncate(msg, 160)}`;
    likely_area = "frontend JavaScript";
    recommended_next_step = "Inspect the stack trace and related UI action";
    requires_cursor = true;
    evidenceLines.push(`Console: ${truncate(msg, 200)}`);
    if (status5xx) {
      evidenceLines.push(
        `Related: ${(status5xx.method ?? "GET").toUpperCase()} ${shortUrl(status5xx.url)} returned ${status5xx.status}`,
      );
    }
  } else if (triggerIsNetwork && status5xx) {
    classification = repeated ? "CONFIRMED_ISSUE" : "POSSIBLE_ISSUE";
    if (hasConsole || repeated) classification = "CONFIRMED_ISSUE";
    title = `API returned HTTP ${status5xx.status}`;
    confidence = repeated ? 0.95 : hasConsole ? 0.92 : 0.85;
    summary = `A request to ${shortUrl(status5xx.url)} failed with an internal server error (${status5xx.status}).`;
    likely_area = inferArea(status5xx.url, "backend API");
    recommended_next_step = "Inspect the failing endpoint and server logs";
    requires_cursor = true;
    evidenceLines.push(
      `${(status5xx.method ?? "GET").toUpperCase()} ${shortUrl(status5xx.url)} returned ${status5xx.status}`,
    );
  } else if (status5xx && !triggerIsConsole) {
    classification = repeated ? "CONFIRMED_ISSUE" : "POSSIBLE_ISSUE";
    if (hasConsole || repeated) classification = "CONFIRMED_ISSUE";
    title = `API returned HTTP ${status5xx.status}`;
    confidence = repeated ? 0.95 : hasConsole ? 0.92 : 0.85;
    summary = `A request to ${shortUrl(status5xx.url)} failed with an internal server error (${status5xx.status}).`;
    likely_area = inferArea(status5xx.url, "backend API");
    recommended_next_step = "Inspect the failing endpoint and server logs";
    requires_cursor = true;
    evidenceLines.push(
      `${(status5xx.method ?? "GET").toUpperCase()} ${shortUrl(status5xx.url)} returned ${status5xx.status}`,
    );
  } else if (triggerIsNetwork && networkError) {
    classification = "POSSIBLE_ISSUE";
    title = "Network request failed";
    confidence = 0.8;
    summary = `A request to ${shortUrl(networkError.url)} failed: ${networkError.error ?? "network error"}.`;
    likely_area = inferArea(networkError.url, "network / API connectivity");
    recommended_next_step = "Verify the endpoint is reachable and CORS/network config";
    requires_cursor = true;
    evidenceLines.push(
      `Request to ${shortUrl(networkError.url)} failed (${networkError.error ?? "error"})`,
    );
  } else if (networkError && !triggerIsConsole) {
    classification = "POSSIBLE_ISSUE";
    title = "Network request failed";
    confidence = 0.8;
    summary = `A request to ${shortUrl(networkError.url)} failed: ${networkError.error ?? "network error"}.`;
    likely_area = inferArea(networkError.url, "network / API connectivity");
    recommended_next_step = "Verify the endpoint is reachable and CORS/network config";
    requires_cursor = true;
    evidenceLines.push(
      `Request to ${shortUrl(networkError.url)} failed (${networkError.error ?? "error"})`,
    );
  } else if (status4xx) {
    const is404 = status4xx.status === 404;
    const afterClick = evidence.eventsBefore.some((e) => e.type === "user_click");
    classification =
      is404 && !afterClick ? "WARNING" : afterClick ? "POSSIBLE_ISSUE" : "WARNING";
    title = `HTTP ${status4xx.status} response`;
    confidence = is404 ? 0.7 : 0.78;
    summary = `Request to ${shortUrl(status4xx.url)} returned HTTP ${status4xx.status}.`;
    likely_area = inferArea(status4xx.url, "frontend routing / API");
    recommended_next_step = is404
      ? "Confirm the resource URL is correct"
      : "Inspect client request and API validation";
    requires_cursor = classification === "POSSIBLE_ISSUE";
    evidenceLines.push(
      `${(status4xx.method ?? "GET").toUpperCase()} ${shortUrl(status4xx.url)} → ${status4xx.status}`,
    );
  } else if (hasConsole) {
    const msg = evidence.consoleErrors[0] ?? "console error";
    const crashLike = /uncaught|crash|cannot read|is not a function|typeerror/i.test(
      msg,
    );
    classification = crashLike || repeated ? "CONFIRMED_ISSUE" : "POSSIBLE_ISSUE";
    title = crashLike ? "JavaScript runtime error" : "Console error observed";
    confidence = crashLike ? 0.9 : repeated ? 0.88 : 0.75;
    summary = `A console error was observed on ${evidence.url ?? "the page"}: ${truncate(msg, 160)}`;
    likely_area = "frontend JavaScript";
    recommended_next_step = "Inspect the stack trace and related UI action";
    requires_cursor = true;
    evidenceLines.push(`Console: ${truncate(msg, 200)}`);
  } else if (brokenButton) {
    classification = "POSSIBLE_ISSUE";
    title = "UI action appears to trigger an error";
    confidence = 0.72;
    summary = `Click on "${evidence.triggerSummary}" was followed by error signals.`;
    likely_area = "UI interaction handler";
    recommended_next_step = "Inspect the click handler and related API calls";
    requires_cursor = true;
  } else if (
    evidence.triggerEventType === "navigation" &&
    /error|404|crash|fail/i.test(evidence.url ?? "")
  ) {
    classification = "WARNING";
    title = "Unexpected navigation / page state";
    confidence = 0.65;
    summary = `Navigated to a potentially unexpected URL: ${evidence.url}`;
    likely_area = "routing";
    recommended_next_step = "Confirm intended navigation targets";
    requires_cursor = false;
  }

  for (const action of evidence.recentActions.slice(0, 3)) {
    if (!evidenceLines.includes(action)) evidenceLines.push(action);
  }
  if (evidence.repeatCount && evidence.repeatCount > 1) {
    evidenceLines.push(`Similar signal repeated ${evidence.repeatCount} times`);
  }
  if (evidence.screenshotPath) {
    evidenceLines.push(`Screenshot: ${evidence.screenshotPath}`);
  }

  if (classification === "NORMAL" && evidenceLines.length === 0) {
    evidenceLines.push(evidence.triggerSummary || "benign observation");
  }

  return {
    classification,
    title,
    confidence,
    summary,
    evidence: evidenceLines.slice(0, 12),
    likely_area,
    recommended_next_step,
    requires_cursor,
  };
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.slice(0, 120) || url.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function inferArea(url: string, fallback: string): string {
  const lower = url.toLowerCase();
  if (/login|auth|session|token/.test(lower)) return "backend authentication";
  if (/api\//.test(lower)) return "backend API";
  if (/static|assets|\.js|\.css|\.png/.test(lower)) return "static resources";
  return fallback;
}
