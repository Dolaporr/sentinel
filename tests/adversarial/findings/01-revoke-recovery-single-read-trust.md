# Finding: the D1 lifecycle leaves a live, uncapped gateway key behind on every failure except the one its recovery path handles

**Target:** [`src/orbio/client.ts`](../../../src/orbio/client.ts) and the lifecycle and recovery path in [`scripts/d1-lifecycle.ts`](../../../scripts/d1-lifecycle.ts)
**Severity:** High. A gateway key "has no credit limit of its own" and spends the account balance directly ([`docs/MCP_SURFACE.md`](../../../docs/MCP_SURFACE.md)). A key that outlives the run can spend the whole balance.
**Revised:** 2026-09-11. Sections 1–4 and 8 are new. Sections 5–7 are the 2026-09-07 finding, kept, with its reproduction output corrected (see section 5).

## Summary

`d1-lifecycle.ts` mints a live key at line 22. Its only protection is the `RECOVERING` branch at lines 36–47, and that branch runs only if `revokeKey()` itself throws. Every earlier failure exits `main()` with the key still live. That includes a failed inference (line 26), a failed balance read (line 30), and an unmoved balance (line 34). None of those writes a failure event.

Stale reads and telemetry lag don't need their own code paths to cause harm. Both lead to the line 34 exit:

- Under any balance-read lag longer than the gap between the inference and the next read, D1 **cannot succeed**. It always takes the orphaning path.
- The recorded evidence puts that gap at 1ms.

`docs/DAY1_FAILURE_MODES.md` says `stale_balance` "fails closed". That's true of the spend proof. It isn't true of the key: the key fails open.

## What is and isn't measured

| Quantity | Status | Source |
| --- | --- | --- |
| Balance-telemetry lag | **Never measured.** The only figure is the mock's hardcoded 30s, and that applies to key-status telemetry, not the balance. | [`client.ts:44`](../../../src/orbio/client.ts#L44). The whole `Codex/` tree was searched on 2026-09-11 and no other figure exists. |
| Live balance movement | **Never observed.** Both live balance reads were taken before any spend. | `docs/MCP_SURFACE.md`, `docs/DAY1_RESULT.md` (2026-09-07). |
| Live balance reads during D2 | **None.** The recorded feed opened with a `BALANCE_READ` that wasn't a read; it was removed on 2026-09-11 (section 8). | `fixtures/sample-feed.jsonl`, [`scripts/d2-race-live.ts`](../../../scripts/d2-race-live.ts) |
| Spend telemetry available to the gateway key | **Only the `usage.cost` in each response.** `GET /api/v1/key`, `/auth/key` and `/credits` all return 404. | Probed 2026-09-11 with the current key. These were GETs only, with no spend. |

## 1. Any failure between mint and revoke orphans the key

```ts
const key = await client.createKey({ label: "sentinel-d1" });                 // 22: key is live from here
const inference = await client.runInference({ ... });                          // 26: can throw
const afterSpend = await client.getBalance();                                  // 30: can throw
if (!(spentDelta > 0)) throw new Error("Spend proof failed: ...");             // 34: throws on any stale read
try { await client.revokeKey(); } catch (error) { /* RECOVERING */ }           // 36-47: first and only revoke path
```

There is no `try/finally` from line 22 onward. Running the real script against the mock in `stale_balance` mode, with the ledger in a temp directory:

```
D1 MODE: mock
1 BALANCE_BEFORE_SPEND: $50.000000
2 KEY_CREATED: key_id=mock-gateway-0001
3 INFERENCE_CALL: model=openai/gpt-4.1-mini cost=$0.000020 cap=$1.000000
4 BALANCE_AFTER_SPEND: $50.000000 delta=$0.000000
D1 FAILED: Spend proof failed: gateway balance did not decrease.
ledger events: BALANCE_READ KEY_CREATED INFERENCE_CALL BALANCE_READ
```

The ledger has no `KEY_REVOKED` and no `RECONCILIATION_FAILED`. The committed evidence file shows the same thing: seq 1–4 are the 2026-09-07 `stale_balance` run, and it stops at the post-spend read. After the script exits, the same client object reports the key as live, and the key can still spend. From the reproduction below:

```
MockOrbioClient stale_balance | died: line 34: Spend proof failed | key live after exit: true | orphan can spend: SUCCEEDED | true $49.999960 vs read $50.000000
```

**Live consequence:** the gateway secret now sits in `.env` as `ORBIO_API_KEY` (updated 2026-09-11 09:45). Four scripts read it. So an orphaned key can be spent by anything that reads `.env`, and nothing in the evidence says it needs revoking. `orbio_revoke_key` takes no arguments, so an operator can clean up out of band. But only if they know to.

## 2. Any balance-read lag forces the section 1 path

The recorded gap between the inference and the post-spend read is 1ms in every run in `evidence/d1-lifecycle.jsonl`:

