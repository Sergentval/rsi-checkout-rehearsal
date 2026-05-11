# sc-drop-watcher

Personal Star Citizen drop notifier. **Read-only polling**, push to Discord +
ntfy when something new appears. No authenticated calls, no purchase
automation, nothing that touches a checkout flow — just a feed reader that
gets you to the keyboard before everyone else.

## Sources

| Source         | Endpoint                                                              | Cadence | Signal                                                                              |
| -------------- | --------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `ship-matrix`  | `POST /ship-matrix/index`                                             | 5 min   | Datamined ship roster — fires on new ship ID **and** on `production_status` flips (concept ↔ flight-ready), the leak signal beyond "never seen before". |
| `comm-link`    | `GET /en/comm-link/transmission`                                      | 60 s    | Authoritative drop signal — concept sales are announced here first.                 |
| `pledge-store` | `GET /en/pledge/ships`                                                | 60 s    | Best-effort. Listing is JS-rendered, so plain-HTML scraping usually returns 0 SKUs. |
| `calendar`     | hardcoded annual cadence (Invictus / Alien Week / CitizenCon / IAE / Luminalia) | 1 h | Heads-up ~24h before a known sale window opens, then again when it goes live and 24h before it closes. |

The `comm-link` source is what actually catches new drops in real time. The
`calendar` source covers "you forgot Invictus starts tomorrow" — useful for
windows where concept reveals are likely. `ship-matrix` is the leak channel.

## Watchlist

The daemon detects every drop. The watchlist is the filter that decides which
ones get a louder alert.

Set `WATCHLIST` in `.env` to a comma-separated list of `ship:mode` pairs:

```bash
# Just the ship: alert on any version
WATCHLIST=Polaris

# Warbond only (fresh-money sale)
WATCHLIST=Polaris:warbond

# Store-credit allowed only (no warbond suffix in URL)
WATCHLIST=Polaris:store-credit

# Mixed: track several ships, each with its own preference
WATCHLIST=Polaris:warbond,Idris:any,Galaxy:credit
```

Mode aliases: `warbond` = `wb`, `store-credit` = `credit` = `sc`, `any`
(default).

Match logic is case-insensitive substring search across the detection's
title + URL. The warbond marker is the whole word `warbond` (won't trigger
on e.g. "Warbondage"). When a match fires, the push is escalated:

| Channel  | Normal drop                    | Watchlist match                                |
| -------- | ------------------------------ | ---------------------------------------------- |
| Discord  | green embed, `[DROP]` tag      | bright red embed, `[WATCH]` tag                |
| ntfy     | priority `high`, tag `rocket`  | priority `max`, tag `rotating_light` (alarm)   |

After editing `WATCHLIST` in `.env`, restart the service:
`sudo systemctl restart sc-drop-watcher`. The startup log line shows the
parsed watchlist so you can confirm it loaded correctly.

## URL probe (for known ships that may re-stock)

The watchlist matches against detections from comm-link posts and ship-matrix
entries — that covers everything once CIG announces or adds the ship to
their data. The URL probe is for the specific case where you already know a
ship's canonical URL (because it's been sold before) and want to catch the
moment its page flips from 404 back to 200 — i.e. RSI silently re-stocks a
limited item without publishing a new comm-link post.

### What the probe can and can't do

| Scenario                                                | Right tool                            |
| ------------------------------------------------------- | ------------------------------------- |
| Unannounced ship like ODIN, you have no URL             | `WATCHLIST=ODIN:any` (no probe)       |
| Re-stock of a known ship (e.g. Idris-K)                 | `PROBE_URLS=<its canonical url>`      |
| Concept-sale announcement of any ship                   | watchlist or default `[DROP]` push    |

You **cannot** probe an upcoming ship's URL — the URL isn't knowable until
RSI publishes the ship-matrix entry, and at that point the existing
ship-matrix detection already catches it (within 5 min, and with the
correct canonical URL in the push because the daemon now reads RSI's own
`.url` field).

### Finding a canonical URL

