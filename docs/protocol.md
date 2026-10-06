# Codex account protocol

Verified against the locally installed `codex-cli 0.160.1`, using its generated experimental TypeScript bindings and a live read-only account probe. No browser cookies or credential file parsing is used.

Generate the local CLI's protocol types for inspection:

```sh
codex app-server generate-ts --experimental --out /tmp/codex-protocol
```

The client uses newline-delimited JSON-RPC over `codex app-server --stdio`. It calls `initialize` with the `experimentalApi` capability, then sends the `initialized` notification.

| Method | Parameters | Relevant response |
| --- | --- | --- |
| `account/read` | `{refreshToken: false}` | ChatGPT account and optional workspace account routing |
| `account/rateLimits/read` | `{excludeResetCreditDetails: false}` | `rateLimits`, `rateLimitsByLimitId`, `rateLimitResetCredits`, `accountId` |
| `account/rateLimitResetCredit/consume` | `{creditId, idempotencyKey}` | `outcome`: `reset`, `nothingToReset`, `noCredit`, or `alreadyRedeemed` |

`rateLimitResetCredits.availableCount` is independent of the length of `credits`. `credits: null` means only the count is known; an empty list means details were fetched but no credits were returned. The backend can cap the detail list. The monitor does not treat missing entries as expired or redeemed.

Each credit supplies its opaque `id`, `resetType`, `status`, `grantedAt`, `expiresAt`, optional `title`, and optional `description`. Only `codexRateLimits` with `available` status is eligible for a new request. Timestamps are Unix seconds; `expiresAt: null` means no expiry and therefore no automatic application. All displayed and stored snapshot timestamps are converted to milliseconds.

These APIs are experimental. An unavailable method produces an actionable update message in the CLI/dashboard. The local stdio fixture validates the exact handshake, detail-read parameter, explicit credit ID, and stable attempt key without contacting Codex.
