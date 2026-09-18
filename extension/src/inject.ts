/**
 * Injected into page world — captures console errors only.
 * Does not modify page behavior beyond wrapping console.error / window.onerror.
 */
(function aboInject() {
  const SOURCE = "abo-inject";

  function send(kind: string, payload: Record<string, unknown>) {
    window.postMessage({ source: SOURCE, kind, ...payload }, "*");
  }

  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const message = args
        .map((a) => {
          if (a instanceof Error) return a.message;
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ")
        .slice(0, 2000);
      send("console_error", { level: "error", message });
    } catch {
      /* ignore */
    }
    origError(...args);
  };

  window.addEventListener("error", (ev) => {
    send("console_error", {
      level: "error",
      message: String(ev.message || "error").slice(0, 2000),
      stack: ev.error?.stack ? String(ev.error.stack).slice(0, 4000) : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "unhandledrejection";
    send("console_error", {
      level: "error",
      message: String(message).slice(0, 2000),
      stack: reason instanceof Error && reason.stack ? reason.stack.slice(0, 4000) : undefined,
    });
  });
})();
