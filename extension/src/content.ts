/**
 * Content script — observe only. Never clicks, types, or submits.
 */
import {
  isPasswordInput,
  isSensitiveFieldName,
  redactString,
  redactUrl,
  sanitizeValueForField,
} from "./shared/sanitizer.js";

const MAX_TEXT = 4000;
let mutationTimer: ReturnType<typeof setTimeout> | null = null;
let lastMutationCount = 0;
let settings = {
  captureDomMutations: true,
  captureConsole: true,
  captureClicks: true,
  captureInputs: true,
  redactSensitive: true,
  maxVisibleTextChars: MAX_TEXT,
};

function post(
  eventType: string,
  payload: Record<string, unknown>,
): void {
  chrome.runtime.sendMessage({
    type: "abo_content_event",
    eventType,
    url: redactUrl(location.href),
    title: document.title,
    payload,
  }).catch(() => undefined);
}

function selectorHint(el: Element): string {
  const id = el.id ? `#${CSS.escape(el.id)}` : "";
  const cls =
    el.classList?.length > 0
      ? "." + [...el.classList].slice(0, 2).map((c) => CSS.escape(c)).join(".")
      : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 120);
}

function summarizeDom() {
  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .slice(0, 30)
    .map((h) => redactString((h.textContent || "").trim()).slice(0, 120))
    .filter(Boolean);

  const buttons = [...document.querySelectorAll("button, [role=button], input[type=submit]")]
    .slice(0, 40)
    .map((el) => {
      const e = el as HTMLElement & HTMLInputElement;
      return {
        tag: e.tagName.toLowerCase(),
        id: e.id || undefined,
        name: e.name || undefined,
        type: e.type || undefined,
        text: redactString((e.innerText || e.value || "").trim()).slice(0, 80) || undefined,
        selectorHint: selectorHint(e),
      };
    });

  const inputs = [...document.querySelectorAll("input, textarea, select")].slice(0, 50).map((el) => {
    const e = el as HTMLInputElement;
    const sensitive = isPasswordInput(e) || isSensitiveFieldName(e.name) || isSensitiveFieldName(e.id);
    return {
      tag: e.tagName.toLowerCase(),
      id: e.id || undefined,
      name: e.name || undefined,
      type: e.type || undefined,
      text: sensitive ? "[REDACTED]" : undefined,
      selectorHint: selectorHint(e),
    };
  });

  const links = [...document.querySelectorAll("a[href]")]
    .slice(0, 30)
    .map((a) => {
      const el = a as HTMLAnchorElement;
      return {
        tag: "a",
        href: redactUrl(el.href).slice(0, 200),
        text: redactString((el.innerText || "").trim()).slice(0, 80) || undefined,
        selectorHint: selectorHint(el),
      };
    });

  const visibleText = redactString(
    (document.body?.innerText || "").replace(/\s+/g, " ").trim(),
  ).slice(0, settings.maxVisibleTextChars);

  return {
    url: redactUrl(location.href),
    title: document.title,
    visibleText,
    domSummary: {
      elementCount: document.querySelectorAll("*").length,
      headings,
      buttons,
      inputs,
      links,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

function sendPageLoad(): void {
  post("PAGE_LOAD", summarizeDom());
}

function onClick(ev: MouseEvent): void {
  if (!settings.captureClicks) return;
  const t = ev.target as Element | null;
  if (!t || !(t instanceof Element)) return;
  const el = t.closest("a,button,input,select,textarea,[role=button]") || t;
  const html = el as HTMLElement & HTMLInputElement;
  const sensitive = isPasswordInput(html);
  post("CLICK", {
    target: {
      tag: html.tagName.toLowerCase(),
      id: html.id || undefined,
      name: (html as HTMLInputElement).name || undefined,
      type: (html as HTMLInputElement).type || undefined,
      text: sensitive
        ? "[REDACTED]"
        : redactString((html.innerText || (html as HTMLInputElement).value || "").trim()).slice(0, 80),
      href: html instanceof HTMLAnchorElement ? redactUrl(html.href) : undefined,
      role: html.getAttribute("role") || undefined,
      ariaLabel: html.getAttribute("aria-label") || undefined,
      selectorHint: selectorHint(html),
    },
    x: ev.clientX,
    y: ev.clientY,
  });
}

function onInput(ev: Event): void {
  if (!settings.captureInputs) return;
  const el = ev.target as HTMLInputElement | null;
  if (!el || !("value" in el)) return;
  const sensitive = isPasswordInput(el);
  post("INPUT", {
    target: {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      name: el.name || undefined,
      type: el.type || undefined,
      selectorHint: selectorHint(el),
    },
    value: sensitive
      ? "[REDACTED]"
      : sanitizeValueForField(el.name || el.id, String(el.value || ""), settings.redactSensitive),
    redacted: sensitive,
  });
}

function injectConsoleProbe(): void {
  if (!settings.captureConsole) return;
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("inject.js");
  s.onload = () => s.remove();
  (document.documentElement || document.head).appendChild(s);
}

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.source !== "abo-inject") return;
  if (data.kind === "console_error") {
    post("CONSOLE_ERROR", {
      level: data.level || "error",
      message: redactString(String(data.message || "")).slice(0, 2000),
      stack: data.stack ? redactString(String(data.stack)).slice(0, 4000) : undefined,
    });
  }
});

function setupMutations(): void {
  if (!settings.captureDomMutations) return;
  const obs = new MutationObserver((mutations) => {
    lastMutationCount += mutations.length;
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      const count = lastMutationCount;
      lastMutationCount = 0;
      if (count === 0) return;
      const sample = mutations.slice(0, 5).map((m) => ({
        type: m.type,
        added: m.addedNodes.length,
        removed: m.removedNodes.length,
        target: m.target instanceof Element ? selectorHint(m.target) : "node",
      }));
      post("DOM_MUTATION", {
        addedNodes: count,
        removedNodes: sample.reduce((a, s) => a + s.removed, 0),
        sample,
        note: "Batched mutation summary (no innerHTML dump)",
      });
    }, 1500);
  });
  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "abo_request_snapshot") {
    sendPageLoad();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "abo_agent_check") {
    const checkType = String(msg.checkType ?? "");
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (checkType === "snapshot" || checkType === "dom_summary") {
      sendResponse({ ok: true, type: checkType, ...summarizeDom() });
      return true;
    }
    if (checkType === "find_element") {
      const selector = String(params.selector ?? "");
      const text = String(params.text ?? "");
      let found = false;
      let match: Record<string, unknown> | null = null;
      if (selector) {
        try {
          const el = document.querySelector(selector);
          if (el) {
            found = true;
            match = {
              selector,
              tag: el.tagName.toLowerCase(),
              selectorHint: selectorHint(el),
              text: redactString((el.textContent || "").trim()).slice(0, 80),
            };
          }
        } catch {
          /* bad selector */
        }
      }
      if (!found && text) {
        const blob = (document.body?.innerText || "").toLowerCase();
        found = blob.includes(text.toLowerCase());
        match = { text, foundInVisibleText: found };
      }
      sendResponse({ ok: true, type: "find_element", found, match, url: redactUrl(location.href) });
      return true;
    }
    if (checkType === "console_errors") {
      sendResponse({
        ok: true,
        type: "console_errors",
        note: "live console stream is event-based; use observer store for history",
        url: redactUrl(location.href),
      });
      return true;
    }
    sendResponse({ ok: false, error: "unsupported check" });
    return true;
  }
  return false;
});

document.addEventListener("click", onClick, true);
document.addEventListener("change", onInput, true);
injectConsoleProbe();
setupMutations();
sendPageLoad();
