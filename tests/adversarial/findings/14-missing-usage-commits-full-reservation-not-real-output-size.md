# Implementation finding: a missing `usage.cost` commits the full safety-multiplied reservation, with no relationship to how much was actually generated

**Target:** [`src/worker/shared-worker.ts:41-42`](../../../src/worker/shared-worker.ts#L41-L42), [`src/governor/governor.ts:85-94`](../../../src/governor/governor.ts#L85-L94) (`commitEstimated()`)
**Commit reviewed:** `8b875ec`
**Severity:** Medium on its own; compounds directly with [finding 12](12-shipped-max-tokens-exceeds-mission-budget.md) once `max_tokens` is sized down to something the mission budget can actually admit.

## What's correctly implemented (closing out the design review)

The design review's [finding 04](04-stream-cut-bills-money-the-ledger-never-sees.md) and [finding 05](05-missing-or-malformed-usage-field.md) flagged that the original spec had no defined behavior for a response with no readable cost, and recommended committing the worst-case estimate rather than silently defaulting to zero. That recommendation is implemented and works correctly:

```ts
if (typeof response.usage?.cost === "number") await this.governor.commitExact(admission.reservation.attemptId, response.usage.cost);
else await this.governor.commitEstimated(admission.reservation.attemptId, "missing_usage_cost");
```

and on a thrown error (a cut stream, a transport failure):

```ts
} catch (error) {
  await this.governor.commitEstimated(admission.reservation.attemptId, `transport_error:${error instanceof Error ? error.name : "unknown"}`);
```

Both paths commit via `commitEstimated()`, which books `reservation.amountUsd` — the full safety-multiplied worst-case — and tags the event `cost_source: "estimated"` ([governor.ts:90-91](../../../src/governor/governor.ts#L90-L91)), keeping it visibly distinct from a real, metered `"exact"` commit. `tests/unit/d2-governor.test.ts`'s `testErroredStreamEstimates` confirms this holds for a thrown error, and `testEstimatedAndUnknownPrice` confirms it for a missing field. **The exact-vs-estimated distinction the design review asked to verify is real and working as designed for both cases.**

## The residual bug

`commitEstimated()` takes no cost argument at all — it always books the full reservation amount, unconditionally:

```ts
async commitEstimated(attemptId: string, reason: string): Promise<boolean> {
  return this.atomic(async () => {
    const reservation = this.reservations.get(attemptId);
    if (!reservation || reservation.state !== "active") return this.rejectLate(...);
    this.closeReservation(reservation);
    this.committedEstimated = round(this.committedEstimated + reservation.amountUsd);
```

For a genuinely cut stream, that's the right conservative choice (finding 04's own recommendation — you can't know the real cost, so assume the worst). But `SharedWorker` routes a **successful call whose output is used** through the exact same path whenever `usage.cost` merely happens to be absent:

```ts
if (typeof response.usage?.cost === "number") await this.governor.commitExact(...);
else await this.governor.commitEstimated(admission.reservation.attemptId, "missing_usage_cost");
outputs.push({ stepId: step.id, text: response.text }); // the output is used either way
```

Nothing here looks at how much was actually generated — not `response.text.length`, not a token count, nothing. A one-sentence tool-call response and a response that used every one of its allotted `max_tokens` are billed identically whenever the cost field happens to be missing.

## Reproduction

[`missing_usage_bills_full_worst_case.ts`](../repro/missing_usage_bills_full_worst_case.ts), using the real `openai/gpt-4.1-mini` price table from `scripts/d2-race.ts` but with `max_tokens: 2,000` (small enough to actually be admitted — see finding 12 for why the driver's real `1,000,000` never gets this far):

```
max_tokens for this call: 2000
Reservation admitted at: $0.004064
Real response: a short tool-call string, well under 2,000 tokens, usage.cost absent.
Amount actually committed (as "estimated"): $0.004064
Worker result: completed=true

REPRO CONFIRMED: the commit equals the FULL worst-case reservation, not any function of what was
actually generated.
```

The committed amount ($0.004064) is identical to the full reservation, regardless of the fact that the real response was a handful of words.

## Why this matters

Once `max_tokens` is sized sensibly per [finding 12](12-shipped-max-tokens-exceeds-mission-budget.md)'s recommendation, this stops being dormant: a multi-step mission (§3: search, three fetches, synthesis) that hits even one ordinary missing-`usage` response mid-mission — plausible on intermediate tool-call turns, per the design review's [finding 05](05-missing-or-malformed-usage-field.md) — pays that step's *entire* worst-case ceiling regardless of how cheap the real call was, eating budget that should have been available for the mission's later, genuinely expensive steps (e.g. the escalated synthesis call). A mission that would easily fit its budget under real costs can still starve itself out on paper purely because of how conservatively a single ordinary telemetry gap is priced.

## Suggested direction (not implementation)

Where a real signal about actual output size is available even without `usage.cost` (e.g., `response.text.length`, or a token estimate derived from it), use it to compute a tighter — but still conservative — estimated commit instead of always defaulting to the full reservation. Where no such signal exists at all (a true cut stream with no partial content), falling back to the full worst-case remains the right fail-closed choice; the bug is treating "cost unknown for an otherwise-normal, content-bearing response" identically to "cost unknown because nothing came back at all."
