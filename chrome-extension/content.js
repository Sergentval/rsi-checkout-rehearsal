
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
    lockToStandalone: false, // [A] refuses Add-to-Cart when the selected option is a pack
  };
  const settings = { ...DEFAULT_SETTINGS };

  // Hotkey bindings — defaults match the options page. Single lowercase
  // characters; events compared via e.key.toLowerCase(). Escape stays
  // fixed as the "hide / show" key (not user-rebindable).
  const HOTKEY_DEFAULTS = {
    focus: "f", max: "m", next: "n",
    add: "a", standalone: "s", cart: "c", refresh: "r",
  };
  const hotkeys = { ...HOTKEY_DEFAULTS };

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

  async function loadHotkeys() {
    if (!hasChromeStorage()) return;
    try {
      const stored = await chrome.storage.local.get({ customHotkeys: HOTKEY_DEFAULTS });
      Object.assign(hotkeys, HOTKEY_DEFAULTS, stored.customHotkeys || {});
    } catch { /* keep defaults */ }
  }

  function watchSettings(onChange) {
    if (!hasChromeStorage() || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let touched = false;
      for (const [k, v] of Object.entries(changes)) {
        if (k in DEFAULT_SETTINGS) { settings[k] = v.newValue; touched = true; }
      }
      if ("customHotkeys" in changes) {
        Object.assign(hotkeys, HOTKEY_DEFAULTS, changes.customHotkeys.newValue || {});
        touched = true;
      }
      if (touched) onChange();
    });
  }
  // ----------------------------------------------------------------------

  const BUY_PATTERNS = [
    /^\s*add to cart\s*$/i,
    /^\s*buy\b/i,
    /^\s*pledge\b/i,
    /^\s*view offers?\s*$/i,            // RSI's ship-page CTA opens the bottom sheet
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
        background: rgba(6, 12, 20, 0.94); color: #d6e7ff;
        font: 12px/1.45 ui-sans-serif, system-ui, sans-serif;
        border: 1px solid #1f3550; border-radius: 10px; padding: 12px 14px;
        min-width: 260px; max-width: 340px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.5);
        backdrop-filter: blur(6px);
      }
      #${PANEL_ID} h4 {
        margin: 0 0 8px; font-size: 12px; color: #6df2a9;
        letter-spacing: 0.06em; text-transform: uppercase;
        display: flex; justify-content: space-between; align-items: baseline;
      }
      #${PANEL_ID} h4 .ver { color: #5a708a; font-weight: 400; font-size: 10px; letter-spacing: 0; text-transform: none; }
      #${PANEL_ID} .section {
        margin-top: 8px; padding-top: 6px;
        border-top: 1px solid rgba(31, 53, 80, 0.55);
      }
      #${PANEL_ID} .section:first-of-type { margin-top: 0; padding-top: 0; border-top: none; }
      #${PANEL_ID} .section .sec-title {
        color: #5a8aae; font-size: 10px; letter-spacing: 0.10em;
        text-transform: uppercase; margin-bottom: 3px;
      }
      #${PANEL_ID} .row { display: flex; justify-content: space-between; gap: 10px; padding: 1px 0; }
      #${PANEL_ID} .k { color: #7ea0c2; font-size: 11px; }
      #${PANEL_ID} .v { color: #fff; font-size: 12px; font-weight: 500; text-align: right; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PANEL_ID} .v.mono { font-family: ui-monospace, Menlo, monospace; }
      #${PANEL_ID} .v.dim { color: #6e87a3; font-weight: 400; }
      #${PANEL_ID} .pill {
        display: inline-block; padding: 1px 7px; border-radius: 9px;
        font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
        border: 1px solid currentColor; line-height: 1.4;
      }
      #${PANEL_ID} .pill.ok    { color: #00e676; background: rgba(0, 230, 118, 0.10); }
      #${PANEL_ID} .pill.warn  { color: #ffd166; background: rgba(255, 209, 102, 0.10); }
      #${PANEL_ID} .pill.bad   { color: #ff6b6b; background: rgba(255, 107, 107, 0.10); }
      #${PANEL_ID} .pill.muted { color: #7ea0c2; background: rgba(126, 160, 194, 0.06); border-color: #2c4566; }
      #${PANEL_ID} .hot { color: #6df2a9; font-size: 11px; margin-top: 6px; }
      #${PANEL_ID} kbd {
        background: #15233a; border: 1px solid #2c4566; border-radius: 3px;
        padding: 1px 5px; font: 600 10px/1.2 ui-monospace, Menlo, monospace;
        color: #cfe; min-width: 14px; display: inline-block; text-align: center;
      }
      #${PANEL_ID} .keys {
        display: flex; flex-wrap: wrap; gap: 4px 6px;
        margin-top: 6px; padding-top: 6px;
        border-top: 1px solid rgba(31, 53, 80, 0.55);
      }
      #${PANEL_ID} .keys .kx { display: flex; align-items: center; gap: 3px; color: #7ea0c2; font-size: 10px; }
      #${BANNER_ID} {
        position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
        background: linear-gradient(90deg,#ff5252,#ff9100);
        color: #111; font: 700 14px/1.4 system-ui, sans-serif;
        padding: 10px 16px; text-align: center; letter-spacing: 0.02em;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
      #${PANEL_ID} .lookup-header {
        display: flex; justify-content: space-between; align-items: center;
        cursor: pointer; user-select: none; margin-top: 8px; padding-top: 6px;
        border-top: 1px solid #1f3550; color: #6df2a9; font-size: 11px;
        letter-spacing: 0.04em; text-transform: uppercase;
      }
      #${PANEL_ID} .lookup-header .caret { color: #7ea0c2; font-size: 10px; }
      #${PANEL_ID} .lookup-body { display: none; margin-top: 4px; }
      #${PANEL_ID} .lookup-body.open { display: block; }
      #${PANEL_ID} .lookup-input {
        width: 100%; box-sizing: border-box;
        background: #0e1c2b; color: #d6e7ff;
        border: 1px solid #2c4566; border-radius: 4px;
        padding: 4px 6px; font: inherit; margin-bottom: 4px;
      }
      #${PANEL_ID} .lookup-input:focus { outline: none; border-color: #6df2a9; }
      #${PANEL_ID} .lookup-list { max-height: 200px; overflow-y: auto; }
      #${PANEL_ID} .lookup-ship {
        display: flex; align-items: center; gap: 4px; padding: 2px 0;
        border-bottom: 1px solid #122036; font-size: 11px;
      }
      #${PANEL_ID} .lookup-ship:last-child { border-bottom: none; }
      #${PANEL_ID} .lookup-ship .lname { flex: 1; min-width: 0; color: #fff; cursor: pointer; }
      #${PANEL_ID} .lookup-ship .lname:hover { color: #6df2a9; text-decoration: underline; }
      #${PANEL_ID} .lookup-ship .lmfr { color: #7ea0c2; font-size: 9px; }
      #${PANEL_ID} .lookup-ship .lstar {
        background: transparent; color: #7ea0c2; border: 0; cursor: pointer;
        font-size: 12px; padding: 0 2px;
      }
      #${PANEL_ID} .lookup-ship .lstar.on { color: #ffd166; }
      #${PANEL_ID} .lookup-empty { color: #7ea0c2; font-size: 10px; padding: 4px 0; }
      .scr-opt-pack {
        outline: 3px solid #ff5252 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(255, 82, 82, 0.18) !important;
      }
      .scr-opt-pack::before {
        content: "⚠ PACK / BUNDLE";
        position: absolute; top: 6px; right: 6px;
        background: #ff5252; color: #111;
        font: 700 10px/1 system-ui, sans-serif;
        padding: 3px 6px; border-radius: 3px; letter-spacing: 0.04em;
        z-index: 1;
        pointer-events: none;
      }
      .scr-opt-standalone {
        outline: 3px solid #00e676 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(0, 230, 118, 0.20) !important;
      }
      .scr-opt-upgrade {
        outline: 3px solid #ffd166 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(255, 209, 102, 0.16) !important;
      }
      .scr-opt-upgrade::before {
        content: "ℹ UPGRADE (requires source ship)";
        position: absolute; top: 6px; right: 6px;
        background: #ffd166; color: #111;
        font: 700 10px/1 system-ui, sans-serif;
        padding: 3px 6px; border-radius: 3px; letter-spacing: 0.04em;
        z-index: 1; pointer-events: none;
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

  // ---------------- Pack vs standalone detection ------------------------
  // RSI's ship-selection bottom sheet (.orion-c-bottomSheet__content) lists
  // one or more `c-optionsItemShip` cards. Some are standalone ships, some
  // are large bundles ("Legatus 2953" with 188 ships, "Praetorian Pack" with
  // 30 ships, etc.). A misclick on "Add to cart" while a bundle is selected
  // can cost you €41k instead of €890. The detector flags each option as
  // pack-or-standalone, the panel surfaces the result, and lockToStandalone
  // refuses the [A] hotkey if a pack is currently selected.
  // ----------------------------------------------------------------------
  const PACK_KEYWORDS = [
    /pack\b/i, /bundle\b/i, /collection\b/i, /legatus/i, /anniversary/i,
    /praetorian/i, /pioneer.?pledge/i, /completionist/i,
  ];

  function findShipOptions() {
    return [...document.querySelectorAll(".c-optionsItemShip")];
  }

  function classifyShipOption(el) {
    const title = el.querySelector(".c-optionsItemShip__title")?.innerText.trim() ?? "";
    const subtitle = el.querySelector(".c-optionsItemShip__subtitle")?.innerText.trim() ?? "";
    const priceText = el.querySelector(".a-priceUnit__amount")?.innerText.trim() ?? "";
    const bodyItems = [...el.querySelectorAll(".c-optionsItemShip__bodyPledgeListContent p")]
      .map((p) => p.innerText.trim());
    const isSelected = el.classList.contains("-selected");

    // RSI labels each option's category in the title field — use it directly.
    // Verified live values: "STANDALONE SHIP", "UPGRADE", "PACKAGE".
    // (My old heuristic — ship-count, subtitle keywords, price — is kept as
    // a fallback for unknown titles like sale-specific labels.)
    let category;
    if (/^STANDALONE SHIP$/i.test(title)) category = "standalone";
    else if (/^UPGRADE$/i.test(title)) category = "upgrade";
    else if (/^PACKAGE$/i.test(title) || /^PACK$/i.test(title)) category = "pack";
    else {
      // Heuristic fallback
      let shipCount = 0;
      for (const item of bodyItems) {
        const m = item.match(/^(\d+)\s+ships?\b/i);
        if (m) { const n = Number(m[1]); if (n > shipCount) shipCount = n; }
      }
      const priceNum = Number((priceText.match(/[\d,]+/) || [""])[0].replace(/,/g, "")) || 0;
      const hasPackKeyword = PACK_KEYWORDS.some((re) => re.test(subtitle));
      if (shipCount > 1 || hasPackKeyword || priceNum > 2000) category = "pack";
      else category = "standalone";
    }

    const priceNum = Number((priceText.match(/[\d,]+/) || [""])[0].replace(/,/g, "")) || 0;
    return {
      el, title, subtitle, priceText, priceNum,
      category,                    // 'standalone' | 'upgrade' | 'pack'
      isStandalone: category === "standalone",
      isUpgrade: category === "upgrade",
      isPack: category === "pack",
      isSelected,
    };
  }

  function analyzeShipOptions() {
    const opts = findShipOptions().map(classifyShipOption);
    return {
      options: opts,
      hasOptions: opts.length > 0,
      selected: opts.find((o) => o.isSelected) ?? null,
      standalone: opts.filter((o) => o.isStandalone),
      upgrades: opts.filter((o) => o.isUpgrade),
      packs: opts.filter((o) => o.isPack),
    };
  }

  // Visual feedback: outline packs in red, upgrades in amber, standalone in
  // green. Idempotent — class additions overwrite prior runs, no buildup.
  function paintShipOptions(analysis) {
    for (const o of analysis.options) {
      o.el.classList.toggle("scr-opt-pack", o.isPack);
      o.el.classList.toggle("scr-opt-standalone", o.isStandalone);
      o.el.classList.toggle("scr-opt-upgrade", o.isUpgrade);
    }
  }

  // ---------------- Add-to-Cart + cart-nav helpers ----------------------
  function findAddToCartButton() {
    // Match the exact RSI shape first.
    for (const b of document.querySelectorAll("button")) {
      const txt = (b.querySelector('[data-cy-id="button__text"]')?.innerText || b.innerText || "").trim();
      if (/^add to cart$/i.test(txt)) {
        const rect = b.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && !b.disabled) return b;
      }
    }
    return null;
  }

  function findCartNavLink() {
    // Header cart link: anchor whose href ends with /cart or aria-label "cart".
    for (const el of document.querySelectorAll('a[href*="/cart"], a[aria-label*="cart" i], button[aria-label*="cart" i]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      return el;
    }
    return null;
  }

  let cartStatus = "—";
  function tryClickAddToCart() {
    const analysis = analyzeShipOptions();
    if (settings.lockToStandalone && analysis.hasOptions) {
      const sel = analysis.selected;
      // Strict: standalone only. Pack and Upgrade both blocked, with
      // different messages so the user knows what to do.
      if (!sel || !sel.isStandalone) {
        const reason = sel?.isPack ? "pack selected" : sel?.isUpgrade ? "upgrade selected" : "no standalone selected";
        cartStatus = `BLOCKED: ${reason}${sel ? ` (${sel.subtitle || sel.title})` : ""}`;
        const panel = document.getElementById(PANEL_ID);
        if (panel) {
          const prev = panel.style.border;
          panel.style.border = "2px solid #ff0033";
          setTimeout(() => { panel.style.border = prev; }, 1500);
        }
        return false;
      }
    }
    const btn = findAddToCartButton();
    if (!btn) { cartStatus = "no Add-to-Cart button on page"; return false; }
    btn.click();
    cartStatus = "Add-to-Cart clicked";
    const prev = btn.style.outline;
    btn.style.outline = "3px solid #00e676";
    setTimeout(() => { btn.style.outline = prev; }, 1500);
    return true;
  }

  function trySelectStandalone() {
    const analysis = analyzeShipOptions();
    if (analysis.standalone.length === 0) {
      cartStatus = "no STANDALONE SHIP option on this sheet";
      return false;
    }
    if (analysis.selected?.isStandalone) {
      cartStatus = "already on standalone";
      return true;
    }
    // Pick the cheapest standalone, click its title (the -isClickable element).
    const target = [...analysis.standalone].sort((a, b) => a.priceNum - b.priceNum)[0];
    const clickable = target.el.querySelector(".c-optionsItemShip__title.-isClickable, .c-optionsItemShip__subtitleContainer.-isClickable")
      || target.el;
    clickable.click();
    cartStatus = `switched to standalone: ${target.subtitle || target.title}`;
    return true;
  }

  function tryGoToCart() {
    const link = findCartNavLink();
    if (link) { link.click(); cartStatus = "clicked cart link"; return true; }
    // Fallback: direct navigation. Locale prefix derived from current path.
    const locale = (location.pathname.match(/^\/([a-z]{2})\//i) || [, "en"])[1];
    location.href = `/${locale}/pledge/cart`;
    cartStatus = `navigating to /${locale}/pledge/cart`;
    return true;
  }
  // ----------------------------------------------------------------------

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
      // Probe the CURRENT page (HEAD) — guaranteed not to redirect, so we
      // measure pure round-trip without polluting the user's history or
      // triggering RSI's locale-redirect chain. Previously hit "/" which
      // 302s to "/en/" and was implicated in the homepage navigation issue.
      const res = await fetch(location.pathname + location.search, { method: "HEAD", cache: "no-store" });
      if (!res.ok && res.status !== 0) return;
      latencyMs = Math.round(performance.now() - t0);
    } catch { /* ignore */ }
  }

  // Page-relevance gate. Manifest matches are wide (anything on RSI) so the
  // script attaches everywhere, but this gate hides the panel + skips all
  // work on the homepage / locale root — the pages where prior versions of
  // the script were interfering with RSI's locale-redirect on link clicks.
  // Returns false ONLY for homepage-shaped URLs; everything else is fair game.
  const HOMEPAGE_PATTERNS = [
    /^\/?$/,              //  ""  or  "/"
    /^\/[a-z]{2}\/?$/i,   //  "/en", "/en/", "/fr", etc.
  ];
  function isRelevantPage() {
    return !HOMEPAGE_PATTERNS.some((p) => p.test(location.pathname));
  }

  // ---------------- Ship lookup (overlay-panel section) ----------------
  // Same data flow as the popup's lookup — fetch ship-matrix once, cache in
  // chrome.storage.local (or localStorage in userscript context) for 1h,
  // expose search + bookmarks. Click a ship to open its canonical pledge
  // URL in a new tab.
  const LOOKUP_CACHE_KEY = "scr_shipMatrixCache";
  const LOOKUP_BOOKMARKS_KEY = "scr_bookmarkedShipIds";
  const LOOKUP_CACHE_TTL_MS = 60 * 60 * 1000;
  const LOOKUP_SEEDS = [
    "Idris", "Javelin", "Polaris", "Pioneer", "Banu Merchantman", "Kraken",
    "Galaxy", "Liberator", "Ironclad", "Carrack", "890 Jump", "BMM",
  ];

  let lookupShips = [];
  let lookupBookmarks = new Set();
  let lookupOpen = false;
  let lookupLoaded = false;

  // Storage abstraction: chrome.storage.local in the extension, localStorage
  // in the userscript. Same get/set surface so callers don't branch.
  async function lookupStorageGet(key) {
    if (hasChromeStorage()) {
      try { const v = await chrome.storage.local.get(key); return v[key]; }
      catch { /* fall through */ }
    }
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
  }
  async function lookupStorageSet(key, value) {
    if (hasChromeStorage()) {
      try { await chrome.storage.local.set({ [key]: value }); return; } catch { /* fall */ }
    }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }

  async function lookupFetchMatrix(force = false) {
    if (!force) {
      const cached = await lookupStorageGet(LOOKUP_CACHE_KEY);
      if (cached && Date.now() - cached.ts < LOOKUP_CACHE_TTL_MS) return cached.data;
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
    await lookupStorageSet(LOOKUP_CACHE_KEY, { ts: Date.now(), data });
    return data;
  }

  function lookupSeedBookmarksFromSeeds() {
    lookupBookmarks = new Set();
    for (const seed of LOOKUP_SEEDS) {
      for (const s of lookupShips) {
        if (s.name && s.name.toLowerCase().includes(seed.toLowerCase())) {
          lookupBookmarks.add(s.id);
        }
      }
    }
  }

  async function lookupLoad() {
    if (lookupLoaded) return;
    try {
      lookupShips = await lookupFetchMatrix();
      const stored = await lookupStorageGet(LOOKUP_BOOKMARKS_KEY);
      if (stored === undefined || stored === null) {
        lookupSeedBookmarksFromSeeds();
        await lookupStorageSet(LOOKUP_BOOKMARKS_KEY, [...lookupBookmarks]);
      } else if (Array.isArray(stored)) {
        lookupBookmarks = new Set(stored);
      }
      lookupLoaded = true;
    } catch (err) {
      console.warn("[scr] ship-matrix load failed:", err);
    }
  }

  function lookupRenderList(rootEl, query) {
    while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
    const q = (query || "").trim().toLowerCase();
    let view;
    if (q) {
      view = lookupShips.filter((s) =>
        s.name.toLowerCase().includes(q) || s.manufacturer.toLowerCase().includes(q),
      ).slice(0, 20);
    } else {
      view = lookupShips.filter((s) => lookupBookmarks.has(s.id))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    if (view.length === 0) {
      const e = document.createElement("div");
      e.className = "lookup-empty";
      e.textContent = q ? `No ships match "${q}"` : "No bookmarks — type a ship name to search.";
      rootEl.appendChild(e);
      return;
    }
    for (const s of view) {
      const row = document.createElement("div");
      row.className = "lookup-ship";

      const name = document.createElement("span");
      name.className = "lname";
      name.title = s.url || s.name;
      const nameTxt = document.createElement("span");
      nameTxt.textContent = s.name;
      const mfr = document.createElement("span");
      mfr.className = "lmfr";
      mfr.textContent = s.manufacturer ? `  · ${s.manufacturer}` : "";
      name.appendChild(nameTxt); name.appendChild(mfr);
      name.addEventListener("click", () => {
        if (!s.url) return;
        window.open(s.url, "_blank", "noopener,noreferrer");
      });
      row.appendChild(name);

      const star = document.createElement("button");
      star.className = "lstar" + (lookupBookmarks.has(s.id) ? " on" : "");
      star.textContent = lookupBookmarks.has(s.id) ? "★" : "☆";
      star.title = lookupBookmarks.has(s.id) ? "Unbookmark" : "Bookmark";
      star.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (lookupBookmarks.has(s.id)) lookupBookmarks.delete(s.id);
        else lookupBookmarks.add(s.id);
        await lookupStorageSet(LOOKUP_BOOKMARKS_KEY, [...lookupBookmarks]);
        lookupRenderList(rootEl, query);
      });
      row.appendChild(star);

      rootEl.appendChild(row);
    }
  }
  // ---------------------------------------------------------------------

  // ---------------- Panel construction (sectioned, visual) -------------
  function mkSection(title) {
    const sec = document.createElement("div");
    sec.className = "section";
    const t = document.createElement("div");
    t.className = "sec-title";
    t.textContent = title;
    sec.appendChild(t);
    return sec;
  }

  function mkRow(id, label, opts = {}) {
    const row = document.createElement("div");
    row.className = "row";
    const k = document.createElement("span"); k.className = "k"; k.textContent = label;
    const v = document.createElement("span");
    v.className = "v" + (opts.mono ? " mono" : "");
    v.id = `scr-${id}`;
    v.textContent = "—";
    row.appendChild(k); row.appendChild(v);
    return row;
  }

  // Build the panel using DOM methods — no innerHTML, no untrusted content.
  function makePanel() {
    const p = document.createElement("div");
    p.id = PANEL_ID;

    const h = document.createElement("h4");
    const hLeft = document.createElement("span");
    hLeft.textContent = "RSI checkout rehearsal";
    const hRight = document.createElement("span");
    hRight.className = "ver";
    hRight.textContent = "scr";
    h.appendChild(hLeft); h.appendChild(hRight);
    p.appendChild(h);

    // ─── PAGE ─────────────────────────────────────────────────────────
    const secPage = mkSection("Page");
    secPage.appendChild(mkRow("url",  "URL",  { mono: true }));
    secPage.appendChild(mkRow("ship", "Ship"));
    secPage.appendChild(mkRow("mode", "Mode"));
    // Alt-URL row (link). Hidden by default; shown only on pledge pages.
    const altRow = document.createElement("div");
    altRow.className = "row"; altRow.id = "scr-alt-row"; altRow.style.display = "none";
    const altK = document.createElement("span"); altK.className = "k"; altK.textContent = "Alt URL";
    const altA = document.createElement("a"); altA.id = "scr-alt"; altA.className = "v";
    altA.style.color = "#6df2a9"; altA.style.textDecoration = "underline";
    altA.target = "_self"; altA.rel = "noopener";
    altRow.appendChild(altK); altRow.appendChild(altA);
    secPage.appendChild(altRow);
    p.appendChild(secPage);

    // ─── OFFERS ──────────────────────────────────────────────────────
    const secOffers = mkSection("Offers");
    secOffers.appendChild(mkRow("offers", "Count"));
    secOffers.appendChild(mkRow("selopt", "Selected"));
    p.appendChild(secOffers);

    // ─── CHECKOUT ────────────────────────────────────────────────────
    const secCheckout = mkSection("Checkout");
    secCheckout.appendChild(mkRow("buy", "Buy buttons"));
    secCheckout.appendChild(mkRow("co",  "Checkout"));
    secCheckout.appendChild(mkRow("sc",  "Store credit"));
    secCheckout.appendChild(mkRow("tot", "Total"));
    p.appendChild(secCheckout);

    // ─── ACTIONS ─────────────────────────────────────────────────────
    const secStatus = mkSection("Actions");
    secStatus.appendChild(mkRow("max",     "Max button"));
    secStatus.appendChild(mkRow("prefill", "SC autofill"));
    secStatus.appendChild(mkRow("flow",    "Flow"));
    secStatus.appendChild(mkRow("cart",    "Cart action"));
    secStatus.appendChild(mkRow("lock",    "SC lock"));
    secStatus.appendChild(mkRow("lockSA",  "Standalone lock"));
    secStatus.appendChild(mkRow("lat",     "Latency", { mono: true }));
    p.appendChild(secStatus);

    // ─── HOTKEYS (rendered fresh each refresh so custom bindings show) ─
    const keys = document.createElement("div");
    keys.className = "keys";
    keys.id = "scr-keys";
    p.appendChild(keys);

    const tip = document.createElement("div");
    tip.className = "hot"; tip.id = "scr-tip";
    p.appendChild(tip);

    // Collapsible lookup section.
    const lookupHeader = document.createElement("div");
    lookupHeader.className = "lookup-header";
    const lookupTitle = document.createElement("span");
    lookupTitle.textContent = "Ship lookup";
    const lookupCaret = document.createElement("span");
    lookupCaret.className = "caret";
    lookupCaret.id = "scr-lookup-caret";
    lookupCaret.textContent = "[+]";
    lookupHeader.appendChild(lookupTitle);
    lookupHeader.appendChild(lookupCaret);
    p.appendChild(lookupHeader);

    const lookupBody = document.createElement("div");
    lookupBody.className = "lookup-body";
    lookupBody.id = "scr-lookup-body";
    const lookupInput = document.createElement("input");
    lookupInput.type = "search";
    lookupInput.className = "lookup-input";
    lookupInput.placeholder = "Type a ship name (e.g. Polaris)";
    lookupInput.id = "scr-lookup-input";
    lookupInput.autocomplete = "off";
    const lookupList = document.createElement("div");
    lookupList.className = "lookup-list";
    lookupList.id = "scr-lookup-list";
    const lookupHint = document.createElement("div");
    lookupHint.className = "lookup-empty";
    lookupHint.textContent = "Loading ship-matrix…";
    lookupList.appendChild(lookupHint);
    lookupBody.appendChild(lookupInput);
    lookupBody.appendChild(lookupList);
    p.appendChild(lookupBody);

    // Header click toggles open. Load ship-matrix lazily on first expand.
    lookupHeader.addEventListener("click", async () => {
      lookupOpen = !lookupOpen;
      lookupBody.classList.toggle("open", lookupOpen);
      lookupCaret.textContent = lookupOpen ? "[–]" : "[+]";
      if (lookupOpen) {
        await lookupLoad();
        lookupRenderList(lookupList, lookupInput.value);
      }
    });
    lookupInput.addEventListener("input", () => {
      lookupRenderList(lookupList, lookupInput.value);
    });
    // Don't let M / N / R / F hotkeys fire when typing in the lookup search.
    lookupInput.addEventListener("keydown", (e) => { e.stopPropagation(); });

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

  // Set a status cell as a coloured pill. `kind` ∈ ok | warn | bad | muted.
  // Falls back to plain text if cell is missing.
  function setPill(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    el.style.color = ""; el.style.fontWeight = "";
    if (!text || text === "—") {
      const span = document.createElement("span");
      span.className = "v dim";
      span.textContent = "—";
      el.appendChild(span);
      return;
    }
    const pill = document.createElement("span");
    pill.className = `pill ${kind || "muted"}`;
    pill.textContent = text;
    el.appendChild(pill);
  }

  // Render the dynamic hotkey legend (so user's custom bindings show up).
  function renderHotkeysLegend() {
    const root = document.getElementById("scr-keys");
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    const order = [
      ["focus",      "focus"],
      ["add",        "add"],
      ["standalone", "standalone"],
      ["cart",       "cart"],
      ["max",        "max"],
      ["next",       "next"],
      ["refresh",    "refresh"],
    ];
    for (const [action, label] of order) {
      const wrap = document.createElement("span");
      wrap.className = "kx";
      const kbd = document.createElement("kbd");
      const k = hotkeys[action] || "";
      kbd.textContent = k.length === 1 ? k.toUpperCase() : (k || "?");
      wrap.appendChild(kbd);
      wrap.appendChild(document.createTextNode(" " + label));
      root.appendChild(wrap);
    }
    const esc = document.createElement("span");
    esc.className = "kx";
    const kEsc = document.createElement("kbd"); kEsc.textContent = "Esc";
    esc.appendChild(kEsc); esc.appendChild(document.createTextNode(" hide"));
    root.appendChild(esc);
  }

  function clearButtonHighlights() {
    for (const el of document.querySelectorAll(".scr-buy-hi, .scr-checkout-hi")) {
      el.classList.remove("scr-buy-hi", "scr-checkout-hi");
    }
  }

  function refresh() {
    // SPA-navigation safety: if the URL has drifted to a page we don't care
    // about, hide everything and skip all work. The user clicked a link,
    // we get out of their way.
    if (!isRelevantPage()) {
      const p = document.getElementById(PANEL_ID);
      if (p) p.style.display = "none";
      const b = document.getElementById(BANNER_ID);
      if (b) b.remove();
      clearButtonHighlights();
      return;
    }

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

    setText("scr-url", location.pathname.slice(0, 36));
    setText("scr-buy", String(buys.length));
    setText("scr-co", String(cos.length));
    setText("scr-sc", readStoreCredit() ?? "—");
    setText("scr-tot", readCartTotal() ?? "—");

    // Max button — green pill on success, muted otherwise.
    if (!maxStatus || maxStatus === "—") setPill("scr-max", "—", "muted");
    else if (/applied/i.test(maxStatus))  setPill("scr-max", "applied", "ok");
    else if (/no Max/i.test(maxStatus))   setPill("scr-max", "not found", "muted");
    else                                  setPill("scr-max", maxStatus, "muted");

    // SC autofill
    if (!prefillStatus || prefillStatus === "—") setPill("scr-prefill", "—", "muted");
    else if (/prefilled/i.test(prefillStatus))   setPill("scr-prefill", "prefilled", "ok");
    else if (/disabled/i.test(prefillStatus))    setPill("scr-prefill", "off", "muted");
    else                                         setPill("scr-prefill", prefillStatus.slice(0, 24), "muted");

    // Flow ([N])
    if (!settings.enableFlowHotkey) setPill("scr-flow", "off", "muted");
    else if (!flowStatus || flowStatus === "—") setPill("scr-flow", "armed", "warn");
    else if (/^BLOCKED/.test(flowStatus))       setPill("scr-flow", "BLOCKED", "bad");
    else if (/^clicked/.test(flowStatus))       setPill("scr-flow", "clicked", "ok");
    else                                        setPill("scr-flow", flowStatus.slice(0, 22), "muted");

    // Cart ([A] / [C])
    if (!cartStatus || cartStatus === "—") setPill("scr-cart", "—", "muted");
    else if (/^BLOCKED/.test(cartStatus))  setPill("scr-cart", "BLOCKED", "bad");
    else if (/clicked|switched|navigat/i.test(cartStatus)) setPill("scr-cart", cartStatus.slice(0, 26), "ok");
    else                                    setPill("scr-cart", cartStatus.slice(0, 26), "muted");

    // Ship-option detection: paint outlines + report counts.
    const analysis = analyzeShipOptions();
    paintShipOptions(analysis);
    if (!analysis.hasOptions) {
      setText("scr-offers", "—");
      setPill("scr-selopt", "—", "muted");
    } else {
      setText(
        "scr-offers",
        `${analysis.options.length} · ${analysis.standalone.length} sa / ${analysis.upgrades.length} up / ${analysis.packs.length} pk`,
      );
      const sel = analysis.selected;
      const catKind = sel?.isPack ? "bad" : sel?.isUpgrade ? "warn" : sel?.isStandalone ? "ok" : "muted";
      const subtitle = (sel?.subtitle || sel?.title || "none").slice(0, 26);
      const tag = sel?.isPack ? "PACK" : sel?.isUpgrade ? "UPGRADE" : sel?.isStandalone ? "standalone" : "?";
      setPill("scr-selopt", `${tag} · ${subtitle}`, catKind);
    }

    if (!settings.lockStoreCredit) setPill("scr-lock", "off", "muted");
    else if (isStoreCreditApplied()) setPill("scr-lock", "OK applied", "ok");
    else setPill("scr-lock", "ARMED — blocks Place Order", "bad");

    if (!settings.lockToStandalone) setPill("scr-lockSA", "off", "muted");
    else if (!analysis.hasOptions) setPill("scr-lockSA", "armed (no offers)", "warn");
    else if (!analysis.selected?.isStandalone) {
      const r = analysis.selected?.isPack ? "pack" : analysis.selected?.isUpgrade ? "upgrade" : "none";
      setPill("scr-lockSA", `ARMED — ${r} selected`, "bad");
    } else setPill("scr-lockSA", "OK standalone", "ok");

    setText("scr-lat", latencyMs == null ? "—" : `${latencyMs} ms`);
    renderHotkeysLegend();

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
    const k = (e.key || "").toLowerCase();
    if (k === hotkeys.focus)           { focusNext();           e.preventDefault(); }
    else if (k === hotkeys.max)        { tryClickMaxCredit();   refresh(); e.preventDefault(); }
    else if (k === hotkeys.next)       { tryClickFlow();        refresh(); e.preventDefault(); }
    else if (k === hotkeys.add)        { tryClickAddToCart();   refresh(); e.preventDefault(); }
    else if (k === hotkeys.cart)       { tryGoToCart();         e.preventDefault(); }
    else if (k === hotkeys.standalone) { trySelectStandalone(); refresh(); e.preventDefault(); }
    else if (k === hotkeys.refresh)    { refresh(); }
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
      if (!isRelevantPage()) return;
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
    await Promise.all([loadSettings(), loadHotkeys()]);
    watchSettings(() => refresh());
    refresh(); // immediate first paint
    if (settings.measureLatency) measureLatency().then(refresh);
    setInterval(() => {
      if (settings.measureLatency) measureLatency().then(refresh);
      else refresh();
    }, 1500); // was 3000 — snappier panel updates
  })();
})();
