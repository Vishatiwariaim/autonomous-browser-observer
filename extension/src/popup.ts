const badge = document.getElementById("connBadge")!;
const observerUrlEl = document.getElementById("observerUrl")!;
const sessionIdEl = document.getElementById("sessionId")!;
const eventsSentEl = document.getElementById("eventsSent")!;
const queueDepthEl = document.getElementById("queueDepth")!;
const lastOkEl = document.getElementById("lastOk")!;
const lastErrorEl = document.getElementById("lastError")!;
const versionEl = document.getElementById("version")!;

const toggleIds = [
  "enabled",
  "captureClicks",
  "captureInputs",
  "captureConsole",
  "captureNetwork",
  "captureDomMutations",
  "captureScreenshots",
  "redactSensitive",
] as const;

function setBadge(connected: boolean | null) {
  badge.classList.remove("ok", "bad", "unknown");
  if (connected === true) {
    badge.textContent = "Connected";
    badge.classList.add("ok");
  } else if (connected === false) {
    badge.textContent = "Disconnected";
    badge.classList.add("bad");
  } else {
    badge.textContent = "Checking…";
    badge.classList.add("unknown");
  }
}

function applyStatus(data: {
  state: {
    connected: boolean;
    lastOkAt: string | null;
    lastError: string | null;
    eventsSent: number;
    queueDepth: number;
    version: string;
  };
  settings: Record<string, unknown>;
}) {
  const { state, settings } = data;
  setBadge(state.connected);
  observerUrlEl.textContent = String(settings.observerUrl ?? "");
  eventsSentEl.textContent = String(state.eventsSent);
  queueDepthEl.textContent = String(state.queueDepth);
  lastOkEl.textContent = state.lastOkAt
    ? new Date(state.lastOkAt).toLocaleTimeString()
    : "—";
  versionEl.textContent = `v${state.version}`;
  if (state.lastError) {
    lastErrorEl.textContent = state.lastError;
    lastErrorEl.classList.remove("hidden");
  } else {
    lastErrorEl.classList.add("hidden");
  }
  for (const id of toggleIds) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el && typeof settings[id] === "boolean") el.checked = settings[id] as boolean;
  }
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "abo_get_status" });
  if (res?.ok) applyStatus(res);
  const sess = await chrome.storage.session.get("abo_session_id");
  sessionIdEl.textContent = (sess.abo_session_id as string) || "—";
}

for (const id of toggleIds) {
  document.getElementById(id)?.addEventListener("change", async (ev) => {
    const checked = (ev.target as HTMLInputElement).checked;
    await chrome.runtime.sendMessage({
      type: "abo_save_settings",
      partial: { [id]: checked },
    });
    await refresh();
  });
}

document.getElementById("btnPing")?.addEventListener("click", async () => {
  setBadge(null);
  await chrome.runtime.sendMessage({ type: "abo_ping" });
  await refresh();
});

document.getElementById("btnShot")?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({
    type: "abo_capture_screenshot",
    url: tab?.url,
    title: tab?.title,
  });
  await refresh();
});

document.getElementById("btnDash")?.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "abo_get_status" });
  const url = String(res?.settings?.observerUrl ?? "http://127.0.0.1:3847");
  await chrome.tabs.create({ url: `${url}/` });
});

document.getElementById("btnOptions")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

void refresh();
