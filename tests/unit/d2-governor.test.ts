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
  // nowMs=150: past attempt-a's expiry (100) but before attempt-b's (201) -- isolates
  // "does a late result for the expired original corrupt the still-active retry" from
  // an unrelated real-clock sweep expiring the retry too.
  assert.equal(await governor.commitExact("attempt-a", 0.1, 150), false, "late original result cannot reconcile into the retry");
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
  // maxTokens=500_000 -> worst-case $0.625: over the 25% fraction limit ($0.25) but
  // under the full $1.00 budget, so this isolates the fraction guard specifically
  // instead of tripping the coarser "exceeds mission budget" check first.
  await assert.rejects(worker.run([{ id: "oversized", model: "test/cheap", prompt: "x", inputTokens: 0, maxTokens: 500_000 }]), /mission-budget fraction/);
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

function retentionGovernor(retentionMs: number, ledger = new ReservationLedger()) {
  return new BudgetGovernor({ budgetUsd: 1_000, reservationTtlMs: 100, reservationSafetyMultiplier: 1.25, maxStepBudgetFraction: 1, prices, resolvedRetentionMs: retentionMs }, ledger);
}
const step = (id: string, nowMs: number) => ({ attemptId: id, logicalCallId: id, model: "test/cheap", inputTokens: 0, maxTokens: 10, nowMs });

async function testResolvedReservationsAreBounded(): Promise<void> {
  const governor = retentionGovernor(1_000);
  for (let i = 0; i < 5_000; i++) {
    const admission = await governor.reserve(step(`a-${i}`, i));
    assert.ok(admission.admitted);
    assert.equal(await governor.commitExact(`a-${i}`, 0.000001, i), true);
  }
  const snap = governor.snapshot();
  assert.equal(snap.activeReservations, 0);
  assert.ok(snap.reservations.size <= 1_001, `resolved reservations are pruned past the window, kept ${snap.reservations.size}`);
  assert.ok(snap.reservations.size >= 999, "but everything inside the window is still remembered");
}

async function testDuplicateRefusedInsideRetention(): Promise<void> {
  const governor = retentionGovernor(1_000);
  assert.ok((await governor.reserve(step("dup", 0))).admitted);
  assert.equal(await governor.commitExact("dup", 0.000001, 1), true);
  const reuse = await governor.reserve(step("dup", 500));
  assert.equal(reuse.admitted ? null : reuse.reason, "DUPLICATE_ATTEMPT", "a resolved id cannot be reused while a late result for it could still arrive");
}

async function testLateResultAfterPruneStillQuarantines(): Promise<void> {
  const ledger = new ReservationLedger();
  const governor = retentionGovernor(1_000, ledger);
  assert.ok((await governor.reserve(step("late", 0))).admitted);
  await governor.expire(200);
  await governor.expire(5_000); // long past the window: "late" is forgotten
  assert.equal(governor.snapshot().reservations.has("late"), false);
  assert.equal(await governor.commitExact("late", 0.01, 5_001), false, "a forgotten id is rejected exactly like a resolved one");
  assert.equal(governor.snapshot().quarantined, true);
  assert.equal(ledger.count("LATE_RESULT_REJECTED"), 1);
}

async function testLogicalCallIndexReleasesOnResolve(): Promise<void> {
  const governor = retentionGovernor(1_000);
  assert.ok((await governor.reserve({ ...step("x-1", 0), logicalCallId: "x" })).admitted);
  const second = await governor.reserve({ ...step("x-2", 1), logicalCallId: "x" });
  assert.equal(second.admitted ? null : second.reason, "LOGICAL_CALL_IN_FLIGHT");
  await governor.commitExact("x-1", 0.000001, 2);
  assert.ok((await governor.reserve({ ...step("x-3", 3), logicalCallId: "x" })).admitted, "a retry is admitted once the first attempt resolves");
  await governor.expire(200);
  assert.ok((await governor.reserve({ ...step("x-4", 201), logicalCallId: "x" })).admitted, "and once it expires");
}

