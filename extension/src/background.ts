import { toObserverIngestBody } from "./shared/mapper.js";
import { redactUrl, sanitizeHeaders, sanitizePayload } from "./shared/sanitizer.js";
import { getSessionId, loadSettings, saveSettings } from "./shared/storage.js";
import {
  newEventId,
  type ExtEventType,
  type ExtSettings,
  type ObservationEvent,
} from "./shared/types.js";

interface ConnectionState {
  connected: boolean;
  lastOkAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
  eventsSent: number;
  queueDepth: number;
  extensionId: string;
  version: string;
}

const state: ConnectionState = {
  connected: false,
  lastOkAt: null,
  lastError: null,
  lastEventAt: null,
  eventsSent: 0,
  queueDepth: 0,
  extensionId: chrome.runtime.id,
  version: chrome.runtime.getManifest().version,
};

let settings: ExtSettings;
const queue: ObservationEvent[] = [];
const recentFingerprints = new Map<string, number>();
const DEDUPE_MS = 2500;
let flushing = false;

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (settings?.apiToken) headers["X-ABO-Token"] = settings.apiToken;
  return headers;
}

async function init(): Promise<void> {
  settings = await loadSettings();
  await emitLocal("SESSION_START", "chrome://newtab/", "ABO Extension", {
    extensionVersion: state.version,
    extensionId: state.extensionId,
  });
  chrome.alarms.create("abo_heartbeat", { periodInMinutes: 0.5 });
  chrome.alarms.create("abo_flush", { periodInMinutes: 0.2 });
  chrome.alarms.create("abo_checks", { periodInMinutes: 0.1 });
  void pingAndHeartbeat();
  void pollAgentChecks();
}

function fingerprint(ev: ObservationEvent): string {
  const keyBits = [
    ev.type,
    ev.url,
    String(ev.payload.message ?? ""),
    String(ev.payload.status ?? ""),
    String((ev.payload.target as { selectorHint?: string } | undefined)?.selectorHint ?? ""),
    String(ev.payload.addedNodes ?? ""),
  ];
  return keyBits.join("|").slice(0, 400);
}

function isDuplicate(ev: ObservationEvent): boolean {
  const fp = fingerprint(ev);
  const now = Date.now();
  const prev = recentFingerprints.get(fp);
  recentFingerprints.set(fp, now);
  if (recentFingerprints.size > 500) {
    for (const [k, t] of recentFingerprints) {
      if (now - t > DEDUPE_MS * 4) recentFingerprints.delete(k);
    }
  }
  return prev !== undefined && now - prev < DEDUPE_MS;
}

async function emitLocal(
  type: ExtEventType,
  url: string,
  title: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!settings?.enabled && type !== "HEARTBEAT" && type !== "SESSION_START") return;

  const session_id = await getSessionId();
  const ev: ObservationEvent = {
    event_id: newEventId(),
    session_id,
    timestamp: new Date().toISOString(),
    type,
    url: redactUrl(url || ""),
    title: (title || "").slice(0, 300),
    payload: sanitizePayload(payload, settings.redactSensitive),
  };

  if (type !== "HEARTBEAT" && isDuplicate(ev)) return;

  queue.push(ev);
  while (queue.length > settings.maxQueueSize) queue.shift();
  state.queueDepth = queue.length;
  void flushQueue();
}

async function flushQueue(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, 20);
      const ok = await postEvents(batch);
      if (!ok) {
        queue.unshift(...batch);
        break;
      }
      state.eventsSent += batch.length;
      state.lastEventAt = batch[batch.length - 1]?.timestamp ?? state.lastEventAt;
      state.queueDepth = queue.length;
    }
  } finally {
    flushing = false;
    await persistStatus();
  }
}

async function postEvents(events: ObservationEvent[]): Promise<boolean> {
  const body = toObserverIngestBody(events);
  try {
    const res = await fetch(`${settings.observerUrl}/api/events`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      state.connected = false;
      state.lastError = `HTTP ${res.status}`;
      return false;
    }
    state.connected = true;
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
    return true;
  } catch (err) {
    state.connected = false;
    state.lastError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

async function pingAndHeartbeat(): Promise<void> {
  settings = await loadSettings();
  try {
    const res = await fetch(`${settings.observerUrl}/api/extension/ping`, {
      headers: authHeaders(),
    });
    state.connected = res.ok;
    if (res.ok) {
      state.lastOkAt = new Date().toISOString();
      state.lastError = null;
      await fetch(`${settings.observerUrl}/api/extension/heartbeat`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          extensionId: state.extensionId,
          version: state.version,
          eventsSent: state.eventsSent,
          queueDepth: state.queueDepth,
          sessionId: await getSessionId(),
          connected: true,
        }),
      }).catch(() => undefined);
    } else {
      state.lastError = `ping ${res.status}`;
    }
  } catch (err) {
    state.connected = false;
    state.lastError = err instanceof Error ? err.message : String(err);
  }
  await emitLocal("HEARTBEAT", settings.observerUrl, "observer", {
    connected: state.connected,
    eventsSent: state.eventsSent,
    queueDepth: state.queueDepth,
  });
  await persistStatus();
}

