# Design finding: the specified concurrency test proves the ledger arithmetic is race-free, not that retries and releases are race-free

**Target:** `SENTINEL_D2_RUNNER.md` §2 ("Guard it. Twenty concurrent calls must not each see the same pre-reservation total") and §7's required concurrency test.
**Status:** design review — no `src/governor/` code or test exists yet.
**Severity:** Medium-High. This is a gap in the test's coverage, not just the implementation's.

## The gap

§7 requires "a concurrency test that fires 20 simultaneous admission requests against a $1 budget and asserts the total reserved never exceeds it." That test, as described, exercises exactly one race: N *new, independent* admission requests arriving at once. A single mutex around the reserve step is sufficient to pass it, and the test in §7 would pass.

It does not exercise the race that actually matters once [finding 03](03-reservation-held-forever-on-timeout.md)'s timeout-release path exists: **a release and a new reservation happening concurrently, where the new reservation is logically a retry of the thing being released.** This is a different hazard class than "20 fresh calls at once," and passing the specified test gives no evidence about it.

## Concrete race

1. Call A is dispatched, reservation held: reserved=$0.40 out of a $1.00 budget.
2. Call A hangs (per finding 03). The agent's tool-use loop, seeing no response after some internal timeout of its own — separate from and likely shorter than the governor's reservation timeout, since nothing in the spec says these two timers are the same — decides to retry the same logical tool call.
3. The retry issues a **new** admission request for the same worst-case cost while call A's original reservation is still technically held (the governor's own timeout hasn't fired yet, or fires at the same instant). Two valid orderings exist and the spec picks neither:
   - **New reservation admitted alongside the old one:** reserved briefly = $0.80 for what is semantically one task. If both eventually land (call A was not actually dead, just slow — a live network call succeeding late is exactly what `docs/DAY1_RESULT.md`'s hung call could have done if the safety window had been longer), **both get dispatched**, doubling real spend for one logical unit of work, not just doubling paper reservation. This is a real-money duplicate-dispatch bug, not just a bookkeeping one.
   - **New reservation refused because the old one is still "in flight" per the ledger:** the agent's retry — its only recovery path for a hung call — is refused by the same governor that caused the hang to look unrecoverable in the first place, feeding directly into [finding 09](09-refusal-cascade-self-starvation.md)'s deadlock.
4. Whichever ordering happens, it depends on exact timing between the governor's own timeout-release and the agent's retry decision — two independently-timed events the spec never says are coordinated, synchronized, or even aware of each other.
5. Separately: if call A's original hung request *does* eventually return, after its reservation was already released (by timeout) and possibly already reused by an unrelated concurrent call from the *other* agent process or a different tool call in the same mission, its reconciliation (step 4) has no defined reservation slot to reconcile against. Does it commit into a slot that's already been given to someone else, silently corrupting that other call's accounting? Does it get dropped? The spec's model assumes a 1:1 lifetime between "a call" and "a reservation," and a late zombie response breaks that assumption.

## Why the §7 test as specified won't catch this

Twenty simultaneous *fresh* admissions all racing the same check-then-reserve critical section is the textbook case a single mutex solves cleanly and a unit test can assert deterministically (sum of admitted reservations ≤ budget). The retry-before-release race depends on the relative timing of two asynchronous timeout paths (agent-level retry timeout vs. governor-level reservation timeout) plus a late/zombie response arriving after either has fired — a fundamentally different, timing-dependent hazard that a same-instant-fire test doesn't exercise at all. A green concurrency test under §7 provides no evidence either way about this class of bug.

## Question the design needs to answer before implementation

- Is there a single canonical timeout that both the agent's retry decision and the governor's reservation release are driven by, or are they independent timers that can disagree about whether a call is "still in flight"?
- Does a reservation carry an identity (a call/attempt ID) so a late reconciliation can detect "this slot was already released/reused" and refuse to commit into it, versus corrupting an unrelated reservation's accounting?
- Is retry-of-a-possibly-still-live-call idempotent at the gateway (e.g., can it be scoped so a late-landing original response is safely discarded once a retry has been dispatched), or does a retry always risk double-dispatch?

## Suggested direction (not implementation)

Extend the required concurrency test beyond §7's literal wording to include a retry-during-pending-timeout scenario (reserve → let it time out → retry-reserve while a fabricated "late" response for the original is still in flight → assert exactly one commit happens, not zero and not two), since that is the scenario this spec's own retry-friendly design actually creates.
