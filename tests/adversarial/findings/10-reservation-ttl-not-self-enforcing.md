# Implementation finding: the reservation TTL only fires as a side effect of unrelated governor activity — it is not a live deadline

**Target:** [`src/governor/governor.ts`](../../../src/governor/governor.ts) (`reserve()`, `commitExact()`, `commitEstimated()`, `expireUnlocked()`), [`src/worker/shared-worker.ts`](../../../src/worker/shared-worker.ts) (`run()`)
**Commit reviewed:** `8b875ec` ("Implement Day 2 budget governor")
**Severity:** Critical. This is [design finding 03](03-reservation-held-forever-on-timeout.md) confirmed present in the shipped code, and it is worse than the design review anticipated: it's not just that the release-on-timeout policy is undefined — the timeout has **no independent trigger at all**.

## The bug

`reserve()` calls `this.expireUnlocked(nowMs)` as its first step ([governor.ts:31](../../../src/governor/governor.ts#L31)), and the public `expire()` method ([governor.ts:96](../../../src/governor/governor.ts#L96)) also calls it. **Nothing else does.** Specifically, `commitExact()` and `commitEstimated()` — the two methods that decide whether a call's result is honored — never call `expireUnlocked()`. They only inspect the reservation's current `state` field:

```ts
async commitExact(attemptId: string, costUsd: number): Promise<boolean> {
  return this.atomic(async () => {
    const reservation = this.reservations.get(attemptId);
    if (!reservation || reservation.state !== "active") return this.rejectLate(...);
```

`state` is only ever flipped from `"active"` to `"expired"` inside `expireUnlocked()`. So a reservation's TTL does not expire on a timer, a clock, or anything intrinsic to itself — it expires only when **some other call** to `reserve()` or `expire()` happens to run on the *same governor instance* after the TTL has elapsed. If nothing else touches the governor in the meantime, the reservation stays `"active"` forever, no matter how much real wall-clock time passes.

Separately, and compounding this: `SharedWorker.run()` ([shared-worker.ts:40](../../../src/worker/shared-worker.ts#L40)) does `await this.transport.complete(...)` with no deadline of any kind — no `Promise.race`, no `AbortController`, nothing tied to `reservationTtlMs`. If the transport call hangs, the loop simply waits, and it never calls `governor.expire()` either. So in the single-agent, no-concurrent-activity case — which is the *normal* case, not an edge case, for a worker running its own sequential step loop — the TTL configured on the governor is inert.

## Reproduction

**1. At the governor level** — [`ttl_not_self_enforcing.ts`](../repro/ttl_not_self_enforcing.ts): reserve with `reservationTtlMs: 50`, sleep 200ms (4x the TTL) with no other governor call in between, then `commitExact()`:

```
Reservation created with TTL=50ms. Sleeping 200ms (4x the TTL) with NO intervening reserve()/expire() call...
commitExact() after 4x-TTL wall-clock delay, with no intervening expire, returned: true
Ledger events: RESERVATION_CREATED, COST_COMMITTED
Final snapshot: committedExact=0.5, reservedTotal=0, quarantined=false

REPRO CONFIRMED: a call that hung for 4x its reservation's TTL was committed as a completely normal, on-time exact result.
```

A call that took four times its allotted TTL is treated identically to one that returned instantly. `docs/DAY1_FAILURE_MODES.md`'s `tool_latency_30s` mode and `docs/DAY1_RESULT.md`'s live call that never returned inside its safety window are exactly the conditions this should catch — and doesn't.

**2. At the worker level** — [`shared_worker_hangs_forever.ts`](../repro/shared_worker_hangs_forever.ts): a transport whose `complete()` never settles, raced against 8x the TTL:

```
Dispatching a step against a transport that never resolves, TTL=50ms...
After waiting 400ms (8x the governor's own reservationTtlMs), worker.run() has: timed_out
Governor snapshot at that point: reservedTotal=1, committedExact=0, committedEstimated=0
Ledger events so far: RESERVATION_CREATED
```

`worker.run()` is still hanging, and the $1.00 reservation is still fully counted against the budget — indefinitely, since nothing will ever release it.

## Why this matters for the actual deliverable

The whole reservation scheme exists to bound risk from exactly the failure mode Day 1 already proved is real for this gateway: a call that doesn't return promptly. As shipped, `reservationTtlMs` is a config field the governor accepts and stores, but the only two code paths that would act on it (`reserve()` and `expire()`) are never invoked by the one caller (`SharedWorker`) that actually makes long-running network calls. The TTL protects against nothing unless a second, unrelated reservation happens to be created on the same governor afterward — which, for a solo agent working through its own step list, doesn't happen until *its own next step*, i.e., never, if the hang is on the last step or the only step.

## Suggested direction (not implementation — flagging what's missing)

- `SharedWorker.run()` needs to race `transport.complete()` against a deadline (naturally `reservation.expiresAtMs`), and treat a deadline loss as a call to `commitEstimated(attemptId, "ttl_exceeded")` — the same fail-closed path already used for thrown errors.
- Independently, `commitExact()`/`commitEstimated()` should not trust a reservation's `state` without first reconciling it against the current time (call `expireUnlocked(nowMs)`, or an equivalent check, before reading `state`), so a late result is judged against real elapsed time regardless of what else has or hasn't happened to the governor in between.