Visit the ship's page on `robertsspaceindustries.com`; the URL bar will show
`https://robertsspaceindustries.com/pledge/ships/<mfr-slug>/<ship-slug>`.
Or query ship-matrix directly:

```bash
curl -s -X POST https://robertsspaceindustries.com/ship-matrix/index \
  -H "X-Requested-With: XMLHttpRequest" \
  | jq '.data[] | select(.name | test("Idris"; "i")) | {name, url}'
```

### Configuration

```bash
PROBE_URLS=https://robertsspaceindustries.com/pledge/ships/aegis-dynamics/Idris-K,https://robertsspaceindustries.com/pledge/ships/aegis-dynamics/Javelin
PROBE_INTERVAL_SEC=120
```

Status-transition logic:

| Was      | Now      | Action                                                                                |
| -------- | -------- | ------------------------------------------------------------------------------------- |
| (first)  | any      | silent — just learn the baseline                                                      |
| 4xx / -1 | 2xx      | **watchlist-priority push** ("URL went live: HTTP 404 → 200")                         |
| 2xx      | 4xx      | removed-priority push ("page taken down")                                             |
| same     | same     | silent                                                                                |

The probe is targeted, not a scanner — list the exact URLs you care about,
not categories. 120s default is the recommended floor; below ~60s starts
to look rude on RSI's side.

Restart the service after editing `PROBE_URLS`. Startup line includes
`probe=N url(s) every Ns` so you can confirm it loaded.

## Companion: checkout rehearsal (browser-side)

Two equivalent flavors — pick one. Both run only on `robertsspaceindustries.com`
and do exactly the same thing.

What they do:

- Outline buy/checkout buttons with a pulsing green/orange ring.
- Show a small overlay with: page URL, buy-button count, store-credit balance
  (parsed from page text), cart total, latency to RSI in ms, store-credit
  autofill status.
- On `/checkout/payment` (and `/payment` / `/confirm`), find the store-credit
  amount input by name/placeholder/aria-label/surrounding-label and pre-fill
  it with the cart total. Input flashes green when filled. **You still click
  Apply and Place Order yourself.**
- Hotkeys: **F** focus next buy button, **R** force refresh, **Esc** hide
  the overlay.
- On payment-shaped URLs, paint a red "slow down" banner so you don't
  misclick under pressure.

It does **not** click anything, submit anything, or fill payment-card fields.
The store-credit autofill is the same UX category as a password manager
filling a credit-card number — value goes in, human presses the button.

### Option A: Chromium extension (recommended)

`chrome-extension/` is a Manifest V3 extension. Load unpacked:

1. Open `chrome://extensions/` (or `brave://extensions/`, `edge://extensions/`).
2. Toggle **Developer mode** on (top right).
3. **Load unpacked** → select `~/projects/sc-drop-watcher/chrome-extension/`.
4. Open any RSI page. The bottom-right panel should appear within a second.
5. Click the toolbar icon for a popup showing version + current-tab status +
   hotkey reference.

No build step. Edit `content.js`, hit the refresh icon next to the extension
card on `chrome://extensions/` to reload.

### Option B: Tampermonkey / Violentmonkey userscript

`userscript/rsi-checkout-rehearsal.user.js` is the same logic without the
extension chrome. Drag the file into Tampermonkey or Violentmonkey to install.
Useful if you don't want a permanent extension entry in your browser, or if
you're using a managed Chrome where extension loading is restricted.

> The userscript is generated from `chrome-extension/content.js` plus
> `userscript/header.txt` via `npm run build:userscript`. Edit `content.js`
> (the source of truth), then regenerate. Don't hand-edit the userscript
> file directly — your changes will be overwritten on the next build.

### What the panel shows

