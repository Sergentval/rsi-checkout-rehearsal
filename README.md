# RSI Checkout Rehearsal — Chromium / Edge extension

Personal click-helper for the Roberts Space Industries pledge / cart /
checkout flow. Highlights buy buttons, shows store-credit balance + cart
total + latency, surfaces ship-availability info, gives rebindable hotkeys
that fire one click per keypress. Never auto-submits a purchase chain —
every committing click stays on you, just faster.

This repo previously contained a Node.js / systemd daemon that polled RSI
sources and pushed Discord/ntfy alerts. That side has been removed —
external tools (like SC Tracker) cover the same need. The extension is
the only thing here now.

## What it does

| Feature                        | Why it matters                                              |
| ------------------------------ | ----------------------------------------------------------- |
| Overlay panel                  | Live page state: ship, mode (warbond/credit), cart total, latency, locks |
| Pack / standalone detection    | Red outline on PACKAGE bundles, green on STANDALONE SHIP    |
| Pack-only banner               | Full-width alert when the bottom sheet has zero standalone offers |
| Wave countdown                 | Local-time countdown to the next DefenseCon wave + per-ship status |
| Pre-wave reminder              | Desktop notification 5 min before each wave (for scouted ships) |
| Scout                          | Background service worker polls ship URLs, notifies on sold-out → available |
| Cart / checkout keep-alive     | Marks those tabs `autoDiscardable=false` so Chrome doesn't unload them |
| Draggable panel                | Click and drag the header; position persists                |
| Hotkey-driven flow             | One key, one click — V → S → A → C → M → T → N             |

## Install

The extension is **unpacked** (loaded from disk, not the Chrome Web Store).

```
git clone https://github.com/Sergentval/sc-drop-watcher.git
```

Then in Edge / Chrome / Brave:

1. Open `edge://extensions/` (or `chrome://extensions/`)
2. Toggle **Developer mode** on (top right in Chrome, left sidebar in Edge)
3. Click **Load unpacked** → select the `chrome-extension/` folder
4. The extension appears in the toolbar. Click its icon for the popup.

To update: `git pull` then click the refresh icon on the extension card.
Hard-refresh any open RSI tab to pick up the new content script.

## Hotkeys

All rebindable in the options page (right-click icon → **Options**, or popup
→ **Open settings page →**). One key = one click on a single button.

| Key | Action                                                          |
| --- | --------------------------------------------------------------- |
| `V` | Click **VIEW OFFERS** on a ship page                            |
| `S` | Select the **STANDALONE SHIP** option in the offer sheet        |
| `A` | Click **Add to Cart**                                           |
| `C` | Go to **Cart** (header link or `/<locale>/pledge/cart`)         |
| `M` | Click **Apply Max Credit** on the payment page                  |
| `T` | Tick the TOS checkbox in the cart disclaimer modal              |
| `N` | Click **Continue / Place Order / I agree** — the page's primary "next" |
| `B` | Go **Back** (escape a pack-only ship)                           |
| `R` | Force-refresh the overlay panel                                 |
| `Esc` | Hide / show the overlay (fixed, not rebindable)               |

A typical run from ship page → completed purchase:

```
V → opens offers
S → switches to STANDALONE SHIP if RSI defaulted to PACKAGE
A → Add to Cart
C → go to cart
N → Continue to checkout
N → Continue from address page
M → Apply Max Credit on payment
N → Place Order → disclaimer modal opens
T → tick TOS checkbox (or leave auto-tick on)
N → I agree → purchase commits
```

## Settings page

Three cards:

**Behaviour** — toggle each feature independently. Toggles that can complete
a purchase or change the purchase flow are tagged `ALTERS PURCHASE FLOW`
in red. All defaults are safe.

**Hotkeys** — click any key cell, press the new key to rebind. `Escape`
cancels. Duplicate keys show in red.

**Reset** — wipes toggles + hotkeys + bookmarks (with confirm prompt).

Plus dedicated cards:

