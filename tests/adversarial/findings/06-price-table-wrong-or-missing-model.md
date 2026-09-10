# Design finding: the entire ceiling rests on price-table accuracy, and the spec has no defined behavior for a wrong or missing entry

**Target:** `SENTINEL_D2_RUNNER.md` §2 ("Maintain a hardcoded price table... Fetch it from `/api/v1/models` once at startup if that endpoint works... fall back to the table if not.")
**Status:** design review — no `src/governor/prices.ts` exists yet.
**Severity:** Critical. This is the load-bearing assumption for everything else in §2 — step 1 explicitly says "the ceiling is knowable" *because* `max_tokens` is set by us. That claim is only true if the price multiplied by that ceiling is also correct.

## The gap

Two distinct failure shapes are folded into one line of the spec, and neither has defined behavior:

**1. Missing model.** If a model the agent routes to (cheap default, or the escalated model from §4) isn't in the hardcoded table, and the startup fetch from `/api/v1/models` either wasn't attempted, failed, or returned a shape the code didn't expect to parse — what does the worst-case calculation in step 1 produce? There are only bad options:
   - Throw / refuse the call outright for an unpriced model. Safe, but not specified, and if the escalation path in §4 (`MODEL_ESCALATED`) routes to a model that's missing from the table, the mission fails at the one point it was trying to spend more deliberately, and there is no defined recovery.
   - Default to $0 or skip the reservation. Turns the "hard cap" into no cap at all for that call — the exact failure this whole scheme exists to prevent, silently reintroduced through a table gap.
   - Default to some other model's price as a stand-in. Wrong in an unbounded direction depending on which models are conflated (a cheap-model price applied to an expensive model's real cost is the dangerous direction: worst-case estimate looks affordable, real cost isn't).

**2. Wrong (stale) price for a known model.** Providers change prices. If the hardcoded table in `src/governor/prices.ts` drifts from what the gateway actually bills — and the spec's own fallback design means the table is used *whenever* the live `/api/v1/models` fetch "doesn't work," which includes it silently returning stale-but-parseable data, not just hard failures — the worst-case estimate in step 1 is computed against a number that no longer matches reality. If the table *underprices* a model, every admission decision for that model is wrong in the unsafe direction, and it's wrong systematically (every call to that model, not a one-off), and it's only caught retroactively when `usage.cost` is reconciled in step 4 — by which point the money is already spent.

## Why this compounds with the other findings instead of being independent

This is what makes it the most severe finding in the set: [findings 03-05](03-reservation-held-forever-on-timeout.md) are about individual calls drifting from the ledger. A price-table error is systematic — it silently miscalibrates the ceiling for *every* call to that model for the entire mission (or the entire day, across both agents, against the shared $3.00 cap in §6), and it fails exactly the way the Day 1 adversarial finding already proved is fatal: the ceiling looks like it's holding (every individual admission check passes cleanly) right up until reconciliation reveals it wasn't holding at all. A stale price table is a slow-motion version of the 313ms concurrent drain — the failure isn't a burst of unchecked calls, it's every call being individually "checked" against the wrong number.

## Concrete scenario

1. `src/governor/prices.ts` has the escalation-tier model priced at last week's rate. The provider raised output pricing 20% since.
2. `/api/v1/models` either isn't implemented on this gateway (plausible — it's speculative in the spec, not verified against the live gateway the way `orbio_get_balance`/`orbio_get_key_status` were verified in `docs/MCP_SURFACE.md`) or returns something the startup code doesn't handle, so the stale hardcoded table is used for the whole run.
3. Every escalated call's worst-case reservation is admitted based on the old, lower price. Every one is individually "safe" by the governor's own logic.
4. Real cumulative spend, reconciled call-by-call, tracks 20% ahead of `committed_total` throughout the mission for every escalated call.
5. Nothing in the design catches this class of error until either the mission budget or the $3.00 daily cap (§6) is blown by real spend that the governor's own admission checks never saw coming, because they were computed correctly against the wrong price.

## Question the design needs to answer before implementation

- Has `/api/v1/models` actually been verified against the live gateway (the way `orbio_get_balance` and `orbio_get_key_status` were verified for Day 1), or is it assumed to exist? `docs/MCP_SURFACE.md` documents exactly five verified live tools, and this endpoint isn't one of them.
- Is there a cross-check between the reserved worst-case and the reconciled actual cost per call, that raises an alarm (not just silently absorbs the difference) when they diverge by more than a small tolerance — so a mispriced table is caught on the *first* affected call instead of discovered only when a budget is unexpectedly exhausted?
- What happens on a call to a model with no table entry at all — is refusal-by-default (fail closed, per the project's stated philosophy) the specified behavior, or left to whoever implements `src/governor/prices.ts` to decide under deadline pressure?

## Suggested direction (not implementation)

Refuse any call to a model without a verified price entry — no stand-in, no zero-cost default — and treat every reconciled cost that exceeds its own reservation's worst-case estimate (which should never happen if the table and `max_tokens` are both honored) as a distinct alarm event, not a quiet update to `committed_total`. A price table that's wrong should be loud the first time it's wrong, not discovered by a blown budget at the end of the day.