async function testAdmissionCostDoesNotGrowWithHistory(): Promise<void> {
  // Before bounded retention, every reserve() scanned every reservation ever
  // made: 50k calls was ~1.25e9 comparisons. Now it is bounded by what is in flight.
  const governor = retentionGovernor(1_000);
  const started = Date.now();
  for (let i = 0; i < 50_000; i++) {
    await governor.reserve(step(`s-${i}`, i));
    await governor.commitExact(`s-${i}`, 0.000001, i);
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `50k reserve/commit cycles took ${elapsed}ms`);
}

function testLedgerBoundKeepsExactCounts(): void {
  const ledger = new ReservationLedger(undefined, { maxInMemoryEvents: 100 });
  const base = { attempt_id: null, logical_call_id: null, amount_usd: null, committed_exact: 0, committed_estimated: 0, reserved_total: 0, budget_usd: 1, cost_source: null, raw: {} };
  for (let i = 0; i < 1_000; i++) ledger.append({ ...base, event: i % 2 ? "COST_COMMITTED" : "RESERVATION_CREATED" });
  assert.equal(ledger.all().length, 100, "in-memory events are bounded when asked to be");
  assert.equal(ledger.all().at(-1)?.seq, 1_000, "and the newest are the ones kept");
  assert.equal(ledger.count("COST_COMMITTED"), 500, "counts stay exact over the ledger's whole life");
  const unbounded = new ReservationLedger();
  for (let i = 0; i < 300; i++) unbounded.append({ ...base, event: "COST_COMMITTED" });
  assert.equal(unbounded.all().length, 300, "a mission ledger still keeps every event by default");
}

async function testReleaseUnbilledIsNotACommit(): Promise<void> {
  const ledger = new ReservationLedger();
  const governor = retentionGovernor(1_000, ledger);
  assert.ok((await governor.reserve(step("rejected", 0))).admitted);
  assert.ok(governor.snapshot().reservedTotal > 0);
  assert.equal(await governor.releaseUnbilled("rejected", "upstream_status:401", 1), true);
  const snap = governor.snapshot();
  assert.equal(snap.reservedTotal, 0, "the hold is released");
  assert.equal(snap.committedExact, 0, "nothing is committed as exact");
  assert.equal(snap.committedEstimated, 0, "and nothing as estimated");
  assert.equal(snap.quarantined, false);
  const event = ledger.all().find((e) => e.event === "RESERVATION_RELEASED");
  assert.equal(event?.cost_source, "not_billed", "tagged distinctly from exact and estimated");
  assert.equal(event?.amount_usd, 0);
  assert.equal(ledger.count("COST_COMMITTED"), 0, "a release is not a cost commit");
  assert.equal(await governor.commitExact("rejected", 0.01, 2), false, "a released id cannot be committed afterwards");
  const governor2 = retentionGovernor(1_000);
  assert.equal(await governor2.releaseUnbilled("never-reserved", "upstream_status:401", 0), false);
  assert.equal(governor2.snapshot().quarantined, false, "a stray release involves no money, so it does not quarantine");
}

await testReleaseUnbilledIsNotACommit();
await testResolvedReservationsAreBounded();
await testDuplicateRefusedInsideRetention();
await testLateResultAfterPruneStillQuarantines();
await testLogicalCallIndexReleasesOnResolve();
await testAdmissionCostDoesNotGrowWithHistory();
testLedgerBoundKeepsExactCounts();
await testConcurrentAdmission();
await testRetryReleaseRace();
await testEstimatedAndUnknownPrice();
await testErroredStreamEstimates();
await testLogicalCallSingleFlight();
await testTtlAndWorkerDeadline();
await testStartupStepBudgetAssertion();
await testGovernorIsolation();
console.log("D2 governor tests passed");
