// Proves the fix for tests/adversarial/findings/13-shared-governor-quarantine-conflates-refusal-with-integrity-violation.md
//
// Property under test: an agent that actually dispatched and reconciled real
// work (its outputs were produced) must not be reported as failed/quarantined
// purely because of a peer's fate. Whatever shape the fix takes — separating
// "ordinary refusal" from "integrity violation" inside a shared BudgetGovernor,
// or giving each watched agent its own governor instance entirely — this is
// the observable contract scripts/d2-race.ts must satisfy either way.
//
// Runs the ACTUAL `d2-race.ts` deliverable as a real child process (see
// run-d2-race.ts) rather than a synthetic governor setup, per the standing
// instruction to verify the real command, not just unit-level behavior —
// findings 12 and 13 were only found by doing exactly that.
//
// RED today (main @ 8b875ec): watched-a dispatches and reconciles its real
// call exactly, then is still reported completed=false/QUARANTINED because
// watched-b's ordinary BUDGET_EXCEEDED refusal quarantines the shared governor.
//
// Run: npx tsx tests/adversarial/regression/13-peer-refusal-must-not-quarantine-successful-agent.test.ts

import assert from "node:assert/strict";
import { collectWorkerResults, runD2Race } from "./run-d2-race.js";

function main(): void {
  const output = runD2Race();
  const results = collectWorkerResults(output);
  assert.ok(results.length >= 2, `expected at least two worker results in d2-race.ts output, found ${results.length}`);

  const producedRealOutput = results.filter((r) => r.outputs.length > 0);
  assert.ok(producedRealOutput.length > 0, "setup: at least one agent must have actually dispatched a real call");

  for (const result of producedRealOutput) {
    assert.equal(
      result.completed,
      true,
      `an agent that produced real output (outputs.length=${result.outputs.length}) must be reported completed=true, ` +
      `not downgraded to a failure/quarantine because of an unrelated peer's own refusal. Got: ${JSON.stringify(result)}`
    );
  }

  console.log(`PASS: all ${producedRealOutput.length} agent(s) with real output were reported completed=true.`);
}

main();
