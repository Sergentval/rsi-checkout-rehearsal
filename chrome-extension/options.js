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

  // -------- Scout ----------------------------------------------------
  // Storage shape mirrors background.js.
  const SCOUT_DEFAULTS = {
    scoutShips: [],
    scoutEnabled: true,
    scoutIntervalSec: 30,
    keepAliveEnabled: true,
  };

  const MATRIX_CACHE_KEY = "shipMatrixCache";
  const MATRIX_TTL_MS = 60 * 60 * 1000;

  let scoutShipsCache = []; // ship-matrix listing

  async function loadMatrix(force = false) {
    if (!force) {
      const cached = await chrome.storage.local.get(MATRIX_CACHE_KEY);
      const e = cached[MATRIX_CACHE_KEY];
      if (e && Date.now() - e.ts < MATRIX_TTL_MS) return e.data;
    }
    const res = await fetch("https://robertsspaceindustries.com/ship-matrix/index", {
      method: "POST",
      headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" },
    });
    if (!res.ok) throw new Error(`ship-matrix HTTP ${res.status}`);
    const json = await res.json();
    if (json.success !== 1) throw new Error("unexpected ship-matrix shape");
    const data = json.data.map((s) => ({
      id: s.id,
      name: s.name ?? `ship #${s.id}`,
      manufacturer: s.manufacturer?.name ?? "",
      url: typeof s.url === "string" && s.url.startsWith("/")
        ? `https://robertsspaceindustries.com${s.url}`
        : null,
    }));
    await chrome.storage.local.set({ [MATRIX_CACHE_KEY]: { ts: Date.now(), data } });
    return data;
  }

  async function getScoutShips() {
    const stored = await chrome.storage.local.get({ scoutShips: [] });
    return Array.isArray(stored.scoutShips) ? stored.scoutShips : [];
  }
  async function setScoutShips(list) {
    await chrome.storage.local.set({ scoutShips: list });
  }

  function fmtAge(ts) {
    if (!ts) return "never";
    const ageSec = Math.round((Date.now() - ts) / 1000);
    if (ageSec < 60) return `${ageSec}s ago`;
    const ageMin = Math.round(ageSec / 60);
    if (ageMin < 60) return `${ageMin}m ago`;
    const ageHour = Math.round(ageMin / 60);
    return `${ageHour}h ago`;
  }

  async function renderScoutList() {
    const root = document.getElementById("scout-list");
    while (root.firstChild) root.removeChild(root.firstChild);
    const ships = await getScoutShips();
    if (ships.length === 0) {
      const e = document.createElement("div");
      e.className = "scout-empty";
      e.textContent = "No ships in the scout list. Search above and click + to add.";
      root.appendChild(e);
      return;
    }
    for (const s of ships) {
      const row = document.createElement("div");
      row.className = "scout-row";

      const dot = document.createElement("span");
      dot.className = "status-dot";
      if (s.lastError) dot.classList.add("warn");
      else if (s.lastAvailable === true) dot.classList.add("ok");
      else if (s.lastAvailable === false) dot.classList.add("bad");
      row.title = s.lastError ? `Last error: ${s.lastError}` : `Last available: ${s.lastAvailable}`;
      row.appendChild(dot);

      const meta = document.createElement("div");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = s.name || "(unknown ship)";
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = s.url.replace(/^https?:\/\/[^/]+/, "");
      meta.appendChild(name);
      meta.appendChild(sub);
      row.appendChild(meta);

      const lastCheck = document.createElement("span");
      lastCheck.className = "last-check";
      const statusTxt =
        s.lastError ? "error" :
        s.lastAvailable === true  ? "available" :
        s.lastAvailable === false ? "sold out"  : "unknown";
      lastCheck.textContent = `${statusTxt} · ${fmtAge(s.lastChecked)}`;
      row.appendChild(lastCheck);

      const rm = document.createElement("button");
      rm.className = "remove";
      rm.textContent = "×";
      rm.title = "Remove from scout list";
      rm.addEventListener("click", async () => {
        const cur = await getScoutShips();
        await setScoutShips(cur.filter((x) => x.url !== s.url));
        renderScoutList();
        toast(`removed ${s.name}`);
      });
      row.appendChild(rm);

      root.appendChild(row);
    }
  }

  async function renderScoutSearch(query) {
    const root = document.getElementById("scout-search-results");
    const meta = document.getElementById("scout-search-meta");
    while (root.firstChild) root.removeChild(root.firstChild);
    const q = (query || "").trim().toLowerCase();
    if (!q) {
      meta.textContent = `${scoutShipsCache.length} ships loaded · type to filter`;
      return;
    }
    const matches = scoutShipsCache.filter((s) =>
      s.name.toLowerCase().includes(q) || s.manufacturer.toLowerCase().includes(q),
    ).slice(0, 20);
    meta.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
    const scouted = new Set((await getScoutShips()).map((x) => x.url));
    for (const s of matches) {
      const row = document.createElement("div");
      row.className = "row";
      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = s.name;
      const mfr = document.createElement("span");
      mfr.className = "mfr";
      mfr.textContent = s.manufacturer || "—";
      meta.appendChild(name);
      meta.appendChild(mfr);
      const addBtn = document.createElement("button");
      addBtn.className = "add-btn";
      const already = s.url && scouted.has(s.url);
      addBtn.textContent = already ? "✓" : "+";
      if (already) addBtn.classList.add("added");
      addBtn.disabled = !s.url || already;
      addBtn.title = !s.url ? "no canonical URL — can't scout"
                    : already  ? "already in scout list"
                    : "Add to scout list";
      addBtn.addEventListener("click", async () => {
        if (!s.url || already) return;
        const cur = await getScoutShips();
        cur.push({
          id: s.id, name: s.name, url: s.url,
          addedAt: Date.now(), lastChecked: 0,
          lastAvailable: null, lastTransitionAt: null, lastError: null,
        });
        await setScoutShips(cur);
        renderScoutList();
        renderScoutSearch(document.getElementById("scout-search").value);
        toast(`scouting ${s.name}`);
      });
      row.appendChild(meta);
      row.appendChild(addBtn);
      root.appendChild(row);
    }
  }

  async function loadScoutBehaviour() {
    // Migrate from old scoutIntervalMin (minutes) → scoutIntervalSec (seconds).
    const stored = await chrome.storage.local.get({
      ...SCOUT_DEFAULTS,
      scoutIntervalMin: null, // legacy key
    });
    if (stored.scoutIntervalSec == null && stored.scoutIntervalMin != null) {
      stored.scoutIntervalSec = Math.round(Number(stored.scoutIntervalMin) * 60);
      await chrome.storage.local.set({ scoutIntervalSec: stored.scoutIntervalSec });
      await chrome.storage.local.remove("scoutIntervalMin");
    }

    const en = document.getElementById("t-scoutEnabled");
    const ka = document.getElementById("t-keepAliveEnabled");
    const iv = document.getElementById("scoutIntervalSec");
    const warn = document.getElementById("scout-rate-warning");
    if (en) en.checked = !!stored.scoutEnabled;
    if (ka) ka.checked = !!stored.keepAliveEnabled;
    if (iv) iv.value = String(stored.scoutIntervalSec ?? 30);

    function updateRateWarning() {
      if (!warn || !iv) return;
      const sec = Number(iv.value);
      getScoutShips().then((ships) => {
        const n = ships.length;
        while (warn.firstChild) warn.removeChild(warn.firstChild);
        if (sec < 30 && n > 0) {
          const rpm = Math.round((60 / sec) * n);
          warn.appendChild(document.createTextNode("⚠ ~"));
          const b = document.createElement("b");
          b.textContent = `${rpm} requests/min`;
          warn.appendChild(b);
          warn.appendChild(document.createTextNode(
            ` total (${n} ship${n === 1 ? "" : "s"} × ${(60 / sec).toFixed(1)}/min). ` +
            "Polite floor is 1.5 s. Excessive polling may get your IP rate-limited by RSI.",
          ));
          warn.style.color = "#ffd166";
        } else if (sec >= 30) {
          warn.textContent = "Chrome's MV3 alarm floor is 30 s — intervals ≥30 s use chrome.alarms (low overhead, survives SW death).";
          warn.style.color = "var(--weak, #7ea0c2)";
        } else {
          warn.textContent = "Fast tier uses setInterval inside the service worker. Heartbeat alarm restarts it within ~30 s if Chrome kills the SW.";
          warn.style.color = "var(--weak, #7ea0c2)";
        }
      });
    }
    updateRateWarning();

    en?.addEventListener("change", async () => {
      await chrome.storage.local.set({ scoutEnabled: en.checked });
      toast(`scout ${en.checked ? "enabled" : "paused"}`);
    });
    ka?.addEventListener("change", async () => {
      await chrome.storage.local.set({ keepAliveEnabled: ka.checked });
      toast(`keep-alive ${ka.checked ? "on" : "off"}`);
    });
    iv?.addEventListener("change", async () => {
      await chrome.storage.local.set({ scoutIntervalSec: Number(iv.value) });
      toast(`poll interval: ${iv.options[iv.selectedIndex].textContent.trim().replace(/\s*⚠.*/, "")}`);
      updateRateWarning();
    });

    // Recalculate the rate warning whenever the scout list changes size.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && "scoutShips" in changes) updateRateWarning();
    });
  }

  async function initScout() {
    await loadScoutBehaviour();
    try {
      scoutShipsCache = await loadMatrix();
      document.getElementById("scout-search-meta").textContent =
        `${scoutShipsCache.length} ships loaded · type to filter`;
    } catch (err) {
      document.getElementById("scout-search-meta").textContent = `error: ${err.message}`;
    }
    document.getElementById("scout-search").addEventListener("input", (e) => {
      renderScoutSearch(e.target.value);
    });
    document.getElementById("scout-refresh").addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        scoutShipsCache = await loadMatrix(true);
        renderScoutSearch(document.getElementById("scout-search").value);
        toast("ship-matrix refreshed");
      } catch (err) {
        toast(`refresh failed: ${err.message}`);
      }
    });
    renderScoutList();
    // Re-render the list when the background service worker updates statuses.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && "scoutShips" in changes) renderScoutList();
    });
  }

  initScout();

  // -------- Wave config editor ---------------------------------------
  // Times entered in UTC (matches RSI's FAQ); displayed in local time
  // alongside each input via a small preview span.
  const DEFAULT_WAVE_CONFIG = {
    eventName: "DefenseCon 2956",
    startMs: Date.UTC(2026, 4, 14, 16, 0, 0),
    endMs:   Date.UTC(2026, 4, 27, 20, 0, 0),
    waveTimesUtc: [16 * 60, 20 * 60, 0, 4 * 60, 8 * 60, 12 * 60],
    limitedShips: [
      { name: "Drake Kraken",           availableFromMs: Date.UTC(2026, 4, 14, 16, 0, 0) },
      { name: "Drake Kraken Privateer", availableFromMs: Date.UTC(2026, 4, 14, 16, 0, 0) },
      { name: "Aegis Idris-P",          availableFromMs: Date.UTC(2026, 4, 20, 16, 0, 0) },
      { name: "Aegis Javelin",          availableFromMs: Date.UTC(2026, 4, 20, 16, 0, 0) },
    ],
  };

  // ---- UTC helpers --------------------------------------------------
  // datetime-local inputs use the browser's local timezone by default. We
  // want them to represent UTC, so we encode/decode manually.
  const pad2 = (n) => String(n).padStart(2, "0");
  function utcMsToUtcInputValue(ms) {
    if (ms == null) return "";
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
           `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }
  function utcInputValueToMs(v) {
    if (!v) return null;
    // Append seconds + Z so JS parses as UTC instead of local.
    const ms = Date.parse(v.length === 16 ? `${v}:00Z` : `${v}Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  function fmtLocalShort(ms) {
    if (ms == null) return "—";
    return new Date(ms).toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }
  function parseWaveTimesStr(s) {
    const out = [];
    for (const part of (s || "").split(/[,\s]+/)) {
      const m = part.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) continue;
      const h = Number(m[1]), mn = Number(m[2]);
      if (h < 0 || h > 23 || mn < 0 || mn > 59) continue;
      out.push(h * 60 + mn);
    }
    return out;
  }
  function fmtWaveTimes(mins) {
    return (mins || []).map((m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`).join(", ");
  }

  // ---- Editor rendering ---------------------------------------------
  let wcShipsDraft = [];

  function renderShipRows() {
    const root = document.getElementById("wc-ships");
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    wcShipsDraft.forEach((ship, idx) => {
      const row = document.createElement("div");
      row.className = "wc-ship-row";

      const name = document.createElement("input");
      name.type = "text";
      name.placeholder = "Ship name (e.g. Drake Kraken)";
      name.value = ship.name || "";
      name.addEventListener("input", () => { wcShipsDraft[idx].name = name.value; });

      const date = document.createElement("input");
      date.type = "datetime-local";
      date.value = utcMsToUtcInputValue(ship.availableFromMs);
      date.title = "Available-from (UTC). Local: " + fmtLocalShort(ship.availableFromMs);
      const localSpan = document.createElement("span");
      localSpan.className = "from-local";
      localSpan.textContent = fmtLocalShort(ship.availableFromMs);
      date.addEventListener("change", () => {
        const ms = utcInputValueToMs(date.value);
        wcShipsDraft[idx].availableFromMs = ms;
        localSpan.textContent = fmtLocalShort(ms);
      });

      const rm = document.createElement("button");
      rm.textContent = "×";
      rm.title = "Remove ship";
      rm.addEventListener("click", () => {
        wcShipsDraft.splice(idx, 1);
        renderShipRows();
      });

      row.appendChild(name);
      row.appendChild(date);
      row.appendChild(localSpan);
      row.appendChild(rm);
      root.appendChild(row);
    });
  }

  function bindLocalPreview(inputId, previewId) {
    const inp = document.getElementById(inputId);
    const prev = document.getElementById(previewId);
    if (!inp || !prev) return;
    const update = () => {
      const ms = utcInputValueToMs(inp.value);
      prev.textContent = ms ? `· local: ${fmtLocalShort(ms)}` : "";
    };
    inp.addEventListener("input", update);
    inp.addEventListener("change", update);
    update();
  }

  async function loadWaveConfigEditor(cfg) {
    const config = cfg || (await chrome.storage.local.get({ waveConfig: null })).waveConfig || DEFAULT_WAVE_CONFIG;
    document.getElementById("wc-name").value = config.eventName || "";
    document.getElementById("wc-start").value = utcMsToUtcInputValue(config.startMs);
    document.getElementById("wc-end").value = utcMsToUtcInputValue(config.endMs);
    document.getElementById("wc-times").value = fmtWaveTimes(config.waveTimesUtc);
    wcShipsDraft = (config.limitedShips || []).map((s) => ({ ...s }));
    renderShipRows();
    bindLocalPreview("wc-start", "wc-start-local");
    bindLocalPreview("wc-end", "wc-end-local");
  }

  document.getElementById("wc-add-ship")?.addEventListener("click", () => {
    wcShipsDraft.push({ name: "", availableFromMs: null });
    renderShipRows();
  });

  document.getElementById("wc-save")?.addEventListener("click", async () => {
    const eventName = document.getElementById("wc-name").value.trim();
    const startMs = utcInputValueToMs(document.getElementById("wc-start").value);
    const endMs = utcInputValueToMs(document.getElementById("wc-end").value);
    const waveTimesUtc = parseWaveTimesStr(document.getElementById("wc-times").value);
    const ships = wcShipsDraft
      .filter((s) => s.name && s.name.trim() && s.availableFromMs)
      .map((s) => ({ name: s.name.trim(), availableFromMs: s.availableFromMs }));

    if (!eventName)             return toast("event name required");
    if (!startMs || !endMs)     return toast("start/end dates required");
    if (endMs <= startMs)       return toast("end must be after start");
    if (waveTimesUtc.length === 0) return toast("need at least one wave time");

    await chrome.storage.local.set({
      waveConfig: { eventName, startMs, endMs, waveTimesUtc, limitedShips: ships },
    });
    toast(`saved · ${ships.length} ship${ships.length === 1 ? "" : "s"} · ${waveTimesUtc.length} wave times`);
  });

  document.getElementById("wc-reset")?.addEventListener("click", async () => {
    if (!confirm("Reset wave config to DefenseCon 2956 defaults?")) return;
    await chrome.storage.local.remove("waveConfig");
    await loadWaveConfigEditor(DEFAULT_WAVE_CONFIG);
    toast("reset to defaults");
  });

  document.getElementById("wc-open-faq")?.addEventListener("click", async () => {
    try {
      await chrome.tabs.create({
        url: "https://robertsspaceindustries.com/spectrum/community/SC/forum/1/thread/defensecon-2956-faq",
      });
    } catch {
      window.open("https://robertsspaceindustries.com/spectrum/community/SC/forum/1/thread/defensecon-2956-faq", "_blank");
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "waveConfig" in changes) {
      loadWaveConfigEditor(changes.waveConfig.newValue);
    }
  });

  loadWaveConfigEditor();
  // ----- end Wave config editor --------------------------------------

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
