// Proves the fix for tests/adversarial/findings/12-shipped-max-tokens-exceeds-mission-budget.md
//
// Property under test: SENTINEL_D2_RUNNER.md §6 mandates a $1.00 per-agent
// mission budget. No single step's worst-case reservation, as actually
// configured in the shipped scripts/d2-race.ts, may exceed that — a step that
// alone costs more than the whole per-agent budget can never coexist with any
// other step, making a multi-step mission (§3: search + fetches + synthesis)
// structurally impossible regardless of how many steps are planned.
//
// Runs the ACTUAL `d2-race.ts` deliverable as a real child process (see
// run-d2-race.ts), not a re-typed copy of its config, so this can't go green
// just because an isolated unit test was adjusted while the real driver
// script's own max_tokens/price/budget numbers stayed broken.
//
// RED today (main @ 8b875ec): the single "final-synthesis" step reserves
// $2.000064 (128 input + 1,000,000 max_tokens against openai/gpt-4.1-mini's
// $1.60/M output price, x1.25 safety) — double the $1.00 mandated budget.
//
// Run: npx tsx tests/adversarial/regression/12-mission-step-must-fit-agent-budget.test.ts

import assert from "node:assert/strict";
import { collectLedgerEvents, collectWorkerResults, runD2Race } from "./run-d2-race.js";

const PER_AGENT_BUDGET_USD = 1.0; // SENTINEL_D2_RUNNER.md §6

function main(): void {
  const output = runD2Race();
  const events = collectLedgerEvents(output);
  const reservations = events.filter((e) => e.event === "RESERVATION_CREATED");
  assert.ok(reservations.length > 0, "setup: at least one RESERVATION_CREATED event must exist in the d2-race.ts output");

  for (const reservation of reservations) {
    assert.ok(
      typeof reservation.amount_usd === "number" && reservation.amount_usd <= PER_AGENT_BUDGET_USD,
      `RESERVATION_CREATED reserved $${reservation.amount_usd}, which exceeds the $${PER_AGENT_BUDGET_USD.toFixed(2)} ` +
      `per-agent mission budget mandated by SENTINEL_D2_RUNNER.md §6 on its own — no mission step should ever be ` +
      `sized to consume the entire budget by itself. Event: ${JSON.stringify(reservation)}`
    );
  }

  // A budget that can admit a single step should, in the offline/fixture run, let real
  // multi-step missions actually proceed rather than dying on the very first admission.
  const results = collectWorkerResults(output);
  const anyProducedOutput = results.some((r) => r.outputs.length > 0);
  assert.ok(anyProducedOutput, "expected at least one agent to have produced real output, not refused before any dispatch");

  console.log(`PASS: all ${reservations.length} reservation(s) fit within the $${PER_AGENT_BUDGET_USD.toFixed(2)} per-agent budget.`);
}

main();