| Field          | Source                                                                        |
| -------------- | ----------------------------------------------------------------------------- |
| URL            | `location.pathname` (truncated to 32 chars)                                   |
| Ship           | parsed from `/pledge/<category>/<slug>` URLs, with `-Warbond` stripped        |
| Mode           | `WARBOND (fresh money)` if URL ends in `-Warbond`, else `Store credit OK`     |
| Alt URL        | the toggled-warbond URL — clickable, present only on `/pledge/...` pages      |
| Buy buttons    | count of visible Add-to-Cart-shaped buttons                                   |
| Checkout       | count of visible Checkout / Place-Order / Pay-shaped buttons                  |
| Store credit   | dollar amount near "store credit" text, parsed from page                      |
| Total          | dollar amount near "total" / "order total" / "grand total", parsed from page  |
| SC autofill    | regex-based fallback if RSI's Max button isn't on the page                    |
| Max button     | did we find and click RSI's "apply max credit" button on a payment page?      |
| Latency        | round-trip time of one HEAD request to RSI per refresh                        |

Hotkeys: **F** focus next buy button, **M** click Max-credit button on
payment pages, **R** force refresh, **Esc** hide / show the overlay.

### Toggles (extension only)

Click the toolbar icon to open the popup. Six toggles control the script's
features individually; settings persist via `chrome.storage.local` and apply
instantly to any open RSI tab via `chrome.storage.onChanged`. All default on.

| Toggle                              | What it controls                                          |
| ----------------------------------- | --------------------------------------------------------- |
| Show overlay panel                  | bottom-right info overlay (off → panel hidden, no work)   |
| Highlight buy buttons               | pulsing green/orange button outlines                      |
| Payment-page warning banner         | red "slow down" banner on `/checkout/payment`             |
| Auto-click "Max credit" button      | clicks RSI's Max button once on payment-page entry        |
| Store-credit input prefill          | regex-based fallback when RSI's Max button isn't present  |
| Measure latency to RSI              | one HEAD request per refresh (off → no extra traffic)     |
| [N] hotkey (default **off**)        | press `N` to click the page's primary Continue / Place Order |
| Lock to store credit (default **off**) | `N` refuses to click Place Order until credit is applied |

There's also a **Reset to defaults** button that flips everything back to its
default (everything on except `enableFlowHotkey` and `lockStoreCredit`).

### Store-credit lock

Off by default — flip it on if you want to **enforce** that every purchase
uses store credit and not your card. When armed:

- The `N` hotkey gates clicks on `Place Order` / `Confirm` / `Pay` buttons
  on a check: is store credit actually applied?
- Detection signals (any one counts as "applied"):
  1. The script clicked RSI's Max-credit button this page-load.
  2. The script prefilled the store-credit input (regex fallback).
  3. Visible page text contains `"store credit applied: $X"` (X > 0) or the
     order total reads `$0`.
- If none of the above, `N` refuses to click and flashes the panel red.
  The panel `SC lock` row shows `ARMED: blocks Place Order` (red) vs
  `OK: credit applied` (green).
- **Continue / Next / Checkout / Proceed clicks are unaffected** — the lock
  only fires on the final commit button.

To bypass once: turn the lock off in the popup and press `N`.

### The N hotkey

Off by default — flip it on in the popup if you want it.

