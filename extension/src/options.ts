const urlEl = document.getElementById("observerUrl") as HTMLInputElement;
const tokenEl = document.getElementById("apiToken") as HTMLInputElement;
const textEl = document.getElementById("maxVisibleTextChars") as HTMLInputElement;
const queueEl = document.getElementById("maxQueueSize") as HTMLInputElement;
const msg = document.getElementById("msg")!;

async function load() {
  const res = await chrome.runtime.sendMessage({ type: "abo_get_status" });
  if (!res?.ok) return;
  urlEl.value = String(res.settings.observerUrl ?? "");
  tokenEl.value = String(res.settings.apiToken ?? "");
  textEl.value = String(res.settings.maxVisibleTextChars ?? 4000);
  queueEl.value = String(res.settings.maxQueueSize ?? 200);
}

document.getElementById("save")?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "abo_save_settings",
    partial: {
      observerUrl: urlEl.value.replace(/\/$/, ""),
      apiToken: tokenEl.value.trim(),
      maxVisibleTextChars: Number(textEl.value) || 4000,
      maxQueueSize: Number(queueEl.value) || 200,
    },
  });
  await chrome.runtime.sendMessage({ type: "abo_ping" });
  msg.textContent = "Saved. Ping sent.";
});

void load();
