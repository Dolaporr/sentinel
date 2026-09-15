# Finding: four concurrent requests can drain the balance within one request's latency; the breaker must admit before dispatch, hold the only copy of the key, and survive restarts

**Target:**
- the Orbio gateway model ([`docs/MCP_SURFACE.md`](../../../docs/MCP_SURFACE.md))
- [`src/governor/governor.ts`](../../../src/governor/governor.ts) and [`src/governor/ledger.ts`](../../../src/governor/ledger.ts)
- `SessionSpendCap` in [`scripts/d2-race-live.ts`](../../../scripts/d2-race-live.ts)
- every script that reads `ORBIO_API_KEY`
- the D3 breaker, which is not built yet

**Severity:** High. This decides where D3's breaker has to live. Put it anywhere else and it's decoration.
**Revised:** 2026-09-11. The 2026-09-07 version used assumed inputs ($5/call, 150ms, 20-way) and was written before the D2 governor existed. This version replaces those inputs with measured ones and adds three placement requirements the earlier version missed: key custody, durability, and gating key minting. The earlier conclusion, that admission must happen before the request, stands and is now shown against real numbers.

## Given

- A gateway key spends the account balance directly and "has no credit limit of its own". `orbio_create_key` "retires/replaces the previous gateway key", and `orbio_revoke_key` leaves the balance "explicitly unchanged" ([`docs/MCP_SURFACE.md`](../../../docs/MCP_SURFACE.md)). So revoking stops one key, and anyone who can mint gets a fresh uncapped key against the same balance.
- **Telemetry lag L has never been measured.** No one has observed the live balance move ([finding 01](01-revoke-recovery-single-read-trust.md), "What is and isn't measured"). This analysis keeps L as a parameter and shows the answer doesn't depend on it.
- The gateway key has **no telemetry endpoint**. `GET /api/v1/key`, `/auth/key` and `/credits` all return 404 (probed 2026-09-11, GETs only, no spend). The only spend signal the key holder gets is `usage.cost` in each response body, and that arrives only when the request completes.

## Measured inputs

| Input | Value | Source |
| --- | --- | --- |
| Balance | $100.076010 | Last actual read, 2026-09-07 ([`MCP_SURFACE.md`](../../../docs/MCP_SURFACE.md)). Unread since. |
| Per-call latency, `openai/gpt-4.1` | 1.8s to 25.9s, median 15.6s (15,624ms) | 19 sequential naked-agent calls, `fixtures/sample-feed.jsonl` (live, 2026-09-10) |
| Max observed cost per call | $0.01868 | same |
| Warm round trip to `www.orbio.so` | 108–118ms | GETs, 2026-09-11 |
| Advertised models | 439, none listing `max_completion_tokens` | `GET /api/v1/models`, 2026-09-11 |
| Highest input-only full-context request | `gpt-5.5-pro` 1,050,000 tok × $30/M = **$31.50**. `o1-pro` 200,000 × $150/M = **$30.00**. `gpt-4.1` = $2.10. | same |

Input cost is a floor on what a single request costs, because the attacker chooses the input size. Output adds to it, and the price list gives no output ceiling.

## Fastest credible drain

With N = ceil(B / c) requests needed and k in flight at once, drain time is ceil(N / k) × T. Output of [`drain_bound_from_measured_parameters.ts`](../repro/drain_bound_from_measured_parameters.ts):

```
naked agent as observed (sequential)         c=$  0.0134 N= 7466 waves=7466 drain ~ 31.7h
same calls, 20 in flight                     c=$  0.0187 N= 5358 waves= 268 drain ~ 69.8min
same calls, 200 in flight                    c=$  0.0187 N= 5358 waves=  27 drain ~ 7.0min
gpt-4.1 full-context input, 48 in flight     c=$  2.0952 N=   48 waves=   1 drain ~ 15.6s
gpt-5.5-pro full-context input, 4 in flight  c=$ 31.5000 N=    4 waves=   1 drain ~ 15.6s
```

**Answer:** four full-context requests to one listed model exceed the balance. All four fit in a single concurrent wave, so the fastest drain is **one request's latency**. With a model this repo already uses (`gpt-4.1`), 48 requests do the same. The 15.6s figure is the measured median for this repo's own 2k-token completions, used as a stand-in. A 1M-token request's latency hasn't been measured and will be longer. But it's still one wave: the attacker waits for one request, not for 5,358.

