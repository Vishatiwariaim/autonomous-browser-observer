import { randomUUID } from "node:crypto";
import {
  createAiAnalyzer,
  type AiAnalyzer,
  type AnalysisEvidenceBundle,
} from "@abo/ai";
import { detectIssueCandidates } from "./detector.js";
import { eventSummary, groupEvents } from "./grouper.js";
import { generateAgentTask, isSignificantIssue } from "./task-generator.js";
import type {
  AgentTaskRecord,
  AnalysisRecord,
  ControllerEvent,
  DetectedCandidate,
  EventGroup,
  IssueRecord,
} from "./types.js";

/** Persistence port — implemented by observer EventStore Phase 2 methods */
export interface ControllerStore {
  listEvents(limit?: number, sessionId?: string): ControllerEvent[];
  saveIssue(issue: IssueRecord): void;
  saveAnalysis(analysis: AnalysisRecord): void;
  saveAgentTask(task: AgentTaskRecord): void;
  findIssueByFingerprint(
    sessionId: string,
    fingerprint: string,
  ): IssueRecord | undefined;
  listIssues(limit?: number): IssueRecord[];
  getIssue(id: string): IssueRecord | undefined;
  listAnalysesForIssue(issueId: string): AnalysisRecord[];
  listTasksForIssue(issueId: string): AgentTaskRecord[];
  listRecentGroups?(limit?: number): EventGroup[];
  saveEventGroup?(group: EventGroup): void;
}

export type ControllerResult = {
  groups: EventGroup[];
  issues: IssueRecord[];
  analyses: AnalysisRecord[];
  tasks: AgentTaskRecord[];
};

/**
 * Phase 2 Controller:
 * receive events → group → detect → AI analyze → store issue → generate task.
 * Never modifies application code or executes shell commands.
 */
export class Controller {
  private readonly analyzer: AiAnalyzer;
  private processing = false;
  private pending: ControllerEvent[] = [];

  constructor(
    private readonly store: ControllerStore,
    analyzer?: AiAnalyzer,
  ) {
    this.analyzer = analyzer ?? createAiAnalyzer();
  }

  /** Called when observer ingests new events */
  async onEvents(events: ControllerEvent[]): Promise<ControllerResult> {
    this.pending.push(...events);
    if (this.processing) {
      return { groups: [], issues: [], analyses: [], tasks: [] };
    }
    this.processing = true;
    const allResults: ControllerResult = {
      groups: [],
      issues: [],
      analyses: [],
      tasks: [],
    };
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0, this.pending.length);
        const result = await this.processBatch(batch);
        allResults.groups.push(...result.groups);
        allResults.issues.push(...result.issues);
        allResults.analyses.push(...result.analyses);
        allResults.tasks.push(...result.tasks);
      }
    } finally {
      this.processing = false;
    }
    return allResults;
  }

  private async processBatch(
    newEvents: ControllerEvent[],
  ): Promise<ControllerResult> {
    const bySession = new Map<string, ControllerEvent[]>();
    for (const e of newEvents) {
      const list = bySession.get(e.sessionId) ?? [];
      list.push(e);
      bySession.set(e.sessionId, list);
    }

    const groups: EventGroup[] = [];
    const issues: IssueRecord[] = [];
    const analyses: AnalysisRecord[] = [];
    const tasks: AgentTaskRecord[] = [];

    for (const [sessionId, batch] of bySession) {
      const sessionEvents = this.store
        .listEvents(500, sessionId)
        .map(ensureControllerEvent);
      // Ensure newest batch ids are present (may already be in store)
      const known = new Set(sessionEvents.map((e) => e.id));
      for (const e of batch) {
        if (!known.has(e.id)) sessionEvents.push(ensureControllerEvent(e));
      }
      sessionEvents.sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
      );

      const sessionGroups = groupEvents(sessionEvents);
      for (const g of sessionGroups.slice(-5)) {
        this.store.saveEventGroup?.(g);
        groups.push(g);
      }

      const candidates = detectIssueCandidates(
        sessionEvents,
        batch.map(ensureControllerEvent),
      );

      for (const candidate of candidates) {
        const existing = this.store.findIssueByFingerprint(
          candidate.sessionId,
          candidate.fingerprint,
        );
        if (existing) {
          // Already tracked — skip duplicate issue creation
          continue;
        }

        const evidence = toEvidenceBundle(candidate);
        const analysis = await this.analyzer.analyze(evidence);
        if (!isSignificantIssue(analysis)) continue;

        const issue = toIssueRecord(candidate, analysis);
        this.store.saveIssue(issue);
        issues.push(issue);

        const analysisRecord: AnalysisRecord = {
          id: randomUUID(),
          issueId: issue.id,
          analyzer: this.analyzer.name,
          result: analysis,
          createdAt: new Date().toISOString(),
        };
        this.store.saveAnalysis(analysisRecord);
        analyses.push(analysisRecord);

        const task = generateAgentTask(candidate, analysis);
        if (task) {
          const taskRecord: AgentTaskRecord = {
            id: randomUUID(),
            issueId: issue.id,
            task,
            status: "pending",
            createdAt: new Date().toISOString(),
          };
          this.store.saveAgentTask(taskRecord);
          tasks.push(taskRecord);
        }
      }
    }

    return { groups, issues, analyses, tasks };
  }
}

