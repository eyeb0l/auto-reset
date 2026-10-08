# Auto Reset

A small local utility that watches the banked usage resets on your current Codex CLI account and applies expiring resets automatically, with an optional trigger for low weekly usage. Includes a web dashboard for usage limits, expiry dates, automation settings, manual application, and activity.

Uses `codex app-server --stdio`. Codex manages the existing ChatGPT login and token refresh. No API key or separate web login is needed, and polling does not run model turns.

## Run

Requires Node.js 22+ and a current Codex CLI with banked reset support. Tested against Codex CLI **0.160.1**. Its account APIs are experimental; older releases may need updating.

```sh
codex login status
npm install
npm run build
npm start
```

Open **http://127.0.0.1:4780**. Automatic application is enabled by default: check every **60 seconds**, apply a reset when it has **30 minutes or less** left. The optional **Low weekly usage trigger** is disabled by default, with a **1%** weekly remaining threshold. Enable it in the dashboard to apply the oldest supported available banked reset when weekly remaining usage reaches or falls below the threshold. The **minimum between automatic redemptions** defaults to **60 minutes**, independently of the polling interval. Change or pause these settings in the dashboard and click **Save settings**. Existing saved polling and expiry settings are preserved.

To serve HTTPS on your tailnet, keep the app listening on `127.0.0.1:4780` and add a persistent Tailscale Serve proxy:

```sh
tailscale serve --bg --https=4780 http://127.0.0.1:4780
tailscale serve status
```

Open the HTTPS URL printed by Tailscale, such as `https://squiggle.spaniel-delta.ts.net:4780`. Both the HTTPS listener and the local backend use port **4780**. The app has no authentication layer, as requested; access is controlled by your tailnet. Leave the app running for automatic application; the browser can be closed. This command adds the port’s mapping without replacing other Serve mappings.

For development, run `npm start` and `npm run dev` in separate terminals. Vite proxies `/api` to port 4780.

## CLI

```sh
npm run status                       # Usage and detailed resets, read only
npm run check:dry                    # Preview which credits are expiring; never consumes
npm run check                        # Check once; honor saved automatic settings
node src/cli.mjs apply                # Apply the oldest available supported reset now
node src/cli.mjs apply <credit-id>    # Apply one specific reset now
node src/cli.mjs --help
```

Only one monitoring or mutation process may use a state directory at a time. Use the running dashboard for changes while the service is active. `status` can run alongside it. `check --dry-run --state-dir /tmp/auto-reset-preview` can preview independently without spending resets.

Options: `--host`, `--port`, `--state-dir`, and `--dry-run` for `check`. Environment variables: `AUTO_RESET_HOST`, `PORT`, `AUTO_RESET_STATE_DIR`, `CODEX_BIN`, and Codex's existing `CODEX_HOME`. The default state directory is `.auto-reset/` beside this README; it is excluded from Git.

## What the monitor does

- Opens a fresh local Codex app-server session per operation, so a subsequent check picks up a changed CLI login.
- Reads `account/read` and `account/rateLimits/read` with reset credit details explicitly enabled. Displays the actual usage windows the account reports.
- The expiry trigger selects the earliest expiring supported credit within the configured window. The optional low-usage trigger selects the oldest grant when a reported weekly window (10,080 minutes) is at or below the configured remaining percentage. Low usage can use a supported credit with no expiry; expiry automation cannot. Unknown types, expired credits, missing account identities and missing credit details are never eligible. If both triggers fire, expiry takes priority and only one reset is selected.
- Calls `account/rateLimitResetCredit/consume` with an explicit credit ID and a UUID idempotency key. The account identity must be available and must match Codex's account routing.
- Saves the attempt to disk **before** calling consume. Timeouts and uncertain results reuse the same key, including after a restart. Attempts are scoped to the account; switching accounts cannot reuse another account's key.
- Accepts the backend's decision. `nothingToReset` backs off; another attempt requires fresh confirmation and the automatic cooldown. `noCredit` and `alreadyRedeemed` stop retries for that credit. An explicit refusal completes that attempt, so a later eligible attempt gets a new key.
- Keeps checking after network/login errors. The dashboard marks its previous successful snapshot as stale and disables application until it can make a fresh read. Pausing automation also pauses uncertain automatic retries; manually retrying remains possible.
- Serializes all operations. A saved pending operation is resolved or retried with its original key before another credit can be considered. A credit reported as `redeeming` also blocks new requests. Lost responses back off until another successful account read; successful RPC results are journaled even if the post-request usage read fails.
- Requires fresh account data to verify an outcome before starting a different reset. A successful reset must also show an allowance increase and explicit backend permission for ordinary usage before another automatic redemption. If weekly usage was low, it must increase above the threshold saved with the attempt (or reach 100%); tiny fluctuations below that threshold do not rearm automation. A missing credit in a possibly partial list is not sufficient proof of success. Unverifiable outcomes remain held across restarts.
- Shares the configurable automatic cooldown between both triggers. It is measured from the latest automatic request or completion, whichever is later, and persists through the attempt journal. Retries of the same uncertain key do not represent a second redemption. Explicit manual application bypasses the automatic cooldown, but cannot bypass an unresolved outcome or an in-progress reset.
- Makes trigger decisions from a successful account read, never from the cached dashboard snapshot after an API error. Local snapshots older than 30 seconds, invalid usage percentages, and weekly windows with missing or elapsed reset times do not trigger low-usage redemption. The API does not provide a usage revision; allowance verification therefore uses an observed increase from the saved pre-request usage. The dashboard shows why an operation is held for verification or cooldown.
- Shows the last successful check and next scheduled check separately from Activity, even when the usage values have not changed. Successful checks do not add log entries; Activity records settings changes, reset actions, and errors.

Activity initially displays the newest **12 entries**. **Show more** reveals another 12; **Show less** collapses the list. History is capped at **1,000 entries**, with entries older than **7 days** removed at startup and during an hourly cleanup on subsequent state saves. Existing routine check rows are removed on startup. Reset attempt records and their idempotency keys are retained independently of activity cleanup.

The monitor cannot override Codex eligibility rules or redeem an already expired credit. It needs to be running and able to reach Codex before expiry. Resets are applied only through Codex's own API; this utility never buys credits or changes payment settings. Keep `.auto-reset/state.json` when restarting so pending attempts retain their idempotency keys.

## Keep it running on Linux

An example user service is in [docs/auto-reset.service](docs/auto-reset.service). Edit its paths and Node executable for your installation; keep the default loopback bind for Tailscale Serve, then install it as `~/.config/systemd/user/auto-reset.service`:

```sh
systemctl --user daemon-reload
systemctl --user enable --now auto-reset
journalctl --user -u auto-reset -f
```

Stop a manually running instance before starting the service. Enable user lingering if you want a user service to run after logout (`loginctl enable-linger "$USER"`).

## Verification

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Start the app before browser tests (or set `AUTO_RESET_TEST_URL`). Browser tests intercept all API calls with simulated data, so they never consume real credits. Service tests cover both triggers and their interaction, threshold boundaries, stale or missing usage, cooldown persistence, outcome and allowance verification, account switching, concurrency, lost responses, durable retries, paused/dry-run behavior, the stdio protocol, and HTTP requests.

The dashboard design reference and fidelity notes are in [docs/dashboard-concept.png](docs/dashboard-concept.png) and [docs/design.md](docs/design.md).
