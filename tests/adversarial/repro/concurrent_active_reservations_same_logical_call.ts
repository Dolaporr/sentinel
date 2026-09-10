// Adversarial repro for tests/adversarial/findings/11-no-single-flight-per-logical-call.md
//
// governor.ts's DUPLICATE_ATTEMPT check in reserve() only compares the new
// request's attemptId against existing reservation keys (the reservations Map
// is keyed by attemptId). It never checks logicalCallId. So two different
// attempts for the SAME logical unit of work can both be admitted and both be
// "active" reservations at once, as long as neither has expired and there is
// enough budget for both — exactly the premature-retry-while-original-is-still-
// in-flight scenario the D2 spec review flagged as a real double-dispatch risk.
//
// Run: npx tsx tests/adversarial/repro/concurrent_active_reservations_same_logical_call.ts

import assert from "node:assert/strict";
import { BudgetGovernor } from "../../../src/governor/governor.js";
import { ReservationLedger } from "../../../src/governor/ledger.js";

const prices = { "test/cheap": { inputPerMillionUsd: 0, outputPerMillionUsd: 1, verifiedAt: "2026-09-08T00:00:00.000Z" } };
const ledger = new ReservationLedger();
const governor = new BudgetGovernor({ budgetUsd: 3, reservationTtlMs: 10_000, reservationSafetyMultiplier: 1, prices }, ledger);

async function main(): Promise<void> {
  const original = await governor.reserve({
    attemptId: "attempt-original", logicalCallId: "research-step-2", model: "test/cheap", inputTokens: 0, maxTokens: 500_000, nowMs: 0
  });
  assert.ok(original.admitted, "setup: original call must be admitted");
  console.log(`Original attempt for logicalCallId="research-step-2" admitted, reservedTotal=${governor.snapshot().reservedTotal}`);

  // The original hasn't timed out (TTL=10s, we're still at t=0) and hasn't errored.
  // An impatient caller (e.g. a worker-level retry issued because the call *feels*
  // slow, well before the governor's own TTL) retries with a fresh attemptId for
  // the SAME logical call.
  const retry = await governor.reserve({
    attemptId: "attempt-retry", logicalCallId: "research-step-2", model: "test/cheap", inputTokens: 0, maxTokens: 500_000, nowMs: 1
  });

  console.log(`Retry attempt for the SAME logicalCallId="research-step-2" (original still active, not expired): admitted=${retry.admitted}`);
  console.log(`reservedTotal after both: ${governor.snapshot().reservedTotal}`);

  if (retry.admitted) {
    console.log("\nREPRO CONFIRMED: two independently-active reservations exist for the same logical call at once.");
    console.log("If both attempts are actually dispatched to the gateway and both land, this is a real double-spend");
    console.log("for what the mission model treats as a single step — nothing in reserve() prevents it.");

    // Show the double-commit follows through end to end: both attempts can be
    // reconciled as real, distinct, successful spends.
    const originalCommitted = await governor.commitExact("attempt-original", 0.05);
    const retryCommitted = await governor.commitExact("attempt-retry", 0.05);
    console.log(`Both attempts independently reconciled as EXACT commits: original=${originalCommitted}, retry=${retryCommitted}`);
    console.log(`Total real committed spend for one logical step: $${governor.snapshot().committedExact} (should be one call's worth, not two)`);
  } else {
    console.log("\nREPRO NOT REPRODUCED: the governor refused the concurrent same-logical-call retry.");
  }
}

main();
