import { BudgetGovernor } from "../src/governor/governor.js";
import { ReservationLedger } from "../src/governor/ledger.js";
import { SharedWorker, type WorkerStep } from "../src/worker/shared-worker.js";

const sessionBudgetUsd = Number(process.env.D2_BUDGET_USD ?? 3);
if (!Number.isFinite(sessionBudgetUsd) || sessionBudgetUsd <= 0 || sessionBudgetUsd > 3) {
  throw new Error("D2_BUDGET_USD must be greater than $0 and no more than the $3.00 session ceiling.");
}

const missionBudgetUsd = 1;
const prices = {
  "openai/gpt-4.1-mini": { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, verifiedAt: "2026-09-08T00:00:00.000Z" }
};
const steps: WorkerStep[] = [
  { id: "research", model: "openai/gpt-4.1-mini", prompt: "offline research", inputTokens: 128, maxTokens: 128 },
  { id: "fetch", model: "openai/gpt-4.1-mini", prompt: "offline fetch", inputTokens: 192, maxTokens: 256 },
  { id: "synthesize", model: "openai/gpt-4.1-mini", prompt: "offline synthesis", inputTokens: 256, maxTokens: 512 }
];

const offlineTransport = { complete: async () => ({ text: "offline fixture response", usage: { cost: 0.0000196, outputTokens: 5 } }) };

function watchedAgent(id: string) {
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({
    budgetUsd: missionBudgetUsd,
    reservationTtlMs: 30_000,
    reservationSafetyMultiplier: 1.25,
    maxStepBudgetFraction: 0.25,
    prices
  }, ledger);
  return { worker: new SharedWorker(governor, offlineTransport, id), governor, ledger };
}

/** Deliberately ungated comparison path: no governor instance is created or consulted. */
async function nakedAgent(): Promise<{ completed: boolean; outputs: string[] }> {
  const outputs: string[] = [];
  for (const step of steps) outputs.push((await offlineTransport.complete(step)).text);
  return { completed: true, outputs };
}

const watchedA = watchedAgent("watched-a");
const watchedB = watchedAgent("watched-b");
const [a, b, naked] = await Promise.all([watchedA.worker.run(steps), watchedB.worker.run(steps), nakedAgent()]);

console.log(JSON.stringify({
  mode: "offline",
  session_budget_usd: sessionBudgetUsd,
  watched_a: { result: a, governor: watchedA.governor.snapshot(), events: watchedA.ledger.all() },
  watched_b: { result: b, governor: watchedB.governor.snapshot(), events: watchedB.ledger.all() },
  naked
}, null, 2));
