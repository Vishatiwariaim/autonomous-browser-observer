import path from "node:path";
import { fileURLToPath } from "node:url";
import { CursorBridge } from "@abo/cursor-bridge";
import type { AgentTask, AgentTaskRecord } from "@abo/controller";
import type { EventStore } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

export function resolveAcpLaunch(cwd: string): {
  agentCommand: string;
  agentArgs: string[];
  mode: "real" | "mock";
} {
  const mode = (process.env.ABO_ACP_MODE ?? "auto").toLowerCase();
  const useMock =
    mode === "mock" ||
    (mode === "auto" &&
      !process.env.CURSOR_API_KEY &&
      !process.env.CURSOR_AUTH_TOKEN &&
      process.env.ABO_FORCE_REAL_ACP !== "1");

  if (useMock) {
    const tsxCli = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
    return {
      mode: "mock",
      agentCommand: process.execPath,
      agentArgs: [tsxCli, path.join(repoRoot, "cursor-bridge/src/mock-acp-server.ts")],
    };
  }

  return {
    mode: "real",
    agentCommand: process.env.ABO_AGENT_COMMAND ?? "agent",
    agentArgs: ["acp"],
  };
}

export function createCursorBridge(store: EventStore, cwd = repoRoot): {
  bridge: CursorBridge;
  mode: "real" | "mock";
} {
  const launch = resolveAcpLaunch(cwd);
  const bridge = new CursorBridge(store, {
    cwd,
    agentCommand: launch.agentCommand,
    agentArgs: launch.agentArgs,
    apiKey: process.env.CURSOR_API_KEY,
    authToken: process.env.CURSOR_AUTH_TOKEN,
    env: {
      PATH: process.env.PATH,
      CURSOR_API_KEY: process.env.CURSOR_API_KEY,
      CURSOR_AUTH_TOKEN: process.env.CURSOR_AUTH_TOKEN,
    },
  });
  return { bridge, mode: launch.mode };
}

export async function dispatchAgentTaskToCursor(
  bridge: CursorBridge,
  store: EventStore,
  taskRecord: AgentTaskRecord,
  opts?: { observerBaseUrl?: string },
) {
  const issue = taskRecord.issueId
    ? store.getIssue(taskRecord.issueId)
    : undefined;
  return bridge.runTask({
    task: taskRecord.task as AgentTask,
    taskId: taskRecord.id,
    issueId: taskRecord.issueId,
    browserSessionId: issue?.sessionId,
    observerBaseUrl: opts?.observerBaseUrl,
    evidenceExtra: issue
      ? [
          `classification=${issue.classification}`,
          `confidence=${issue.confidence}`,
          ...(Array.isArray(issue.contextJson.recentActions)
            ? (issue.contextJson.recentActions as string[]).slice(0, 5)
            : []),
        ]
      : [],
  });
}
