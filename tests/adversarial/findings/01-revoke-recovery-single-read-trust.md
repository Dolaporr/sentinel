# Finding: revoke recovery trusts a single, unretried, unbounded read

**Target:** [`src/orbio/client.ts`](../../../src/orbio/client.ts), recovery path in [`scripts/d1-lifecycle.ts:36-47`](../../../scripts/d1-lifecycle.ts#L36-L47)
**Severity:** High — this is the exact path responsible for proving "balance intact after revoke," and it can both under-report and silently swallow evidence.

## Summary

When `revokeKey()` throws, `d1-lifecycle.ts` enters a `RECOVERING` branch that does **one** re-read of `getKeyStatus()` and `getBalance()`, taken immediately, with no delay, no retry, and no timeout. It then trusts that single read as ground truth for whether the key is actually dead and the balance is actually intact. Three independent problems follow from this design, all triggerable by conditions the codebase already documents as real (`MOCK_FAILURE_MODES`, `docs/MCP_SURFACE.md`'s note that live spend proof "remains unproven," and the live bridge timing out in `docs/DAY1_RESULT.md`).

## 1. The recovery reads are not fault-tolerant, so recovery failures vanish from the ledger

`scripts/d1-lifecycle.ts:36-47`:

```ts
try {
  await client.revokeKey();
} catch (error) {
  print("5 RECOVERING", "re-reading gateway status and balance; revoke outcome is not assumed.");
  const status = await client.getKeyStatus();          // not wrapped
  const recoveredBalance = await client.getBalance();   // not wrapped
  record({ event: "KEY_STATUS_READ", ... });
  if (status.hasKey || !equalMoney(...)) {
    record({ event: "RECONCILIATION_FAILED", ... });
    throw error;
  }
}
```

If `getKeyStatus()` or `getBalance()` themselves throw during recovery — the same kind of transport fault that just caused `revokeKey()` to throw is not a one-shot event; a flaky bridge stays flaky — the exception propagates straight out of `main()` uncaught. **No `RECONCILIATION_FAILED` record, no `KEY_STATUS_READ` record, nothing is appended for this fault.** `docs/DAY1_FAILURE_MODES.md` states "A failed or irreconcilable revoke emits `RECONCILIATION_FAILED`; evidence is append-only" — that promise is false for exactly the double-fault case, which is also the highest-stakes case (revoke already failed once; the system is actively unsure whether a live key is still spending).

### Reproduction

[`tests/adversarial/repro/revoke_recovery_double_fault.ts`](../repro/revoke_recovery_double_fault.ts) mirrors the recovery block's control flow verbatim against a client whose `revokeKey()` and `getKeyStatus()` both throw:

```bash
npx tsx tests/adversarial/repro/revoke_recovery_double_fault.ts
```

Observed output:

```
Ledger entries before recovery attempt: 0
5 RECOVERING: re-reading gateway status and balance; revoke outcome is not assumed.
REPRO RESULT: uncaught exception escaped the recovery block, exactly as scripts/d1-lifecycle.ts's would:
  adversarial: key-status endpoint reset mid-recovery
Ledger entries after crash: 0 (no RECONCILIATION_FAILED was written for this fault)
```

The `BALANCE_READ` and `KEY_CREATED` events that preceded the fault are on disk; the fault itself is not. An auditor reading the evidence file after this crash sees a lifecycle that simply stops, with no record of why or of a possibly-still-live key.

## 2. Key-status staleness is an unmodeled and unhandled failure surface

`MOCK_FAILURE_MODES` covers `stale_balance` (balance read doesn't advance) and `spend_telemetry_lag` (the `raw.visible_spent_usd` field on `getKeyStatus()` under-reports for up to 30s — see `client.ts:44`). Neither models the far more dangerous case for this specific code path: **`getKeyStatus().hasKey` itself reading stale**, i.e. reporting `false` (revoked) because of read-your-own-write lag on the status endpoint, while the key is in fact still live server-side and still spending. `docs/MCP_SURFACE.md` explicitly flags that the live account's spend/balance semantics are only partially observed ("the spend portion remains unproven"), so there is no basis for assuming the key-status endpoint is strongly consistent with the revoke mutation in production.

The recovery block has exactly one defense against this: `status.hasKey` must be `false`. If that single field is the thing lagging, the defense is the thing that's compromised, and the run will print `KEY_REVOKED: has_key=false`, write `balance_intact_after_revoke: true`, and exit 0 — while a real key may still be attached to the account.

## 3. No deadline on the recovery reads

`client.ts`'s only timing control is `beforeToolCall()`, which in `tool_latency_30s` mode sleeps 30s per call with no cap enforced anywhere above it. Nothing in `d1-lifecycle.ts` races `getKeyStatus()`/`getBalance()` against a deadline. Combined with finding 1, a slow-but-eventually-successful recovery read is indistinguishable, from the caller's perspective, from one that never returns: the process just hangs mid-`RECOVERING`, during which a still-active key (the exact scenario recovery exists to rule out) keeps spending with no ledger event marking that the system is in a stuck, unverified state.

## Why this matters together

These three compound: a transient fault trips `revokeKey()` into the recovery branch → the recovery branch's own reads have no timeout and no retry → if they're slow, the run hangs with an unrevoked key and no evidence of the hang; if they throw, the run crashes with no evidence of the fault; if they merely return stale-but-not-erroring data (unmodeled today), the run reports success incorrectly. In all three sub-cases the one guarantee `docs/DAY1_FAILURE_MODES.md` advertises — "evidence is append-only" and reconciliation failures are always recorded — does not hold.

## Suggested direction (not in scope for this lane to implement)

- Wrap the recovery reads in their own try/catch that always emits a `RECONCILIATION_FAILED` (or a new `RECOVERY_READ_FAILED`) event before rethrowing, so the ledger is never silently truncated.
- Give recovery reads an explicit deadline, and treat a timed-out recovery read as `RECONCILIATION_FAILED`, not as "pending."
- Require two consistent re-reads (or a re-read plus a short backoff-and-retry) before trusting `hasKey: false` during recovery, since a single read cannot distinguish "revoked" from "stale."
