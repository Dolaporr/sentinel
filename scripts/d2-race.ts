import { BudgetGovernor } from "../src/governor/governor.js";
import { ReservationLedger } from "../src/governor/ledger.js";
import { SharedWorker } from "../src/worker/shared-worker.js";

const sessionBudgetUsd = Number(process.env.D2_BUDGET_USD ?? 3);
if (!Number.isFinite(sessionBudgetUsd) || sessionBudgetUsd <= 0 || sessionBudgetUsd > 3) {
  throw new Error("D2_BUDGET_USD must be greater than $0 and no more than the $3.00 session ceiling.");
}

const ledger = new ReservationLedger();
const governor = new BudgetGovernor({
  budgetUsd: sessionBudgetUsd,
  reservationTtlMs: 30_000,
  reservationSafetyMultiplier: 1.25,
  prices: {
    "openai/gpt-4.1-mini": { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, verifiedAt: "2026-09-08T00:00:00.000Z" }
  }
}, ledger);

const offlineTransport = {
  complete: async () => ({ text: "offline fixture response", usage: { cost: 0.0000196 } })
};

const sharedStep = { id: "final-synthesis", model: "openai/gpt-4.1-mini", prompt: "offline only", inputTokens: 128, maxTokens: 1_000_000 };
const [left, right] = await Promise.all([
  new SharedWorker(governor, offlineTransport, "watched-a").run([sharedStep]),
  new SharedWorker(governor, offlineTransport, "watched-b").run([sharedStep])
]);

console.log(JSON.stringify({
  mode: "offline",
  session_budget_usd: sessionBudgetUsd,
  results: [left, right],
  governor: governor.snapshot(),
  events: ledger.all()
}, null, 2));
