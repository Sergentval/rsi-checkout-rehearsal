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
