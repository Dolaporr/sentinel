# SYNTHETIC FIXTURE — NOT A REAL DESIGN DOCUMENT

> This document is fabricated test material for the Sentinel D2 mission. It exists so the
> agents have real text to read instead of pretending to fetch pages they have no tool for.
> Nothing in it describes a real company, product, or system. Do not cite it as fact.

## Design memo: where a spend ceiling can sit, and what each position costs you

**Status:** synthetic / illustrative
**Audience:** platform engineers building cost controls around metered model APIs

### The question

Given a metered API where each call costs a variable amount that is only known after the call
returns, where do you put the control that stops you from spending more than you intended?

There are four candidate positions. They are not equivalent, and three of them fail under
conditions that occur routinely in production.

### Position A: provider-side quota

The provider enforces a hard ceiling and rejects requests past it.

**Strengths.** Authoritative. Cannot be bypassed by a buggy client. Requires no correctness on
the caller's part. If available, this is strictly the best option and everything below is a
workaround for its absence.

**Weaknesses.** Frequently unavailable. Many metered APIs expose no per-key, per-period, or
per-workload cap at all — the account balance is the only ceiling, and the only containment
action is credential revocation. Where quotas do exist they are often account-wide, so a single
runaway workload consumes the quota belonging to every other workload sharing the account.

**When it fails.** It doesn't, when it exists. The failure mode is its absence.

### Position B: post-hoc monitor

A separate process polls a usage or balance endpoint on an interval and takes action —
alerting, revoking, disabling — when reported spend crosses a threshold.

**Strengths.** Easy to bolt on. Requires no changes to the calling code. Works across
heterogeneous callers, including ones you don't control.

**Weaknesses.** Structurally unable to prevent the spend it detects. Three independent lags
compound: the polling interval, the provider's telemetry lag, and the round trip of whatever
containment action the monitor takes. A monitor polling every 60 seconds against telemetry that
trails by 90 seconds, taking a containment action that itself requires a round trip, is
operating on a picture of the world that is minutes old.

**When it fails.** Whenever spend rate is high relative to the detection interval. A caller
issuing concurrent requests can spend an arbitrary amount inside a single polling window; the
monitor's first observation arrives after the money is gone. Concurrency makes this worse
without bound: the monitor's detect-decide-act path is serial, while the caller's spend path is
not.

### Position C: post-hoc reconciliation in the caller

The caller tracks its own spend by summing the actual cost of each call after it returns, and
stops once the running total crosses a threshold.

**Strengths.** No dependence on provider telemetry. Accurate — it sums real billed costs rather
than estimates. Simple to implement.

**Weaknesses.** The check happens after the call. The threshold can only be crossed, never
approached, because the caller learns a call's cost by paying for it. Overshoot is bounded by
the cost of a single call, which is fine when calls are uniform and cheap and catastrophic when
one call can cost a large fraction of the budget.

**When it fails.** When per-call cost variance is high. A caller with $5 remaining that
dispatches a call which turns out to cost $400 has already lost. Nothing in this design could
have prevented it, because the design's entire information source is the invoice.

### Position D: pre-dispatch admission control in the caller

Before dispatching, the caller computes an upper bound on what the call could cost, checks that
bound against remaining budget, and refuses to dispatch if it does not fit. On return, it
reconciles the reservation against actual billed cost.

**Strengths.** The only position that can refuse a call it cannot afford *before* incurring the
cost. Requires no provider cooperation, no telemetry, and no network round trip to make the
decision — the check is local and synchronous, so it cannot be outrun by concurrency the way a
monitor can.

**Weaknesses.** Correctness depends entirely on the upper bound being a genuine upper bound. Two
inputs determine it: the price table and the caller-supplied output ceiling. If either is wrong
in the optimistic direction, the control silently under-reserves and the guarantee evaporates
while every individual admission check still appears to pass.

**When it fails.** When the bound is not sound. Specifically: a stale price table that
under-prices a model; an output ceiling parameter the provider does not strictly enforce;
billing categories the bound does not model, such as reasoning tokens billed separately from
the visible completion; or a declared input size that does not match the prompt actually sent.

### The reservation and the estimate

Position D requires holding a reservation between admission and reconciliation. This introduces
its own failure surface, most of which is bookkeeping rather than money:

- A call that never returns holds its reservation indefinitely unless something actively expires
  it. Over time these phantom reservations consume the budget on paper while no money has moved,
  and the caller refuses work it could in fact afford.
- A response that arrives without cost information cannot be reconciled exactly. The safe
  resolution is to commit the reservation's upper bound rather than zero, and to mark the
  committed figure as an estimate rather than a measurement, so that downstream consumers can
  tell which numbers are billed fact and which are a safety margin.
- Two concurrent attempts at the same logical unit of work can each be admitted independently
  if admission is keyed only on attempt identity and not on the work being attempted. Both then
  dispatch, and the same task is paid for twice.

### On the size of the margin

A sound upper bound will always exceed real cost, because the output ceiling is a ceiling and
real completions land beneath it. This is correct and should not be engineered away.

What matters is the *ratio*. A bound that exceeds observed cost by a factor of two is a
defensible safety margin. A bound that exceeds it by a factor of twenty is not a margin, it is a
miscalibration, and it will refuse affordable work while producing budget reports that bear no
relationship to what the workload actually costs. The remedy is to correct the inputs — the
declared input size, the output ceiling, the price table — not to shrink the multiplier applied
to a bound whose inputs are wrong. Shrinking the multiplier makes the ratio look better while
making the bound less sound, which is precisely backwards.
