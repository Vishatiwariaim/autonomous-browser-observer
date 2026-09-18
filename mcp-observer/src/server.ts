#!/usr/bin/env node
/**
 * Project-level MCP server exposing safe Observer tools to Cursor.
 * Read-only except report_cursor_result.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const OBSERVER_URL = (
  process.env.OBSERVER_URL ?? "http://127.0.0.1:3847"
).replace(/\/$/, "");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${OBSERVER_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

function scrub(value: unknown): unknown {
  // Defense in depth — never return obvious secrets to the model
  const raw = JSON.stringify(value);
  const cleaned = raw
    .replace(/"(password|passwd|pwd|token|authorization|cookie|api[_-]?key|secret|private[_-]?key)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer [REDACTED]");
  return JSON.parse(cleaned);
}

const server = new Server(
  { name: "abo-observer", version: "0.3.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_current_browser_session",
      description: "Get the most recent browser observation session summary",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_recent_browser_events",
      description: "List recent browser observation events (redacted)",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          sessionId: { type: "string" },
        },
      },
    },
    {
      name: "get_issue",
      description: "Get a detected issue by id, or the latest issue if omitted",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
      },
    },
    {
      name: "get_issue_evidence",
      description: "Get issue context, related events, analysis and task",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    {
      name: "get_console_errors",
      description: "Get recent console_error observation events",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" }, sessionId: { type: "string" } },
      },
    },
    {
      name: "get_network_failures",
      description: "Get recent network_failure observation events",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" }, sessionId: { type: "string" } },
      },
    },
    {
      name: "get_screenshot",
      description: "Get screenshot metadata/path for an event or latest screenshot",
      inputSchema: {
        type: "object",
        properties: { eventId: { type: "string" } },
      },
    },
    {
      name: "get_agent_task",
      description: "Get a generated agent task (latest or by issue id)",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
      },
    },
    {
      name: "request_browser_check",
      description:
        "Ask the browser extension (or Observer fallback) to run a live check: snapshot, find_element, screenshot, console_errors, network_failures, extension_health, recent_events, dom_summary",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "snapshot|find_element|screenshot|console_errors|network_failures|extension_health|recent_events|dom_summary",
          },
          params: { type: "object" },
          wait: { type: "boolean", description: "Wait for result (default true)" },
          timeoutMs: { type: "number" },
        },
        required: ["type"],
      },
    },
    {
      name: "await_browser_check",
      description: "Wait for / fetch a browser check by id",
      inputSchema: {
        type: "object",
        properties: {
          checkId: { type: "string" },
          wait: { type: "boolean" },
        },
        required: ["checkId"],
      },
    },
    {
      name: "start_autopilot",
      description: "Start Phase 4 autopilot: gather checks → Cursor fix → verify → retry until PASS",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          issueId: { type: "string" },
        },
      },
    },
    {
      name: "report_cursor_result",
      description:
        "Report structured Cursor investigation/fix result back to the Controller",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          issueId: { type: "string" },
          result: { type: "object" },
        },
        required: ["result"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    let payload: unknown;

    switch (name) {
      case "get_current_browser_session": {
        const sessions = await api<{ sessions: unknown[] }>("/api/sessions");
        payload = sessions.sessions[0] ?? null;
        break;
      }
      case "get_recent_browser_events": {
        const limit = Number(args.limit ?? 30);
        const q = new URLSearchParams({ limit: String(limit) });
        if (typeof args.sessionId === "string") q.set("sessionId", args.sessionId);
        payload = await api(`/api/events?${q}`);
        break;
      }
      case "get_issue": {
        if (typeof args.issueId === "string") {
          payload = await api(`/api/issues/${args.issueId}`);
        } else {
          const issues = await api<{ issues: unknown[] }>("/api/issues?limit=1");
          payload = issues.issues[0] ?? null;
        }
        break;
      }
      case "get_issue_evidence": {
        payload = await api(`/api/issues/${String(args.issueId)}`);
        break;
      }
      case "get_console_errors": {
        const limit = Number(args.limit ?? 50);
        const q = new URLSearchParams({ limit: String(limit) });
        if (typeof args.sessionId === "string") q.set("sessionId", args.sessionId);
        const events = await api<{ events: Array<{ type: string }> }>(
          `/api/events?${q}`,
        );
        payload = {
          events: events.events.filter((e) => e.type === "console_error"),
        };
        break;
      }
      case "get_network_failures": {
        const limit = Number(args.limit ?? 50);
        const q = new URLSearchParams({ limit: String(limit) });
        if (typeof args.sessionId === "string") q.set("sessionId", args.sessionId);
        const events = await api<{ events: Array<{ type: string }> }>(
          `/api/events?${q}`,
        );
        payload = {
          events: events.events.filter((e) => e.type === "network_failure"),
        };
        break;
      }
      case "get_screenshot": {
        if (typeof args.eventId === "string") {
          payload = await api(`/api/events/${args.eventId}`);
        } else {
          const events = await api<{
            events: Array<{ type: string; payload: Record<string, unknown> }>;
          }>("/api/events?limit=50");
          payload =
            events.events.find((e) => e.type === "screenshot") ?? null;
        }
        break;
      }
      case "get_agent_task": {
        if (typeof args.issueId === "string") {
          const detail = await api<{ tasks: unknown[] }>(
            `/api/issues/${args.issueId}`,
          );
          payload = detail.tasks?.[0] ?? null;
        } else {
          const tasks = await api<{ tasks: unknown[] }>("/api/agent-tasks?limit=1");
          payload = tasks.tasks[0] ?? null;
        }
        break;
      }
      case "request_browser_check": {
        payload = await api("/api/checks", {
          method: "POST",
          body: JSON.stringify({
            type: args.type,
            params: args.params ?? {},
            wait: args.wait !== false,
            timeoutMs: args.timeoutMs,
            source: "mcp",
          }),
        });
        break;
      }
      case "await_browser_check": {
        const q = args.wait === false ? "" : "?wait=1";
        payload = await api(`/api/checks/${String(args.checkId)}${q}`);
        break;
      }
      case "start_autopilot": {
        payload = await api("/api/autopilot/start", {
          method: "POST",
          body: JSON.stringify({
            taskId: args.taskId,
            issueId: args.issueId,
          }),
        });
        break;
      }
      case "report_cursor_result": {
        payload = await api("/api/cursor/results", {
          method: "POST",
          body: JSON.stringify({
            taskId: args.taskId,
            issueId: args.issueId,
            result: args.result,
          }),
        });
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(scrub(payload), null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
