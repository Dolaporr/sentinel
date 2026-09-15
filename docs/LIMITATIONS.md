# Limitations

Sentinel's spending limits cover less than a reader might assume. This page lists what they don't cover, as of 2026-09-11. It describes the gaps and does not propose fixes. The details and reproductions are in [finding 01](../tests/adversarial/findings/01-revoke-recovery-single-read-trust.md) and [finding 02](../tests/adversarial/findings/02-balance-drain-path-and-breaker-placement.md).

**Background.** Orbio has no spending limit of its own. A gateway key spends the account balance directly, with no cap per key and no cap per period. Revoking a key doesn't protect the balance, because a new key can be created against the same balance. So the only spending limits are the ones Sentinel applies.

## 1. The spending limit resets when the process restarts

Sentinel keeps its running total of spend in memory. When the process stops, that total is lost. The next run starts again at $0 with the full budget, even though the ledger file on disk records what has already been spent. Two copies of Sentinel running at the same time don't see each other's spending either.

In a test with a $1.00 budget, five restarts spent $4.50 in total, and two copies running side by side reserved $1.80 between them ([reproduction](../tests/adversarial/repro/governor_cap_resets_on_restart.ts)).

The "$3.00 live-session ceiling" in `SENTINEL_D2_RUNNER.md` works the same way. It is $3.00 per run, not per session or per day.

## 2. Four scripts read the key directly

The Orbio gateway key is stored in `.env`, and four scripts read it from there. Each script applies its own limit, or none:

| Script | Limit before money is spent |
| --- | --- |
| `scripts/d2-race-live.ts` | Checks the session limit before each request. |
| `scripts/d2-calibrate.ts` | Checks its own limit before each request. |
| `scripts/d1-gateway-inference.ts` | Checks its $1 limit only after the response arrives, when the money is already spent. |
| `scripts/raw-gateway-proof.ts` | None. |

The limit belongs to the script, not to the key. Any code that can read the environment can spend without a Sentinel limit applying. That includes a new script, a library, or a tool an agent calls.

## 3. Creating keys is not controlled

Anyone who can call Orbio's `orbio_create_key` gets a new key that spends the same balance. Nothing in Sentinel controls who can create keys. Nothing stops keys from being created after a limit has been reached, either. Revoking a key stops that key, not spending.

## 4. The Orbio MCP authorization can spend the whole balance

The Orbio MCP authorization is the OAuth grant used to read the balance and manage keys. Whoever holds it can create keys whenever they like and spend the entire balance. Nothing Sentinel runs can prevent that. Only a limit enforced by Orbio could, and Orbio doesn't currently offer one.

## Not measured

- **Telemetry lag.** How far Orbio's balance trails actual spending has never been measured. No live run has read the balance before and after a known spend. The 30-second windows in the mock (`tool_latency_30s`, `spend_telemetry_lag` in `docs/DAY1_FAILURE_MODES.md`) are modelling choices, not measurements.
- **Balance movement.** The live balance has never been seen to go down. Both live balance reads, on 2026-09-07, were taken before any spending. No live spending, including the D2 live run, has been checked against the balance.
- **The 90-second lag in `fixtures/corpus/`.** That figure is part of a synthetic document written as mission input for the agents. It is not a measurement of Orbio.

## Stale tests

Five of the adversarial reproductions in `tests/adversarial/repro/` no longer typecheck against the current `GovernorConfig` (they omit `maxStepBudgetFraction`), so they still run under `tsx` but on an incomplete configuration.
