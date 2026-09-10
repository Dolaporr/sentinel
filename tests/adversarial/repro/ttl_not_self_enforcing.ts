// Adversarial repro for tests/adversarial/findings/10-reservation-ttl-not-self-enforcing.md
//
// src/governor/governor.ts only flips a Reservation's state from "active" to
// "expired" inside expireUnlocked(), which is invoked from two places:
// reserve() (as its first step) and the public expire(). commitExact() and
// commitEstimated() never call expireUnlocked() themselves — they only check
// the reservation's *current* `state` field.
//
// This repro shows that a reservation whose TTL has genuinely elapsed in wall
// time is STILL treated as a normal, on-time "active" reservation by
// commitExact() if nothing else happened to call reserve()/expire() on the
// same governor in the interim. The TTL is not a live deadline; it only takes
// effect as a side effect of unrelated governor activity.
//
// Run: npx tsx tests/adversarial/repro/ttl_not_self_enforcing.ts

import assert from "node:assert/strict";
import { BudgetGovernor } from "../../../src/governor/governor.js";
import { ReservationLedger } from "../../../src/governor/ledger.js";

const prices = { "test/cheap": { inputPerMillionUsd: 0, outputPerMillionUsd: 1, verifiedAt: "2026-09-08T00:00:00.000Z" } };
const ledger = new ReservationLedger();
const governor = new BudgetGovernor({ budgetUsd: 3, reservationTtlMs: 50, reservationSafetyMultiplier: 1, prices }, ledger);

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  const admission = await governor.reserve({ attemptId: "hung-call", logicalCallId: "hung-call", model: "test/cheap", inputTokens: 0, maxTokens: 1_000_000 });
  assert.ok(admission.admitted, "setup: reservation must be admitted");
  console.log(`Reservation created with TTL=50ms. Sleeping 200ms (4x the TTL) with NO intervening reserve()/expire() call...`);

  await sleep(200); // real wall-clock time now far exceeds reservationTtlMs=50ms

  // Nothing has called reserve() or expire() on this governor since the reservation
  // was created, so expireUnlocked() has never run. Per the governor's own code,
  // the reservation's `state` field is still "active" at this point.
  const committed = await governor.commitExact("hung-call", 0.5);

  console.log(`commitExact() after 4x-TTL wall-clock delay, with no intervening expire, returned: ${committed}`);
  console.log(`Ledger events: ${ledger.all().map((e) => e.event).join(", ")}`);
  console.log(`Final snapshot: committedExact=${governor.snapshot().committedExact}, reservedTotal=${governor.snapshot().reservedTotal}, quarantined=${governor.snapshot().quarantined}`);

  if (committed === true && ledger.count("RESERVATION_EXPIRED") === 0 && ledger.count("LATE_RESULT_REJECTED") === 0) {
    console.log("\nREPRO CONFIRMED: a call that hung for 4x its reservation's TTL was committed as a completely normal, on-time exact result.");
    console.log("The TTL never fired because nothing else touched this governor in the interim — it is not a live deadline.");
    process.exitCode = 0;
  } else {
    console.log("\nREPRO NOT REPRODUCED: the reservation was expired/rejected as expected.");
    process.exitCode = 1;
  }
}

main();
