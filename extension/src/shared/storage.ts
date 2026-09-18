import { DEFAULT_SETTINGS, type ExtSettings } from "./types.js";

const KEY = "abo_settings_v1";

export async function loadSettings(): Promise<ExtSettings> {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<ExtSettings> | undefined) };
}

export async function saveSettings(partial: Partial<ExtSettings>): Promise<ExtSettings> {
  const current = await loadSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function getSessionId(): Promise<string> {
  const { abo_session_id } = await chrome.storage.session.get("abo_session_id");
  if (typeof abo_session_id === "string" && abo_session_id) return abo_session_id;
  const id = `sess_${crypto.randomUUID()}`;
  await chrome.storage.session.set({ abo_session_id: id });
  return id;
}
