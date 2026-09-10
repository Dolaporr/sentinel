# Design finding: a stream cut mid-response is the one failure mode where real money is spent but the reservation scheme has no path to record it

**Target:** `SENTINEL_D2_RUNNER.md` §2, steps 3-5.
**Status:** design review — no `src/governor/` code exists yet.
**Severity:** Critical. Unlike the timeout case ([finding 03](03-reservation-held-forever-on-timeout.md)), this is a drift that *understates* real spend, which is the direction that actually breaks the hard-cap guarantee the whole scheme exists to provide.

## The gap

§2 defines exactly two clean outcomes for a dispatched call: it returns with `usage.cost` (step 4, reconcile), or it never returns and the reservation sits held (step 5). A cut stream is a third outcome the spec doesn't name, and it doesn't fit either bucket:

- It is not "never returns" — tokens were generated and (on a token-metered, streaming-billed gateway) very plausibly already charged to the account before the connection dropped, was reset, or the client aborted the read.
- It is not "returns with `usage.cost`" either, because the terminal message that normally carries the `usage` object is exactly the part that got cut off.

So whichever bucket an implementation forces this into, it's wrong:

- **Treated as "never returns" / timeout:** the reservation is held (per finding 03's already-unresolved handling) or eventually released. Either way, the *actual* dollar amount the gateway charged for the partial generation is never subtracted from budget and never appears in `committed_total`. The governor's picture of remaining budget is now higher than reality — the dangerous direction, since it means a subsequent admission check can approve a call that pushes real cumulative spend over the $1.00 mission budget (or the $3.00 daily cap in §6) without the governor ever seeing it coming.
- **Treated as a normal completed call with `usage.cost = 0`** (because there's no usage object to read): same outcome — the real partial cost silently vanishes from the ledger.

## Why this is worse than the missing-`usage`-field case

[Finding 05](05-missing-or-malformed-usage-field.md) covers a clean response that simply lacks a `usage` field. A stream cut is strictly worse because there the response is not just missing a field — it's missing *entirely*, and unlike a clean non-streaming error response (which plausibly means nothing was generated and nothing was billed), a mid-stream cut typically means partial generation *did* happen and, on usage-based billing, is exactly the case most likely to have already been metered server-side.

## Concrete scenario

1. Budget = $1.00, worst-case reservation for a large-output call = $0.60. Reservation: reserved=$0.60.
2. The gateway streams 40,000 of a possible 50,000 output tokens (real cost so far, say, $0.35), then the connection is reset (this is a live network gateway — `docs/DAY1_RESULT.md` already documents one call that didn't complete cleanly).
3. No terminal `usage` object ever arrives. The governor's only observation is "this call did not complete normally."
4. Whatever this resolves to (release, zero-cost commit, or held-forever per finding 03), the ledger never records $0.35 as spent.
5. `committed_total` after this event undercounts real cumulative spend by $0.35. Every subsequent admission decision in the mission is now working from a wrong number, in the unsafe direction — the opposite of the fail-closed guarantee steps 2 and 5 are meant to provide.

## Why this can't be waved off as rare

The mission (§3) explicitly requires large-context research summarization with variable-length model output and real tool use over a live gateway that this project's own Day 1 findings already showed can stall or fail mid-call. A design that only has clean-success and clean-timeout as its two resolution states is missing the resolution state that its own prior findings say is the realistic one.

## Question the design needs to answer before implementation

- Is there any way to query the gateway for the actual metered cost of a call that the client itself couldn't read to completion (an out-of-band cost lookup, independent of the response stream)? If Orbio exposes nothing like this (nothing in `docs/MCP_SURFACE.md` suggests it does), the governor structurally cannot know the true cost of a cut stream, and the design must say so explicitly rather than silently defaulting to zero.
- If no true cost is recoverable, does the governor commit the *worst-case estimate* instead of the unknown real cost for a cut stream, deliberately trading "possibly overcounts" for "never undercounts"? That's the only direction consistent with fail-closed, but §5 says `COST_COMMITTED`'s numbers "must be exact and never estimated" — this scenario is a direct contradiction the spec doesn't resolve: there is no exact number to commit, and refusing to estimate is exactly what silently loses the spend.

## Suggested direction (not implementation)

Treat a cut stream as its own reconciliation outcome, distinct from both success and timeout, and resolve the exactness-vs-fail-closed conflict explicitly in one direction: commit the worst-case reservation amount (not zero, not "still pending") whenever a call's true cost cannot be determined, and mark that `COST_COMMITTED` event as estimated in its `raw` payload so the evidence stream is honest about which numbers are metered fact and which are a safety-margin guess.
