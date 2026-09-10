# Implementation finding: `reserve()` deduplicates by `attemptId` only — nothing stops two concurrently-active reservations for the same logical call

**Target:** [`src/governor/governor.ts`](../../../src/governor/governor.ts), `reserve()` ([governor.ts:28-64](../../../src/governor/governor.ts#L28-L64)), specifically the `DUPLICATE_ATTEMPT` check at [governor.ts:33](../../../src/governor/governor.ts#L33)
**Commit reviewed:** `8b875ec`
**Severity:** High. This is [design finding 08](08-retry-before-release-races-the-specified-concurrency-test.md)'s core concern, now checked directly against the shipped admission logic.

## The bug

```ts
if (this.reservations.has(request.attemptId)) return this.refuse("DUPLICATE_ATTEMPT", request, {});
```

The only idempotency check `reserve()` performs is keyed on `attemptId` — a value the *caller* generates fresh for every attempt (`SharedWorker` uses `crypto.randomUUID()` per call, [shared-worker.ts:29](../../../src/worker/shared-worker.ts#L29)). `ReservationRequest` also carries a `logicalCallId` ([types.ts:11](../../../src/governor/types.ts#L11)), clearly intended to identify "this is a retry of that same piece of work" (it's what groups an original attempt and its retries together for reporting), but `reserve()` never reads `logicalCallId` when deciding admission. It is stored on the `Reservation` record and never consulted again until it's just carried through into ledger events.

The consequence: two different attempts sharing the same `logicalCallId`, each with a distinct `attemptId`, can both be `active` reservations simultaneously, as long as the earlier one hasn't been expired (see [finding 10](10-reservation-ttl-not-self-enforcing.md) for how easy that is to fail to happen) and there's enough budget for both. There is no single-flight protection — nothing that says "only one active reservation may exist per logical call at a time."

## Reproduction

[`concurrent_active_reservations_same_logical_call.ts`](../repro/concurrent_active_reservations_same_logical_call.ts): reserve `attempt-original` for `logicalCallId: "research-step-2"`, then — before it expires or resolves — reserve `attempt-retry` for the *same* `logicalCallId`:

```
Original attempt for logicalCallId="research-step-2" admitted, reservedTotal=0.5
Retry attempt for the SAME logicalCallId="research-step-2" (original still active, not expired): admitted=true
reservedTotal after both: 1

REPRO CONFIRMED: two independently-active reservations exist for the same logical call at once.
Both attempts independently reconciled as EXACT commits: original=true, retry=true
Total real committed spend for one logical step: $0.1 (should be one call's worth, not two)
```

Both attempts reconcile cleanly and independently — the governor's arithmetic is internally consistent (it never loses track of either reservation), but it happily books **two real, distinct dollar amounts** for what the mission model treats as a single logical step.

## Why this is a real risk, not a theoretical one

`SharedWorker` itself doesn't retry today (see [finding 10](10-reservation-ttl-not-self-enforcing.md) — it has no deadline logic at all, so it can't retry, it can only hang). But the data model (`logicalCallId` existing precisely to correlate attempts) and the design review's own explicit prompt ("attack the reservation scheme... retry-vs-release race") both signal that retry-on-slow-call is an intended future capability of this governor, and the unit test suite already exercises retry-shaped call sequences (`testRetryReleaseRace` in `tests/unit/d2-governor.test.ts`, which carefully sequences `expire()` before the retry's `reserve()` so no overlap occurs). That test proves the *well-behaved* ordering is handled correctly — it does not prove the *ill-behaved* ordering (retry issued before the original is expired) is prevented, because nothing prevents it. Any future caller — a worker-level retry-on-slow-response, a supervisor process restarting a stuck step, or simply a bug that calls `reserve()` twice for one logical unit of work — will be silently admitted twice by the current code, with no error, no refusal, and no warning in the ledger.

## Suggested direction (not implementation)

Before admitting a new reservation, check for any other `active` reservation sharing the same `logicalCallId` and refuse (a new `LOGICAL_CALL_IN_FLIGHT`-style reason) unless the caller is explicitly and deliberately superseding it (e.g., an explicit "cancel and retry" operation that atomically expires the old reservation as part of admitting the new one, rather than two independent, uncoordinated `reserve()` calls).
