import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { StoredEvent } from "./storage.js";
import type { AgentTaskRecord, AnalysisRecord, IssueRecord } from "@abo/controller";

export type WsOutboundMessage =
  | { type: "hello"; phase: number; mode: string }
  | { type: "events"; events: StoredEvent[] }
  | {
      type: "status";
      totalEvents: number;
      sessions: number;
      byType: Record<string, number>;
      issues?: number;
      agentTasks?: number;
      extension?: unknown;
    }
  | {
      type: "issues";
      issues: IssueRecord[];
      analyses: AnalysisRecord[];
      tasks: AgentTaskRecord[];
    };

export class ObserverRealtime {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
      this.clients.add(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          phase: 2,
          mode: "observe-readonly",
        } satisfies WsOutboundMessage),
      );
      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => this.clients.delete(socket));
    });
  }

  broadcast(message: WsOutboundMessage): void {
    const raw = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(raw);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
}