- seq 3→4: `.131`→`.132`
- seq 7→8: `.883`→`.884`
- seq 14→15: `.758`→`.759`

`MockOrbioClient` can't show this problem. Its `getBalance()` ([`client.ts:26-31`](../../../src/orbio/client.ts#L26-L31)) returns either the live value or a snapshot frozen forever. Its only lag mode delays `getKeyStatus().raw.visible_spent_usd`, never the balance. So `stale_balance` is the lag=∞ case, and no mode covers a finite lag.

With a stand-in whose `getBalance()` reflects only spend older than `LAG_MS`:

```
lag 0ms      | died: no (revoked at line 37)                  | key live after exit: false
lag 1ms      | died: line 34: Spend proof failed ...          | key live after exit: true  | orphan can spend: SUCCEEDED
lag 50ms     | died: line 34: Spend proof failed ...          | key live after exit: true  | orphan can spend: SUCCEEDED
lag 1000ms   | died: line 34: Spend proof failed ...          | key live after exit: true  | orphan can spend: SUCCEEDED
lag 30000ms  | died: line 34: Spend proof failed ...          | key live after exit: true  | orphan can spend: SUCCEEDED
```

Against the live bridge, the gap is one MCP round trip instead of 1ms. D1 succeeds only if the balance endpoint's lag is shorter than that round trip. Nobody has measured that lag, so whether live D1 can pass at all is unknown. And if it fails, it fails by orphaning the key.

## 3. A mid-call failure is billed, never recorded, and orphans the key

