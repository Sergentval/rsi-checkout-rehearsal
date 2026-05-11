(async function () {
  "use strict";

  // --- Setting & hotkey defaults must match content.js exactly. ---
  const DEFAULT_SETTINGS = {
    showPanel: true,
    highlightButtons: true,
    paymentBanner: true,
    autoClickMax: true,
    scAutofill: true,
    measureLatency: true,
    enableFlowHotkey: false,
    lockStoreCredit: false,
    lockToStandalone: false,
  };

  // (key in storage) → { description, hint, danger? }
  const TOGGLE_META = {
    showPanel:        { name: "Show overlay panel",                hint: "Bottom-right info panel on RSI pages." },
    highlightButtons: { name: "Highlight buy buttons",             hint: "Pulsing green/orange outlines on Add-to-Cart, Checkout, etc." },
    paymentBanner:    { name: "Payment-page warning banner",       hint: "Red “PAYMENT PAGE — slow down” banner on /checkout/payment." },
    autoClickMax:     { name: "Auto-click \"Max credit\" button",  hint: "Clicks RSI's Apply-Max-Credit button on payment-page entry. Same as a UI value-fill, no submit." },
    scAutofill:       { name: "Store-credit input prefill",        hint: "Regex-based fallback when RSI's Max button isn't on the page." },
    measureLatency:   { name: "Measure latency to RSI",            hint: "One HEAD request to the current page per refresh. Off → no extra traffic." },
    enableFlowHotkey: { name: "[N] hotkey: click Continue / Place Order", hint: "Clicks the page's primary Continue/Place-Order button. Default off — this is the only setting that can complete a purchase.", danger: true },
    lockStoreCredit:  { name: "Lock to store credit",              hint: "[N] refuses to click Place Order if credit isn't detected as applied. Off by default." },
    lockToStandalone: { name: "Lock to standalone ship",           hint: "[A] refuses to click Add-to-Cart when a PACKAGE or UPGRADE is selected. Off by default — flip off to buy a pack intentionally." },
  };

  const HOTKEY_DEFAULTS = {
    focus:      "f",
    view:       "v",
    standalone: "s",
    add:        "a",
    cart:       "c",
    max:        "m",
    next:       "n",
    back:       "b",
    refresh:    "r",
  };

  const HOTKEY_META = {
    focus:      { name: "Focus next buy button",           sub: "Scrolls to and focuses the next visible Add-to-Cart / Checkout button." },
    view:       { name: "Click View Offers",               sub: "Clicks the ship page's “VIEW OFFERS” button to open the offer bottom sheet." },
    standalone: { name: "Select STANDALONE SHIP option",   sub: "Switches the bottom-sheet selection to the cheapest STANDALONE SHIP." },
    add:        { name: "Click Add-to-Cart",               sub: "Clicks the bottom-sheet's Add-to-Cart. Gated by Lock to standalone." },
    cart:       { name: "Go to cart",                      sub: "Clicks the header cart link or navigates to /<locale>/pledge/cart." },
    max:        { name: "Click Max-credit button",         sub: "Clicks RSI's “Apply Max Credit” button on the payment page." },
    next:       { name: "Click Continue / Place Order",    sub: "Clicks the page's primary Continue / Place-Order button. Gated by Lock to store credit." },
    back:       { name: "Go back (escape pack-only ship)", sub: "history.back() when possible; falls back to /<locale>/pledge/ships." },
    refresh:    { name: "Refresh overlay panel",           sub: "Forces a panel rebuild — useful after RSI rerenders the page." },
  };

  // -------- Helpers ---------------------------------------------------

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function toast(msg) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1400);
  }

  async function getSettings() {
    const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  async function setSetting(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  async function getHotkeys() {
    const stored = await chrome.storage.local.get({ customHotkeys: HOTKEY_DEFAULTS });
    return { ...HOTKEY_DEFAULTS, ...(stored.customHotkeys || {}) };
  }

  async function setHotkeys(map) {
    await chrome.storage.local.set({ customHotkeys: map });
  }

  // -------- Version --------------------------------------------------

  try {
    const manifest = chrome.runtime.getManifest();
    setText("version", `v${manifest.version}`);
  } catch { setText("version", "—"); }

  // -------- Toggles --------------------------------------------------

  async function renderToggles() {
    const settings = await getSettings();
    const root = document.getElementById("toggles");
    while (root.firstChild) root.removeChild(root.firstChild);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const meta = TOGGLE_META[key] || { name: key, hint: "" };
      const label = document.createElement("label");
      label.className = "toggle";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!settings[key];
      cb.addEventListener("change", async () => {
        await setSetting(key, cb.checked);
        toast(`${meta.name}: ${cb.checked ? "on" : "off"}`);
      });
      const labelText = document.createElement("div");
      labelText.className = "label";
      const nameSpan = document.createElement("span");
      nameSpan.className = "name";
      nameSpan.textContent = meta.name;
      if (meta.danger) {
        const tag = document.createElement("span");
        tag.className = "danger-tag";
        tag.textContent = "ALTERS PURCHASE FLOW";
        nameSpan.appendChild(tag);
      }
      const hintSpan = document.createElement("span");
      hintSpan.className = "hint";
      hintSpan.textContent = meta.hint;
      labelText.appendChild(nameSpan);
      labelText.appendChild(hintSpan);
      label.appendChild(cb);
      label.appendChild(labelText);
      root.appendChild(label);
    }
  }

  // -------- Hotkeys --------------------------------------------------

  let listeningKey = null; // action being rebinded, or null

  function describeKey(k) {
    if (!k) return "—";
    if (k === " ") return "Space";
    if (k.length === 1) return k.toUpperCase();
    return k;
  }

  function findConflicts(map) {
    // Returns a Set of action names whose key is duplicated.
    const counts = {};
    for (const [, v] of Object.entries(map)) counts[v] = (counts[v] || 0) + 1;
    const dup = new Set();
    for (const [k, v] of Object.entries(map)) if (counts[v] > 1) dup.add(k);
    return dup;
  }

  async function renderHotkeys() {
    const map = await getHotkeys();
    const root = document.getElementById("hotkeys");
    while (root.firstChild) root.removeChild(root.firstChild);
    const conflicts = findConflicts(map);
    for (const action of Object.keys(HOTKEY_DEFAULTS)) {
      const meta = HOTKEY_META[action] || { name: action, sub: "" };
      const row = document.createElement("div");
      row.className = "hotkey-row";

      const desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = meta.name;
      if (meta.sub) {
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = meta.sub;
        desc.appendChild(sub);
      }

      const cell = document.createElement("div");
      cell.className = "key-cell";
      const keyBtn = document.createElement("span");
      keyBtn.className = "key";
      if (conflicts.has(action)) keyBtn.classList.add("conflict");
      keyBtn.textContent = describeKey(map[action]);
      keyBtn.title = "Click and press a key to rebind. Press Escape to cancel.";
      keyBtn.addEventListener("click", () => beginRebind(action, keyBtn));
      cell.appendChild(keyBtn);

      row.appendChild(desc);
      row.appendChild(cell);
      root.appendChild(row);
    }
  }

  function beginRebind(action, keyBtn) {
    if (listeningKey) return; // already rebinding
    listeningKey = action;
    keyBtn.classList.add("listening");
    keyBtn.textContent = "press a key…";
    const handler = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener("keydown", handler, true);
      keyBtn.classList.remove("listening");
      const k = e.key;
      if (k === "Escape") { listeningKey = null; renderHotkeys(); toast("rebind cancelled"); return; }
      // Accept single printable chars or named keys; normalise letters to lowercase.
      if (k.length === 1) {
        const norm = k.toLowerCase();
        const current = await getHotkeys();
        const next = { ...current, [action]: norm };
        await setHotkeys(next);
        listeningKey = null;
        renderHotkeys();
        toast(`${HOTKEY_META[action].name}: ${describeKey(norm)}`);
        return;
      }
      // Reject non-printable bindings — too easy to brick yourself.
      listeningKey = null;
      renderHotkeys();
      toast(`rebind rejected: "${k}" not allowed`);
    };
    document.addEventListener("keydown", handler, true);
  }

  document.getElementById("reset-hotkeys").addEventListener("click", async () => {
    await setHotkeys({ ...HOTKEY_DEFAULTS });
    renderHotkeys();
    toast("hotkeys reset to defaults");
  });

  document.getElementById("reset-all").addEventListener("click", async () => {
    if (!confirm("Reset all toggles, hotkeys, and bookmarks to defaults?")) return;
    // Wipe + restore defaults for the three managed keys; leave caches intact.
    await chrome.storage.local.remove(["customHotkeys", "scr_bookmarkedShipIds"]);
    await chrome.storage.local.set({ ...DEFAULT_SETTINGS });
    renderToggles();
    renderHotkeys();
    toast("all settings reset");
  });

  // Live update when another tab/popup changes settings.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("customHotkeys" in changes) renderHotkeys();
    // Re-render toggles if any toggle key changed.
    if (Object.keys(changes).some((k) => k in DEFAULT_SETTINGS)) renderToggles();
  });

  await renderToggles();
  await renderHotkeys();
})();
