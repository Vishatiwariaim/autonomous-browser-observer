import type { AiAnalysisResult } from "@abo/ai";
import { AgentTaskSchema, type AgentTask, type DetectedCandidate } from "./types.js";

/**
 * Generate a structured agent task for future Cursor integration.
 * Phase 2 only creates the task record — it does NOT send it anywhere
 * and does NOT modify code.
 */
export function generateAgentTask(
  candidate: DetectedCandidate,
  analysis: AiAnalysisResult,
): AgentTask | null {
  if (!analysis.requires_cursor) return null;
  if (
    analysis.classification !== "POSSIBLE_ISSUE" &&
    analysis.classification !== "CONFIRMED_ISSUE"
  ) {
    return null;
  }

  const priority =
    analysis.classification === "CONFIRMED_ISSUE"
      ? analysis.confidence >= 0.9
        ? "CRITICAL"
        : "HIGH"
      : analysis.confidence >= 0.85
        ? "HIGH"
        : "MEDIUM";

  const task: AgentTask = {
    task_type: "BUG_INVESTIGATION",
    priority,
    url: candidate.url ?? "unknown",
    problem: analysis.title,
    evidence: analysis.evidence,
    expected_behavior: inferExpected(candidate, analysis),
    actual_behavior: analysis.summary,
    suggested_area: analysis.likely_area,
    verification_required: true,
  };

  return AgentTaskSchema.parse(task);
}

function inferExpected(
  candidate: DetectedCandidate,
  analysis: AiAnalysisResult,
): string {
  if (candidate.kind.startsWith("http_5")) {
    return "API request should succeed with a 2xx response";
  }
  if (candidate.kind === "http_404") {
    return "Requested resource should exist or client should handle absence gracefully";
  }
  if (candidate.kind.includes("javascript") || candidate.kind === "console_error") {
    return "Page should run without uncaught JavaScript errors";
  }
  if (candidate.kind === "unresponsive_ui") {
    return "UI control should respond without triggering errors";
  }
  return analysis.recommended_next_step;
}

/** Whether an analyzed issue is significant enough to store as an investigation item */
export function isSignificantIssue(analysis: AiAnalysisResult): boolean {
  if (analysis.classification === "NORMAL") return false;
  if (analysis.classification === "WARNING" && analysis.confidence < 0.7) {
    return false;
  }
  return true;
}