Three gateway behaviours are unmeasured, and each could move this answer:

- **Concurrency or rate limits.** A per-key concurrency cap below 4 would turn one wave into several.
- **Balance pre-check.** Nobody knows whether the gateway refuses a request whose cost would exceed the remaining balance. If it doesn't, the fourth request overdraws.
- **Admission of maximum-size requests.** The model list says what the gateway advertises. It doesn't prove the gateway will accept a 1M-token request.

## A breaker that reacts to spend cannot beat this, whatever L is

A breaker reacting to spend has two possible signals:

- **`usage.cost`.** It arrives when the response completes.
- **The balance.** It moves after the spend and after L.

Neither can fire before the request that caused it has been billed:

```
breaker in the dispatch path reading usage.cost: trips at ~15.7s (T + one RTT) whatever L is; 20-in-flight gpt-4.1 lands >= $0.75 first
L=  0.0s: balance watcher trips at ~ 16.9s; 20-in-flight gpt-4.1 lands >= $0.75 first
L=  1.0s: balance watcher trips at ~ 17.9s; 20-in-flight gpt-4.1 lands >= $0.75 first
L= 30.0s: balance watcher trips at ~ 46.9s; 20-in-flight gpt-4.1 lands >= $1.12 first
L= 60.0s: balance watcher trips at ~ 76.9s; 20-in-flight gpt-4.1 lands >= $1.87 first
Under either breaker, 4 full-context gpt-5.5-pro requests dispatched together bill $126.00 before it can trip.
```

L only changes how much *more* gets through. Even at L = 0 the drain has already finished by the time the breaker fires, because the drain takes one wave and the detection signal comes out of that same wave. So measuring L is still needed for reconciliation ([finding 01](01-revoke-recovery-single-read-trust.md)), but it doesn't change where the breaker has to go.

Pre-dispatch admission, the shape `SessionSpendCap` already uses:

```
$3.00 ceiling: the first gpt-5.5-pro request reserves >= $31.50 and is refused before dispatch; $0.00 leaves the process.
Worst case for any mix of priced calls: <= $3.00, whatever T or L is, provided every dispatch passes through it and no call bills above its reservation.
```

That "provided" clause holds three conditions, and the code today breaks two of them. Each broken condition becomes a placement requirement below.

## Where the breaker must sit

### 1. Before dispatch, reserving the worst case

