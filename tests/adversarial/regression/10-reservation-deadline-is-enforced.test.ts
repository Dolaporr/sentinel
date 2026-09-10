// Proves the fix for tests/adversarial/findings/10-reservation-ttl-not-self-enforcing.md
//
// Two properties under test, both at the actual call-path level (governor +
// SharedWorker), not just the governor's internal bookkeeping in isolation:
//
//  1. SharedWorker.run() must not hang forever on a transport call that never
//     settles — it must resolve within a bounded multiple of the reservation's
//     own TTL, one way or another (success, refusal, or a deadline failure).
//  2. A result that arrives after real wall-clock time has passed the TTL must
//     not be silently accepted as an on-time exact commit, regardless of
//     whether anything else happened to touch the governor in between.
//
// RED today (main @ 8b875ec): (1) worker.run() against a never-resolving
// transport does not resolve within 8x the TTL — nothing races the transport
// call against a deadline. (2) commitExact() never reconciles elapsed time
// against the reservation's expiry before accepting a result; only a
// coincidental reserve()/expire() call elsewhere would flip its state.
//
// Run: npx tsx tests/adversarial/regression/10-reservation-deadline-is-enforced.test.ts

import assert from "node:assert/strict";
import { BudgetGovernor } from "../../../src/governor/governor.js";
import { ReservationLedger } from "../../../src/governor/ledger.js";
import { SharedWorker } from "../../../src/worker/shared-worker.js";

const prices = { "test/cheap": { inputPerMillionUsd: 0, outputPerMillionUsd: 1, verifiedAt: "2026-09-08T00:00:00.000Z" } };

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function testWorkerDoesNotHangPastReservationTtl(): Promise<void> {
  const ttlMs = 50;
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({ budgetUsd: 3, reservationTtlMs: ttlMs, reservationSafetyMultiplier: 1, prices }, ledger);
  const neverResolvingTransport = { complete: () => new Promise<{ text: string; usage?: { cost?: number } }>(() => { /* hangs forever */ }) };
  const worker = new SharedWorker(governor, neverResolvingTransport, "hung-agent");

  const RACE_MS = ttlMs * 8;
  const raced = await Promise.race([
    worker.run([{ id: "step-1", model: "test/cheap", prompt: "x", inputTokens: 0, maxTokens: 1_000_000 }]).then((r) => ({ settled: "resolved" as const, value: r })),
    sleep(RACE_MS).then(() => ({ settled: "timed_out" as const, value: null }))
  ]);

  assert.equal(
    raced.settled,
    "resolved",
    `worker.run() must resolve within ${RACE_MS}ms (8x the reservation TTL of ${ttlMs}ms) when its transport call hangs forever. ` +
    `It is still pending, meaning nothing in the call path imposes a deadline on the transport call.`
  );
}

async function testLateExactCommitIsRejectedRegardlessOfInterveningActivity(): Promise<void> {
  const ttlMs = 50;
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({ budgetUsd: 3, reservationTtlMs: ttlMs, reservationSafetyMultiplier: 1, prices }, ledger);

  const admission = await governor.reserve({ attemptId: "hung-call", logicalCallId: "hung-call", model: "test/cheap", inputTokens: 0, maxTokens: 1_000_000 });
  assert.ok(admission.admitted, "setup: reservation must be admitted");

  // Real wall-clock time elapses well past the TTL, with NO other reserve()/expire()
  // call on this governor in between — deliberately isolating whether the reservation's
  // own expiry is self-enforcing, rather than only firing as a side effect of unrelated activity.
  await sleep(ttlMs * 4);

  const committed = await governor.commitExact("hung-call", 0.5);
  assert.equal(
    committed,
    false,
    "a result arriving 4x past its reservation's TTL, with no intervening reserve()/expire() call, must not be " +
    "accepted as a normal on-time exact commit — the TTL must be checked against real elapsed time at commit time."
  );
}

async function main(): Promise<void> {
  await testWorkerDoesNotHangPastReservationTtl();
  await testLateExactCommitIsRejectedRegardlessOfInterveningActivity();
  console.log("PASS: reservation deadlines are enforced both at the worker call-path level and at commit time.");
}

main();
