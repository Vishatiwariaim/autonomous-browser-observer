/**
 * Redacts credentials and sensitive values before storage or AI use.
 * Phase 1: applied on the server for every inbound event.
 */

const SENSITIVE_KEY_PATTERN =
  /pass(word)?|passwd|pwd|secret|token|api[_-]?key|auth|authorization|cookie|set-cookie|session|credential|private[_-]?key|access[_-]?key|refresh[_-]?token|bearer|ssn|cvv|card[_-]?number/i;

const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, // JWT-ish
  /\b(sk-[A-Za-z0-9]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
];

const REDACTED = "[REDACTED]";

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(name);
}

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redactValuePreview(
  fieldName: string | undefined,
  inputType: string | undefined,
  value: string | undefined,
): { valuePreview?: string; redacted: boolean } {
  if (value === undefined) {
    return { redacted: true };
  }

  const sensitiveType =
    inputType === "password" ||
    inputType === "hidden" ||
    (fieldName !== undefined && isSensitiveFieldName(fieldName));

  if (sensitiveType) {
    return { valuePreview: REDACTED, redacted: true };
  }

  const trimmed = value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return { valuePreview: redactString(trimmed), redacted: true };
}

function redactDeep(value: unknown, parentKey = ""): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    if (isSensitiveFieldName(parentKey)) {
      return REDACTED;
    }
    return redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, parentKey));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFieldName(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = redactDeep(child, key);
      }
    }
    return result;
  }

  return value;
}

/** Deep-redact an observation event payload (and nested fields). */
export function redactEventPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return redactDeep(payload) as Record<string, unknown>;
}

export const REDACTED_PLACEHOLDER = REDACTED;
