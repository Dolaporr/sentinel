// Adversarial repro for tests/adversarial/findings/14-missing-usage-commits-full-reservation-not-real-output-size.md
//
// shared-worker.ts commits the FULL safety-multiplied reservation amount as
// "estimated" spend whenever a response lacks usage.cost — regardless of how
// much output the call actually produced. This isolates that mechanism with a
// max_tokens small enough to actually be admitted (see finding 12 for why the
// driver script's real max_tokens: 1_000_000 never gets this far at all), using
// the real price table from scripts/d2-race.ts, to show the commit amount has
// no relationship to what was really generated — a response that used almost
// none of its allotted tokens is billed identically to one that used all of them.
//
// Run: npx tsx tests/adversarial/repro/missing_usage_bills_full_worst_case.ts

import { BudgetGovernor } from "../../../src/governor/governor.js";
import { ReservationLedger } from "../../../src/governor/ledger.js";
import { SharedWorker } from "../../../src/worker/shared-worker.js";

// Same price table as scripts/d2-race.ts.
const prices = {
  "openai/gpt-4.1-mini": { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, verifiedAt: "2026-09-08T00:00:00.000Z" }
};

async function main(): Promise<void> {
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({ budgetUsd: 1.0, reservationTtlMs: 30_000, reservationSafetyMultiplier: 1.25, prices }, ledger);

  // A modest, realistic ceiling for one tool-call turn — small enough to be
  // admitted against a $1.00 budget (unlike the driver's own 1,000,000, see
  // finding 12), but the point below holds at any max_tokens value.
  const step = { id: "tool-call-turn", model: "openai/gpt-4.1-mini", prompt: "call web_search", inputTokens: 128, maxTokens: 2_000 };

  // Real behavior: the model made a short, cheap tool call (a handful of tokens)
  // and the provider's response for this intermediate turn simply didn't carry
  // a usage object — plausible for a tool-call turn, per finding 05 of the
  // design review that preceded this implementation.
  const shortRealOutputMissingUsage = { complete: async () => ({ text: "search(query=\"Robinhood Chain\")" }) };
  const worker = new SharedWorker(governor, shortRealOutputMissingUsage, "sentinel");

  const result = await worker.run([step]);
  const snapshot = governor.snapshot();

  const reservationAmount = ledger.all().find((e) => e.event === "RESERVATION_CREATED")?.amount_usd ?? 0;
  console.log(`max_tokens for this call: ${step.maxTokens}`);
  console.log(`Reservation admitted at: $${reservationAmount}`);
  console.log(`Real response: a short tool-call string, well under 2,000 tokens, usage.cost absent.`);
  console.log(`Amount actually committed (as "estimated"): $${snapshot.committedEstimated}`);
  console.log(`Worker result: completed=${result.completed}`);

  if (snapshot.committedEstimated === reservationAmount && reservationAmount > 0) {
    console.log("\nREPRO CONFIRMED: the commit equals the FULL worst-case reservation, not any function of what was");
    console.log("actually generated. A one-token tool call and a maxTokens-length completion are billed identically");
    console.log("whenever usage.cost happens to be missing — there is no attempt to infer real size (e.g. from the");
    console.log("length of `response.text`) before falling back to the pessimistic bound.");
  }
}

main();
