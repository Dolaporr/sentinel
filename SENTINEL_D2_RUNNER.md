# Sentinel Day 2 runner specification

**Status:** active. Dola authorized Day 2 implementation on 2026-09-08; the $3.00 live-session ceiling remains in force. The included race harness is offline-only.

## 1. Scope

Day 2 adds the watched two-agent runner and its shared budget governor. The governor is the admission authority: no model request is dispatched before it records a reservation.

## 2. Budget governor — binding rules

The following rules are mandatory. They are not fallbacks, best-effort behavior, or UI conventions.

### 2.1 Reservation lifecycle

- Every reservation has an immutable ID, amount, creation time, and hard expiry time (TTL).
- On TTL expiry, the governor releases the reservation amount exactly once and writes `RESERVATION_EXPIRED`, including the reservation ID and released amount. A reservation must never become a phantom debit.
- A late result identifies its original reservation ID. It may not reconcile into a released or reused reservation slot.

### 2.2 Exact and estimated commitments

- The ledger tracks `committed_exact` and `committed_estimated` separately. Admission uses their sum, plus all active reservations, plus the proposed reservation.
- A normal response with a readable `usage.cost` commits that value to `committed_exact` with `cost_source: "exact"`.
- A cut stream, errored stream, or dispatched call that returns without a readable `usage.cost` commits the reservation's safety-adjusted estimated cost to `committed_estimated` with `cost_source: "estimated"`. It is never silently released or treated as zero cost.
- The screen shows `committed_exact` as the exact figure and visibly flags every state where `committed_estimated > 0`. It must not present the combined amount as wholly exact.

### 2.3 Fail-closed pricing and reservations

- A request whose model has no verified price-table entry is refused before dispatch. There is no assumed price, zero-cost default, or permissive fallback.
- `max_tokens` is not accepted as a guaranteed bound on billed output. The reservation is the configured worst-case request cost multiplied by a configurable `reservation_safety_multiplier` greater than or equal to one.
- Each reservation event records the model price inputs, calculated worst case, and the `reservation_safety_multiplier` used.
- If an exact reconciled cost exceeds its reservation, emit a distinct over-reservation alarm event and quarantine further admissions until the discrepancy is resolved.

### 2.4 Concurrency and retry safety

- All admission, commit, expiry, and release transitions use one shared atomic critical section.
- The required concurrency suite covers both simultaneous fresh admissions and retry-versus-release races: an expiring original attempt, a retry for the same logical work, and a late original response. It must prove that capacity is not double-reserved, double-dispatched, or reconciled into another attempt's slot.

### 2.5 Terminal outcomes

- `MISSION_COMPLETE` is emitted only when the mission’s defined success condition is met.
- If a run ends with budget remaining and the mission unfinished, it emits `QUARANTINED_UNPRODUCTIVE`, never `MISSION_COMPLETE`.
- `QUARANTINED_UNPRODUCTIVE` includes the unfinished mission condition, `committed_exact`, `committed_estimated`, active/released reservation totals, and the reason for quarantine.

## 3. Origin

This amendment resolves adversarial findings 03–09 in `tests/adversarial/findings/`: reservation expiry, unmetered streams, missing usage, unknown prices, unsafe output bounds, retry/release races, and refusal-driven self-starvation.

## 4. Mission deviation — inlined corpus instead of live tools

**Recorded 2026-09-10. Approved deviation from the original mission definition.**

The original mission gave both agents `web_search` and `fetch_page` tools over a live topic. The
implemented mission does not. It reads a fixed corpus checked into `fixtures/corpus/`, inlined
into every prompt, and asks for extraction and synthesis over that text.

**Why.** The first live run exposed that the tools were never real. Steps declared 12,000 input
tokens and 24,000 output tokens while sending an eighty-token instruction to fetch a page the
model had no tool for; the model replied asking which search engine was meant. Two consequences:

- The worst-case reservation was computed against a prompt that did not exist, so the bound sat
  10–60× above billed cost. That refused `governed-expensive` after a single call while `naked`
  ran nineteen, which reads as an over-tuned governor rather than a fair comparison.
- No agent was doing the mission, so the recorded artifact demonstrated governance over an
  activity that was not happening.

**What changed.** The corpus is real text really present in the prompt, so declared input size is
derived from the assembled prompt at dispatch time rather than declared in a task definition and
left to drift. Output ceilings are set from observed completion lengths — the largest completion
in the first live run was 2,321 tokens — rather than round numbers. Sentinel's cheap routing caps
output only; it no longer clamps input, which would have left it reading a truncated corpus and
solving an easier problem than the agents it is compared against.

**What did not change.** The worst-case formula and the `reservation_safety_multiplier` are
untouched. A sound bound necessarily exceeds billed cost, because the ceiling is a ceiling and
completions land beneath it. The correction was to the bound's inputs, not to the margin applied
to it; discounting the multiplier toward observed cost would have reintroduced finding 07.

**Reproducibility.** A recorded artifact that depends on live web content cannot be verified by
anyone reading it later. The corpus is in the repository, so the run can be reproduced from a
clone. The corpus documents are clearly labelled synthetic fixtures and are not claims about the
world.
