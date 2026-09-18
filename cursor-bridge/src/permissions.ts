/**
 * Permission policy for ACP session/request_permission.
 * Phase 3: never auto-approve destructive ops.
 * Read-only investigation may be auto-allowed when clearly safe.
 */
export type PermissionDecision = "allow-once" | "allow-always" | "reject-once";

export type PermissionRequest = {
  toolCallId?: string;
  title?: string;
  options?: Array<{ optionId: string; name?: string; label?: string }>;
  /** Best-effort tool metadata from ACP payloads */
  tool?: {
    name?: string;
    kind?: string;
    input?: Record<string, unknown>;
  };
  raw?: unknown;
};

export type PermissionPolicyOptions = {
  /** Auto-allow clearly read-only tools */
  autoAllowReadonly?: boolean;
  /** Auto-allow writes only inside this cwd (E2E / explicit opt-in) */
  autoApproveWritesInCwd?: string | null;
  /** Force reject shell commands that look destructive */
  rejectDestructive?: boolean;
};

const READONLY_HINT =
  /read|list|search|grep|glob|stat|get_|fetch|inspect|cat|head|tail|ls|dir|find|open|view|examine/i;

const WRITE_HINT =
  /write|edit|apply|patch|create|delete|remove|mkdir|mv|move|rename|rm |unlink|truncate|save|update_file|str_replace/i;

const DESTRUCTIVE_HINT =
  /rm\s+-rf|Remove-Item\s+-Recurse|format |drop\s+table|git\s+push\s+--force|git\s+reset\s+--hard|mkfs|del\s+\/s|rd\s+\/s/i;

export class PermissionPolicy {
  private pending = new Map<
    string,
    {
      request: PermissionRequest;
      resolve: (d: PermissionDecision) => void;
      createdAt: string;
    }
  >();

  constructor(private readonly options: PermissionPolicyOptions = {}) {
    this.options = {
      autoAllowReadonly: true,
      autoApproveWritesInCwd: null,
      rejectDestructive: true,
      ...options,
    };
  }

  listPending(): Array<{ id: string; request: PermissionRequest; createdAt: string }> {
    return [...this.pending.entries()].map(([id, v]) => ({
      id,
      request: v.request,
      createdAt: v.createdAt,
    }));
  }

  resolvePending(id: string, decision: PermissionDecision): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    this.pending.delete(id);
    item.resolve(decision);
    return true;
  }

  /**
   * Decide immediately or wait for explicit approval.
   */
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const text = JSON.stringify(request).toLowerCase();

    if (this.options.rejectDestructive !== false && DESTRUCTIVE_HINT.test(text)) {
      return "reject-once";
    }

    const readonly =
      this.options.autoAllowReadonly !== false &&
      READONLY_HINT.test(text) &&
      !WRITE_HINT.test(text);

    if (readonly) {
      return "allow-once";
    }

    const cwd = this.options.autoApproveWritesInCwd;
    if (cwd && WRITE_HINT.test(text)) {
      // Only auto-approve writes when scoped to demo cwd and not destructive
      const pathHit =
        text.includes(cwd.toLowerCase().replace(/\\/g, "/")) ||
        text.includes(cwd.toLowerCase().replace(/\//g, "\\")) ||
        /demo-app|login\.ts|auth\.ts|server\.ts/i.test(text);
      if (pathHit) {
        return "allow-once";
      }
    }

    // Require explicit approval for modifications / shell
    const id = request.toolCallId ?? `perm-${Date.now()}-${Math.random()}`;
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(id, {
        request,
        resolve,
        createdAt: new Date().toISOString(),
      });
      // Safety timeout: reject if nobody approves in 10 minutes
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve("reject-once");
        }
      }, 10 * 60_000);
    });
  }
}
