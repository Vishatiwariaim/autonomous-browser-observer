import type { Page } from "playwright";

/**
 * Must stay as a string so tsx/esbuild __name helpers are not injected
 * into the Playwright browser context.
 */
const CAPTURE_SCRIPT = `(() => {
  const truncate = (s, max) => {
    const t = s.replace(/\\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
  };

  const summarize = (el) => {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      name: el.name || undefined,
      type: el.type || undefined,
      text: truncate(el.innerText || el.textContent || "", 80) || undefined,
      href: el.tagName === "A" ? el.href : undefined,
    };
  };

  return {
    url: location.href,
    title: document.title,
    visibleText: truncate(document.body && document.body.innerText ? document.body.innerText : "", 4000),
    domSummary: {
      elementCount: document.querySelectorAll("*").length,
      headings: Array.from(document.querySelectorAll("h1,h2,h3"))
        .map((h) => truncate(h.textContent || "", 100))
        .filter(Boolean)
        .slice(0, 30),
      buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
        .slice(0, 50)
        .map(summarize),
      inputs: Array.from(document.querySelectorAll("input, textarea, select"))
        .slice(0, 50)
        .map(summarize),
      links: Array.from(document.querySelectorAll("a[href]")).slice(0, 30).map(summarize),
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

export async function capturePageSnapshotViaPage(page: Page): Promise<{
  url: string;
  title: string;
  visibleText: string;
  domSummary: {
    elementCount: number;
    headings: string[];
    buttons: Array<Record<string, unknown>>;
    inputs: Array<Record<string, unknown>>;
    links: Array<Record<string, unknown>>;
  };
  viewport: { width: number; height: number };
}> {
  return page.evaluate(CAPTURE_SCRIPT) as Promise<{
    url: string;
    title: string;
    visibleText: string;
    domSummary: {
      elementCount: number;
      headings: string[];
      buttons: Array<Record<string, unknown>>;
      inputs: Array<Record<string, unknown>>;
      links: Array<Record<string, unknown>>;
    };
    viewport: { width: number; height: number };
  }>;
}