function ensureControllerEvent(e: ControllerEvent): ControllerEvent {
  // Observer already redacts on ingest; controller never sees raw secrets.
  return e;
}

function toEvidenceBundle(c: DetectedCandidate): AnalysisEvidenceBundle {
  return {
    sessionId: c.sessionId,
    url: c.url,
    title: c.title,
    timestamp: c.timestamp,
    triggerEventType: c.triggerEvent.type,
    triggerSummary: eventSummary(c.triggerEvent),
    recentActions: c.recentActions,
    consoleErrors: c.consoleMessage
      ? [c.consoleMessage]
      : c.group.events
          .filter((e) => e.type === "console_error")
          .map((e) => String(e.payload.message ?? "")),
    networkFailures: c.network
      ? [c.network]
      : c.group.events
          .filter((e) => e.type === "network_failure")
          .map((e) => ({
            url: String(e.payload.url ?? ""),
            method:
              typeof e.payload.method === "string" ? e.payload.method : undefined,
            status:
              typeof e.payload.status === "number" ? e.payload.status : undefined,
            error:
              typeof e.payload.error === "string" ? e.payload.error : undefined,
          })),
    screenshotPath: c.screenshotPath,
    eventsBefore: c.eventsBefore.map((e) => ({
      type: e.type,
      summary: eventSummary(e),
      timestamp: e.timestamp,
    })),
    eventsAfter: c.eventsAfter.map((e) => ({
      type: e.type,
      summary: eventSummary(e),
      timestamp: e.timestamp,
    })),
    repeatCount: c.repeatCount,
    domHints: c.domHints,
  };
}

function toIssueRecord(
  c: DetectedCandidate,
  analysis: Awaited<ReturnType<AiAnalyzer["analyze"]>>,
): IssueRecord {
  const severity =
    analysis.classification === "CONFIRMED_ISSUE"
      ? analysis.confidence >= 0.9
        ? "CRITICAL"
        : "HIGH"
      : analysis.classification === "POSSIBLE_ISSUE"
        ? "HIGH"
        : analysis.classification === "WARNING"
          ? "MEDIUM"
          : "LOW";

  return {
    id: randomUUID(),
    sessionId: c.sessionId,
    classification: analysis.classification,
    severity,
    title: analysis.title,
    summary: analysis.summary,
    confidence: analysis.confidence,
    url: c.url,
    titlePage: c.title,
    timestamp: c.timestamp,
    fingerprint: c.fingerprint,
    groupId: c.group.id,
    triggerEventId: c.triggerEvent.id,
    relatedEventIds: c.group.eventIds,
    screenshotPath: c.screenshotPath,
    contextJson: {
      kind: c.kind,
      network: c.network,
      consoleMessage: c.consoleMessage,
      recentActions: c.recentActions,
      eventsBefore: c.eventsBefore.map((e) => ({
        id: e.id,
        type: e.type,
        summary: eventSummary(e),
      })),
      eventsAfter: c.eventsAfter.map((e) => ({
        id: e.id,
        type: e.type,
        summary: eventSummary(e),
      })),
      domHints: c.domHints,
      recommended_next_step: analysis.recommended_next_step,
      likely_area: analysis.likely_area,
    },
    createdAt: new Date().toISOString(),
  };
}

export function createController(store: ControllerStore): Controller {
  return new Controller(store);
}
