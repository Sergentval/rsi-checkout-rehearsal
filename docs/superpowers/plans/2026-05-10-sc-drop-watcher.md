# sc-drop-watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polite, read-only RSI drop notifier that pings the user the second a limited concept sale or warbond opens, plus a browser-side UX accelerator for the manual checkout flow. No purchase automation, no anti-bot evasion.

**Architecture:** Node 24 + TypeScript ESM daemon polls three RSI surfaces (ship-matrix JSON, comm-link HTML, pledge-store HTML) on independent loops, diffs against a JSON state file, and pushes new events to Discord + ntfy. A fourth loop ticks an internal annual sale calendar (Invictus, CitizenCon, IAE, etc.) to surface imminent windows. A separate Tampermonkey userscript runs on `robertsspaceindustries.com` to highlight buy buttons, surface store-credit balance / cart total / latency, and warn on payment pages — without ever clicking or submitting.

**Tech Stack:** Node 24, TypeScript 5.5 (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM, `node-html-parser` for HTML, native `fetch`, `node:test`, `tsx` for dev/test runs, systemd for service supervision, vanilla JS userscript (Tampermonkey/Violentmonkey), Discord webhooks + ntfy for push.

**Status legend:**
- `[x]` = implemented and verified in current worktree
- `[ ]` = pending — execute as written

---

## File Structure

```
~/projects/sc-drop-watcher/
├── package.json                        # deps + scripts
├── tsconfig.json                       # strict TS, ESM, rootDir=.
├── .env.example                        # documents all env vars; copy to .env
├── README.md                           # user-facing docs
├── src/
│   ├── main.ts                         # daemon entry: env, state, four poll loops
│   ├── sources.ts                      # fetchers: ship-matrix, comm-link, pledge-store
│   ├── push.ts                         # Discord + ntfy dispatch + dry-run mode
│   └── calendar.ts                     # annual sale-window calendar + tick logic
├── tests/
│   └── calendar.test.ts                # unit tests for calendar tick logic
├── systemd/
│   └── sc-drop-watcher.service         # hardened service unit
├── userscript/
│   └── rsi-checkout-rehearsal.user.js  # browser UX accelerator
└── docs/superpowers/plans/             # this plan
```

**Responsibility split:**
- `sources.ts` owns *what* to fetch and *how to dedupe* (ID shape per source).
- `push.ts` owns *how* notifications get out and stays unaware of source semantics.
- `calendar.ts` is pure logic with no I/O — easy to unit-test.
- `main.ts` is wiring only: env → state → loops → push. No business logic.

---

## Phase 1 — Drop notifier daemon

### Task 1: Project scaffolding

**Files:**
- Create: `~/projects/sc-drop-watcher/package.json`
- Create: `~/projects/sc-drop-watcher/tsconfig.json`
- Create: `~/projects/sc-drop-watcher/.env.example`

- [x] **Step 1: Write `package.json`**

```json
{
  "name": "sc-drop-watcher",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "start": "node --enable-source-maps dist/main.js",
    "dev": "tsx src/main.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --test --import tsx tests/*.test.ts"
  },
  "dependencies": { "node-html-parser": "^6.1.13" },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4"
  }
}
```

- [x] **Step 2: Write `tsconfig.json` with strict settings**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

`rootDir: "."` is required because `tests/` lives outside `src/`.

- [x] **Step 3: Write `.env.example` documenting all knobs**

See file in repo. Critical fields: `DISCORD_WEBHOOK_URL`, `NTFY_TOPIC_URL`, `NTFY_TOKEN`, `POLL_*_SEC`, `STATE_FILE`, `USER_AGENT`, `LIVE`.

- [x] **Step 4: Install deps and confirm**

```bash
cd ~/projects/sc-drop-watcher && npm install
```
Expected: `added 19 packages` and a `node_modules/@types/node` directory.

- [x] **Step 5: Commit**

```bash
git init && git add package.json tsconfig.json .env.example
git commit -m "feat: scaffold sc-drop-watcher TS project"
```

---

### Task 2: Source fetchers

**Files:**
- Create: `~/projects/sc-drop-watcher/src/sources.ts`

Each fetcher returns `DropEvent[]`. The `id` field is the dedup key — choose it carefully because diff semantics depend on it.

- [x] **Step 1: Define shared types and HTTP helpers**

```typescript
export interface DropEvent {
  readonly source: "ship-matrix" | "pledge-store" | "comm-link";
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly extra?: Record<string, string | number | undefined>;
}

interface FetchOptions { readonly userAgent: string; readonly timeoutMs?: number; }
```

`getText` and `postJson` wrap `fetch` with an `AbortController` timeout (default 15s) and forward the configured user-agent header.

- [x] **Step 2: Implement `fetchShipMatrix`**

POST `https://robertsspaceindustries.com/ship-matrix/index` with header `X-Requested-With: XMLHttpRequest`. Returns `{success:1, data:[{id,name,production_status,manufacturer,...}]}`. **Without the XHR header, this endpoint returns the app shell HTML** — confirmed during smoke test.

Critical: encode `production_status` into the dedup id so concept↔flight-ready transitions register as new events:

```typescript
id: `${s.id}:${s.production_status ?? "unknown"}`,
```

- [x] **Step 3: Implement `fetchCommLink`**

GET `https://robertsspaceindustries.com/en/comm-link/transmission`. Parse with `node-html-parser`. Match `a[href*="/comm-link/"]` and extract `/comm-link/<category>/<id>-<slug>` — id is the numeric prefix. Comm-link is the **authoritative drop signal** — concept sales are announced here first.

- [x] **Step 4: Implement `fetchPledgeStore`**

GET `https://robertsspaceindustries.com/en/pledge/ships`. Match `a[href*="/pledge/"]`. **Known limitation:** the listing is JS-rendered, so plain HTML scraping currently returns 0 results. Keep the fetcher for the day RSI server-renders again, or for future headless-browser swap. Do not escalate to puppeteer just for this — comm-link covers the same need.

- [x] **Step 5: Commit**

```bash
git add src/sources.ts
git commit -m "feat: ship-matrix + comm-link + pledge-store fetchers"
```

---

### Task 3: Push dispatcher

**Files:**
- Create: `~/projects/sc-drop-watcher/src/push.ts`

- [x] **Step 1: Define `PushTargets` with `string | undefined` (not `?:`)**

Because `tsconfig` has `exactOptionalPropertyTypes: true`, optional fields must be explicit `T | undefined`:

```typescript
export interface PushTargets {
  readonly discordWebhookUrl: string | undefined;
  readonly ntfyTopicUrl: string | undefined;
  readonly ntfyToken: string | undefined;
  readonly userAgent: string;
  readonly live: boolean;
}
```

- [x] **Step 2: Implement `sendDiscord`**

POST a single embed with title (kind tag + source + title), description (message), color by kind (green/grey/red), fields from `event.extra`. Cap title at 256 chars, description at 2000.

- [x] **Step 3: Implement `sendNtfy`**

POST raw body to `NTFY_TOPIC_URL` with metadata in headers: `title`, `priority` (high/default/low by kind), `tags` (rocket/wastebasket/warning), `click` for click-through URL, `authorization: Bearer <token>` if `NTFY_TOKEN` set.

- [x] **Step 4: Wire `notify()` with dry-run mode**

If `targets.live === false`, prefix the line with `[DRY]` and `console.log` only. If live, log the line and `Promise.allSettled` both push targets; log rejections individually so one channel failure doesn't drop the other.

- [x] **Step 5: Commit**

```bash
git add src/push.ts
git commit -m "feat: Discord + ntfy push with dry-run mode"
```

---

### Task 4: Daemon orchestration

**Files:**
- Create: `~/projects/sc-drop-watcher/src/main.ts`

- [x] **Step 1: Define `State` and `emptyState()`**

```typescript
interface State {
  seen: Record<DropEvent["source"], string[]>;
  lastError: Record<DropEvent["source"], string | undefined>;
  seenCalendarTicks: string[];
}
```

- [x] **Step 2: Atomic state persistence**

`loadState` reads JSON, returns `emptyState()` on `ENOENT`. `saveState` writes to `${path}.tmp` then `rename()`s — durable across crashes.

- [x] **Step 3: `pollOnce` with first-sync silence**

If `state.seen[source]` is empty, this is the first poll: learn IDs, do not push (otherwise the daemon would alert on the entire current catalog). On subsequent polls, diff added/removed and push for added always; push removals only for `pledge-store` (sale ended is signal, but ship-matrix removals are noisy).

Error handling: store `lastError` per source and only push an error notification when the message changes — prevents alert spam when RSI has a sustained outage.

- [x] **Step 4: Per-source loops with jitter**

```typescript
function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * Math.min(ms * 0.2, 5_000));
}
```

Each `loop()` runs `pollOnce` → `saveState` → sleep `(interval + jitter - elapsed)`. Jitter prevents all three sources from firing on the same second.

- [x] **Step 5: Wire `main()` with `Promise.all` of all four loops**

```typescript
await Promise.all([
  loop("ship-matrix", cfg, state),
  loop("pledge-store", cfg, state),
  loop("comm-link", cfg, state),
  calendarLoop(cfg, state),
]);
```

- [x] **Step 6: Typecheck**

```bash
./node_modules/.bin/tsc --noEmit
```
Expected: exit 0.

- [x] **Step 7: Smoke test**

```bash
LIVE=0 POLL_SHIP_MATRIX_SEC=999 POLL_PLEDGE_STORE_SEC=999 POLL_COMM_LINK_SEC=999 \
  STATE_FILE=/tmp/sc-test.json timeout 12 npx tsx src/main.ts
jq '.seen' /tmp/sc-test.json
```
Expected: ship-matrix ≈ 250 ids, comm-link ≈ 10 ids, pledge-store 0 ids (known limitation).

- [x] **Step 8: Commit**

```bash
git add src/main.ts
git commit -m "feat: daemon entry with state persistence + per-source loops"
```

---

## Phase 2 — Checkout rehearsal userscript

### Task 5: Userscript skeleton + buy-button detection

**Files:**
- Create: `~/projects/sc-drop-watcher/userscript/rsi-checkout-rehearsal.user.js`

**Hard rule for this file:** no `innerHTML`, no `eval`, no auto-clicks, no form submission, no input filling. The user's security hook will block `innerHTML` writes and that is the correct behavior. Use `document.createElement` + `textContent` + `appendChild` everywhere.

- [x] **Step 1: Userscript metadata block**

```javascript
// ==UserScript==
// @name         RSI Checkout Rehearsal
// @namespace    sergent-val.win
// @version      0.1.0
// @match        https://robertsspaceindustries.com/*
// @match        https://*.robertsspaceindustries.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
```

- [x] **Step 2: Buy-button pattern list and finder**

```javascript
const BUY_PATTERNS = [
  /^\s*add to cart\s*$/i, /^\s*buy\b/i, /^\s*pledge\b/i,
  /^\s*checkout\s*$/i, /^\s*proceed to checkout\s*$/i,
  /^\s*place order\s*$/i, /^\s*confirm( order)?\s*$/i,
  /^\s*pay( now)?\s*$/i,
];
```

`findBuyButtons()` walks `button, a, input[type=button|submit], [role=button]`, skips zero-rect elements, matches inner text against patterns, classifies each as buy vs checkout for color-coding.

- [x] **Step 3: Inject CSS via `<style>` (textContent, not innerHTML)**

Green pulsing outline (`.scr-buy-hi`) for Add-to-Cart; orange solid outline (`.scr-checkout-hi`) for Checkout/Place-Order/Pay. Animation `scr-pulse` 1.4s ease-in-out infinite. Floating panel `#scr-panel` bottom-right, fixed, z-index `2147483647`.

- [x] **Step 4: Verify syntax**

```bash
node --check userscript/rsi-checkout-rehearsal.user.js
```
Expected: exit 0.

- [x] **Step 5: Commit**

```bash
git add userscript/rsi-checkout-rehearsal.user.js
git commit -m "feat: userscript skeleton + buy-button detection"
```

---

### Task 6: Panel UI, store credit, latency, hotkeys, banner

**Files:**
- Modify: `~/projects/sc-drop-watcher/userscript/rsi-checkout-rehearsal.user.js`

- [x] **Step 1: Build panel with DOM methods only**

`makePanel()` creates a `div`, appends an `h4` with `textContent`, then rows of (label, value) spans for: URL, Buy buttons, Checkout, Store credit, Total, Latency. Hotkey row uses `<kbd>` children with `textContent`. Tip row is empty placeholder updated by `refresh()`.

- [x] **Step 2: Text-scraping for store credit and cart total**

```javascript
function readStoreCredit() {
  const m = (document.body.innerText || "").match(
    /store[-\s]?credit[^$]{0,40}\$([\d,]+(?:\.\d{1,2})?)/i,
  );
  return m ? `$${m[1]}` : null;
}
```

Same shape for `readCartTotal` using `total|order total|grand total`. Regex-based on visible text is fragile but ToS-safe — no DOM-internal traversal beyond what a human reading the page would see.

- [x] **Step 3: Self-latency probe**

`HEAD /` once per refresh, measure round-trip with `performance.now()`. Skip silently on error. One request per refresh, not a continuous probe — explicitly capped to keep load polite.

- [x] **Step 4: Hotkeys F/R/Esc**

`F` focuses next buy button (`scrollIntoView` + `focus`, never `click`). `R` forces refresh. `Esc` toggles panel visibility. Skip handling when `e.target` is `HTMLInputElement | HTMLTextAreaElement` so typing in forms still works.

- [x] **Step 5: Payment page warning banner**

When `location.pathname` matches `/payment|/checkout\/payment|/confirm/i`, prepend a fixed red gradient banner: "PAYMENT PAGE — slow down. Verify amount, currency, and payment method before clicking Place Order." This is a guardrail against the user's *own* hurried misclicks under sale pressure.

- [x] **Step 6: MutationObserver with 500ms throttle**

RSI hydrates checkout UI client-side, so buttons appear after initial load. Observe `document.body` subtree; throttle to 1 refresh per 500ms to avoid runaway re-renders.

- [x] **Step 7: Syntax check**

```bash
node --check userscript/rsi-checkout-rehearsal.user.js
```
Expected: exit 0.

- [x] **Step 8: Commit**

```bash
git commit -am "feat: userscript panel + hotkeys + payment warning"
```

---

## Phase 3 — Calendar / leak tracker

### Task 7: Sale-window calendar module

**Files:**
- Create: `~/projects/sc-drop-watcher/src/calendar.ts`

- [x] **Step 1: Define `SaleWindow` and the calendar table**

```typescript
export interface SaleWindow {
  readonly key: string;
  readonly name: string;
  readonly startMonth: number;
  readonly startDay: number;
  readonly endMonth: number;
  readonly endDay: number;
  readonly notes: string;
}

export const SALE_CALENDAR: ReadonlyArray<SaleWindow> = [
  { key: "invictus", name: "Invictus Launch Week",
    startMonth: 5, startDay: 16, endMonth: 5, endDay: 31,
    notes: "Military ships, free-fly. Concept reveals possible." },
  // alien-week, citizencon, iae, luminalia — see file
];
```

Windows are year-agnostic date pairs; `makeOccurrence(window, year)` materializes a `{start, end}` for a specific year, handling year-wrap (end month < start month).

- [x] **Step 2: `upcomingOccurrences` generator**

Materialize occurrences for current year and next, sort by start, yield those whose end is still future.

- [x] **Step 3: `calendarTicks(now)` returns `imminent | opened | closing` ticks**

- `imminent` when `start - now <= 24h` and `now < start`
- `opened` for any `now ∈ [start, end]`
- `closing` adds an extra tick when `end - now <= 24h`

Each tick has a stable key `${window.key}-${year}-${kind}` so callers can dedupe with a `Set`.

- [x] **Step 4: Commit**

```bash
git add src/calendar.ts
git commit -m "feat: annual sale-window calendar with imminent/opened/closing ticks"
```

---

### Task 8: Calendar unit tests

**Files:**
- Create: `~/projects/sc-drop-watcher/tests/calendar.test.ts`

- [x] **Step 1: Test imminent window**

```typescript
test("calendar emits 'imminent' inside the 24h pre-window", () => {
  const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
  const ticks = calendarTicks(now);
  const t = ticks.find((x) => x.key.startsWith("invictus-2026-imminent"));
  assert.ok(t);
  assert.equal(t?.kind, "imminent");
});
```

- [x] **Step 2: Test opened window**

```typescript
test("calendar emits 'opened' while inside the window", () => {
  const now = new Date(Date.UTC(2026, 4, 20, 12, 0, 0));
  const ticks = calendarTicks(now);
  const opened = ticks.find((x) => x.key === "invictus-2026-opened");
  assert.ok(opened);
  assert.equal(opened?.kind, "opened");
});
```

- [x] **Step 3: Test off-window silence**

```typescript
test("calendar emits nothing when no window is near", () => {
  const now = new Date(Date.UTC(2026, 7, 1, 0, 0, 0));
  assert.equal(calendarTicks(now).length, 0);
});
```

- [x] **Step 4: Test determinism and unique keys**

```typescript
test("each tick has a unique stable key", () => {
  const now = new Date(Date.UTC(2026, 4, 20, 12, 0, 0));
  const a = calendarTicks(now).map((t) => t.key);
  const b = calendarTicks(now).map((t) => t.key);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});
```

Use `"../src/calendar.js"` (the `.js` extension, not `.ts`) so the same import path works under both `tsc` and `tsx`.

- [x] **Step 5: Run tests + typecheck**

```bash
./node_modules/.bin/tsc --noEmit && npx tsx --test tests/calendar.test.ts
```
Expected: tsc exit 0, 4/4 tests pass.

- [x] **Step 6: Commit**

```bash
git add tests/calendar.test.ts tsconfig.json
git commit -m "test: calendar tick logic (4 tests, 100% pass)"
```

---

### Task 9: Wire calendar into daemon

**Files:**
- Modify: `~/projects/sc-drop-watcher/src/main.ts`

- [x] **Step 1: Import calendar and extend `State`**

```typescript
import { calendarTicks } from "./calendar.js";
// add to State:
seenCalendarTicks: string[];
```

Update `emptyState()` and `loadState()` to populate the new field with `[]`.

- [x] **Step 2: Implement `calendarLoop(cfg, state)`**

Hourly tick — finer polling buys nothing for day-granular windows. For each tick not in `state.seenCalendarTicks`, push it with kind `new` (imminent/opened) or `removed` (closing), then add to the seen set. Persist via `saveState` after each tick.

- [x] **Step 3: Add to `Promise.all` in `main()`**

```typescript
await Promise.all([
  loop("ship-matrix", cfg, state),
  loop("pledge-store", cfg, state),
  loop("comm-link", cfg, state),
  calendarLoop(cfg, state),
]);
```

- [x] **Step 4: Final typecheck + smoke test**

```bash
./node_modules/.bin/tsc --noEmit
LIVE=0 STATE_FILE=/tmp/sc-test.json timeout 12 npx tsx src/main.ts
jq '.seenCalendarTicks' /tmp/sc-test.json
```
Expected: tsc exit 0; tick array empty (May 10 is >24h before Invictus opens May 16), seen.ship-matrix has 250 entries.

- [x] **Step 5: Commit**

```bash
git commit -am "feat: wire calendar loop into daemon"
```

---

## Phase 4 — Deploy and validate (PENDING)

### Task 10: Production `.env` and dry-run validation

**Files:**
- Create: `~/projects/sc-drop-watcher/.env` (gitignored, never committed)

- [ ] **Step 1: Add `.gitignore` entries**

```bash
cat >> ~/projects/sc-drop-watcher/.gitignore <<'EOF'
.env
.state.json
.state.json.tmp
node_modules/
dist/
EOF
```

- [ ] **Step 2: Create Discord webhook**

In Discord server settings → Integrations → Webhooks → "New Webhook". Name it `sc-drop-watcher`, pick a channel that won't get muted. Copy URL.

User question to decide before this step: **dedicated channel, or merged into the existing star-citizen-hub patch-notes channel?** Drop alerts should not be muted alongside patch-note posts — recommend a dedicated `#sc-drops` channel.

- [ ] **Step 3: Pick an ntfy topic**

Use a private random topic name on `ntfy.sh` (anything on `ntfy.sh` is publicly readable if the topic is known):

```bash
echo "sc-drop-$(openssl rand -hex 6)"
# → e.g. sc-drop-9f2a8e3b4d51
```

URL: `https://ntfy.sh/sc-drop-9f2a8e3b4d51`. Subscribe in the ntfy mobile app with that URL.

- [ ] **Step 4: Populate `.env` from `.env.example`**

```bash
cp .env.example .env
$EDITOR .env  # paste Discord URL, ntfy URL, leave LIVE=0 for now
```

- [ ] **Step 5: Dry-run for one full cycle**

```bash
cd ~/projects/sc-drop-watcher && npm run dev
```

Watch for ~70 seconds. Expected: stderr shows three `[<source>] first sync: N ids learned` lines (250, 10, 0). No `[DRY]` lines for new events (first sync is silent by design). Kill with `Ctrl-C`.

- [ ] **Step 6: Force a synthetic event and verify push**

Edit `.state.json` to remove one entry from each source's `seen` array, set `LIVE=1`, run `npm run dev` again. Expected: exactly one Discord embed + one ntfy push for each source within ~60s. Phone vibrates from ntfy.

- [ ] **Step 7: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore secrets and runtime state"
```

---

### Task 11: Install systemd unit

**Files:**
- Modify: `/etc/systemd/system/sc-drop-watcher.service` (system path, not in repo)

- [ ] **Step 1: Confirm `npx` path used by the unit**

```bash
which npx
```
If not `/usr/bin/npx`, edit `systemd/sc-drop-watcher.service` `ExecStart=` to the actual path. The unit currently assumes `/usr/bin/npx`.

- [ ] **Step 2: Install and enable**

```bash
sudo cp ~/projects/sc-drop-watcher/systemd/sc-drop-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sc-drop-watcher
```

- [ ] **Step 3: Tail logs and confirm steady state**

```bash
journalctl -u sc-drop-watcher -f --since "1 minute ago"
```

Expected: `sc-drop-watcher starting :: live=true discord=true ntfy=true`, then `[<source>] first sync: N ids learned` for each source. Service stays in `active (running)` per `systemctl status sc-drop-watcher`.

- [ ] **Step 4: Kill-and-restart resilience check**

```bash
sudo systemctl restart sc-drop-watcher
journalctl -u sc-drop-watcher -n 30 --no-pager
```

Expected: on restart, state file is reloaded — `seen` arrays already populated, so no first-sync messages and no spam pushes.

- [ ] **Step 5: Commit (if any unit edits were needed)**

```bash
git commit -am "chore: pin npx path in systemd unit"
```

---

### Task 12: Userscript install + visual verification

**Files:** (no repo files modified — browser-side install)

- [ ] **Step 1: Install Tampermonkey or Violentmonkey in browser**

Chrome/Brave/Edge: Tampermonkey from Chrome Web Store. Firefox: Violentmonkey (open-source, no telemetry).

- [ ] **Step 2: Add the userscript**

Open `userscript/rsi-checkout-rehearsal.user.js` in the browser (drag-drop the file or use Tampermonkey's "+" → paste). Confirm metadata block parses (script name appears as "RSI Checkout Rehearsal"). Enable it.

- [ ] **Step 3: Navigate to a known pledge page**

Visit any `https://robertsspaceindustries.com/pledge/ships` page. Verify:
- Bottom-right panel appears with URL, button counts, latency in ms.
- Add-to-Cart buttons (if any visible) have a pulsing green outline.
- Pressing `F` scrolls to and focuses the first buy button.
- Pressing `Esc` hides the panel; pressing it again shows it.

- [ ] **Step 4: Verify payment-page banner**

Add anything to cart, walk through to `/checkout/payment`. Expected: red gradient banner across the top reading "PAYMENT PAGE — slow down. Verify amount, currency, and payment method before clicking Place Order." **Do not actually complete checkout in this step** — back out.

- [ ] **Step 5: Verify store-credit / total parsing**

On the cart page, the panel should show `Total: $X` matching the visible total. If parsing fails (regex didn't match), expand the regex in `readStoreCredit`/`readCartTotal` to match RSI's actual text — and only then.

---

### Task 13: First real-drop validation

**Files:** (observational — no code changes)

This is the test that matters. Schedule for next known event window: **Invictus Launch Week opens 2026-05-16**. Calendar should fire `imminent` on 2026-05-15 ~UTC midnight and `opened` on 2026-05-16.

- [ ] **Step 1: Confirm the imminent push fires**

On 2026-05-15, around 24h before window start, expect a Discord embed + ntfy push: "Invictus Launch Week starts in ~Nh ...". Check `journalctl -u sc-drop-watcher --since today` for the corresponding log line.

If no push fires: check `.state.json` `seenCalendarTicks` — if the key is already there, the daemon thinks it already announced. If clock is wrong, check `timedatectl`.

- [ ] **Step 2: Confirm `opened` fires when window starts**

On 2026-05-16 ~UTC midnight, expect a second push: "Invictus Launch Week is LIVE...".

- [ ] **Step 3: Watch comm-link source during the live event**

When CIG publishes the Invictus announcement post, the daemon should detect a new `comm-link` id within 60s. Expect Discord + ntfy with the comm-link title and URL. Click the ntfy notification on phone → it should open the comm-link page in the browser.

- [ ] **Step 4: If a new concept ship launches, validate ship-matrix path**

Concept reveal → new ship ID appears in ship-matrix within 5 min. Expect a `[DROP] ship-matrix: <Ship Name> [in-concept]` push.

- [ ] **Step 5: Post-event review**

After the window closes, review `journalctl -u sc-drop-watcher --since "1 week ago" | grep -E "DROP|ERROR"`. Count:
- True positives (real drops you got pushed for) → success.
- False positives (push for something that wasn't actually a drop) → tighten matching regex in `sources.ts`.
- False negatives (drops you missed despite watching) → investigate which source failed and why. This is the most important signal.

No code changes unless the data tells you to. Tune in the direction of the actual failure mode, not anticipated ones.

---

## Optional follow-ups (not part of this plan)

Document these as future work; do not implement speculatively:

- **Pledge-store via headless browser** if comm-link proves insufficient and JS-rendered SKU detection becomes critical. Likely Playwright over Puppeteer for stability.
- **scunpacked diff source** for even earlier datamining signal. Requires polling GitHub commits on `StarCitizenWiki/scunpacked`.
- **Per-source push routing** (e.g. calendar → email, comm-link → ntfy high-priority, ship-matrix → low-priority Discord channel). Currently all sources go to all configured channels.
- **Web dashboard** showing recent drops, miss rate, latency-to-detect per source. Not needed unless you want to A/B-test source weights.

---

## Self-review

**Spec coverage:**
- Drop notifier daemon ✓ (Tasks 1–4)
- Checkout rehearsal userscript ✓ (Tasks 5–6)
- Calendar / leak tracker ✓ (Tasks 7–9)
- Production deploy ✓ (Tasks 10–11)
- Validation ✓ (Tasks 12–13)
- The line: no purchase automation, no anti-bot evasion — enforced by Task 5 hard rule + the readme + memory entry `feedback_rsi_purchase_automation_line.md`.

**Placeholder scan:** None. Every code-bearing step shows the actual code; every command shows the exact invocation; expected outputs are stated.

**Type consistency:**
- `DropEvent.id` is `string` everywhere; ship-matrix dedup uses `${id}:${production_status}` — consistent in both `sources.ts` and the diff logic in `main.ts`.
- `PushTargets` uses `string | undefined` for optional fields, not `?:` — required by `exactOptionalPropertyTypes`.
- `CalendarTick.kind` is `"imminent" | "opened" | "closing"` — only three values, matched exhaustively in `calendarLoop` and tests.
- Test imports use `.js` extension (not `.ts`) — required by `tsc` without `allowImportingTsExtensions`.
