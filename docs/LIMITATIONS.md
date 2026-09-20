# Limitations

Sentinel's spending limits cover less than a reader might assume. This page lists what they don't cover, as of 2026-09-20. It describes the gaps and does not propose fixes. The details and reproductions are in [finding 01](../tests/adversarial/findings/01-revoke-recovery-single-read-trust.md) and [finding 02](../tests/adversarial/findings/02-balance-drain-path-and-breaker-placement.md).

**Scope note, 2026-09-20.** The local proxy ([docs/PROXY.md](PROXY.md)) closes parts of 1 and 2 **for traffic that goes through it**. Nothing here is closed for traffic that does not. Each section below says which.

**Background.** Orbio has no spending limit of its own. A gateway key spends the account balance directly, with no cap per key and no cap per period. Revoking a key doesn't protect the balance, because a new key can be created against the same balance. So the only spending limits are the ones Sentinel applies.

## 1. The spending limit resets when the process restarts

Sentinel keeps its running total of spend in memory. When the process stops, that total is lost. The next run starts again at $0 with the full budget, even though the ledger file on disk records what has already been spent. Two copies of Sentinel running at the same time don't see each other's spending either.

In a test with a $1.00 budget, five restarts spent $4.50 in total, and two copies running side by side reserved $1.80 between them ([reproduction](../tests/adversarial/repro/governor_cap_resets_on_restart.ts)).

The "$3.00 live-session ceiling" in `SENTINEL_D2_RUNNER.md` works the same way. It is $3.00 per run, not per session or per day.

**Closed for proxy traffic.** The proxy writes its running total to `.cache/spend.json` after every commit and seeds the governor with `cap - spent_today` at startup, so a restart cannot hand back a fresh budget. Verified live: a restart with today's total already over the cap starts in a refusing state and answers `sentinel_daily_cap_reached`.

**Still open.** The file is local, so the cap is per-machine, not per-account: two proxies on two machines sharing one key each get their own full daily cap, and the gateway console or any other client is invisible to both. The window is evaluated at startup, so a proxy left running across midnight keeps the budget it was given until it restarts. And anything that does not go through the proxy — including the four scripts in 2 below — is unaffected.

## 2. Four scripts read the key directly

The Orbio gateway key is stored in `.env`, and four scripts read it from there. Each script applies its own limit, or none:

| Script | Limit before money is spent |
| --- | --- |
| `scripts/d2-race-live.ts` | Checks the session limit before each request. |
| `scripts/d2-calibrate.ts` | Checks its own limit before each request. |
| `scripts/d1-gateway-inference.ts` | Checks its $1 limit only after the response arrives, when the money is already spent. |
| `scripts/raw-gateway-proof.ts` | None. |

The limit belongs to the script, not to the key. Any code that can read the environment can spend without a Sentinel limit applying. That includes a new script, a library, or a tool an agent calls.

**Closed for proxy traffic.** A tool pointed at the proxy never holds the key. The proxy reads `ORBIO_API_KEY` itself, binds loopback only, and discards whatever bearer the client sends; the key is never forwarded to a client, never logged, and redacted out of upstream error bodies. A leaked editor config, a synced settings file or a screen share exposes nothing that can spend.

**Still open.** The four scripts above are unchanged — they still read `.env` directly and still apply their own limit or none. The proxy adds a governed path; it does not remove the ungoverned ones. Its loopback binding is trust, not authentication: any process or user on that machine can spend against its budget.

## 3. Creating keys is not controlled

Anyone who can call Orbio's `orbio_create_key` gets a new key that spends the same balance. Nothing in Sentinel controls who can create keys. Nothing stops keys from being created after a limit has been reached, either. Revoking a key stops that key, not spending.

## 4. The Orbio MCP authorization can spend the whole balance

The Orbio MCP authorization is the OAuth grant used to read the balance and manage keys. Whoever holds it can create keys whenever they like and spend the entire balance. Nothing Sentinel runs can prevent that. Only a limit enforced by Orbio could, and Orbio doesn't currently offer one.

## 5. A streamed response does not say whether its cost was exact or estimated

The proxy sets `x-sentinel-cost-source` on non-streaming responses, so a caller can tell a reconciled cost from an estimated one. On a streamed response the header is absent: HTTP headers flush before the stream begins, and the cost is not known until the terminating chunk arrives.

A client streaming through the proxy therefore cannot tell from the response whether that call committed as exact or fell back to an estimate. The distinction is real — a cut stream or a missing `usage` commits an estimate — and it is only visible server-side, in `committed_exact` versus `committed_estimated` on `/healthz`.

Measured on 2026-09-20: the gateway does honour `stream_options: {include_usage: true}`, so streamed calls currently commit as exact ([docs/PROXY_VERIFICATION.md](PROXY_VERIFICATION.md)). That makes this a reporting gap rather than an accounting one today, but it is the reporting a caller would need on the day a stream is cut.

## Not measured

- **Telemetry lag.** How far Orbio's balance trails actual spending has never been measured. No live run has read the balance before and after a known spend. The 30-second windows in the mock (`tool_latency_30s`, `spend_telemetry_lag` in `docs/DAY1_FAILURE_MODES.md`) are modelling choices, not measurements.
- **Balance movement.** The live balance has never been seen to go down. Both live balance reads, on 2026-09-07, were taken before any spending. No live spending, including the D2 live run, has been checked against the balance.
- **The 90-second lag in `fixtures/corpus/`.** That figure is part of a synthetic document written as mission input for the agents. It is not a measurement of Orbio.
- **Input-token estimation beyond a single request.** The proxy corrects its estimate for chat-template overhead using constants calibrated against exactly one live response (`prompt_tokens: 23` against an estimate of 18). The correction is biased high and scales per message, but it has never been checked against a multi-message or tool-carrying request.

## Stale tests

Five of the adversarial reproductions in `tests/adversarial/repro/` no longer typecheck against the current `GovernorConfig` (they omit `maxStepBudgetFraction`), so they still run under `tsx` but on an incomplete configuration.
