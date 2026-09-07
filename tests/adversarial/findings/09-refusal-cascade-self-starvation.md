# Design finding: a sequence of refusals can deadlock the agent into ending the mission while holding budget it never spent

**Target:** `SENTINEL_D2_RUNNER.md` §4 ("Refusal. When a call is refused, the agent records why and continues with a cheaper path or ends the mission cleanly. Refusal is not a crash.") and §4's loop-detection rule.
**Status:** design review — no `src/governor/` or `src/worker/` code exists yet.
**Severity:** High. This is the direct answer to "can a sequence of refusals deadlock the agent into doing nothing while holding budget" — yes, and the spec's own loop-detector makes the failure *look* handled without actually resolving it.

## The gap

§4 gives refusal exactly two exits: "a cheaper path" or "ends the mission cleanly." Neither is well-defined enough to guarantee termination is actually reachable and actually correct:

**"A cheaper path" isn't guaranteed to exist.** §4's model routing is two-tier: cheap by default, escalate only on a hardcoded condition (e.g., final synthesis). If the *cheap* model's worst-case reservation is itself refused, there is no cheaper tier below it to fall back to — "cheaper path" silently means "no path" for exactly the refusals that matter most (refusals happen because budget is tight, and the cheap tier is already the cheapest option). The spec doesn't say what the agent does when the cheapest available call is still refused: retry the same call (feeding the loop detector), skip that step of the mission (risking an incomplete/wrong summary that still reports `MISSION_COMPLETE`), or terminate.

**Phantom scarcity from findings 03/04/05/08 makes this worse, not just present.** The refusal in step 2 of §2 fires on `committed + reserved + worst_case > budget`. If `reserved` includes zombie reservations that were never released (finding 03), or `committed` is missing real spend that should have reduced `budget_remaining` faster and made an earlier refusal correct while this one is now wrong in the other direction — either way, the number the refusal decision is based on can be stale relative to real spend well before real money runs out. **The agent can be refused into ending the mission while a meaningful fraction of its real $1.00 budget was never actually spent** — the literal deadlock the question asks about: doing nothing, while holding budget.

**The loop detector converts a stuck agent into a "handled" one without fixing anything.** §4's loop rule fires on identical tool-call name+args three times in a rolling window, landing the agent in `QUARANTINED`. Consider the natural failure sequence:

1. Agent's next planned step (say, `fetch_page` on the third source) is refused (§2's ceiling, possibly due to phantom reservation as above).
2. Per §4, the agent "continues with a cheaper path" — but fetching a specific page has no cheaper variant; the only retry available is the same call.
3. Agent retries the same `fetch_page` call. Refused again (nothing about the budget picture changed between attempts — no reservation was released, no time passed that would matter).
4. Same hash, three times in the rolling window → `LOOP_DETECTED` → `QUARANTINED`.

This resolves the *symptom* (an actual infinite loop of identical calls) without touching the *cause* (a refusal with no valid alternative action). `QUARANTINED` is listed in §4 as a destination but never defined as a state in §5's event list or described in terms of what happens next — does it write `MISSION_COMPLETE`? `AGENT_DIED`? Does it release its held reservations back before terminating, or do they simply vanish along with the process, leaving `committed_total` at whatever it was mid-mission? If quarantine doesn't explicitly reconcile and release, this is the same "budget held, nothing spent, nothing recorded as to why" outcome as finding 03, just reached via a different door.

## Why this specifically undermines the Day 2 demo goal

§0 frames the entire deliverable as "the naked one must be able to die. The Sentinel one must finish and return change." A Sentinel agent that reaches `QUARANTINED` via a refusal-then-loop-detection cascade, having spent (say) $0.30 of real money but reporting $0.70 of "unavailable" budget that was never actually spent, is neither of the two contracted outcomes: it didn't die (no real budget exhaustion, no crash), and it didn't finish with change (it stopped short of the mission, holding phantom-refused capacity). That's a third outcome the spec doesn't name and the demo isn't built to show — exactly the deadlock this review was asked to find.

## Concrete scenario

1. Mission needs three source fetches plus a synthesis call. Budget $1.00.
2. Two fetches succeed, reconciled at $0.15 real spend each ($0.30 committed).
3. A timeout on an intermediate call (finding 03) leaves a $0.35 zombie reservation. Real spend is still $0.30; the ledger's `committed + reserved` reads $0.65.
4. Third fetch's worst-case is $0.20. `0.65 + 0.20 = 0.85 ≤ 1.00` — admitted, fine so far.
5. Escalation for final synthesis needs $0.40 worst-case. `0.65 (still, if fetch 3 hasn't reconciled yet or reconciled at $0.18 real → 0.83) + 0.40 = 1.23 > 1.00` — refused, even though real spend to date is only ~$0.48 of the real $1.00 budget.
6. No cheaper tier exists for "the final synthesis step" by definition (§4 defines escalation as *the* path for that step). Agent retries, loop-detects, quarantines.
7. Final report (§10) shows the Sentinel agent "refused" its way to a stop with $0.52 of real budget untouched — a result that is easy to misread as "the governor worked perfectly" when it actually failed to finish a mission it had comfortably enough real money to complete.

## Question the design needs to answer before implementation

- Is `QUARANTINED` a terminal state that reconciles and releases all held reservations and emits a final accurate `committed_total`/`budget_remaining`, or does it just stop the loop and leave the ledger as-is?
- What is the agent's action when the cheapest available tier is itself refused and the step isn't optional (e.g., the mission's required synthesis step)? The spec needs a defined answer distinct from "retry until quarantined."
- Should refusal-driven termination be distinguishable in the evidence stream from real budget exhaustion — i.e., does `MISSION_COMPLETE`/`AGENT_DIED` (or a new terminal event) carry enough of the ledger's state (real committed spend vs. budget) that Day 2's report (§10, "the Sentinel agent's committed total and remaining budget") can't accidentally present a phantom-refusal stop as a successful, budget-respecting finish?

## Suggested direction (not implementation)

Before declaring `QUARANTINED` or any refusal-driven stop, reconcile all outstanding reservations against their real state (this requires finding 03's explicit release/expiry design to exist first) so the refusal that ends the mission is checked against real remaining budget, not paper-reserved budget — and make the terminal event explicitly report both numbers side by side, so a demo run can't silently pass off self-inflicted starvation as "the Sentinel agent finished and returned change."
