// Adversarial repro for tests/adversarial/findings/13-shared-governor-quarantine-conflates-refusal-with-integrity-violation.md
//
// scripts/d2-race.ts constructs ONE BudgetGovernor and shares it between two
// SharedWorker instances. governor.ts's `quarantined` flag is global to the
// governor, and SharedWorker.run() sets it via finishMission({completed:false})
// whenever ITS OWN admission is refused (a normal, spec-sanctioned outcome per
// SENTINEL_D2_RUNNER.md §4: "Refusal is not a crash"). Once quarantined is
// true, ANY other in-progress worker's own eventual finishMission({completed:
// true}) call — even one with zero errors, zero over-reservations, and zero
// late results of its own — gets downgraded to QUARANTINED_UNPRODUCTIVE.
//
// This repro sequences the calls explicitly (no timing luck needed) to prove
// the mechanism: agent A does two fully successful, fully-reconciled real
// calls; agent B is refused for an ordinary, expected BUDGET_EXCEEDED reason;
// A's own finishMission call, made strictly after B's refusal, is downgraded
// despite A having done nothing wrong.
//
// Run: npx tsx tests/adversarial/repro/peer_refusal_quarantines_successful_agent.ts

import assert from "node:assert/strict";
import { BudgetGovernor } from "../../../src/governor/governor.js";
import { ReservationLedger } from "../../../src/governor/ledger.js";

const prices = { "test/cheap": { inputPerMillionUsd: 0, outputPerMillionUsd: 1, verifiedAt: "2026-09-08T00:00:00.000Z" } };

async function main(): Promise<void> {
  const ledger = new ReservationLedger();
  // Budget sized so agent A's two real calls (worst-case $0.60 each with a 1x
  // multiplier) fit exactly, leaving no room for agent B's step.
  const governor = new BudgetGovernor({ budgetUsd: 1.20, reservationTtlMs: 10_000, reservationSafetyMultiplier: 1, prices }, ledger);

  // --- Agent A: two steps, both genuinely successful, both reconciled at cost. ---
  const aStep1 = await governor.reserve({ attemptId: "a-1", logicalCallId: "a:step-1", model: "test/cheap", inputTokens: 0, maxTokens: 600_000, nowMs: 0 });
  assert.ok(aStep1.admitted, "setup: A step 1 must be admitted");
  const aStep1Committed = await governor.commitExact("a-1", 0.60);
  assert.ok(aStep1Committed);

  const aStep2 = await governor.reserve({ attemptId: "a-2", logicalCallId: "a:step-2", model: "test/cheap", inputTokens: 0, maxTokens: 600_000, nowMs: 1 });
  assert.ok(aStep2.admitted, "setup: A step 2 must be admitted");
  const aStep2Committed = await governor.commitExact("a-2", 0.60);
  assert.ok(aStep2Committed);

  console.log("Agent A: both steps reserved, dispatched, and reconciled at exact real cost. Zero errors. Zero over-reservations.");
  console.log(`Governor after A's real work: committedExact=$${governor.snapshot().committedExact}, quarantined=${governor.snapshot().quarantined}`);

  // --- Agent B: its one step is refused. This is the SPEC-SANCTIONED "refusal
  // is not a crash" path (SENTINEL_D2_RUNNER.md §4) — B did nothing wrong either;
  // it simply arrived at a governor with no budget left. ---
  const bStep = await governor.reserve({ attemptId: "b-1", logicalCallId: "b:step-1", model: "test/cheap", inputTokens: 0, maxTokens: 600_000, nowMs: 2 });
  console.log(`\nAgent B: its step admission = ${bStep.admitted} (expected: false, BUDGET_EXCEEDED — this mirrors what SharedWorker.run() sees)`);
  assert.equal(bStep.admitted, false);

  // This is exactly what SharedWorker.run() does on a refusal (shared-worker.ts:36).
  await governor.finishMission({ completed: false, reason: "admission_refused:BUDGET_EXCEEDED" });
  console.log(`Governor after B's ordinary refusal reports itself finished: quarantined=${governor.snapshot().quarantined}`);

  // --- Agent A now calls ITS OWN finishMission, strictly after B's refusal
  // above, exactly as SharedWorker.run() does at the end of its loop
  // (shared-worker.ts:50) once all of A's steps genuinely completed. ---
  await governor.finishMission({ completed: true, reason: "all_steps_completed" });
  const finalSnapshot = governor.snapshot();
  const aFinalEvent = ledger.all().filter((e) => e.event === "MISSION_COMPLETE" || e.event === "QUARANTINED_UNPRODUCTIVE").at(-1);

  console.log(`\nAgent A's OWN finishMission call (100% successful real work, zero errors) recorded: ${aFinalEvent?.event}`);
  console.log(`Final governor snapshot: quarantined=${finalSnapshot.quarantined}`);

  if (aFinalEvent?.event === "QUARANTINED_UNPRODUCTIVE") {
    console.log("\nREPRO CONFIRMED: Agent A did everything right — two real calls, dispatched within its own reservations,");
    console.log("reconciled exactly, zero integrity violations — and still gets reported as QUARANTINED_UNPRODUCTIVE,");
    console.log("solely because Agent B's unrelated, expected, spec-compliant refusal happened to be recorded first");
    console.log("on the SAME shared governor instance that scripts/d2-race.ts actually constructs for both agents.");
  } else {
    console.log("\nREPRO NOT REPRODUCED: A's completion was not downgraded.");
  }
}

main();
