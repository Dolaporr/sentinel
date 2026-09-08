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
