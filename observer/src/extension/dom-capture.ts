/**
 * Shared DOM/page capture helpers used by the extension content script.
 * Kept dependency-free for browser injection.
 */

export type DomElementSummary = {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  text?: string;
  href?: string;
  role?: string;
  ariaLabel?: string;
  selectorHint?: string;
};

const SENSITIVE_NAME = /pass(word)?|token|secret|api[_-]?key|auth|credential/i;

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function selectorHint(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const tag = el.tagName.toLowerCase();
  const cls =
    typeof (el as HTMLElement).className === "string" && (el as HTMLElement).className
      ? "." +
        (el as HTMLElement).className
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .join(".")
      : "";
  return truncate(`${tag}${id}${cls}`, 120);
}

function summarizeElement(el: Element): DomElementSummary {
  const html = el as HTMLElement;
  const input = el as HTMLInputElement;
  const summary: DomElementSummary = {
    tag: el.tagName.toLowerCase(),
    selectorHint: selectorHint(el),
  };
  if (el.id) summary.id = el.id;
  if (input.name) summary.name = input.name;
  if (input.type) summary.type = input.type;
  if (html.getAttribute("role")) summary.role = html.getAttribute("role") ?? undefined;
  if (html.getAttribute("aria-label")) {
    summary.ariaLabel = truncate(html.getAttribute("aria-label") ?? "", 80);
  }
  const text = truncate(html.innerText || html.textContent || "", 80);
  if (text) summary.text = text;
  if (el.tagName === "A") {
    summary.href = (el as HTMLAnchorElement).href;
  }
  return summary;
}

export function capturePageSnapshot(): {
  url: string;
  title: string;
  visibleText: string;
  domSummary: {
    elementCount: number;
    headings: string[];
    buttons: DomElementSummary[];
    inputs: DomElementSummary[];
    links: DomElementSummary[];
  };
  viewport: { width: number; height: number };
} {
  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .map((h) => truncate(h.textContent ?? "", 100))
    .filter(Boolean)
    .slice(0, 30);

  const buttons = [
    ...document.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"]',
    ),
  ]
    .slice(0, 50)
    .map(summarizeElement);

  const inputs = [...document.querySelectorAll("input, textarea, select")]
    .slice(0, 50)
    .map((el) => {
      const summary = summarizeElement(el);
      const name = summary.name ?? summary.id ?? "";
      if (SENSITIVE_NAME.test(name) || summary.type === "password") {
        // Never include live values for sensitive fields
        delete (summary as { text?: string }).text;
      }
      return summary;
    });

  const links = [...document.querySelectorAll("a[href]")]
    .slice(0, 30)
    .map(summarizeElement);

  return {
    url: location.href,
    title: document.title,
    visibleText: truncate(document.body?.innerText ?? "", 4000),
    domSummary: {
      elementCount: document.querySelectorAll("*").length,
      headings,
      buttons,
      inputs,
      links,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
}

export function describeClickTarget(target: EventTarget | null): {
  tag: string;
  id?: string;
  text?: string;
  selectorHint?: string;
} {
  if (!(target instanceof Element)) {
    return { tag: "unknown" };
  }
  const html = target as HTMLElement;
  return {
    tag: target.tagName.toLowerCase(),
    id: target.id || undefined,
    text: truncate(html.innerText || html.textContent || "", 80) || undefined,
    selectorHint: selectorHint(target),
  };
}
