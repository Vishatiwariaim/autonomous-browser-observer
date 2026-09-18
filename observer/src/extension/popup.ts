const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const endpointEl = document.getElementById("endpoint") as HTMLInputElement;
const sessionEl = document.getElementById("session") as HTMLParagraphElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;

function setStatus(text: string, ok: boolean): void {
  statusEl.textContent = text;
  statusEl.className = `status ${ok ? "ok" : "err"}`;
}

async function load(): Promise<void> {
  const settings = await chrome.runtime.sendMessage({ type: "abo-get-settings" });
  enabledEl.checked = settings.enabled !== false;
  endpointEl.value = settings.endpoint || "http://127.0.0.1:3847";
  sessionEl.textContent = `Session: ${settings.sessionId}`;
}

document.getElementById("save")!.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "abo-set-settings",
    patch: {
      enabled: enabledEl.checked,
      endpoint: endpointEl.value.trim(),
    },
  });
  setStatus("Saved", true);
});

document.getElementById("ping")!.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "abo-set-settings",
    patch: {
      enabled: enabledEl.checked,
      endpoint: endpointEl.value.trim(),
    },
  });
  const result = await chrome.runtime.sendMessage({ type: "abo-ping-observer" });
  if (result?.ok) {
    setStatus("Connected to observer", true);
  } else {
    setStatus(result?.error || "Observer unreachable — is npm start running?", false);
  }
});

document.getElementById("newSession")!.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "abo-new-session" });
  sessionEl.textContent = `Session: ${result.sessionId}`;
  setStatus("New session started", true);
});

document.getElementById("snapshot")!.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("No active tab", false);
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "abo-request-snapshot",
    });
    if (response?.snapshot) {
      await chrome.runtime.sendMessage({
        type: "abo-forward",
        eventType: "page_snapshot",
        payload: response.snapshot,
      });
    }
    const shot = await chrome.runtime.sendMessage({
      type: "abo-capture-screenshot",
    });
    await chrome.runtime.sendMessage({ type: "abo-flush" });
    if (shot?.ok) {
      setStatus("Snapshot + screenshot sent", true);
    } else {
      setStatus(shot?.error || "Screenshot failed", false);
    }
  } catch (err) {
    setStatus(
      err instanceof Error
        ? err.message
        : "Content script missing — reload the page after loading the extension",
      false,
    );
  }
});

void load();
