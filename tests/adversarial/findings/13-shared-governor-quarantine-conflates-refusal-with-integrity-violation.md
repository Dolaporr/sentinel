# Implementation finding: one agent's ordinary, spec-sanctioned refusal quarantines its peer's already-successful mission on the shared governor

**Target:** [`src/governor/governor.ts`](../../../src/governor/governor.ts) (`finishMission()`, [governor.ts:98-110](../../../src/governor/governor.ts#L98-L110)), [`src/worker/shared-worker.ts`](../../../src/worker/shared-worker.ts) (`run()`, [shared-worker.ts:35-37](../../../src/worker/shared-worker.ts#L35-L37)), as wired together in [`scripts/d2-race.ts`](../../../scripts/d2-race.ts) (one `BudgetGovernor` shared by two `SharedWorker`s, [d2-race.ts:10-27](../../../scripts/d2-race.ts#L10-L27))
**Commit reviewed:** `8b875ec`
**Severity:** Critical. This is directly observable from the actual `npm run d2:race` output, not just a constructed edge case — see below.

## The bug

`quarantined` is a single boolean on the `BudgetGovernor` instance ([governor.ts:18](../../../src/governor/governor.ts#L18)), and `d2-race.ts` constructs exactly one `BudgetGovernor` shared by both `watched-a` and `watched-b` ([d2-race.ts:10-27](../../../scripts/d2-race.ts#L10-L27)). Two very different kinds of event both set it:

- **Genuine integrity violations** — `commitExact()`'s `OVER_RESERVATION` path (real cost exceeded even the safety-padded reservation, [governor.ts:73-79](../../../src/governor/governor.ts#L73-L79)) and `rejectLate()`'s `LATE_RESULT_REJECTED` path (a result arrived for a reservation that's no longer active, [governor.ts:138-142](../../../src/governor/governor.ts#L138-L142)). These are legitimately alarming — someone's accounting doesn't match reality.
- **Ordinary, expected refusals** — any time `SharedWorker.run()`'s own admission is refused, it calls `this.governor.finishMission({ completed: false, reason: ... })` ([shared-worker.ts:36](../../../src/worker/shared-worker.ts#L36)), and `finishMission()` unconditionally sets `this.quarantined = true` whenever `completed` is false ([governor.ts:102](../../../src/governor/governor.ts#L102)). `SENTINEL_D2_RUNNER.md` §4 is explicit that this is supposed to be a benign outcome: *"Refusal is not a crash."*

Both land in the same global flag, and `reserve()` refuses **all future admissions for the whole governor** once it's set ([governor.ts:32](../../../src/governor/governor.ts#L32)). Worse, `finishMission()`'s own completion check re-evaluates `quarantined` at call time regardless of that caller's own track record:

```ts
const completed = input.completed && !this.quarantined;
```

So an agent that reserved correctly, dispatched successfully, and reconciled at its exact real cost with zero errors of its own can still have its own `finishMission({completed: true})` call downgraded to `QUARANTINED_UNPRODUCTIVE`, purely because a **different, unrelated caller's ordinary budget refusal** happened to set the flag first.

## Reproduction: this is what `npm run d2:race` actually produces today

```bash
npm run d2:race
```

```json
{
  "results": [
    { "completed": false, "outputs": [{ "stepId": "final-synthesis", "text": "offline fixture response" }], "refusal": "QUARANTINED" },
    { "completed": false, "outputs": [], "refusal": "BUDGET_EXCEEDED" }
  ],
  "governor": { "committedExact": 0.0000196, "quarantined": true }
}
```

Read the ledger sequence (full output captured while producing this finding): `watched-a` reserves ($2.00, see [finding 12](12-shipped-max-tokens-exceeds-mission-budget.md) for why it's that large), dispatches, and gets `COST_COMMITTED` at its **real, exact, correct cost of $0.0000196** — a completely clean, successful call. Separately, `watched-b` is refused `BUDGET_EXCEEDED` (there's no budget left after `watched-a`'s reservation) and its `SharedWorker` correctly calls `finishMission({completed:false})` per spec — this quarantines the governor. `watched-a`'s *own* `finishMission({completed:true})` call, made afterward, is now downgraded:

```json
{ "event": "QUARANTINED_UNPRODUCTIVE", "raw": { "reason": "all_steps_completed", "mission_completed": false, "completion_blocked_by_quarantine": true, "active_reservations": 0 } }
```

`reason: "all_steps_completed"` and `mission_completed: false` in the same event record the contradiction directly: this agent finished everything it set out to do, and is still reported as an unproductive quarantine.

## Isolated confirmation, controlling for ordering explicitly

[`peer_refusal_quarantines_successful_agent.ts`](../repro/peer_refusal_quarantines_successful_agent.ts) removes any doubt about whether this depends on `finding 12`'s specific numbers or on scheduling luck, by sequencing two fully-successful real calls for agent A (reserved, dispatched, reconciled exactly, zero errors) before agent B's ordinary refusal, and only then calling A's own `finishMission(completed:true)`:

```
Agent A: both steps reserved, dispatched, and reconciled at exact real cost. Zero errors. Zero over-reservations.
Governor after A's real work: committedExact=$1.2, quarantined=false

Agent B: its step admission = false (expected: false, BUDGET_EXCEEDED...)
Governor after B's ordinary refusal reports itself finished: quarantined=true

Agent A's OWN finishMission call (100% successful real work, zero errors) recorded: QUARANTINED_UNPRODUCTIVE
Final governor snapshot: quarantined=true

REPRO CONFIRMED: Agent A did everything right... and still gets reported as QUARANTINED_UNPRODUCTIVE,
solely because Agent B's unrelated, expected, spec-compliant refusal happened to be recorded first.
```

## Why this matters for the project's actual goal

`SENTINEL_D2_RUNNER.md` §0 frames the whole deliverable as a contrast: *"The naked one must be able to die. The Sentinel one must finish and return change."* As built, when two Sentinel-governed agents share one governor (exactly what `d2-race.ts` does), an entirely ordinary, individually-harmless refusal on one agent can make **both** agents report as failed — including the one that did nothing wrong and has money left over. `tests/unit/d2-governor.test.ts`'s `testSharedMissionCannotCompleteAfterPeerQuarantine` already asserts this exact behavior as intended ("a peer's unproductive quarantine blocks mission completion"), so this may be a deliberate design choice rather than an oversight — but if so, it conflates two things that should be distinguishable in the evidence and in the reported outcome: *"something is wrong with our accounting"* (over-reservation, late results — genuinely alarming, should halt everything) versus *"we simply ran out of shared budget, and one caller was told no"* (expected, survivable, and per §4 explicitly not supposed to look like a crash).

## Suggested direction (not implementation)

Separate the two conditions. Keep the hard, whole-governor lockout for actual integrity violations (`OVER_RESERVATION`, `LATE_RESULT_REJECTED`). For ordinary budget refusals, let the refused caller report its own honest outcome (`refused`) without forcing every other, already-successful caller on the same governor to retroactively report failure — a successful agent's own ledger events already say `mission_completed: true` where accurate; the shared flag shouldn't be able to override that after the fact for an event that already happened correctly.
