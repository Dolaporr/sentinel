// Adversarial repro for tests/adversarial/findings/02-balance-drain-path-and-breaker-placement.md,
// "The cap must outlive the process".
//
// BudgetGovernor keeps committed and reserved spend only in memory
// (src/governor/governor.ts:16-18, all zero at construction). ReservationLedger
// writes every transition to disk but reads the file back only to count lines for
// seq (src/governor/ledger.ts:15). So a fresh governor over the same ledger file
// starts at $0 committed, however much that file records. Two governors alive at
// once never see each other's reservations either.
//
// A crash-restart loop, or a second worker that builds its own governor, gets a
// full new budget each time. The Orbio gateway has no cap behind it.
//
// Run: npx tsx tests/adversarial/repro/governor_cap_resets_on_restart.ts
// In-memory plus one temp ledger file; no network, no key.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetGovernor } from "../../../src/governor/governor.js";
import { ReservationLedger } from "../../../src/governor/ledger.js";

const LEDGER = join(mkdtempSync(join(tmpdir(), "sentinel-adv-gov-")), "governor.jsonl");
const BUDGET_USD = 1;
const STEP_USD = 0.9;
const config = {
  budgetUsd: BUDGET_USD,
  reservationTtlMs: 60_000,
  reservationSafetyMultiplier: 1,
  maxStepBudgetFraction: 1,
  prices: { "test/model": { inputPerMillionUsd: 0, outputPerMillionUsd: 1, verifiedAt: "2026-09-11T00:00:00.000Z" } }
};
const step = (id: string) => ({ attemptId: id, logicalCallId: id, model: "test/model", inputTokens: 0, maxTokens: STEP_USD * 1_000_000 });

async function main(): Promise<void> {
  console.log(`=== Restart loop: one $${STEP_USD.toFixed(2)} step per process life, $${BUDGET_USD.toFixed(2)} budget, same ledger file ===`);
  let realSpend = 0;
  for (let life = 1; life <= 5; life++) {
    const governor = new BudgetGovernor(config, new ReservationLedger(LEDGER)); // what a restarted process constructs
    const admission = await governor.reserve(step(`life-${life}`));
    if (admission.admitted) {
      await governor.commitExact(admission.reservation.attemptId, STEP_USD);
      realSpend += STEP_USD;
    }
    console.log(`life ${life}: admitted=${admission.admitted} governor committed=$${governor.snapshot().committedExact.toFixed(2)} real cumulative spend=$${realSpend.toFixed(2)}`);
  }
  const onDisk = readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { event: string; amount_usd: number | null });
  const recorded = onDisk.filter((e) => e.event === "COST_COMMITTED").reduce((sum, e) => sum + (e.amount_usd ?? 0), 0);
  console.log(`ledger on disk: ${onDisk.length} events, $${recorded.toFixed(2)} committed; each new governor still started at $0.00`);

  console.log(`\n=== Two governors alive at once over the same ledger ===`);
  const a = new BudgetGovernor(config, new ReservationLedger(LEDGER));
  const b = new BudgetGovernor(config, new ReservationLedger(LEDGER));
  const ra = await a.reserve(step("worker-a"));
  const rb = await b.reserve(step("worker-b"));
  const reserved = (ra.admitted ? STEP_USD : 0) + (rb.admitted ? STEP_USD : 0);
  console.log(`worker A admitted=${ra.admitted}, worker B admitted=${rb.admitted}: $${reserved.toFixed(2)} reserved against a $${BUDGET_USD.toFixed(2)} budget`);

  const breached = realSpend > BUDGET_USD || reserved > BUDGET_USD;
  console.log(`\nREPRO RESULT: ${breached ? `cap not durable: $${realSpend.toFixed(2)} spent over 5 restarts and $${reserved.toFixed(2)} reserved by 2 governors, both against a $${BUDGET_USD.toFixed(2)} budget` : "cap held (bug NOT reproduced)"}.`);
  console.log(`ledger file: ${LEDGER}`);
  if (breached) process.exitCode = 1;
}

main();
