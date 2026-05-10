
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
    prefillStatus = `prefilled $${formatted} (press Apply manually)`;
    // Briefly flash the input so it's visible the script touched it.
    const prevOutline = input.style.outline;
    input.style.outline = "3px solid #00e676";
    setTimeout(() => { input.style.outline = prevOutline; }, 1500);
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
      ["buy",      "Buy buttons"],
      ["co",       "Checkout"],
      ["sc",       "Store credit"],
      ["tot",      "Total"],
      ["prefill",  "SC autofill"],
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

    const hkRow = document.createElement("div");
    hkRow.className = "row";
    hkRow.style.marginTop = "6px";
    const hkK = document.createElement("span"); hkK.className = "k"; hkK.textContent = "Hotkeys";
    const hkV = document.createElement("span"); hkV.className = "v";
    for (const [key, label] of [["F", "focus next"], ["R", "refresh"], ["Esc", "hide"]]) {
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

  function refresh() {
    injectStyle();
    const buttons = findBuyButtons();
    highlightButtons(buttons);

    const buys = buttons.filter((b) => !b.isCheckout);
    const cos = buttons.filter((b) => b.isCheckout);

    ensurePanel();

    // Only attempt the store-credit prefill on payment-shaped URLs. Outside
    // those, leave the existing input values alone — pre-filling on a random
    // page would be confusing and could touch unrelated forms.
    const isPaymentPage = PAYMENT_URL_HINTS.some((p) => p.test(location.pathname));
    if (isPaymentPage) tryPrefillStoreCredit(); else prefillStatus = "—";

    setText("scr-url", location.pathname.slice(0, 32));
    setText("scr-buy", String(buys.length));
    setText("scr-co", String(cos.length));
    setText("scr-sc", readStoreCredit() ?? "—");
    setText("scr-tot", readCartTotal() ?? "—");
    setText("scr-prefill", prefillStatus || "—");
    setText("scr-lat", latencyMs == null ? "—" : `${latencyMs} ms`);

    let tip;
    if (isPaymentPage) {
      tip = "Payment page — read total carefully";
      showBanner();
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
    else if (e.key === "r" || e.key === "R") { refresh(); }
    else if (e.key === "Escape") {
      const p = document.getElementById(PANEL_ID);
      if (p) p.style.display = p.style.display === "none" ? "" : "none";
    }
  });

  let pending = false;
  const obs = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; refresh(); }, 500);
  });
  obs.observe(document.body, { childList: true, subtree: true });

  measureLatency().then(refresh);
  setInterval(refresh, 3000);
})();
