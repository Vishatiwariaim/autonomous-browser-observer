import type { ExtEventType, ObservationEvent } from "./types.js";

/** Map extension events → Observer API event `type` */
const TYPE_MAP: Record<ExtEventType, string> = {
  PAGE_LOAD: "page_snapshot",
  CLICK: "user_click",
  INPUT: "user_input",
  CONSOLE_ERROR: "console_error",
  NETWORK_ERROR: "network_failure",
  DOM_MUTATION: "dom_mutation",
  SCREENSHOT: "screenshot",
  HEARTBEAT: "extension_heartbeat",
  SESSION_START: "session_start",
  SESSION_END: "session_end",
  NAVIGATION: "navigation",
};

function normalizePayload(ev: ObservationEvent): Record<string, unknown> {
  const p = { ...ev.payload };
  const target = (p.target as Record<string, unknown> | undefined) ?? undefined;

  if (ev.type === "CLICK" && target) {
    return {
      url: ev.url,
      tag: String(target.tag ?? "unknown"),
      id: target.id,
      name: target.name,
      text: target.text,
      selectorHint: target.selectorHint,
      href: target.href,
      role: target.role,
      ariaLabel: target.ariaLabel,
      x: p.x,
      y: p.y,
      target,
      event_id: ev.event_id,
      extension_type: ev.type,
    };
  }

  if (ev.type === "INPUT" && target) {
    return {
      url: ev.url,
      tag: String(target.tag ?? "input"),
      id: target.id,
      name: target.name,
      inputType: target.type,
      valuePreview: p.value,
      redacted: p.redacted ?? true,
      target,
      event_id: ev.event_id,
      extension_type: ev.type,
    };
  }

  if (ev.type === "PAGE_LOAD") {
    return {
      ...p,
      url: (p.url as string) || ev.url,
      title: (p.title as string) || ev.title,
      event_id: ev.event_id,
      extension_type: ev.type,
    };
  }

  if (ev.type === "SCREENSHOT") {
    const dataUrl = String(p.dataUrl ?? "");
    const dataBase64 = dataUrl.includes(",")
      ? dataUrl.slice(dataUrl.indexOf(",") + 1)
      : dataUrl || undefined;
    return {
      url: ev.url,
      title: ev.title,
      mimeType: p.mimeType ?? "image/png",
      dataBase64,
      note: p.note,
      event_id: ev.event_id,
      extension_type: ev.type,
    };
  }

  if (ev.type === "CONSOLE_ERROR") {
    return {
      ...p,
      url: ev.url,
      event_id: ev.event_id,
      extension_type: ev.type,
    };
  }

  if (ev.type === "NETWORK_ERROR") {
    return {
      ...p,
      pageUrl: ev.url,
      event_id: ev.event_id,
      extension_type: ev.type,
    };
  }

  return {
    ...p,
    url: p.url ?? ev.url,
    title: p.title ?? ev.title,
    event_id: ev.event_id,
    extension_type: ev.type,
  };
}

export function toObserverIngestBody(events: ObservationEvent[]): {
  events: Array<{
    sessionId: string;
    type: string;
    timestamp: string;
    payload: Record<string, unknown>;
  }>;
} {
  return {
    events: events.map((ev) => ({
      sessionId: ev.session_id,
      type: TYPE_MAP[ev.type] ?? ev.type.toLowerCase(),
      timestamp: ev.timestamp,
      payload: normalizePayload(ev),
    })),
  };
}
