import { z } from "zod";

export const CursorResultSchema = z.object({
  status: z.enum(["INVESTIGATED", "FIXED", "FAILED", "BLOCKED"]),
  summary: z.string(),
  root_cause: z.string().optional().default(""),
  files_changed: z.array(z.string()).optional().default([]),
  tests_run: z.array(z.string()).optional().default([]),
  tests_passed: z.array(z.string()).optional().default([]),
  tests_failed: z.array(z.string()).optional().default([]),
  remaining_issue: z.string().optional().default(""),
  requires_user_action: z.boolean().optional().default(false),
});

export type CursorResult = z.infer<typeof CursorResultSchema>;

/** Extract structured Cursor result from agent transcript text. */
export function parseCursorResult(transcript: string): CursorResult | null {
  // Prefer fenced json blocks
  const fence = transcript.match(/```json\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      const parsed = CursorResultSchema.safeParse(JSON.parse(fence[1]));
      if (parsed.success) return parsed.data;
    } catch {
      /* continue */
    }
  }

  // Fallback: find first JSON object with status field
  const start = transcript.indexOf('{"status"');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < transcript.length; i++) {
      const ch = transcript[i];
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = CursorResultSchema.safeParse(
              JSON.parse(transcript.slice(start, i + 1)),
            );
            if (parsed.success) return parsed.data;
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}
