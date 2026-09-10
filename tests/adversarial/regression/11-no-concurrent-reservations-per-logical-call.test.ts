// Proves the fix for tests/adversarial/findings/11-no-single-flight-per-logical-call.md
//
// Property under test: reserve() must not admit a second, independently-active
// reservation for a logicalCallId that already has one active reservation.
// Two attempts sharing a logicalCallId are, by definition, retries of the same
// piece of work — admitting both at once opens the door to a real double-
// dispatch/double-spend for what the mission model treats as a single step.
//
// This is a black-box contract check: it only asserts the second reservation
// is refused, not any particular refusal reason string, so it doesn't overfit
// to one implementation's naming choice.
//
// RED today (main @ 8b875ec): reserve()'s only dedupe check is keyed on
// attemptId; it never inspects logicalCallId, so a second attempt for the
// same logical call is admitted (and later reconciles) exactly like an
// unrelated call would.
//
// Run: npx tsx tests/adversarial/regression/11-no-concurrent-reservations-per-logical-call.test.ts

import assert from "node:assert/strict";
import { BudgetGovernor } from "../../../src/governor/governor.js";
import { ReservationLedger } from "../../../src/governor/ledger.js";

const prices = { "test/cheap": { inputPerMillionUsd: 0, outputPerMillionUsd: 1, verifiedAt: "2026-09-08T00:00:00.000Z" } };

async function main(): Promise<void> {
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({ budgetUsd: 3, reservationTtlMs: 10_000, reservationSafetyMultiplier: 1, prices }, ledger);

  // Real clock throughout (no synthetic nowMs override) — matching how SharedWorker
  // actually calls the governor, and avoiding any mismatch against a fix that makes
  // commitExact()/commitEstimated() reconcile elapsed real time (finding 10's fix).
  const original = await governor.reserve({
    attemptId: "attempt-original", logicalCallId: "research-step-2", model: "test/cheap", inputTokens: 0, maxTokens: 500_000
  });
  assert.ok(original.admitted, "setup: the original attempt must be admitted");

  // The original hasn't expired (TTL=10s, and no real time has meaningfully passed)
  // and hasn't errored — a second attempt for the SAME logical call arrives while it's still active.
  const concurrentRetry = await governor.reserve({
    attemptId: "attempt-retry", logicalCallId: "research-step-2", model: "test/cheap", inputTokens: 0, maxTokens: 500_000
  });

  assert.equal(
    concurrentRetry.admitted,
    false,
    "a second reservation for the same logicalCallId, while the first is still active and unexpired, must be " +
    "refused — admitting both risks a real double-dispatch for one logical step. " +
    `Got: ${JSON.stringify(concurrentRetry)}`
  );

  // The original itself must be entirely unaffected by the refused retry.
  const originalCommitted = await governor.commitExact("attempt-original", 0.05);
  assert.equal(originalCommitted, true, "the original attempt must still reconcile normally after the concurrent retry was refused");
  assert.equal(governor.snapshot().committedExact, 0.05, "exactly one call's worth of real spend should exist for this logical step");

  console.log("PASS: a concurrent reservation for an already-active logical call is refused, and the original still reconciles normally.");
}

main();
