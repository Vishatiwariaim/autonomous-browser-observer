/**
 * Aggressive local redaction — never send passwords, tokens, cookies, or secrets.
 */

const SENSITIVE_NAME =
  /password|passwd|pwd|secret|token|api[_-]?key|auth|authorization|bearer|session|cookie|csrf|ssn|credit|card|cvv|cvc|pin|otp|private[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret/i;

const TOKENISH =
  /\b(Bearer\s+[A-Za-z0-9\-._~+/]+=*|eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*)\b/g;

const COOKIE_HEADER = /\b(Cookie|Set-Cookie)\s*:[^\n]*/gi;

const API_KEYISH =
  /\b(sk|pk|rk|ak|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g;

const EMAILISH = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function isSensitiveFieldName(name: string | null | undefined): boolean {
  if (!name) return false;
  return SENSITIVE_NAME.test(name);
}

export function isPasswordInput(el: {
  type?: string | null;
  name?: string | null;
  id?: string | null;
  autocomplete?: string | null;
}): boolean {
  const t = (el.type || "").toLowerCase();
  if (t === "password") return true;
  if (isSensitiveFieldName(el.name) || isSensitiveFieldName(el.id)) return true;
  const ac = (el.autocomplete || "").toLowerCase();
  if (ac.includes("password") || ac.includes("current-password") || ac.includes("new-password")) {
    return true;
  }
  return false;
}

export function redactString(input: string, redactEmails = false): string {
  let s = input;
  s = s.replace(TOKENISH, "[REDACTED_TOKEN]");
  s = s.replace(COOKIE_HEADER, "$1: [REDACTED]");
  s = s.replace(API_KEYISH, "[REDACTED_KEY]");
  s = s.replace(
    /(password|passwd|pwd|token|api[_-]?key|secret|authorization)\s*[:=]\s*["']?[^"'&\s]+/gi,
    "$1=[REDACTED]",
  );
  if (redactEmails) {
    s = s.replace(EMAILISH, "[REDACTED_EMAIL]");
  }
  return s;
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const sensitiveKeys = [...u.searchParams.keys()].filter((k) => isSensitiveFieldName(k));
    for (const k of sensitiveKeys) {
      u.searchParams.set(k, "[REDACTED]");
    }
    // Strip fragment that may hold tokens
    u.hash = "";
    return redactString(u.toString());
  } catch {
    return redactString(url);
  }
}

export function sanitizeValueForField(
  fieldName: string | null | undefined,
  value: string,
  redactSensitive: boolean,
): string {
  if (!redactSensitive) return value.slice(0, 200);
  if (isSensitiveFieldName(fieldName)) return "[REDACTED]";
  return redactString(value).slice(0, 200);
}

export function sanitizePayload(
  payload: Record<string, unknown>,
  redactSensitive: boolean,
): Record<string, unknown> {
  if (!redactSensitive) return payload;
  return deepRedact(payload) as Record<string, unknown>;
}

function deepRedact(value: unknown, keyHint = ""): unknown {
  if (typeof value === "string") {
    if (isSensitiveFieldName(keyHint)) return "[REDACTED]";
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepRedact(v, keyHint));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFieldName(k)) {
        out[k] = "[REDACTED]";
      } else if (
        (k === "value" || k === "text" || k === "visibleText") &&
        isSensitiveFieldName(String((value as Record<string, unknown>).name ?? (value as Record<string, unknown>).id ?? ""))
      ) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = deepRedact(v, k);
      }
    }
    return out;
  }
  return value;
}

/** Headers allowed in network failure reports — never Cookie/Authorization */
export function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth)/i.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactString(v).slice(0, 200);
    }
  }
  return out;
}
