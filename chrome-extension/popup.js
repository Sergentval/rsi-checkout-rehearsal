(async function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    showPanel: true,
    highlightButtons: true,
    paymentBanner: true,
    autoClickMax: true,
    scAutofill: true,
    measureLatency: true,
  };

  const setText = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  // Static info: extension version + active tab host.
  try {
    const manifest = chrome.runtime.getManifest();
    setText("version", manifest.version);
  } catch {
    setText("version", "—");
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    const url = tab?.url ?? "";
    let host = "—";
    try { host = new URL(url).host; } catch { /* ignore */ }
    setText("tab-host", host);

    const isRsi = /(^|\.)robertsspaceindustries\.com$/i.test(host);
    const statusEl = document.getElementById("status");
    if (isRsi) {
      statusEl.textContent = "active";
      statusEl.classList.add("ok");
    } else {
      statusEl.textContent = "idle (open an RSI page)";
      statusEl.classList.add("warn");
    }
  } catch {
    setText("tab-host", "permission denied");
    setText("status", "—");
  }

  // Toggles — load current values, wire change handlers, support reset.
  const TOGGLE_IDS = Object.keys(DEFAULT_SETTINGS);

  async function loadAndPaint() {
    try {
      const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
      for (const key of TOGGLE_IDS) {
        const cb = document.getElementById(`t-${key}`);
        if (cb) cb.checked = Boolean(stored[key]);
      }
    } catch {
      // Storage unavailable (shouldn't happen with the storage permission
      // declared, but be defensive). Show defaults.
      for (const key of TOGGLE_IDS) {
        const cb = document.getElementById(`t-${key}`);
        if (cb) cb.checked = DEFAULT_SETTINGS[key];
      }
    }
  }

  async function saveOne(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (err) {
      console.error("save failed:", err);
    }
  }

  for (const key of TOGGLE_IDS) {
    const cb = document.getElementById(`t-${key}`);
    if (!cb) continue;
    cb.addEventListener("change", () => saveOne(key, cb.checked));
  }

  const resetBtn = document.getElementById("reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      try {
        await chrome.storage.local.set(DEFAULT_SETTINGS);
        await loadAndPaint();
      } catch (err) {
        console.error("reset failed:", err);
      }
    });
  }

  await loadAndPaint();
})();
