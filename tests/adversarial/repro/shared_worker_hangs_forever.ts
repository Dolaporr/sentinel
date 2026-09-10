// Adversarial repro for tests/adversarial/findings/10-reservation-ttl-not-self-enforcing.md
//
// src/worker/shared-worker.ts's run() loop does `await this.transport.complete(...)`
// with no deadline of any kind — no Promise.race against reservationTtlMs, no
// AbortController, nothing. If the transport never resolves and never rejects
// (the exact real-world failure this project's own Day 1 docs already recorded
// against the live gateway — docs/DAY1_RESULT.md), SharedWorker.run() simply
// never returns. It also never calls governor.expire(), so the reservation it
// holds is never released either (see ttl_not_self_enforcing.ts).
//
// This repro races worker.run() against a short timer to prove the call does
// not resolve within several multiples of the governor's own reservationTtlMs,
// and that the reservation is still counted as active/reserved throughout.
//
// Run: npx tsx tests/adversarial/repro/shared_worker_hangs_forever.ts

import { BudgetGovernor } from "../../../src/governor/governor.js";
import { ReservationLedger } from "../../../src/governor/ledger.js";
import { SharedWorker } from "../../../src/worker/shared-worker.js";

const prices = { "test/cheap": { inputPerMillionUsd: 0, outputPerMillionUsd: 1, verifiedAt: "2026-09-08T00:00:00.000Z" } };
const ledger = new ReservationLedger();
const governor = new BudgetGovernor({ budgetUsd: 3, reservationTtlMs: 50, reservationSafetyMultiplier: 1, prices }, ledger);

const neverResolvingTransport = { complete: () => new Promise<{ text: string; usage?: { cost?: number } }>(() => { /* never settles — models a hung gateway call */ }) };
const worker = new SharedWorker(governor, neverResolvingTransport, "hung-agent");

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  console.log("Dispatching a step against a transport that never resolves, TTL=50ms...");
  const runPromise = worker.run([{ id: "step-1", model: "test/cheap", prompt: "x", inputTokens: 0, maxTokens: 1_000_000 }]);

  const RACE_MS = 400; // 8x the reservation TTL
  const result = await Promise.race([
    runPromise.then((r) => ({ settled: "resolved" as const, value: r })),
    sleep(RACE_MS).then(() => ({ settled: "timed_out" as const, value: null }))
  ]);

  console.log(`After waiting ${RACE_MS}ms (8x the governor's own reservationTtlMs), worker.run() has: ${result.settled}`);
  console.log(`Governor snapshot at that point: reservedTotal=${governor.snapshot().reservedTotal}, committedExact=${governor.snapshot().committedExact}, committedEstimated=${governor.snapshot().committedEstimated}`);
  console.log(`Ledger events so far: ${ledger.all().map((e) => e.event).join(", ") || "(none)"}`);

  if (result.settled === "timed_out" && governor.snapshot().reservedTotal > 0) {
    console.log("\nREPRO CONFIRMED: SharedWorker.run() is still hanging well past the reservation's TTL,");
    console.log("and the reservation is still fully counted as active/reserved. Nothing in the call path");
    console.log("imposes a deadline on the transport call or releases the reservation on its own.");
  } else {
    console.log("\nREPRO NOT REPRODUCED: the run either resolved or the reservation was released.");
  }
  process.exit(0); // the hung promise would otherwise keep the process alive forever
}

main();
