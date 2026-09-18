import { z } from "zod";

export const IssueClassificationSchema = z.enum([
  "NORMAL",
  "WARNING",
  "POSSIBLE_ISSUE",
  "CONFIRMED_ISSUE",
]);

export type IssueClassification = z.infer<typeof IssueClassificationSchema>;

export const AiAnalysisResultSchema = z.object({
  classification: IssueClassificationSchema,
  title: z.string(),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  evidence: z.array(z.string()).max(20),
  likely_area: z.string(),
  recommended_next_step: z.string(),
  /** Whether a future Cursor investigation would be useful — never executes anything */
  requires_cursor: z.boolean(),
});

export type AiAnalysisResult = z.infer<typeof AiAnalysisResultSchema>;

/** Redacted structured evidence passed to the analyzer (never credentials). */
export type AnalysisEvidenceBundle = {
  sessionId: string;
  url?: string;
  title?: string;
  timestamp: string;
  triggerEventType: string;
  triggerSummary: string;
  recentActions: string[];
  consoleErrors: string[];
  networkFailures: Array<{
    url: string;
    method?: string;
    status?: number;
    error?: string;
  }>;
  screenshotPath?: string;
  eventsBefore: Array<{ type: string; summary: string; timestamp: string }>;
  eventsAfter: Array<{ type: string; summary: string; timestamp: string }>;
  repeatCount?: number;
  domHints?: string[];
};

/**
 * AI analysis interface.
 * Implementations MUST only return structured JSON and MUST NOT execute
 * commands, modify files, or contact remote systems unless explicitly configured
 * for a local model endpoint.
 */
export interface AiAnalyzer {
  readonly name: string;
  analyze(evidence: AnalysisEvidenceBundle): Promise<AiAnalysisResult>;
}
