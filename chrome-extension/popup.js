(async function () {
  "use strict";

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
    autoAgreeDisclaimer: false,
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

  // Open the options page (full tab) for hotkey customisation + bigger UI.
  const openSettings = document.getElementById("open-settings");
  if (openSettings) {
    openSettings.addEventListener("click", () => {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else window.open(chrome.runtime.getURL("options.html"));
    });
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

  // ---------------- Ship lookup ----------------
  // Seed bookmarks with the well-known limited-availability ships from prior
  // RSI sales — capital / large concept ships that historically only appear
  // for short windows. Substring match against ship-matrix `name`, so a seed
  // like "Idris" matches Idris-K/M/P. User can star/unstar via the popup.
  const DEFAULT_BOOKMARK_SEEDS = [
    "Idris", "Javelin", "Polaris", "Pioneer", "Banu Merchantman", "Kraken",
    "Galaxy", "Liberator", "Ironclad", "Carrack", "890 Jump", "BMM",
  ];

  const MATRIX_CACHE_KEY = "shipMatrixCache";
  const MATRIX_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
  const BOOKMARKS_KEY = "bookmarkedShipIds";

  let ships = [];                   // [{ id, name, manufacturer, status, url }]
  let bookmarkedIds = new Set();    // numeric ship ids

  async function loadBookmarks() {
    try {
      const stored = await chrome.storage.local.get({ [BOOKMARKS_KEY]: null });
      if (stored[BOOKMARKS_KEY] === null) return null; // never seeded
      return new Set(stored[BOOKMARKS_KEY]);
    } catch { return new Set(); }
  }

  async function saveBookmarks() {
    try { await chrome.storage.local.set({ [BOOKMARKS_KEY]: [...bookmarkedIds] }); }
    catch (err) { console.error("bookmark save failed:", err); }
  }

  function seedBookmarksFromSeeds() {
    bookmarkedIds = new Set();
    for (const seed of DEFAULT_BOOKMARK_SEEDS) {
      for (const s of ships) {
        if (s.name && s.name.toLowerCase().includes(seed.toLowerCase())) {
          bookmarkedIds.add(s.id);
        }
      }
    }
  }

  async function fetchShipMatrix(force = false) {
    if (!force) {
      try {
        const cached = await chrome.storage.local.get(MATRIX_CACHE_KEY);
        const entry = cached[MATRIX_CACHE_KEY];
        if (entry && Date.now() - entry.ts < MATRIX_CACHE_TTL_MS) return entry.data;
      } catch { /* ignore */ }
    }
    const res = await fetch("https://robertsspaceindustries.com/ship-matrix/index", {
      method: "POST",
      headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" },
    });
    if (!res.ok) throw new Error(`ship-matrix HTTP ${res.status}`);
    const json = await res.json();
    if (json.success !== 1 || !Array.isArray(json.data)) throw new Error("unexpected ship-matrix shape");
    const data = json.data.map((s) => ({
      id: s.id,
      name: s.name ?? `ship #${s.id}`,
      manufacturer: s.manufacturer?.name ?? "",
      status: s.production_status ?? "",
      url: typeof s.url === "string" && s.url.startsWith("/")
        ? `https://robertsspaceindustries.com${s.url}`
        : null,
    }));
    try { await chrome.storage.local.set({ [MATRIX_CACHE_KEY]: { ts: Date.now(), data } }); }
    catch { /* ignore */ }
    return data;
  }

  function statusClass(status) {
    if (/concept|announc|development/i.test(status)) return "concept";
    if (/flight-?ready/i.test(status)) return "flight";
    return "";
  }

  function renderShipRow(s) {
    const row = document.createElement("div");
    row.className = "ship";

    const name = document.createElement("div");
    name.className = "name";
    const n = document.createElement("span"); n.className = "n"; n.textContent = s.name;
    const m = document.createElement("span"); m.className = "m"; m.textContent = s.manufacturer || "—";
    name.appendChild(n); name.appendChild(m);
    row.appendChild(name);

    if (s.status) {
      const st = document.createElement("span");
      st.className = `status ${statusClass(s.status)}`;
      st.textContent = s.status.replace(/-/g, " ");
      row.appendChild(st);
    }

    const star = document.createElement("button");
    star.className = "star" + (bookmarkedIds.has(s.id) ? " on" : "");
    star.textContent = bookmarkedIds.has(s.id) ? "★" : "☆";
    star.title = bookmarkedIds.has(s.id) ? "Unbookmark" : "Bookmark";
    star.addEventListener("click", async (e) => {
      e.preventDefault();
      if (bookmarkedIds.has(s.id)) bookmarkedIds.delete(s.id);
      else bookmarkedIds.add(s.id);
      await saveBookmarks();
      paintList();
    });
    row.appendChild(star);

    const open = document.createElement("button");
    open.textContent = "Open";
    open.disabled = !s.url;
    open.title = s.url ?? "no canonical url";
    open.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!s.url) return;
      try { await chrome.tabs.create({ url: s.url }); }
      catch { window.open(s.url, "_blank"); }
    });
    row.appendChild(open);

    return row;
  }

  function paintList() {
    const list = document.getElementById("lookup-list");
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);

    const q = (document.getElementById("lookup")?.value || "").trim().toLowerCase();
    let view = ships;
    if (q) {
      view = ships.filter((s) =>
        s.name.toLowerCase().includes(q) || s.manufacturer.toLowerCase().includes(q),
      ).slice(0, 30);
    } else {
      // Default view: bookmarks first.
      view = ships.filter((s) => bookmarkedIds.has(s.id))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (view.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = q
        ? `No ships match "${q}"`
        : "No bookmarks — type a ship name above and click ☆ to bookmark.";
      list.appendChild(empty);
      return;
    }
    for (const s of view) list.appendChild(renderShipRow(s));
  }

  function paintMeta(extra) {
    const el = document.getElementById("lookup-meta-left");
    if (el) el.textContent = extra;
  }

  async function loadAndPaintShips({ force = false } = {}) {
    try {
      paintMeta(force ? "Refreshing…" : "Loading…");
      ships = await fetchShipMatrix(force);
      const stored = await loadBookmarks();
      if (stored === null) {
        // First run — seed from defaults so the user sees known limited ships.
        seedBookmarksFromSeeds();
        await saveBookmarks();
      } else {
        bookmarkedIds = stored;
      }
      paintMeta(`${ships.length} ships · ${bookmarkedIds.size} bookmarked`);
      paintList();
    } catch (err) {
      console.error("ship-matrix load failed:", err);
      paintMeta(`error: ${String(err.message || err).slice(0, 40)}`);
      const list = document.getElementById("lookup-list");
      if (list) {
        while (list.firstChild) list.removeChild(list.firstChild);
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "Could not load ship-matrix. Click refresh to retry.";
        list.appendChild(e);
      }
    }
  }

  document.getElementById("lookup")?.addEventListener("input", () => paintList());
  document.getElementById("lookup-refresh")?.addEventListener("click", (e) => {
    e.preventDefault();
    loadAndPaintShips({ force: true });
  });

  await loadAndPaintShips();
})();