**Waves — event schedule** — edit the wave config (event name, window,
daily wave times in UTC, limited-ships release dates). Defaults to the
DefenseCon 2956 schedule scraped from the FAQ on 2026-05-11. Local-time
preview shown next to each UTC field.

**Scout** — enable polling, set interval (1.5s to 5min), pick which ships
to watch. Sub-30s intervals show a live `~N requests/min` warning so
you can see your rate before committing.

## Toggles

| Toggle                                 | What it controls                              | Default |
| -------------------------------------- | --------------------------------------------- | ------- |
| Show overlay panel                     | Bottom-right info panel                       | on      |
| Highlight buy buttons                  | Pulsing green/orange outlines                 | on      |
| Payment-page warning banner            | Red "slow down" banner on `/checkout/payment` | on      |
| Auto-click "Max credit" button         | Click RSI's apply-max on payment-page entry   | on      |
| Store-credit input prefill (fallback)  | Regex prefill when Max button isn't on page   | on      |
| Measure latency to RSI                 | HEAD request per refresh                      | on      |
| `[N]` hotkey: click Continue / Place Order | Required for the N hotkey to fire         | **off** |
| Lock to store credit                   | `N` refuses Place Order until credit applied  | **off** |
| Lock to standalone ship                | `A` refuses Add-to-Cart on PACKAGE/UPGRADE    | **off** |
| Auto-tick TOS modal                    | Auto-tick the cart disclaimer checkbox        | **off** |

## Overlay panel

Sections (collapsible by section header):

```
PAGE        URL, Ship, Mode (Warbond/Credit), Alt URL
OFFERS      Count breakdown, currently-selected option (red/amber/green pill)
CHECKOUT    Buy buttons, Checkout, Store credit, Total
ACTIONS     Max button, SC autofill, TOS modal, Flow, Cart, locks
WAVES       Event, State (LIVE/before/ended), Next wave, Ship status
LATENCY     Site (RTT), Client (refresh), Last action — color-tiered
SHIP LOOKUP collapsible search + bookmarks
```

The header is the drag handle — click and drag to move; position persists.

### Latency tiers

| Metric             | Green   | Amber       | Red      |
| ------------------ | ------- | ----------- | -------- |
| Site (RTT)         | ≤100 ms | ≤300 ms     | >300 ms  |
| Client (refresh)   | ≤5 ms   | ≤20 ms      | >20 ms   |
| Last action        | ≤10 ms  | ≤50 ms      | >50 ms   |

## What the extension does NOT do

- Auto-submit any purchase chain (each commit click is a deliberate keypress)
- Auto-fill credit-card or payment fields
- Bypass captchas or anti-bot detection
- Run on the RSI homepage (`/`, `/en/`, etc.) — only on pledge / checkout / cart / Spectrum / comm-link / account pages

## Permissions

Declared in `manifest.json`:

| Permission         | Used by                                                  |
| ------------------ | -------------------------------------------------------- |
| `activeTab`        | Popup querying the current tab's host                    |
| `storage`          | Persisting toggles, hotkeys, bookmarks, scout list, waves |
| `alarms`           | Scout polling cadence, pre-wave reminder timing          |
| `notifications`    | Scout "back in stock" + pre-wave alerts                  |
| `tabs`             | Marking cart/checkout tabs non-discardable (keep-alive)  |
| host: `robertsspaceindustries.com/*` | Content script + scout fetches      |

## Files

```
chrome-extension/
├── manifest.json         MV3 manifest
├── background.js         service worker — scout poll, keep-alive, pre-wave alarm
├── content.js            DOM overlay panel + all hotkey handlers
├── popup.html / popup.js toolbar popup (toggles + ship lookup)
├── options.html / .css / .js  full-tab settings page (toggles, hotkeys, waves, scout)
└── icons/                16/48/128 px placeholder icons
```

No build step, no dependencies. Plain HTML/CSS/JS — edit, reload extension,
done.
