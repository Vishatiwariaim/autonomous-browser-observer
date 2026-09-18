import { capturePageSnapshot, describeClickTarget } from "./dom-capture.js";

type ObserverMessage =
  | { type: "abo-forward"; eventType: string; payload: Record<string, unknown> }
  | { type: "abo-request-snapshot" }
  | { type: "abo-ping" };

const INJECT_SOURCE = "abo-observer-inject";

function sendToBackground(
  eventType: string,
  payload: Record<string, unknown>,
): void {
  try {
    chrome.runtime.sendMessage(
      {
        type: "abo-forward",
        eventType,
        payload,
      } satisfies ObserverMessage,
      () => {
        // Swallow "Extension context invalidated" during reloads
        void chrome.runtime.lastError;
      },
    );
  } catch {
    /* ignore */
  }
}

function injectPageScript(): void {
  if (document.documentElement?.dataset.aboInjected === "1") return;
  if (document.documentElement) {
    document.documentElement.dataset.aboInjected = "1";
  }
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.async = false;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.addEventListener("load", () => script.remove());
}

function emitSnapshot(): void {
  try {
    const snapshot = capturePageSnapshot();
    sendToBackground("page_snapshot", snapshot);
  } catch {
    /* ignore */
  }
}

function emitNavigation(): void {
  sendToBackground("navigation", {
    toUrl: location.href,
    title: document.title,
  });
}

injectPageScript();
emitNavigation();
emitSnapshot();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as {
    source?: string;
    type?: string;
    payload?: Record<string, unknown>;
  };
  if (!data || data.source !== INJECT_SOURCE || !data.type || !data.payload) {
    return;
  }
  sendToBackground(data.type, data.payload);
});

document.addEventListener(
  "click",
  (event) => {
    const info = describeClickTarget(event.target);
    sendToBackground("user_click", {
      url: location.href,
      ...info,
      x: event.clientX,
      y: event.clientY,
    });
  },
  true,
);

document.addEventListener(
  "change",
  (event) => {
    const target = event.target;
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
    ) {
      return;
    }
    const name = target.name || target.id || "";
    const inputType = "type" in target ? String(target.type) : "text";

    // Never send typed values — metadata only (server also forces redaction)
    sendToBackground("user_input", {
      url: location.href,
      tag: target.tagName.toLowerCase(),
      id: target.id || undefined,
      name: name || undefined,
      inputType,
      valuePreview: "[REDACTED]",
      redacted: true,
    });
  },
  true,
);

let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    emitNavigation();
    emitSnapshot();
  }
}, 1000);

chrome.runtime.onMessage.addListener((message: ObserverMessage, _sender, sendResponse) => {
  if (message.type === "abo-request-snapshot") {
    try {
      const snapshot = capturePageSnapshot();
      sendResponse({ ok: true, snapshot });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }
  if (message.type === "abo-ping") {
    sendResponse({ ok: true, url: location.href });
    return true;
  }
  return false;
});

setInterval(() => {
  if (document.visibilityState === "visible") {
    emitSnapshot();
  }
}, 20_000);
