import { z } from "zod";

/** Observation event kinds supported in Phase 1 */
export const ObservationEventTypeSchema = z.enum([
  "page_snapshot",
  "console_error",
  "network_failure",
  "user_click",
  "user_input",
  "navigation",
  "screenshot",
  "session_start",
  "session_end",
  "page_load",
  "dom_mutation",
  "extension_heartbeat",
]);

export type ObservationEventType = z.infer<typeof ObservationEventTypeSchema>;

export const DomElementSummarySchema = z.object({
  tag: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  text: z.string().optional(),
  href: z.string().optional(),
  role: z.string().optional(),
  ariaLabel: z.string().optional(),
  selectorHint: z.string().optional(),
});

export type DomElementSummary = z.infer<typeof DomElementSummarySchema>;

export const PageSnapshotPayloadSchema = z.object({
  url: z.string(),
  title: z.string(),
  visibleText: z.string(),
  domSummary: z.object({
    elementCount: z.number(),
    headings: z.array(z.string()).max(50),
    buttons: z.array(DomElementSummarySchema).max(100),
    inputs: z.array(DomElementSummarySchema).max(100),
    links: z.array(DomElementSummarySchema).max(50),
  }),
  viewport: z
    .object({
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

export const ConsoleErrorPayloadSchema = z.object({
  level: z.enum(["error", "warn", "uncaught", "unhandledrejection"]),
  message: z.string(),
  source: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  stack: z.string().optional(),
  url: z.string().optional(),
});

export const NetworkFailurePayloadSchema = z.object({
  url: z.string(),
  method: z.string().optional(),
  status: z.number().optional(),
  statusText: z.string().optional(),
  error: z.string().optional(),
  resourceType: z.string().optional(),
  pageUrl: z.string().optional(),
});

export const UserClickPayloadSchema = z.object({
  url: z.string(),
  tag: z.string(),
  id: z.string().optional(),
  text: z.string().optional(),
  selectorHint: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

export const UserInputPayloadSchema = z.object({
  url: z.string(),
  tag: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  inputType: z.string().optional(),
  /** Always redacted / truncated — never raw password values */
  valuePreview: z.string().optional(),
  redacted: z.boolean().default(true),
});

export const NavigationPayloadSchema = z.object({
  fromUrl: z.string().optional(),
  toUrl: z.string(),
  title: z.string().optional(),
});

export const ScreenshotPayloadSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  mimeType: z.string().default("image/png"),
  /** Base64 without data-URL prefix, or relative path after server save */
  dataBase64: z.string().optional(),
  path: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const ObservationEventSchema = z.object({
  id: z.string().uuid().optional(),
  sessionId: z.string().min(1),
  type: ObservationEventTypeSchema,
  timestamp: z.string().datetime().or(z.string().min(1)),
  tabId: z.number().optional(),
  payload: z.record(z.unknown()),
});

export type ObservationEvent = z.infer<typeof ObservationEventSchema>;

export const IngestBodySchema = z.object({
  events: z.array(ObservationEventSchema).min(1).max(100),
});

export type SessionSummary = {
  sessionId: string;
  startedAt: string;
  lastEventAt: string;
  eventCount: number;
  lastUrl?: string;
  lastTitle?: string;
};
