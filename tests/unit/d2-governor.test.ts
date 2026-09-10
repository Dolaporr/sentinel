import assert from "node:assert/strict";
import { BudgetGovernor } from "../../src/governor/governor.js";
import { ReservationLedger } from "../../src/governor/ledger.js";
import { SharedWorker } from "../../src/worker/shared-worker.js";

const prices = { "test/cheap": { inputPerMillionUsd: 0, outputPerMillionUsd: 1, verifiedAt: "2026-09-08T00:00:00.000Z" } };

function makeGovernor(budgetUsd = 3, ttlMs = 100) {
  const ledger = new ReservationLedger();
  return { ledger, governor: new BudgetGovernor({ budgetUsd, reservationTtlMs: ttlMs, reservationSafetyMultiplier: 1.25, maxStepBudgetFraction: 1, prices }, ledger) };
}

async function testConcurrentAdmission(): Promise<void> {
  const { governor } = makeGovernor();
  const results = await Promise.all([...Array(20)].map((_, index) => governor.reserve({
    attemptId: `fresh-${index}`, logicalCallId: `fresh-${index}`, model: "test/cheap", inputTokens: 0, maxTokens: 1_000_000, nowMs: 0
  })));
  const admitted = results.filter((result) => result.admitted);
  assert.equal(admitted.length, 2, "two $1.25 reservations fit within the $3.00 ceiling");
  assert.equal(governor.snapshot().reservedTotal, 2.5);
  assert.ok(governor.snapshot().reservedTotal <= 3);
}

async function testRetryReleaseRace(): Promise<void> {
  const { governor, ledger } = makeGovernor();
  const first = await governor.reserve({ attemptId: "attempt-a", logicalCallId: "logical-a", model: "test/cheap", inputTokens: 0, maxTokens: 1_000_000, nowMs: 0 });
  assert.ok(first.admitted);
  const [, retry] = await Promise.all([
    governor.expire(101),
    governor.reserve({ attemptId: "attempt-b", logicalCallId: "logical-a", model: "test/cheap", inputTokens: 0, maxTokens: 1_000_000, nowMs: 101 })
  ]);
  assert.ok(retry.admitted, "the retry is admitted only after the original reservation expires");
  assert.equal(governor.snapshot().reservedTotal, 1.25, "the expired reservation cannot overlap the retry");
  assert.equal(await governor.commitExact("attempt-a", 0.1), false, "late original result cannot reconcile into the retry");
  assert.equal(governor.snapshot().reservedTotal, 1.25, "late result cannot change another attempt's reservation");
  assert.equal(ledger.count("RESERVATION_EXPIRED"), 1);
  assert.equal(ledger.count("LATE_RESULT_REJECTED"), 1);
}

async function testEstimatedAndUnknownPrice(): Promise<void> {
  const { governor, ledger } = makeGovernor();
  let calls = 0;
  const worker = new SharedWorker(governor, { complete: async () => { calls += 1; return { text: "partial" }; } }, "sentinel");
  const result = await worker.run([{ id: "missing", model: "test/cheap", prompt: "x", inputTokens: 0, maxTokens: 1_000_000 }]);
  assert.equal(result.completed, true);
  assert.equal(governor.snapshot().committedEstimated, 0.0000025, "missing usage estimates from observed output, not full reservation");
  assert.equal(governor.snapshot().committedExact, 0);
  assert.equal(ledger.count("COST_COMMITTED"), 1);
  assert.equal(ledger.all().find((event) => event.event === "COST_COMMITTED")?.cost_source, "estimated");

  const { governor: refusalGovernor, ledger: refusalLedger } = makeGovernor();
  const blocked = new SharedWorker(refusalGovernor, { complete: async () => { calls += 1; return { text: "should not dispatch", usage: { cost: 0 } }; } }, "sentinel");
  const refused = await blocked.run([{ id: "unpriced", model: "unknown/model", prompt: "x", inputTokens: 0, maxTokens: 1 }]);
  assert.equal(refused.completed, false);
  assert.equal(refused.refusal, "MODEL_UNPRICED");
  assert.equal(calls, 1, "unpriced models are refused before transport dispatch");
  assert.equal(refusalLedger.count("QUARANTINED_UNPRODUCTIVE"), 1);
  assert.equal(refusalLedger.count("MISSION_COMPLETE"), 0, "an unfinished mission with budget remaining is never completed");
}

