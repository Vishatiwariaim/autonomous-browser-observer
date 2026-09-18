import { z } from "zod";
import {
  IssueClassificationSchema,
  type AiAnalysisResult,
  type IssueClassification,
} from "@abo/ai";

export type ControllerEvent = {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  receivedAt?: string;
  tabId?: number;
  payload: Record<string, unknown>;
};

export type EventGroup = {
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  eventIds: string[];
  events: ControllerEvent[];
  primaryUrl?: string;
  summary: string;
};

export const AgentTaskSchema = z.object({
  task_type: z.literal("BUG_INVESTIGATION"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  url: z.string(),
  problem: z.string(),
  evidence: z.array(z.string()),
  expected_behavior: z.string(),
  actual_behavior: z.string(),
  suggested_area: z.string(),
  verification_required: z.boolean(),
});

export type AgentTask = z.infer<typeof AgentTaskSchema>;

export type DetectedCandidate = {
  kind: string;
  classificationHint: IssueClassification;
  sessionId: string;
  url?: string;
  title?: string;
  timestamp: string;
  triggerEvent: ControllerEvent;
  group: EventGroup;
  network?: {
    url: string;
    method?: string;
    status?: number;
    error?: string;
  };
  consoleMessage?: string;
  screenshotPath?: string;
  eventsBefore: ControllerEvent[];
  eventsAfter: ControllerEvent[];
  recentActions: string[];
  repeatCount: number;
  domHints: string[];
  fingerprint: string;
};

export type IssueRecord = {
  id: string;
  sessionId: string;
  classification: IssueClassification;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  summary: string;
  confidence: number;
  url?: string;
  titlePage?: string;
  timestamp: string;
  fingerprint: string;
  groupId?: string;
  triggerEventId: string;
  relatedEventIds: string[];
  screenshotPath?: string;
  contextJson: Record<string, unknown>;
  createdAt: string;
};

export type AnalysisRecord = {
  id: string;
  issueId: string;
  analyzer: string;
  result: AiAnalysisResult;
  createdAt: string;
};

export type AgentTaskRecord = {
  id: string;
  issueId: string;
  task: AgentTask;
  status: "pending" | "deferred";
  createdAt: string;
};

export { IssueClassificationSchema };
