/**
 * Extension service worker: session management, queued ingest, screenshots.
 * Read-only — never drives pages or executes host commands.
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:3847";

type ForwardMessage = {
  type: "abo-forward";
  eventType: string;
  payload: Record<string, unknown>;
};

type StoredSettings = {
  endpoint: string;
  enabled: boolean;
  sessionId: string;
};

type QueuedEvent = {
  sessionId: string;
  type: string;
  timestamp: string;
  tabId?: number;
  payload: Record<string, unknown>;
};

const queue: QueuedEvent[] = [];
let flushing = false;
let sessionStarted = false;

async function getSettings(): Promise<StoredSettings> {
  const data = await chrome.storage.local.get([
    "endpoint",
    "enabled",
    "sessionId",
  ]);
  let sessionId = data.sessionId as string | undefined;
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    await chrome.storage.local.set({ sessionId });
  }
  return {
    endpoint: (data.endpoint as string) || DEFAULT_ENDPOINT,
    enabled: data.enabled !== false,
    sessionId,
  };
}

function isObserverUrl(url: string, endpoint: string): boolean {
  try {
    const base = endpoint.replace(/\/$/, "");
    if (url.startsWith(base)) return true;
  } catch {
    /* ignore */
  }
  return (
    /:\/\/(127\.0\.0\.1|localhost):3847\//i.test(url) &&
    /\/(api\/|ws|screenshots\/)/i.test(url)
  );
}

async function postEvents(
  endpoint: string,
  events: QueuedEvent[],
): Promise<void> {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ingest failed: ${response.status} ${text.slice(0, 200)}`);
  }
}

async function flushQueue(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  try {
    const settings = await getSettings();
    if (!settings.enabled) {
      queue.length = 0;
      return;
    }
    while (queue.length > 0) {
      const batch = queue.splice(0, 20);
      try {
        await postEvents(settings.endpoint, batch);
      } catch (err) {
        // put back and stop — retry later
        queue.unshift(...batch);
        console.warn(
          "[abo-observer] flush failed:",
          err instanceof Error ? err.message : err,
        );
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

async function ensureSessionStart(tabId?: number): Promise<void> {
  if (sessionStarted) return;
  sessionStarted = true;
  const settings = await getSettings();
  queue.push({
    sessionId: settings.sessionId,
    type: "session_start",
    timestamp: new Date().toISOString(),
    tabId,
    payload: {
      userAgent: navigator.userAgent,
      endpoint: settings.endpoint,
    },
  });
}

async function forwardEvent(
  eventType: string,
  payload: Record<string, unknown>,
  tabId?: number,
): Promise<void> {
  const settings = await getSettings();
  if (!settings.enabled) return;

  await ensureSessionStart(tabId);

  // Drop noisy observer-self network events
  if (eventType === "network_failure") {
    const url = String(payload.url ?? "");
    if (isObserverUrl(url, settings.endpoint)) return;
  }

  queue.push({
    sessionId: settings.sessionId,
    type: eventType,
    timestamp: new Date().toISOString(),
    tabId,
    payload,
  });

  // Keep queue bounded
  if (queue.length > 500) {
    queue.splice(0, queue.length - 500);
  }

  void flushQueue();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "abo-forward") {
    const msg = message as ForwardMessage;
    void forwardEvent(msg.eventType, msg.payload, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (message?.type === "abo-capture-screenshot") {
    void (async () => {
      const settings = await getSettings();
      if (!settings.enabled) {
        sendResponse({ ok: false, error: "Observer disabled" });
        return;
      }
      const tab = sender.tab ?? (await getActiveTab());
      if (!tab?.id || tab.windowId === undefined) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "png",
        });
        await forwardEvent(
          "screenshot",
          {
            url: tab.url ?? "",
            title: tab.title,
            mimeType: "image/png",
            dataBase64: dataUrl,
          },
          tab.id,
        );
        await flushQueue();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  if (message?.type === "abo-get-settings") {
    void getSettings().then((s) =>
      sendResponse({ ...s, queueLength: queue.length }),
    );
    return true;
  }

  if (message?.type === "abo-set-settings") {
    void chrome.storage.local.set(message.patch ?? {}).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "abo-new-session") {
    const sessionId = crypto.randomUUID();
    sessionStarted = false;
    void chrome.storage.local.set({ sessionId }).then(() => {
      sendResponse({ ok: true, sessionId });
    });
    return true;
  }

  if (message?.type === "abo-ping-observer") {
    void (async () => {
      const settings = await getSettings();
      try {
        const res = await fetch(
          `${settings.endpoint.replace(/\/$/, "")}/api/extension/ping`,
        );
        const body = await res.json();
        sendResponse({ ok: res.ok, body });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true;
  }

  if (message?.type === "abo-flush") {
    void flushQueue().then(() => sendResponse({ ok: true, queueLength: queue.length }));
    return true;
  }

  return false;
});

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    /^https?:|^file:/.test(tab.url)
  ) {
    void forwardEvent(
      "navigation",
      {
        toUrl: tab.url,
        title: tab.title,
      },
      tabId,
    );

    setTimeout(() => {
      void (async () => {
        try {
          if (tab.windowId === undefined) return;
          // Only screenshot http(s) pages when this tab is still valid
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: "png",
          });
          await forwardEvent(
            "screenshot",
            {
              url: tab.url,
              title: tab.title,
              mimeType: "image/png",
              dataBase64: dataUrl,
            },
            tabId,
          );
        } catch {
          /* chrome:// and some restricted pages cannot be captured */
        }
      })();
    }, 900);
  }
});

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode >= 400 && details.tabId >= 0) {
      void getSettings().then((settings) => {
        if (isObserverUrl(details.url, settings.endpoint)) return;
        void forwardEvent(
          "network_failure",
          {
            url: details.url.slice(0, 2000),
            method: details.method,
            status: details.statusCode,
            resourceType: details.type,
          },
          details.tabId,
        );
      });
    }
  },
  { urls: ["<all_urls>"] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId >= 0 && details.error !== "net::ERR_ABORTED") {
      void getSettings().then((settings) => {
        if (isObserverUrl(details.url, settings.endpoint)) return;
        void forwardEvent(
          "network_failure",
          {
            url: details.url.slice(0, 2000),
            method: details.method,
            error: details.error,
            resourceType: details.type,
          },
          details.tabId,
        );
      });
    }
  },
  { urls: ["<all_urls>"] },
);

// Retry queued events periodically (service worker may sleep between)
setInterval(() => {
  void flushQueue();
}, 3000);

void (async () => {
  await ensureSessionStart();
  await flushQueue();
})();
