/** Extension event types (Phase 3A) */
export type ExtEventType =
  | "PAGE_LOAD"
  | "CLICK"
  | "INPUT"
  | "CONSOLE_ERROR"
  | "NETWORK_ERROR"
  | "DOM_MUTATION"
  | "SCREENSHOT"
  | "HEARTBEAT"
  | "SESSION_START"
  | "SESSION_END"
  | "NAVIGATION";

export interface DomSummary {
  elementCount: number;
  headings: string[];
  buttons: Array<Record<string, string | undefined>>;
  inputs: Array<Record<string, string | undefined>>;
  links: Array<Record<string, string | undefined>>;
}

export interface ObservationEvent {
  event_id: string;
  session_id: string;
  timestamp: string;
  type: ExtEventType;
  url: string;
  title: string;
  payload: Record<string, unknown>;
}

export interface ExtSettings {
  observerUrl: string;
  apiToken: string;
  enabled: boolean;
  captureScreenshots: boolean;
  captureDomMutations: boolean;
  captureNetwork: boolean;
  captureConsole: boolean;
  captureClicks: boolean;
  captureInputs: boolean;
  redactSensitive: boolean;
  maxVisibleTextChars: number;
  maxQueueSize: number;
}

declare const __ABO_DEFAULT_OBSERVER_URL__: string | undefined;
declare const __ABO_DEFAULT_API_TOKEN__: string | undefined;

export const DEFAULT_SETTINGS: ExtSettings = {
  observerUrl:
    (typeof __ABO_DEFAULT_OBSERVER_URL__ !== "undefined" &&
      __ABO_DEFAULT_OBSERVER_URL__) ||
    "http://127.0.0.1:3847",
  apiToken:
    (typeof __ABO_DEFAULT_API_TOKEN__ !== "undefined" &&
      __ABO_DEFAULT_API_TOKEN__) ||
    "",
  enabled: true,
  captureScreenshots: true,
  captureDomMutations: true,
  captureNetwork: true,
  captureConsole: true,
  captureClicks: true,
  captureInputs: true,
  redactSensitive: true,
  maxVisibleTextChars: 4000,
  maxQueueSize: 200,
};

export function newEventId(): string {
  return `evt_${crypto.randomUUID()}`;
}

export function newSessionId(): string {
  return `sess_${crypto.randomUUID()}`;
}