The D2 governor ([`governor.ts:42`](../../../src/governor/governor.ts#L42)) and `SessionSpendCap` ([`d2-race-live.ts:78-85`](../../../scripts/d2-race-live.ts#L78-L85)) both already do this. Both fail closed on unpriced models: [`worstCaseUsd`](../../../src/runner/d2-mission.ts#L98-L103) throws, and `createLiveTransport` calls it at [line 114](../../../scripts/d2-race-live.ts#L114), before the cap is consulted. So the $31.50 model can't get through the live race's transport.

The remaining gap is a call that bills more than its reservation ([finding 07](07-max-tokens-not-a-true-ceiling.md)). The governor quarantines on `OVER_RESERVATION`. `SessionSpendCap` adds the overage without checking it, and the only guard is an after-the-fact assertion at line 262.

### 2. In front of the key, as its only holder (new)

A cap bounds only the spend that chooses to go through it. The gateway secret is a bearer credential in `.env`, and four scripts read it directly, each with its own rule or none:

| Script | What stands between the secret and the network |
| --- | --- |
| `scripts/d2-race-live.ts` | `SessionSpendCap`, before dispatch |
| `scripts/d2-calibrate.ts` | its own `HARD_CAP_USD` check, before each fetch |
| `scripts/d1-gateway-inference.ts` | a $1 check at [line 32](../../../scripts/d1-gateway-inference.ts#L32), made **after** the response, when the money is already spent |
| `scripts/raw-gateway-proof.ts` | nothing ([lines 12-18](../../../scripts/raw-gateway-proof.ts#L12-L18)) |

The live race's naked agent was bounded only because the experimenter wrapped its transport. Its own code checks nothing, and [`d2-mission.ts:177`](../../../src/runner/d2-mission.ts#L177) counts a missing cost as $0.

Any code that can read `process.env` has an uncapped key. That includes a new script, a dependency, or an agent tool reached by prompt injection. **Requirement:** a single custodian process holds the secret and offers dispatch as a capability. Agents and scripts never see the secret, and the breaker lives inside that custodian.

### 3. Durable and account-scoped, not per process (new)

`BudgetGovernor` keeps committed and reserved amounts in memory only ([`governor.ts:16-18`](../../../src/governor/governor.ts#L16-L18)). `ReservationLedger` reads its file back only to count lines ([`ledger.ts:15`](../../../src/governor/ledger.ts#L15)). From [`governor_cap_resets_on_restart.ts`](../repro/governor_cap_resets_on_restart.ts):

```
life 1: admitted=true governor committed=$0.90 real cumulative spend=$0.90
...
life 5: admitted=true governor committed=$0.90 real cumulative spend=$4.50
ledger on disk: 10 events, $4.50 committed; each new governor still started at $0.00
worker A admitted=true, worker B admitted=true: $1.80 reserved against a $1.00 budget
REPRO RESULT: cap not durable: $4.50 spent over 5 restarts and $1.80 reserved by 2 governors, both against a $1.00 budget.
```

`SessionSpendCap` has the same property: it's rebuilt at [`d2-race-live.ts:216`](../../../scripts/d2-race-live.ts#L216) on every run. So "the $3.00 live-session ceiling" (`SENTINEL_D2_RUNNER.md`) is $3.00 per process, and each rerun of `npm run d2:race:live` gets a fresh $3.00.

A crash-restart loop, a supervisor retrying a failed run, or a second worker building its own governor each multiplies the cap, and the gateway has none behind it. **Requirement:** one admission authority per Orbio account. It rebuilds committed spend and unexpired reservations from durable state before admitting anything, and refuses to start if it can't.

### 4. Gating key minting, not only inference (new)

Because `orbio_create_key` mints a fresh uncapped key against the same balance, revoking is not containment. The breaker's terminal state has to be "Sentinel stops asking": no further dispatch, **and no further mints**. So the custodian must be the only caller allowed to invoke `orbio_create_key`, and it must refuse to mint once tripped.

### 5. Tripped by every unresolved key state

Any `RECONCILIATION_FAILED`, any key orphaned by the paths in [finding 01](01-revoke-recovery-single-read-trust.md), and any recovery read that fails or times out means spend is currently unbounded. Each must trip the same fail-closed state as hitting the ceiling.

## What no Sentinel-side breaker can beat

- **The secret used outside the custodian.** If it is copied before custody exists (it's in `.env` today), it spends with no Sentinel check. Revoking or re-minting kills that copy. Custody shrinks the surface for future leaks but can't recall one that already happened.
- **A leaked MCP OAuth grant.** Whoever holds it can call `orbio_create_key` at will and spend around any breaker Sentinel runs. Only a cap on the Orbio side, per account or per period, bounds that, and the gateway doesn't offer one. This is the residual risk to accept or escalate, not something D3 can close.

## Measurements that would change or firm up this answer

Nothing below was run. Each needs either access I don't have or real spend, so each needs Dola's go-ahead.

1. **L, the lag between spend and the balance moving.** Read the balance with `orbio_get_balance`, make one call to `gpt-4.1-mini` with `max_tokens: 16` (about $0.0001), then poll the balance until it moves. This needs the authenticated MCP bridge. The gateway key alone can't read the balance.
2. **Whether the gateway refuses a request above the remaining balance.** This is zero-cost if it does refuse. If it doesn't, the request bills real money. Run it only with an explicit dollar bound.
3. **The gateway's concurrency and rate limits.** Probing these takes many paid calls. Recommend asking Orbio instead.

## Reproductions

All three run offline. They use no key, make no network calls and write no committed files.

```bash
npx tsx tests/adversarial/repro/drain_bound_from_measured_parameters.ts
```

Drain times and breaker timing from measured inputs. It reads `fixtures/sample-feed.jsonl` directly, and the price-list figures are recorded as dated constants.

```bash
npx tsx tests/adversarial/repro/governor_cap_resets_on_restart.ts
```

Requirement 3: the cap doesn't survive a restart and isn't shared between governors.

```bash
npx tsx tests/adversarial/repro/balance_drain_race.ts
```

The 2026-09-07 timing model, kept for its illustration of post-hoc versus pre-dispatch. Its inputs are assumptions, and `drain_bound_from_measured_parameters.ts` replaces them.