`MockOrbioClient.runInference()` charges only after both checks pass ([`client.ts:55-60`](../../../src/orbio/client.ts#L55-L60)). No mode bills upstream and then throws. That's the shape of a timeout or a cut connection, and it's also the one live D1 attempt: `docs/DAY1_RESULT.md` records that the transport "was terminated before a result could be received".

That document then takes "a fresh balance read showed no charge" as evidence of no charge. Under an unmeasured lag, a read taken right after the request can't show that.

When upstream bills and then the socket dies, line 26 throws:

- no `INFERENCE_CALL` is written for money that was spent
- no failure event is written
- the key stays live

```
billed-then-throws | died: line 26: socket hang up (request was billed upstream) | key live after exit: true | orphan can spend: SUCCEEDED | true $49.999960 vs read $49.999960
```

## 4. `balance_intact_after_revoke` is read 1ms after the revoke

The post-revoke balance read comes 1ms after `KEY_REVOKED`:

- seq 10→11: `.886`→`.887`
- seq 16→17: `.761`→`.762`

Under a lag L, both reads fall inside the lag window. So the check can't see spend that landed in the last L, and that includes any request still in flight when the revoke happened. Whether a revoke cancels in-flight requests has never been observed. The check will print `balance_intact_after_revoke: true` either way.

The same run records contradictory spend without flagging it. In seq 16 (`spend_telemetry_lag`), `KEY_REVOKED` carries `telemetry_lagging: true, visible_spent_usd: 0`. The balance reads on either side show $0.00002 spent. The run exits 0. `DAY1_FAILURE_MODES.md` names the balance as the source of truth, so the lag gets written down but never reconciled against it.

## 5. Recovery reads aren't protected, so recovery failures vanish from the ledger

*(2026-09-07 finding, unchanged in substance.)*

If `getKeyStatus()` or `getBalance()` throws inside the recovery branch (lines 40–41), the exception escapes `main()`. Neither `KEY_STATUS_READ` nor `RECONCILIATION_FAILED` is written. This is the double-fault case: revoke has already failed once, and the system doesn't know whether a live key is still spending. `DAY1_FAILURE_MODES.md` promises that "a failed or irreconcilable revoke emits `RECONCILIATION_FAILED`". That promise is false in exactly this case.

**Correction to the 2026-09-07 reproduction.** The earlier output said `Ledger entries before recovery attempt: 0` and `after crash: 0`. Both were wrong. The script counted lines with `require()` inside an ES module (`package.json` has `"type": "module"`), and its `catch` swallowed the `ReferenceError` and returned 0. It also appended to the committed `evidence/` file on every run. The fixed script writes to a temp ledger and lists event names:

```
Ledger before recovery attempt: BALANCE_READ, KEY_CREATED
5 RECOVERING: re-reading gateway status and balance; revoke outcome is not assumed.
REPRO RESULT: uncaught exception escaped the recovery block, exactly as scripts/d1-lifecycle.ts's would:
  adversarial: key-status endpoint reset mid-recovery
Ledger after crash (2 entries): BALANCE_READ, KEY_CREATED
RECONCILIATION_FAILED written for this fault: false
```

The finding holds. Only the counts in the old output were wrong.

## 6. A stale key-status read is unmodeled and unhandled

*(2026-09-07 finding.)*

The recovery branch's only proof that the key is dead is a single `status.hasKey === false`. If the status endpoint lags the revoke, that one field is exactly what's wrong. The run then prints `has_key=false`, writes `balance_intact_after_revoke: true` and exits 0, possibly with a live key. `MOCK_FAILURE_MODES` has no mode where `hasKey` itself is stale.

## 7. Recovery reads have no deadline

*(2026-09-07 finding.)*

`client.ts`'s only timing control is `beforeToolCall()`, and in `tool_latency_30s` mode it sleeps 30s with no cap anywhere above it. A slow recovery read looks the same as one that never returns. The process hangs in `RECOVERING`, and nothing in the ledger says it is stuck with an unverified key.

## 8. The live evidence contains no balance observation, and the D2 feed invented one (fixed 2026-09-11)

As recorded on 2026-09-10, the D2 live feed opened with a `BALANCE_READ` that wasn't a read. `scripts/d2-race-live.ts` built it after the race, at feed-assembly time:

- `orbio_balance: null`
- `ts` set to the moment the feed was written (`13:36:46.658`), 4m47s *after* the event that followed it (`13:31:59.055`)
- `seq` taken from array position, not from time, so the rest of the feed was out of time order too

**Fixed on 2026-09-11:**

- `scripts/d2-race-live.ts` no longer emits a `BALANCE_READ`. The script holds only the gateway key, which can't read the balance, so it never performs a read. The endpoint and model details the fake event carried now go to the stdout result.
- The script orders the feed by timestamp and numbers `seq` in that order. Every event keeps the timestamp taken when it happened.
- The recorded `fixtures/sample-feed.jsonl` was corrected mechanically, not re-run: the one fabricated event was removed and `seq` renumbered by timestamp. No other field of the remaining 40 events changed. The original is in git history (commit `e6305dc`).

**Still true:** the race spent $0.256670 according to `usage.cost`, and none of it has been reconciled against the balance. Nobody has ever seen the live balance move. A "measured telemetry lag" can't exist until someone reads the balance before and after a known spend.

**Not changed here:** the UI's offline mock feed (`sentinel-ui/public/sample-feed.jsonl`, in Antigravity's repo) opens with its own `BALANCE_READ` showing `orbio_balance: 3`, which is the session ceiling presented as a balance. That has been handed off to Antigravity.

## How the failures combine

| Failure | Exits at | Key after exit | What the ledger shows |
| --- | --- | --- | --- |
| Stale balance, or any lag above ~1ms | line 34 | **live, spendable** | no `KEY_REVOKED`, no failure event |
| Inference billed upstream, then throws | line 26 | **live, spendable** | no `INFERENCE_CALL` for billed spend, no failure event |
| Post-spend balance read throws | line 30 | **live, spendable** | nothing after `INFERENCE_CALL` |
| Revoke throws, then a recovery read throws | line 40/41 | unknown | nothing (section 5) |
| Revoke throws, `hasKey` reads stale `false` | passes line 43 | possibly live | reports success (section 6) |
| Key-status telemetry lags | completes | revoked | contradictory spend, not flagged (section 4) |

## Suggested direction (not in this lane to implement)

- Revoke from a `finally` that starts at line 22, with its own deadline. Write `RECONCILIATION_FAILED` if the revoke or its confirming read fails for any reason.
- Don't treat an unmoved balance as proof that nothing was spent. Either wait out a *measured* lag bound, or use the response's `usage.cost`, and treat a missing `usage.cost` as "spent, unknown amount".
- Write `INFERENCE_CALL` before dispatch (intent) and again after (outcome). A billed call that throws should still leave a record.
- Measure L before anything relies on a balance read: read the balance, make one tiny spend, then poll the balance until it moves.
- Only emit `BALANCE_READ` when a read actually happened, and stamp every D2 feed event at the time it happens. *(Done on 2026-09-11 in `scripts/d2-race-live.ts`; see section 8.)*

## Reproductions

All run offline against mocks or in-memory stand-ins. They use no key, make no network calls and write no committed files.

```bash
npx tsx tests/adversarial/repro/balance_lag_orphans_live_key.ts
```

This reproduces sections 1–3: stale-mode orphaning, the lag sweep, and billed-then-throws. It ends with `REPRO RESULT: 6 of 7 runs exited with a live, spendable gateway key. Only lag 0 with a clean inference reached the revoke.`

```bash
npx tsx tests/adversarial/repro/revoke_recovery_double_fault.ts
```

This reproduces section 5, with the corrected output shown above.

To run the real script in stale mode without appending to the committed evidence file, run it from a temp directory:

```bash
REPO="$PWD"; cd "$(mktemp -d)" && MOCK_FAILURE_MODE=stale_balance "$REPO/node_modules/.bin/tsx" "$REPO/scripts/d1-lifecycle.ts"; grep -o '"event":"[A-Z_]*"' evidence/d1-lifecycle.jsonl
```
