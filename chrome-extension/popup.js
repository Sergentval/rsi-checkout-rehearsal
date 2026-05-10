(async function () {
  "use strict";

  const setText = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  // Show extension version from manifest.
  try {
    const manifest = chrome.runtime.getManifest();
    setText("version", manifest.version);
  } catch {
    setText("version", "—");
  }

  // Show current tab host and whether the content script is active there.
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
  } catch (err) {
    setText("tab-host", "permission denied");
    setText("status", "—");
  }
})();
