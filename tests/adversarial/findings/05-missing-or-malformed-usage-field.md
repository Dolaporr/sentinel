# Design finding: reconciliation has no defined behavior when a completed response carries no `usage` field

**Target:** `SENTINEL_D2_RUNNER.md` §2, step 4 ("Reconcile on return: release the reservation, commit the real `usage.cost`.")
**Status:** design review — no `src/governor/` code exists yet.
**Severity:** High. This is the ordinary-path version of finding [04](04-stream-cut-bills-money-the-ledger-never-sees.md)'s problem — no crash, no stream cut, just a clean response that doesn't carry the field the whole scheme is built to read.

## The gap

Step 4 assumes every completed call carries `usage.cost`. The Day 1 dependency note at the top of the spec says "`usage.cost` returned in every response body" was true for the calls Day 1 actually made — but Day 1 made exactly one kind of call (a single trivial completion) against one model. Day 2 introduces real tool use, web search, multiple models, and a cheap/expensive routing split (§4). None of the following are exotic:

- An error response (rate limit, model overload, content filter) that returns HTTP 200 with an error body and no `usage` object.
- A tool-calling turn where the model emits only tool calls and no completion `usage` is attached to that particular message (provider-dependent; usage is sometimes only attached to the final turn of a multi-turn tool-use exchange).
- A provider or model quietly omitting `usage` under partial outage, independent of any error being raised.

The spec's reconciliation step has exactly one documented input shape (`usage.cost` present) and zero documented behavior for any other shape.

## Why every plausible default is wrong in some direction

- **Commit `0`:** understates real spend if the gateway still charged something for the call (tool-call turns still consume input/output tokens even without a completion `usage` block attached). This is the same unsafe direction as finding 04 — `committed_total` drifts below reality, and the hard cap becomes soft.
- **Commit the worst-case estimate:** safe for the ceiling, but directly contradicts §5's requirement that `COST_COMMITTED`'s numbers "must be exact and never estimated" — the frontend would be displaying a guess labeled as fact.
- **Throw/treat as an error:** if this exception isn't specifically caught, it has the same effect as finding 03 — the reservation is never released, and the governor now believes that capacity is permanently spent. Worse, if this is a *recoverable* call (e.g., a tool-call turn mid-mission, not a failure), throwing here could tear down an otherwise-successful mission step over a missing telemetry field rather than a real error.

The spec doesn't pick one of these, which means whoever implements it will pick one under time pressure without the tradeoff being examined — precisely the situation this review exists to prevent.

## Concrete scenario

1. Agent dispatches a tool-use turn. Gateway returns 200 with tool calls and no `usage` field (common for intermediate turns on several providers' APIs).
2. Governor's reconcile step reads `response.usage.cost` — `undefined`.
3. If uncaught, `undefined.cost` (or equivalent) throws inside the reconcile path, which is exactly the "reservation never released" failure of finding 03, except now triggered by an entirely successful, billable call rather than a network fault.
4. If defensively coded as `usage?.cost ?? 0`, the call's real (possibly nonzero) cost is silently dropped from `committed_total`, and the mission proceeds believing it has more budget than it does.

## Question the design needs to answer before implementation

- Is `usage` actually guaranteed on every response type this mission will produce (including intermediate tool-call turns, not just final completions)? This needs verifying against the real gateway with the actual call shapes Day 2 uses, not assumed from Day 1's single trivial call.
- What is the one defined fallback when it's absent — and does that fallback get logged distinctly in the event's `raw` payload (e.g. `usage_missing: true`) so a missing-field silent-zero and a real-zero-cost call aren't indistinguishable in the evidence stream?

## Suggested direction (not implementation)

Pick the fail-closed default (commit at worst-case reservation, as in finding 04) for any response that completes without a readable `usage.cost`, and make that an explicitly logged, distinguishable condition rather than a silent fallback — the same resolution this review recommends for the stream-cut case, since both are instances of "the call finished (or seems to have) but we can't read what it cost."