async function testErroredStreamEstimates(): Promise<void> {
  const { governor } = makeGovernor();
  const worker = new SharedWorker(governor, { complete: async () => { throw new Error("stream cut"); } }, "sentinel");
  const result = await worker.run([{ id: "cut", model: "test/cheap", prompt: "x", inputTokens: 0, maxTokens: 1_000_000 }]);
  assert.equal(result.completed, false);
  assert.equal(governor.snapshot().committedEstimated, 1.25, "cut stream commits estimated reservation");
  assert.equal(governor.snapshot().reservedTotal, 0, "error does not leave a phantom reservation");
}

async function testLogicalCallSingleFlight(): Promise<void> {
  const { governor } = makeGovernor();
  const first = await governor.reserve({ attemptId: "original", logicalCallId: "same-work", model: "test/cheap", inputTokens: 0, maxTokens: 1, nowMs: 0 });
  const retry = await governor.reserve({ attemptId: "retry", logicalCallId: "same-work", model: "test/cheap", inputTokens: 0, maxTokens: 1, nowMs: 1 });
  assert.ok(first.admitted);
  assert.deepEqual(retry, { admitted: false, reason: "LOGICAL_CALL_IN_FLIGHT" });
}

async function testTtlAndWorkerDeadline(): Promise<void> {
  const { governor, ledger } = makeGovernor(3, 30);
  const reservation = await governor.reserve({ attemptId: "late", logicalCallId: "late", model: "test/cheap", inputTokens: 0, maxTokens: 1, nowMs: 0 });
  assert.ok(reservation.admitted);
  assert.equal(await governor.commitExact("late", 0.1, 31), false, "commit checks elapsed time before accepting a result");
  assert.equal(ledger.count("RESERVATION_EXPIRED"), 1);

  const { governor: deadlineGovernor } = makeGovernor(3, 30);
  const worker = new SharedWorker(deadlineGovernor, { complete: async () => await new Promise<never>(() => {}) }, "deadline");
  const result = await worker.run([{ id: "hang", model: "test/cheap", prompt: "x", inputTokens: 0, maxTokens: 1 }]);
  assert.equal(result.completed, false, "worker deadline resolves a hung transport");
  assert.equal(deadlineGovernor.snapshot().reservedTotal, 0);
}

async function testStartupStepBudgetAssertion(): Promise<void> {
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({ budgetUsd: 1, reservationTtlMs: 100, reservationSafetyMultiplier: 1.25, maxStepBudgetFraction: 0.25, prices }, ledger);
  const worker = new SharedWorker(governor, { complete: async () => ({ text: "unused", usage: { cost: 0 } }) }, "bounded");
  await assert.rejects(worker.run([{ id: "oversized", model: "test/cheap", prompt: "x", inputTokens: 0, maxTokens: 1_000_000 }]), /mission-budget fraction/);
}

async function testGovernorIsolation(): Promise<void> {
  const { governor: leftGovernor, ledger: leftLedger } = makeGovernor(2);
  const { governor: rightGovernor, ledger: rightLedger } = makeGovernor(2);
  const transport = { complete: async () => ({ text: "ok", usage: { cost: 0.01 } }) };
  const step = { id: "final", model: "test/cheap", prompt: "x", inputTokens: 0, maxTokens: 1_000_000 };
  const [left, right] = await Promise.all([
    new SharedWorker(leftGovernor, transport, "left").run([step]),
    new SharedWorker(rightGovernor, transport, "right").run([step])
  ]);
  assert.equal(left.completed && right.completed, true, "each watched agent completes against its own governor");
  assert.equal(leftLedger.count("MISSION_COMPLETE"), 1);
  assert.equal(rightLedger.count("MISSION_COMPLETE"), 1);
}

await testConcurrentAdmission();
await testRetryReleaseRace();
await testEstimatedAndUnknownPrice();
await testErroredStreamEstimates();
await testLogicalCallSingleFlight();
await testTtlAndWorkerDeadline();
await testStartupStepBudgetAssertion();
await testGovernorIsolation();
console.log("D2 governor tests passed");