When armed, pressing `N` clicks **one** button on the current page: whichever
visible button matches `Continue` / `Next` / `Proceed` / `Checkout` /
`Place Order` / `Pay` / `Confirm`. The script picks the largest such button
by area (RSI's primary CTAs are typically the biggest visible button), clicks
it once, and flashes the click target orange. One keypress = one click.

Typical flow with `N`:

| Page              | Press | Effect                                          |
| ----------------- | ----- | ----------------------------------------------- |
| Cart              | `M`   | Clicks RSI's Max-credit button (already exists) |
| Cart              | `N`   | Clicks Continue / Checkout to leave the cart    |
| Address           | `N`   | Clicks Continue (default address pre-selected)  |
| Payment           | `N`   | Clicks Place Order — your purchase is committed |

Four keypresses for the full cart→done flow. Each `N` is a deliberate
decision; the script does not chain steps automatically. If you stop pressing,
the flow stops. The red "PAYMENT PAGE — slow down" banner still appears on
the final page; consider reading it before pressing the last `N`.

### Latency

Time-critical actions (Max-credit click) run on a **microtask fast path**
triggered by every DOM mutation, so they fire within milliseconds of the
button appearing in the page. The slower panel UI refresh is throttled to
250 ms (down from 500 ms) and the periodic background refresh runs every
1.5 s (down from 3 s). First-paint no longer waits on the latency-probe
HEAD request — it fires-and-forgets and updates the panel when it lands.

### Ship lookup (popup)

The popup includes a search box that queries the live ship-matrix (250+
ships) and lets you jump to any ship's canonical pledge URL in one click.

- Type a name (e.g. `Polaris`, `Idris`, `Galaxy`) — case-insensitive, also
  matches manufacturer name (`Aegis`, `Drake`).
- Each result row shows: ship name, manufacturer, production status
  (yellow pill for `in-concept` / `announced`, green for `flight-ready`).
- `Open` opens the canonical pledge URL in a new tab.
- `☆ / ★` toggles a bookmark — bookmarked ships appear at the top when the
  search box is empty. Bookmarks persist in `chrome.storage.local`.

On first install, bookmarks are seeded with the well-known limited-availability
ships from prior RSI sales: `Idris`, `Javelin`, `Polaris`, `Pioneer`,
`BMM` / `Banu Merchantman`, `Kraken`, `Galaxy`, `Liberator`, `Ironclad`,
`Carrack`, `890 Jump`. You can star/unstar to customise.

ship-matrix data is cached in `chrome.storage.local` for one hour; click
`refresh` to force-pull the latest.

The userscript flavor doesn't have access to `chrome.storage` — userscript
users always get the defaults (everything on). If you need per-feature
toggles, use the extension flavor.

## Install

```bash
cd ~/projects/sc-drop-watcher
npm install
cp .env.example .env
$EDITOR .env  # paste Discord webhook + ntfy topic, set LIVE=1 when ready
```

## Test (dry run)

```bash
npm run dev
```

Output is prefixed `[DRY]` and nothing is sent. Wait one minute to see one
poll cycle of each source; first sync just learns IDs, no alerts.

## Run as a service

```bash
sudo cp systemd/sc-drop-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sc-drop-watcher
journalctl -u sc-drop-watcher -f
```

### After upgrading Node via nvm

The unit's `ExecStart` is pinned to the current nvm-managed node binary
(`/home/ubuntu/.nvm/versions/node/v24.13.1/bin/node`) and invokes `tsx` via
its in-repo entry point (`node_modules/tsx/dist/cli.mjs`). After any
`nvm install` / `nvm use` that changes the active Node version:

1. Update both occurrences of the node path (in `systemd/sc-drop-watcher.service`
   and the example above) to the new version.
2. `sudo cp systemd/sc-drop-watcher.service /etc/systemd/system/`
3. `sudo systemctl daemon-reload && sudo systemctl restart sc-drop-watcher`
4. `journalctl -u sc-drop-watcher -n 30 --no-pager` — confirm `started`,
   not `status=203/EXEC`.

If you forget step 1 and start the service anyway, the `ExecStartPre=` guard
in the unit will log a clear message naming the missing binary, instead of
the generic `status=203/EXEC`.

## Push targets

- **Discord**: rich embed with title, fields, link.
- **ntfy**: high-priority push with click-through to the comm-link / SKU URL.
  Use a private topic name (e.g. `https://ntfy.sh/sc-drop-<random>`); anything
  on `ntfy.sh` is publicly readable if you know the topic.

## State

JSON file at `STATE_FILE` (default `.state.json`). First poll of each source
just learns IDs to avoid spamming you with the entire current catalog. Delete
the file to force a fresh learn.

## Tuning

During an active sale window:

```bash
POLL_PLEDGE_STORE_SEC=15 POLL_COMM_LINK_SEC=20 systemctl restart sc-drop-watcher
```

Don't go below ~10s — RSI's ops will notice and you'll get rate-limited or
blocked. The whole point of this tool is to be a polite, identifying client.
The `User-Agent` is set to identify you with a contact email; keep that
honest.
