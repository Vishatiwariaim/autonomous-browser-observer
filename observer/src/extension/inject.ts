/**
 * Page-context script: console + network interception.
 * Posts messages to the content script via window.postMessage.
 */
(() => {
  const SOURCE = "abo-observer-inject";

  function emit(type: string, payload: Record<string, unknown>): void {
    window.postMessage({ source: SOURCE, type, payload }, "*");
  }

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      emit("console_error", {
        level: "error",
        message: args.map(String).join(" ").slice(0, 2000),
        url: location.href,
      });
    } catch {
      /* ignore */
    }
    originalError(...args);
  };

  window.addEventListener("error", (event) => {
    emit("console_error", {
      level: "uncaught",
      message: String(event.message ?? "uncaught error").slice(0, 2000),
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack?.slice(0, 4000) : undefined,
      url: location.href,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    emit("console_error", {
      level: "unhandledrejection",
      message: String(reason instanceof Error ? reason.message : reason).slice(0, 2000),
      stack: reason instanceof Error ? reason.stack?.slice(0, 4000) : undefined,
      url: location.href,
    });
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    try {
      const response = await originalFetch(input, init);
      if (!response.ok && response.status >= 400) {
        emit("network_failure", {
          url: String(url).slice(0, 2000),
          method,
          status: response.status,
          statusText: response.statusText,
          resourceType: "fetch",
          pageUrl: location.href,
        });
      }
      return response;
    } catch (err) {
      emit("network_failure", {
        url: String(url).slice(0, 2000),
        method,
        error: err instanceof Error ? err.message : String(err),
        resourceType: "fetch",
        pageUrl: location.href,
      });
      throw err;
    }
  };

  const OriginalXHR = window.XMLHttpRequest;
  class PatchedXHR extends OriginalXHR {
    private _aboMethod = "GET";
    private _aboUrl = "";

    open(method: string, url: string | URL): void;
    open(
      method: string,
      url: string | URL,
      async: boolean,
      username?: string | null,
      password?: string | null,
    ): void;
    open(
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      this._aboMethod = String(method).toUpperCase();
      this._aboUrl = String(url);
      if (async === undefined) {
        super.open(method, url);
      } else {
        super.open(method, url, async, username, password);
      }
    }
  }

  // Attach listeners via prototype open override pattern
  const protoOpen = OriginalXHR.prototype.open;
  OriginalXHR.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const xhr = this as XMLHttpRequest & {
      __aboMethod?: string;
      __aboUrl?: string;
      __aboHooked?: boolean;
    };
    xhr.__aboMethod = String(method).toUpperCase();
    xhr.__aboUrl = String(url);
    if (!xhr.__aboHooked) {
      xhr.__aboHooked = true;
      xhr.addEventListener("load", () => {
        if (xhr.status >= 400) {
          emit("network_failure", {
            url: (xhr.__aboUrl ?? "").slice(0, 2000),
            method: xhr.__aboMethod,
            status: xhr.status,
            statusText: xhr.statusText,
            resourceType: "xhr",
            pageUrl: location.href,
          });
        }
      });
      xhr.addEventListener("error", () => {
        emit("network_failure", {
          url: (xhr.__aboUrl ?? "").slice(0, 2000),
          method: xhr.__aboMethod,
          error: "Network error",
          resourceType: "xhr",
          pageUrl: location.href,
        });
      });
    }
    if (async === undefined) {
      return protoOpen.call(this, method, url, true);
    }
    return protoOpen.call(this, method, url, async, username, password);
  };

  // Keep class referenced so bundlers don't drop it if unused in some builds
  void PatchedXHR;
})();
