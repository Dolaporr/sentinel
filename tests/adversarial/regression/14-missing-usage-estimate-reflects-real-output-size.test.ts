// Proves the fix for tests/adversarial/findings/14-missing-usage-commits-full-reservation-not-real-output-size.md
//
// Two properties under test, both required together — a fix that only
// satisfies the first would make the "estimated" commit path unsafe again:
//
//  1. When a signal about real output size IS available (even without
//     usage.cost — e.g. the length of the returned text), a short response
//     must commit meaningfully LESS than the full safety-multiplied
//     reservation, not the full worst-case amount regardless of size.
//  2. When NO signal about output is available at all (a genuine cut stream —
//     the transport throws with no partial content), the fail-closed
//     behavior from finding 04/05 of the design review must still hold: the
//     full reservation is committed. This must keep passing — it is a
//     regression guard against an overcorrection that makes cut streams
//     under-billed again.
//
// RED today (main @ 8b875ec) on property 1: commitEstimated() always books
// reservation.amountUsd unconditionally, with no way to pass or use a
// cheaper real-size signal — a one-line tool call and a max_tokens-length
// completion are billed identically. Property 2 already passes today; it's
// included as a guard rail so a future fix can't break it while fixing 1.
//
// Run: npx tsx tests/adversarial/regression/14-missing-usage-estimate-reflects-real-output-size.test.ts

import assert from "node:assert/strict";
import { BudgetGovernor } from "../../../src/governor/governor.js";
import { ReservationLedger } from "../../../src/governor/ledger.js";
import { SharedWorker } from "../../../src/worker/shared-worker.js";

// Same price table as scripts/d2-race.ts.
const prices = { "openai/gpt-4.1-mini": { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, verifiedAt: "2026-09-08T00:00:00.000Z" } };

async function testShortResponseIsBilledBelowFullReservation(): Promise<void> {
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({ budgetUsd: 1.0, reservationTtlMs: 30_000, reservationSafetyMultiplier: 1.25, prices }, ledger);
  const step = { id: "tool-call-turn", model: "openai/gpt-4.1-mini", prompt: "call web_search", inputTokens: 128, maxTokens: 2_000 };

  const shortRealOutputMissingUsage = { complete: async () => ({ text: "search(query=\"Robinhood Chain\")" }) };
  const worker = new SharedWorker(governor, shortRealOutputMissingUsage, "sentinel");

  const result = await worker.run([step]);
  assert.equal(result.completed, true, "setup: the call itself should succeed");

  const reservationAmount = ledger.all().find((e) => e.event === "RESERVATION_CREATED")?.amount_usd ?? 0;
  const committed = governor.snapshot().committedEstimated;

  assert.ok(reservationAmount > 0, "setup: a nonzero reservation must have been created");
  assert.ok(
    committed < reservationAmount,
    `a short real response (well under max_tokens=${step.maxTokens}) with missing usage.cost committed the FULL ` +
    `reservation ($${reservationAmount}) instead of something reflecting its actual small size. Committed: $${committed}.`
  );
}

async function testGenuineCutStreamStillBillsFullReservation(): Promise<void> {
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({ budgetUsd: 1.0, reservationTtlMs: 30_000, reservationSafetyMultiplier: 1.25, prices }, ledger);
  const step = { id: "cut", model: "openai/gpt-4.1-mini", prompt: "call web_search", inputTokens: 128, maxTokens: 2_000 };

  const trulyCutStream = { complete: async (): Promise<{ text: string; usage?: { cost?: number } }> => { throw new Error("stream cut, no partial content available"); } };
  const worker = new SharedWorker(governor, trulyCutStream, "sentinel");

  await worker.run([step]);
  const reservationAmount = ledger.all().find((e) => e.event === "RESERVATION_CREATED")?.amount_usd ?? 0;
  const committed = governor.snapshot().committedEstimated;

  assert.equal(
    committed,
    reservationAmount,
    "a genuine cut stream, with no real-size signal available at all, must still commit the full worst-case " +
    `reservation as a fail-closed guard (per the design review's finding 04). Reservation: $${reservationAmount}, committed: $${committed}.`
  );
}

async function main(): Promise<void> {
  await testShortResponseIsBilledBelowFullReservation();
  await testGenuineCutStreamStillBillsFullReservation();
  console.log("PASS: missing-usage estimates scale with real output size when available, and stay fail-closed when it isn't.");
}

main();
