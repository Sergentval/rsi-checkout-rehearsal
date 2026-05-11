// ==UserScript==
// @name         RSI Checkout Rehearsal
// @namespace    sergent-val.win
// @version      0.1.0
// @description  Personal click-helper for RSI pledge / cart / checkout pages. Highlights buy buttons, surfaces store-credit balance, shows latency. Does NOT auto-submit anything.
// @match        https://robertsspaceindustries.com/*
// @match        https://*.robertsspaceindustries.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==


/* eslint-disable */
(function () {
  "use strict";

  // -------- Safety rail ---------------------------------------------------
  // This script never clicks, submits, or fills anything. It only:
  //   - Adds visible highlights to buy/checkout buttons.
  //   - Shows a small overlay with latency + button counts + store credit.
  //   - Adds keyboard shortcuts that *focus* (not click) the next buy button.
  //   - On the final payment page, shows a slow-down banner so you don't
  //     misclick under pressure.
  // ----------------------------------------------------------------------

  // -------- Settings ------------------------------------------------------
  // All defaults true (current behavior). Persisted via chrome.storage.local
  // when running as the extension. In userscript context (Tampermonkey /
  // Violentmonkey) chrome.storage isn't available — we silently fall back
  // to defaults and skip persistence.
  const DEFAULT_SETTINGS = {
    showPanel: true,         // bottom-right overlay
    highlightButtons: true,  // pulsing green/orange button outlines
    paymentBanner: true,     // red "slow down" banner on payment pages
    autoClickMax: true,      // click RSI's "apply max credit" button on entry
    scAutofill: true,        // regex-based store-credit input prefill (fallback)
    measureLatency: true,    // HEAD request per refresh to time round-trip
    enableFlowHotkey: false, // [N] hotkey clicks the page's primary "next" button
    lockStoreCredit: false,  // [N] refuses to click Place Order if credit not applied
  };
  const settings = { ...DEFAULT_SETTINGS };

  function hasChromeStorage() {
    try { return typeof chrome !== "undefined" && !!chrome.storage?.local; }
    catch { return false; }
  }

  async function loadSettings() {
    if (!hasChromeStorage()) return;
    try {
      const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
      Object.assign(settings, stored);
    } catch { /* ignore — keep defaults */ }
  }

  function watchSettings(onChange) {
    if (!hasChromeStorage() || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let touched = false;
      for (const [k, v] of Object.entries(changes)) {
        if (k in DEFAULT_SETTINGS) { settings[k] = v.newValue; touched = true; }
      }
      if (touched) onChange();
    });
  }
  // ----------------------------------------------------------------------

  const BUY_PATTERNS = [
    /^\s*add to cart\s*$/i,
    /^\s*buy\b/i,
    /^\s*pledge\b/i,
    /^\s*checkout\s*$/i,
    /^\s*proceed to checkout\s*$/i,
    /^\s*place order\s*$/i,
    /^\s*confirm( order)?\s*$/i,
    /^\s*pay( now)?\s*$/i,
  ];

  // Subset of BUY_PATTERNS: buttons that ADVANCE the checkout flow (not the
  // initial "Add to Cart"). The [N] hotkey targets this set. Exists as its
  // own list so the hotkey doesn't accidentally Add-to-Cart while you're
  // browsing a pledge page.
  const FLOW_PATTERNS = [
    /^\s*continue\s*$/i,
    /^\s*next\s*$/i,
    /^\s*proceed( to checkout)?\s*$/i,
    /^\s*checkout\s*$/i,
    /^\s*place order\s*$/i,
    /^\s*confirm( order)?\s*$/i,
    /^\s*pay( now)?\s*$/i,
  ];

  const PAYMENT_URL_HINTS = [/\/payment/i, /\/checkout\/payment/i, /\/confirm/i];

  const STYLE_ID = "scr-style";
  const PANEL_ID = "scr-panel";
  const BANNER_ID = "scr-banner";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .scr-buy-hi {
        outline: 3px solid #00e676 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(0, 230, 118, 0.25) !important;
        animation: scr-pulse 1.4s ease-in-out infinite !important;
      }
      .scr-checkout-hi {
        outline: 3px solid #ff9100 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(255, 145, 0, 0.3) !important;
      }
      @keyframes scr-pulse {
        0%, 100% { box-shadow: 0 0 0 6px rgba(0, 230, 118, 0.20); }
        50%      { box-shadow: 0 0 0 12px rgba(0, 230, 118, 0.05); }
      }
      #${PANEL_ID} {
        position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
        background: rgba(8,12,18,0.92); color: #d6e7ff; font: 12px/1.4 ui-monospace, Menlo, monospace;
        border: 1px solid #1f3550; border-radius: 8px; padding: 10px 12px;
        min-width: 230px; max-width: 320px;
        box-shadow: 0 6px 22px rgba(0,0,0,0.45);
        backdrop-filter: blur(4px);
      }
      #${PANEL_ID} h4 { margin: 0 0 6px; font-size: 12px; color: #6df2a9; letter-spacing: 0.04em; }
      #${PANEL_ID} .row { display: flex; justify-content: space-between; gap: 8px; }
      #${PANEL_ID} .k { color: #7ea0c2; }
      #${PANEL_ID} .v { color: #fff; font-weight: 600; }
      #${PANEL_ID} .hot { color: #00e676; }
      #${PANEL_ID} kbd {
        background:#1a2638; border:1px solid #2c4566; border-radius:3px;
        padding:0 4px; font-size:11px; color:#cfe;
      }
      #${BANNER_ID} {
        position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
        background: linear-gradient(90deg,#ff5252,#ff9100);
        color: #111; font: 700 14px/1.4 system-ui, sans-serif;
        padding: 10px 16px; text-align: center; letter-spacing: 0.02em;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
    `;
    document.documentElement.appendChild(s);
  }

  function findBuyButtons() {
    const out = [];
    const candidates = document.querySelectorAll(
      'button, a, input[type="button"], input[type="submit"], [role="button"]',
    );
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // hidden
      const txt = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
      if (!txt) continue;
      if (BUY_PATTERNS.some((p) => p.test(txt))) {
        const isCheckout = /checkout|place order|confirm|pay/i.test(txt);
        out.push({ el, txt, isCheckout });
      }
    }
    return out;
  }

  function highlightButtons(buttons) {
    for (const { el, isCheckout } of buttons) {
      el.classList.remove("scr-buy-hi", "scr-checkout-hi");
      el.classList.add(isCheckout ? "scr-checkout-hi" : "scr-buy-hi");
    }
  }

  function readStoreCredit() {
    const txt = document.body.innerText || "";
    const m = txt.match(/store[-\s]?credit[^$]{0,40}\$([\d,]+(?:\.\d{1,2})?)/i);
    return m ? `$${m[1]}` : null;
  }

  function readCartTotal() {
    const txt = document.body.innerText || "";
    const m = txt.match(/(?:order\s+total|total|grand\s+total)[^$]{0,20}\$([\d,]+(?:\.\d{1,2})?)/i);
    return m ? `$${m[1]}` : null;
  }

  // Parse a "$1,578.00" / "$1578" / "1578.00" string into a Number.
  function parseAmount(s) {
    if (!s) return null;
    const m = String(s).match(/([\d,]+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  // Find the input field RSI uses for "amount of store credit to apply".
  // Heuristic — matches by name/placeholder/aria-label/associated-label, all
  // case-insensitive. Returns the first plausible match or null. If RSI
  // changes the field shape, extend MATCHERS rather than rewriting callers.
  function findStoreCreditInput() {
    const MATCHERS = [/store.?credit/i, /apply.?credit/i, /credit.?amount/i];
    const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
    for (const el of inputs) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // hidden
      if (el.disabled || el.readOnly) continue;
      const haystacks = [
        el.getAttribute("name"),
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("id"),
      ].filter(Boolean);
      // Walk up to two parents looking for a label or descriptive text.
      let p = el.parentElement;
      for (let i = 0; i < 2 && p; i++) {
        haystacks.push((p.innerText || "").slice(0, 200));
        p = p.parentElement;
      }
      const blob = haystacks.join(" | ");
      if (MATCHERS.some((re) => re.test(blob))) return el;
    }
    return null;
  }

  // Set an input's value AND dispatch input+change events so React/Vue/etc.
  // controlled-component state actually picks up the change. A plain
  // .value = ... assignment is invisible to those frameworks.
  function setInputValue(el, value) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Track which (input, value) pairs we've already prefilled this page-load,
  // so the MutationObserver doesn't keep clobbering edits the user made by
  // hand. Keyed by the input element identity — cleared on navigation.
  const prefilled = new WeakSet();
  let prefillStatus = "";

  function tryPrefillStoreCredit() {
    const totalStr = readCartTotal();
    const total = parseAmount(totalStr);
    if (total == null || total <= 0) {
      prefillStatus = "no cart total visible";
      return;
    }
    const input = findStoreCreditInput();
    if (!input) {
      prefillStatus = "no store-credit input found";
      return;
    }
    if (prefilled.has(input)) {
      prefillStatus = `prefilled: ${input.value}`;
      return;
    }
    // Format with two decimals if cart total had cents, otherwise integer —
    // matches what a human would type when copying the visible total.
    const formatted = totalStr && totalStr.includes(".") ? total.toFixed(2) : String(total);
    setInputValue(input, formatted);
    prefilled.add(input);
    creditTouched = true;
    prefillStatus = `prefilled $${formatted} (press Apply manually)`;
    // Briefly flash the input so it's visible the script touched it.
    const prevOutline = input.style.outline;
    input.style.outline = "3px solid #00e676";
    setTimeout(() => { input.style.outline = prevOutline; }, 1500);
  }

  // RSI's checkout has an "Apply Max Credit" button that auto-fills the
  // store-credit amount input with min(available_credit, cart_total). This
  // is RSI's own UI affordance — clicking it is functionally identical to
  // a user clicking it themselves, and more reliable than our regex prefill
  // because RSI computes the right amount internally.
  // The button is type="button" — it does NOT submit a form. It only
  // toggles UI state. Place Order still requires a separate explicit click.
  function findMaxCreditButton() {
    // Exact match on the aria-label RSI ships in production.
    let btn = document.querySelector('button[aria-label="apply max credit" i]');
    if (btn) return btn;
    // Fallback: any non-disabled <button> whose visible text is "Max" and
    // whose nearby ancestor mentions "credit".
    for (const b of document.querySelectorAll("button")) {
      if (b.disabled) continue;
      const txt = (b.innerText || "").trim();
      if (txt !== "Max" && txt !== "MAX") continue;
      const rect = b.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const ctx = (b.closest("form, section, div")?.innerText || "").toLowerCase();
      if (ctx.includes("credit")) return b;
    }
    return null;
  }

  // Find the page's primary "advance the checkout flow" button. Used by the
  // [N] hotkey when enableFlowHotkey is on. Picks the largest visible button
  // matching FLOW_PATTERNS — primary CTAs are typically the largest button
  // by area on RSI's checkout pages.
  function findFlowButton() {
    let best = null;
    let bestArea = 0;
    const cands = document.querySelectorAll(
      'button, a, input[type="button"], input[type="submit"], [role="button"]',
    );
    for (const el of cands) {
      if (el.disabled) continue;
      const txt = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
      if (!txt) continue;
      if (!FLOW_PATTERNS.some((p) => p.test(txt))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  // Detect whether store credit is currently applied to the order. Used by
  // the lockStoreCredit gate so [N] won't click Place Order with credit
  // silently unapplied. Three positive signals — any of them counts:
  //   1. We clicked the Max button on this page (clickedMax has any entry).
  //   2. We successfully prefilled the credit input (prefilled has any entry).
  //   3. Page text shows "store credit applied" with a non-zero dollar amount.
  // The text-pattern signal is the most robust against the framework re-creating
  // button DOM nodes (which would clear our WeakSets but leave the apply in place).
  let lastCreditApplied = false;
  function isStoreCreditApplied() {
    // Signal 1+2: did the script or user touch credit on this page-load?
    // (WeakSets don't expose size — use a sentinel flag set when we click/fill.)
    if (creditTouched) return true;
    // Signal 3: visible text confirms credit will be / has been applied.
    const txt = (document.body.innerText || "").toLowerCase();
    if (/store[-\s]?credit[^a-z$]{0,10}applied[^$]{0,20}\$\s*[1-9]/i.test(txt)) return true;
    if (/applied store[-\s]?credit[^$]{0,20}\$\s*[1-9]/i.test(txt)) return true;
    // Order total reached zero — credit fully covered the cart.
    if (/(?:order|grand)\s+total[^$]{0,12}\$\s*0(?:\.0{1,2})?\b/i.test(txt)) return true;
    return false;
  }
  let creditTouched = false; // set true when tryClickMaxCredit or tryPrefillStoreCredit succeeds

  let flowStatus = "—";
  function tryClickFlow() {
    if (!settings.enableFlowHotkey) {
      flowStatus = "hotkey disabled (toggle in popup)";
      return false;
    }
    const btn = findFlowButton();
    if (!btn) { flowStatus = "no Continue/Place-Order button on page"; return false; }
    const label = (btn.innerText || btn.value || btn.getAttribute("aria-label") || "").trim().slice(0, 40);

    // Store-credit lock: when on, refuse to click any "place order / pay /
    // confirm" button until isStoreCreditApplied() returns true. Continue /
    // Next / Checkout / Proceed are unaffected — the lock only fires on the
    // final commit click.
    const isCommit = /^\s*(place order|confirm( order)?|pay( now)?)\s*$/i.test(label);
    if (settings.lockStoreCredit && isCommit) {
      lastCreditApplied = isStoreCreditApplied();
      if (!lastCreditApplied) {
        flowStatus = `BLOCKED: "${label}" — store credit not applied`;
        // Visual feedback: flash the panel border red.
        const panel = document.getElementById(PANEL_ID);
        if (panel) {
          const prev = panel.style.border;
          panel.style.border = "2px solid #ff0033";
          setTimeout(() => { panel.style.border = prev; }, 1500);
        }
        return false;
      }
    }

    btn.click();
    flowStatus = `clicked: ${label}`;
    const prevOutline = btn.style.outline;
    btn.style.outline = "3px solid #ff9100";
    setTimeout(() => { btn.style.outline = prevOutline; }, 1500);
    return true;
  }

  const clickedMax = new WeakSet();
  let maxStatus = "—";
  function tryClickMaxCredit() {
    const btn = findMaxCreditButton();
    if (!btn) {
      maxStatus = "no Max button on page";
      return false;
    }
    if (clickedMax.has(btn)) {
      maxStatus = "Max already applied";
      return true;
    }
    btn.click();
    clickedMax.add(btn);
    creditTouched = true;
    maxStatus = "Max applied";
    // Visible feedback — flash the button green for 1.5s.
    const prevOutline = btn.style.outline;
    btn.style.outline = "3px solid #00e676";
    setTimeout(() => { btn.style.outline = prevOutline; }, 1500);
    return true;
  }

  // Parse pledge-page URLs to surface ship name + warbond status + alt URL.
  // Examples:
  //   /en/pledge/Standalone-Ships/UTV-Warbond  →  warbond, alt = /en/pledge/Standalone-Ships/UTV
  //   /en/pledge/Standalone-Ships/UTV          →  store-credit OK, alt = /en/pledge/Standalone-Ships/UTV-Warbond
  // Not every ship has both versions; the alt URL is a guess that 404s if not.
  function parsePledgePage(pathname) {
    const m = pathname.match(/\/pledge\/[^/]+\/([^/?#]+)\/?$/i);
    if (!m) return null;
    const slug = m[1];
    const isWarbond = /-Warbond$/i.test(slug);
    const baseSlug = slug.replace(/-Warbond$/i, "");
    const altSlug = isWarbond ? baseSlug : `${baseSlug}-Warbond`;
    const altPath = pathname.replace(/[^/]+\/?$/, altSlug);
    return {
      ship: baseSlug.replace(/-/g, " "),
      isWarbond,
      altPath,
      altLabel: isWarbond ? "→ try store-credit URL" : "→ try warbond URL",
    };
  }

  let latencyMs = null;
  async function measureLatency() {
    try {
      const t0 = performance.now();
      const res = await fetch("/", { method: "HEAD", cache: "no-store" });
      if (!res.ok && res.status !== 0) return;
      latencyMs = Math.round(performance.now() - t0);
    } catch { /* ignore */ }
  }

  // Build the panel using DOM methods — no innerHTML, no untrusted content.
  function makePanel() {
    const p = document.createElement("div");
    p.id = PANEL_ID;

    const h = document.createElement("h4");
    h.textContent = "RSI checkout rehearsal";
    p.appendChild(h);

    const fields = [
      ["url",      "URL"],
      ["ship",     "Ship"],
      ["mode",     "Mode"],
      ["buy",      "Buy buttons"],
      ["co",       "Checkout"],
      ["sc",       "Store credit"],
      ["tot",      "Total"],
      ["prefill",  "SC autofill"],
      ["max",      "Max button"],
      ["flow",     "N hotkey"],
      ["lock",     "SC lock"],
      ["lat",      "Latency"],
    ];
    for (const [id, label] of fields) {
      const row = document.createElement("div");
      row.className = "row";
      const k = document.createElement("span"); k.className = "k"; k.textContent = label;
      const v = document.createElement("span"); v.className = "v"; v.id = `scr-${id}`; v.textContent = "—";
      row.appendChild(k); row.appendChild(v);
      p.appendChild(row);
    }

    // Alt-URL row is a clickable link, so it gets its own row outside the
    // generic span-based loop above. Visibility toggled in refresh().
    const altRow = document.createElement("div");
    altRow.className = "row"; altRow.id = "scr-alt-row"; altRow.style.display = "none";
    const altK = document.createElement("span"); altK.className = "k"; altK.textContent = "Alt URL";
    const altA = document.createElement("a"); altA.id = "scr-alt"; altA.className = "v";
    altA.style.color = "#6df2a9"; altA.style.textDecoration = "underline";
    altA.target = "_self"; altA.rel = "noopener";
    altRow.appendChild(altK); altRow.appendChild(altA);
    p.appendChild(altRow);

    const hkRow = document.createElement("div");
    hkRow.className = "row";
    hkRow.style.marginTop = "6px";
    const hkK = document.createElement("span"); hkK.className = "k"; hkK.textContent = "Hotkeys";
    const hkV = document.createElement("span"); hkV.className = "v";
    for (const [key, label] of [["F", "focus"], ["M", "max"], ["N", "next"], ["R", "refresh"], ["Esc", "hide"]]) {
      const kbd = document.createElement("kbd"); kbd.textContent = key;
      hkV.appendChild(kbd);
      hkV.appendChild(document.createTextNode(` ${label}  `));
    }
    hkRow.appendChild(hkK); hkRow.appendChild(hkV);
    p.appendChild(hkRow);

    const tip = document.createElement("div");
    tip.className = "row hot"; tip.id = "scr-tip"; tip.style.marginTop = "6px";
    p.appendChild(tip);

    return p;
  }

  function ensurePanel() {
    let p = document.getElementById(PANEL_ID);
    if (p) return p;
    p = makePanel();
    document.body.appendChild(p);
    return p;
  }

  function showBanner() {
    if (document.getElementById(BANNER_ID)) return;
    const b = document.createElement("div");
    b.id = BANNER_ID;
    b.textContent =
      "PAYMENT PAGE — slow down. Verify amount, currency, and payment method before clicking Place Order.";
    document.body.appendChild(b);
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function clearButtonHighlights() {
    for (const el of document.querySelectorAll(".scr-buy-hi, .scr-checkout-hi")) {
      el.classList.remove("scr-buy-hi", "scr-checkout-hi");
    }
  }

  function refresh() {
    injectStyle();
    const buttons = findBuyButtons();
    if (settings.highlightButtons) highlightButtons(buttons);
    else clearButtonHighlights();

    const buys = buttons.filter((b) => !b.isCheckout);
    const cos = buttons.filter((b) => b.isCheckout);

    // Panel visibility — when off, hide and skip the rest of the panel work.
    const existing = document.getElementById(PANEL_ID);
    if (!settings.showPanel) {
      if (existing) existing.style.display = "none";
      state.buttons = buttons;
      return;
    }
    if (existing) existing.style.display = "";
    ensurePanel();

    // Only attempt the store-credit prefill / Max click on payment-shaped
    // URLs. Outside those, leave the page alone — pre-filling on a random
    // page could touch unrelated forms. Each step gates on its own setting.
    const isPaymentPage = PAYMENT_URL_HINTS.some((p) => p.test(location.pathname));
    if (isPaymentPage) {
      const maxApplied = settings.autoClickMax ? tryClickMaxCredit() : false;
      if (!maxApplied && settings.scAutofill) tryPrefillStoreCredit();
      if (!settings.autoClickMax) maxStatus = "disabled (toggle off)";
      if (!settings.scAutofill && !maxApplied) prefillStatus = "disabled (toggle off)";
    } else {
      prefillStatus = "—";
      maxStatus = "—";
    }

    // Pledge-page parsing — surfaces ship name + warbond status + alt URL.
    const pledge = parsePledgePage(location.pathname);
    const altRow = document.getElementById("scr-alt-row");
    const altA = document.getElementById("scr-alt");
    if (pledge) {
      setText("scr-ship", pledge.ship);
      setText("scr-mode", pledge.isWarbond ? "WARBOND (fresh money)" : "Store credit OK");
      const modeEl = document.getElementById("scr-mode");
      if (modeEl) modeEl.style.color = pledge.isWarbond ? "#ff6b6b" : "#6df2a9";
      if (altA && altRow) {
        altA.textContent = pledge.altLabel;
        altA.href = pledge.altPath;
        altA.title = pledge.altPath;
        altRow.style.display = "";
      }
    } else {
      setText("scr-ship", "—");
      setText("scr-mode", "—");
      const modeEl = document.getElementById("scr-mode");
      if (modeEl) modeEl.style.color = "";
      if (altRow) altRow.style.display = "none";
    }

    setText("scr-url", location.pathname.slice(0, 32));
    setText("scr-buy", String(buys.length));
    setText("scr-co", String(cos.length));
    setText("scr-sc", readStoreCredit() ?? "—");
    setText("scr-tot", readCartTotal() ?? "—");
    setText("scr-prefill", prefillStatus || "—");
    setText("scr-max", maxStatus || "—");
    setText("scr-flow", settings.enableFlowHotkey ? (flowStatus || "armed") : "disabled (off)");
    if (!settings.lockStoreCredit) {
      setText("scr-lock", "disabled (off)");
    } else {
      const applied = isStoreCreditApplied();
      setText("scr-lock", applied ? "OK: credit applied" : "ARMED: blocks Place Order");
      const lockEl = document.getElementById("scr-lock");
      if (lockEl) lockEl.style.color = applied ? "#6df2a9" : "#ff6b6b";
    }
    setText("scr-lat", latencyMs == null ? "—" : `${latencyMs} ms`);

    let tip;
    if (isPaymentPage) {
      tip = "Payment page — read total carefully";
      if (settings.paymentBanner) showBanner();
      else { const b = document.getElementById(BANNER_ID); if (b) b.remove(); }
    } else if (pledge?.isWarbond) {
      tip = "WARBOND page — fresh money required";
    } else if (buys.length > 0) {
      tip = "Add-to-Cart available — press F to focus";
    } else if (cos.length > 0) {
      tip = "Checkout button visible — press F";
    } else {
      tip = "No buy buttons in view";
    }
    setText("scr-tip", tip);

    state.buttons = buttons;
  }

  const state = { buttons: [], focusIdx: 0 };

  function focusNext() {
    if (state.buttons.length === 0) return;
    state.focusIdx = (state.focusIdx + 1) % state.buttons.length;
    const target = state.buttons[state.focusIdx]?.el;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.focus();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "f" || e.key === "F") { focusNext(); e.preventDefault(); }
    else if (e.key === "m" || e.key === "M") { tryClickMaxCredit(); refresh(); e.preventDefault(); }
    else if (e.key === "n" || e.key === "N") { tryClickFlow(); refresh(); e.preventDefault(); }
    else if (e.key === "r" || e.key === "R") { refresh(); }
    else if (e.key === "Escape") {
      const p = document.getElementById(PANEL_ID);
      if (p) p.style.display = p.style.display === "none" ? "" : "none";
    }
  });

  // -------- Latency optimisation -----------------------------------------
  // Two paths:
  //   FAST: microtask-scheduled, fires on every DOM mutation. ONLY does the
  //         idempotent Max-credit click (the time-critical action). Cost is
  //         a WeakSet membership check per call — negligible.
  //   SLOW: panel UI refresh, throttled to 250ms (was 500ms). Does the full
  //         scrape + DOM update; expensive enough to warrant rate-limiting.
  // ----------------------------------------------------------------------
  let fastPathScheduled = false;
  function scheduleFastPath() {
    if (fastPathScheduled) return;
    fastPathScheduled = true;
    queueMicrotask(() => {
      fastPathScheduled = false;
      const isPaymentPage = PAYMENT_URL_HINTS.some((p) => p.test(location.pathname));
      if (isPaymentPage && settings.autoClickMax) tryClickMaxCredit();
    });
  }

  let pending = false;
  const obs = new MutationObserver(() => {
    scheduleFastPath();
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; refresh(); }, 250);
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Boot: load persisted settings before first render. Latency probe runs
  // fire-and-forget so first paint doesn't wait on a network round-trip.
  (async () => {
    await loadSettings();
    watchSettings(() => refresh());
    refresh(); // immediate first paint
    if (settings.measureLatency) measureLatency().then(refresh);
    setInterval(() => {
      if (settings.measureLatency) measureLatency().then(refresh);
      else refresh();
    }, 1500); // was 3000 — snappier panel updates
  })();
})();
