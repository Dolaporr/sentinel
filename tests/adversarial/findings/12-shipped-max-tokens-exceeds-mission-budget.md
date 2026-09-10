# Implementation finding: the shipped driver's own `max_tokens` makes the worst-case reservation exceed the entire mission budget — no step can ever be admitted

**Target:** [`scripts/d2-race.ts`](../../../scripts/d2-race.ts) (`sharedStep`, [d2-race.ts:24](../../../scripts/d2-race.ts#L24)) combined with the reservation formula in [`src/governor/governor.ts:36-37`](../../../src/governor/governor.ts#L36-L37)
**Commit reviewed:** `8b875ec`
**Severity:** Critical. This isn't a subtle edge case — running the deliverable's own required command (`npm run d2:race`, the exact command §8's "definition of done" names) reproduces it on the very first call, every time.

## The bug

The worst-case formula is, correctly per spec:

```ts
const baseWorstCase = (request.inputTokens * price.inputPerMillionUsd + request.maxTokens * price.outputPerMillionUsd) / 1_000_000;
const amountUsd = round(baseWorstCase * this.config.reservationSafetyMultiplier);
```

`scripts/d2-race.ts` sets up the actual mission step with `maxTokens: 1_000_000` ([d2-race.ts:24](../../../scripts/d2-race.ts#L24)) against the priced model `openai/gpt-4.1-mini` (`outputPerMillionUsd: 1.6`, [d2-race.ts:16](../../../scripts/d2-race.ts#L16)) and a `1.25` safety multiplier. Plugging in:

```
baseWorstCase = (128 × 0.4 + 1,000,000 × 1.6) / 1,000,000 = 1.6000512
amountUsd     = 1.6000512 × 1.25 = 2.000064
```

**One single step's worst-case reservation is $2.00** — twice the $1.00 per-agent mission budget `SENTINEL_D2_RUNNER.md` §6 specifies, and more than two-thirds of the entire $3.00 session ceiling that `d2-race.ts` actually configures as its shared budget (`sessionBudgetUsd`, capped at 3, [d2-race.ts:5-8](../../../scripts/d2-race.ts#L5-L8)). Since the mission (§3) requires multiple tool calls per agent — a search, at least three fetches, and a synthesis step — and each of those calls needs a comparably generous `max_tokens` ceiling for genuinely variable-length real output, **no realistic multi-step mission can ever fit**, and as configured, not even a *second* call of any kind can fit once the first $2.00 reservation is outstanding.

## Reproduction: running the shipped deliverable command itself

```bash
npm run d2:race
```

Actual output (abbreviated):

```json
{
  "results": [
    { "completed": false, "outputs": [{ "stepId": "final-synthesis", "text": "offline fixture response" }], "refusal": "QUARANTINED" },
    { "completed": false, "outputs": [], "refusal": "BUDGET_EXCEEDED" }
  ],
  "governor": { "committedExact": 0.0000196, "committedEstimated": 0, "reservedTotal": 0, "budgetUsd": 3, "quarantined": true, "reservations": {} }
}
```

Both agents finish `completed: false`. `watched-a`'s single step actually dispatched, actually reconciled at its true real cost ($0.0000196 — matching Day 1's own live-verified spend figure), with zero errors and zero over-reservation — and it *still* reports failure, because its $2.00 reservation alone left only $1.00 of the shared $3.00 budget, `watched-b`'s identically-sized reservation attempt for its own first step was refused `BUDGET_EXCEEDED`, and (per [finding 13](13-shared-governor-quarantine-conflates-refusal-with-integrity-violation.md)) that ordinary refusal quarantined the whole shared governor, which then retroactively downgraded `watched-a`'s own genuinely-successful completion to `QUARANTINED_UNPRODUCTIVE`.

Every one of these outcomes traces back to one number: `maxTokens: 1_000_000` on a step priced at $1.60/million output tokens is a $1.60+ reservation before any real work happens, against a $1.00-$3.00 budget.

## Why this matters

`SENTINEL_D2_RUNNER.md` §8's definition of done is: *"One command produces a run where the naked agent and the Sentinel agent visibly diverge on the same mission, with both JSONL streams written and the sample fixture committed. The concurrency test passes."* Running that one command today produces two agents that both fail — not "the naked one dies, the Sentinel one finishes and returns change" (§0), but "both refuse before real work can happen." The governor's admission math is doing exactly what it's supposed to do here — refusing correctly given the inputs — but the inputs it's being fed by the driver script make success structurally unreachable.

## Suggested direction (not implementation)

`max_tokens` needs to be sized per step to something the mission's own budget can actually absorb (a few thousand tokens for tool-call turns, a larger but still budget-aware ceiling for the final synthesis step only — consistent with §4's own two-tier cheap/escalate model, which this single flat 1,000,000 figure doesn't reflect at all). This also needs a sanity check somewhere in the admission path: a worst-case reservation that consumes a large fraction of the *entire* mission budget on a single step is very likely a misconfiguration, not a legitimate one-shot spend, and arguably deserves its own refusal reason distinct from ordinary `BUDGET_EXCEEDED` so it's diagnosable at a glance rather than discovered by reading `raw.base_worst_case_usd` out of the ledger after the fact.