async function persistStatus(): Promise<void> {
  await chrome.storage.local.set({ abo_connection: state });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  void (async () => {
    if (msg?.type === "abo_content_event") {
      await emitLocal(msg.eventType, msg.url, msg.title, msg.payload ?? {});
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "abo_get_status") {
      settings = await loadSettings();
      sendResponse({ ok: true, state, settings });
      return;
    }
    if (msg?.type === "abo_save_settings") {
      settings = await saveSettings(msg.partial ?? {});
      sendResponse({ ok: true, settings });
      return;
    }
    if (msg?.type === "abo_ping") {
      await pingAndHeartbeat();
      sendResponse({ ok: true, state });
      return;
    }
    if (msg?.type === "abo_capture_screenshot") {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
        await emitLocal("SCREENSHOT", msg.url ?? "", msg.title ?? "", {
          mimeType: "image/png",
          dataUrl,
          note: "Visible tab capture (local only)",
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    sendResponse({ ok: false, error: "unknown" });
  })();
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "abo_heartbeat") void pingAndHeartbeat();
  if (alarm.name === "abo_flush") void flushQueue();
  if (alarm.name === "abo_checks") void pollAgentChecks();
});

async function pollAgentChecks(): Promise<void> {
  settings = await loadSettings();
  if (!settings.enabled) return;
  try {
    const res = await fetch(`${settings.observerUrl}/api/extension/checks/pending`, {
      headers: authHeaders(),
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      checks: Array<{ id: string; type: string; params: Record<string, unknown> }>;
    };
    for (const check of body.checks ?? []) {
      const result = await fulfillCheck(check);
      await fetch(`${settings.observerUrl}/api/extension/checks/${check.id}/complete`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ result }),
      }).catch(() => undefined);
    }
  } catch {
    /* observer offline */
  }
}

async function fulfillCheck(check: {
  id: string;
  type: string;
  params: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs.find((t) => t.id && t.url?.startsWith("http")) ?? tabs[0];

  if (check.type === "extension_health") {
    return {
      connected: state.connected,
      eventsSent: state.eventsSent,
      queueDepth: state.queueDepth,
      extensionId: state.extensionId,
      version: state.version,
      activeTab: tab?.url ? redactUrl(tab.url) : null,
    };
  }

  if (check.type === "screenshot" && tab?.id) {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
      await emitLocal("SCREENSHOT", tab.url ?? "", tab.title ?? "", {
        mimeType: "image/png",
        dataUrl,
        note: "Agent-requested screenshot",
      });
      return {
        ok: true,
        url: tab.url ? redactUrl(tab.url) : "",
        captured: true,
        note: "screenshot emitted to observer",
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (tab?.id && ["snapshot", "dom_summary", "find_element", "console_errors"].includes(check.type)) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, {
        type: "abo_agent_check",
        checkType: check.type,
        params: check.params,
      });
      return (reply as Record<string, unknown>) ?? { ok: false, error: "no reply" };
    } catch (err) {
      // Ask content for snapshot via existing path
      await chrome.tabs.sendMessage(tab.id, { type: "abo_request_snapshot" }).catch(() => undefined);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        note: "content script may not be injected yet; snapshot requested",
        tabUrl: tab.url ? redactUrl(tab.url) : null,
      };
    }
  }

  if (check.type === "network_failures" || check.type === "recent_events") {
    return {
      ok: true,
      note: "network/recent fulfilled by observer store; extension ack",
      extensionId: state.extensionId,
    };
  }

  return {
    ok: true,
    type: check.type,
    note: "acknowledged by extension",
    tabUrl: tab?.url ? redactUrl(tab.url) : null,
  };
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!settings?.enabled || !settings.captureNetwork) return;
    if (details.statusCode < 400) return;
    if (details.tabId < 0) return;
    void (async () => {
      const tab = await chrome.tabs.get(details.tabId).catch(() => null);
      await emitLocal(
        "NETWORK_ERROR",
        tab?.url ?? details.url,
        tab?.title ?? "",
        {
          url: redactUrl(details.url),
          method: details.method,
          status: details.statusCode,
          statusText: String(details.statusCode),
          resourceType: details.type,
          headers: sanitizeHeaders(undefined),
        },
      );
    })();
  },
  { urls: ["http://*/*", "https://*/*"] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!settings?.enabled || !settings.captureNetwork) return;
    if (details.tabId < 0) return;
    if (details.error === "net::ERR_ABORTED") return;
    void (async () => {
      const tab = await chrome.tabs.get(details.tabId).catch(() => null);
      await emitLocal(
        "NETWORK_ERROR",
        tab?.url ?? details.url,
        tab?.title ?? "",
        {
          url: redactUrl(details.url),
          method: details.method,
          status: 0,
          statusText: details.error,
          resourceType: details.type,
        },
      );
    })();
  },
  { urls: ["http://*/*", "https://*/*"] },
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.startsWith("http") && settings?.enabled) {
    void chrome.tabs.sendMessage(tabId, { type: "abo_request_snapshot" }).catch(() => undefined);
  }
});

void init();
