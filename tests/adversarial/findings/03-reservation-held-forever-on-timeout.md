# Design finding: a timed-out call's reservation has no specified release, so `committed + reserved` drifts upward from real spend

**Target:** `SENTINEL_D2_RUNNER.md` §2, step 5 ("If the call never returns, the reservation stays held until timeout. Failing closed is correct.")
**Status:** design review — no `src/governor/` code exists yet.
**Severity:** High for mission availability; this is the general mechanism behind the "sequence of refusals deadlocks the agent" question in finding [08](08-refusal-cascade-self-starvation.md).

## The gap

Step 5 says a stuck call's reservation "stays held until timeout" and calls that "correct." It is the safe direction for the ceiling (nothing is under-counted), but the spec never says:

- What the timeout duration is.
- What happens **at** the timeout — is the reservation released back to the pool, converted into a permanent commit at the estimated worst-case cost, or left in limbo forever?
- Whether a late response that arrives *after* the timeout fires is still reconciled, and against what — a reservation slot that may already have been released or reused.

"Failing closed is correct" is true for the immediate call (don't let an unconfirmed call spend unbounded money), but it says nothing about closing the loop afterward. A reservation that is held and never explicitly released is operationally indistinguishable from a permanent debit: the budget ceiling in step 2 (`committed + reserved + worst_case > budget`) sees that capacity as gone forever, even though the real gateway may not have charged anything (the call may have failed before dispatch even completed, or Orbio's own timeout may have cancelled it server-side with zero cost).

Given `docs/DAY1_FAILURE_MODES.md`'s `tool_latency_30s` mode and `docs/DAY1_RESULT.md`'s live call that never returned inside its safety window, stuck calls are not a hypothetical here — they are the documented normal failure mode of this exact gateway.

## Concrete drift scenario

1. Budget = $1.00. Agent calls a $0.40 worst-case tool call. Reservation: committed=$0, reserved=$0.40.
2. The call hangs (as already observed against this gateway). No response arrives before whatever timeout is chosen.
3. Nothing in the spec says the reservation is released. `reserved` stays at $0.40 indefinitely.
4. The agent retries (a reasonable thing for a worker loop to do on a hung call) with a fresh call of the same worst-case cost. New reservation: reserved=$0.80.
5. Remaining admittable budget is now $0.20, even though **zero dollars have actually been spent**. A third necessary call at $0.30 worst-case is refused by the governor for a budget the agent never touched.

This is a self-inflicted `CALL_REFUSED` cascade caused entirely by unresolved bookkeeping, not by real spend — the exact "holding budget while doing nothing" failure mode.

## Why "guard it" (the concurrency mutex in §2) doesn't fix this

The mutex requirement in §2 only protects the reserve/commit arithmetic from being read-modified-written incorrectly under concurrency. It says nothing about *when* a reservation transitions out of the "reserved" state. A perfectly race-free ledger still drifts if reservations have no forced expiry-and-release path independent of the call that created them.

## Question the design needs to answer before implementation

- Does the timeout release the reservation, commit it at worst-case, or something else? Each choice has a different failure mode (release risks a late double-spend if the call actually lands after all; commit-at-worst-case risks under-utilizing real budget for cheap calls that were merely slow).
- Is there a reaper that reconciles zombie reservations against a final state read, or does every reservation live or die solely by its own call's local timeout handler?
- What happens to `COST_COMMITTED`'s `committed_total`/`budget_remaining` (which §5 requires to be exact, never estimated) when a reservation resolves this way — is a released-without-charge reservation logged at all, so the evidence stream shows *why* budget_remaining moved without a corresponding real cost?

## Suggested direction (not implementation — flagging the decision that's missing)

Define an explicit third resolution state beyond "committed" and "still reserved": a timed-out reservation must be actively expired by the governor (not passively ignored), releasing its capacity, and must emit an evidence event recording that the release happened with unknown real-world cost — so a human reading the ledger can distinguish "we spent this" from "we don't know and gave up waiting."
