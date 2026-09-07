# Day 1 gateway mock failure modes

The current Orbio gateway spends the account balance directly. There is no funded-key balance to return, so the former late-return mode and unused-versus-returned reconciliation have been removed.

Set one value in `MOCK_FAILURE_MODE` before `npm run d1`.

| Mode | Expected outcome | Sentinel finding |
| --- | --- | --- |
| `stale_balance` | Fails after the bounded inference: the post-spend balance is unchanged. | A stale balance cannot prove a spend; the run fails closed. |
| `tool_latency_30s` | Each mock operation waits 30 seconds. | No timing assumption is made; production should impose a per-tool deadline. |
| `revoke_midway_fail` | The mock disables the key then throws. | `RECOVERING` re-reads key state and balance; it accepts only `has_key=false` and an unchanged post-spend balance. |
| `spend_telemetry_lag` | The key-status raw telemetry temporarily reports zero spend. | The balance delta remains the D1 source of truth; the lag is preserved in `raw.telemetry_lagging`. |

Every successful response retains its mock mode in raw evidence. A failed or irreconcilable revoke emits `RECONCILIATION_FAILED`; evidence is append-only.
