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

## Companion: checkout rehearsal userscript

`userscript/rsi-checkout-rehearsal.user.js` is a Tampermonkey/Violentmonkey
script for the *human* side. Install in your browser's userscript manager and
visit any RSI page. It will:

- Outline buy/checkout buttons with a pulsing green/orange ring.
- Show a small overlay with: page URL, count of buy buttons, store-credit
  balance (parsed from page text), cart total, latency to RSI in ms.
- Provide hotkeys: **F** focus next buy button, **R** force refresh, **Esc**
  hide the overlay.
- On `/checkout/payment` and similar URLs, paint a red "slow down" banner so
  you don't misclick under pressure.

It does **not** click anything, fill anything, or auto-submit. The whole
point is to make a *human* click as fast and as accurately as possible.

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

The unit's `ExecStart` is pinned to the current nvm-managed node binary
(`/home/ubuntu/.nvm/versions/node/v24.13.1/bin/node`) and invokes `tsx` via
its in-repo entry point (`node_modules/tsx/dist/cli.mjs`). After upgrading
Node via nvm, update the node path in the unit file and
`sudo systemctl daemon-reload && sudo systemctl restart sc-drop-watcher`.

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
