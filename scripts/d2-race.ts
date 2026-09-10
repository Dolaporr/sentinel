import { BudgetGovernor } from "../src/governor/governor.js";
import { ReservationLedger } from "../src/governor/ledger.js";
import type { PriceEntry } from "../src/governor/types.js";
import { SharedWorker, type WorkerStep, type WorkerTransport } from "../src/worker/shared-worker.js";

const sessionBudgetUsd = Number(process.env.D2_BUDGET_USD ?? 3);
if (!Number.isFinite(sessionBudgetUsd) || sessionBudgetUsd <= 0 || sessionBudgetUsd > 3) {
  throw new Error("D2_BUDGET_USD must be greater than $0 and no more than the $3.00 session ceiling.");
}

const missionBudgetUsd = 1;
const CHEAP_MODEL = "openai/gpt-4.1-mini";
const EXPENSIVE_MODEL = "openai/gpt-4.1";
const prices: Record<string, PriceEntry> = {
  [CHEAP_MODEL]: { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, verifiedAt: "2026-09-08T00:00:00.000Z" },
  [EXPENSIVE_MODEL]: { inputPerMillionUsd: 2, outputPerMillionUsd: 8, verifiedAt: "2026-09-08T00:00:00.000Z" }
};

const roundUsd = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

interface MissionStep {
  id: string;
  kind: "web_search" | "fetch_page" | "synthesize";
  prompt: string;
  inputTokens: number;
  maxTokens: number;
}

/** Open-ended research: search, fetch pages, then keep gathering if ungated. */
const researchSteps: MissionStep[] = [
  { id: "web_search", kind: "web_search", prompt: "web search for primary sources", inputTokens: 4_000, maxTokens: 20_000 },
  { id: "fetch_1", kind: "fetch_page", prompt: "fetch first search-result page", inputTokens: 12_000, maxTokens: 24_000 },
  { id: "fetch_2", kind: "fetch_page", prompt: "fetch second search-result page", inputTokens: 12_000, maxTokens: 24_000 },
  { id: "fetch_3", kind: "fetch_page", prompt: "fetch third search-result page", inputTokens: 12_000, maxTokens: 24_000 }
];

const synthesisStep: MissionStep = {
  id: "synthesize",
  kind: "synthesize",
  prompt: "synthesize gathered sources into a finished answer",
  inputTokens: 8_000,
  maxTokens: 16_000
};

function bill(model: string, inputTokens: number, outputTokens: number): number {
  const price = prices[model];
  if (!price) throw new Error(`No verified price entry for ${model}.`);
  return roundUsd((inputTokens * price.inputPerMillionUsd + outputTokens * price.outputPerMillionUsd) / 1_000_000);
}

function actualOutputTokens(model: string, maxTokens: number): number {
  return model === EXPENSIVE_MODEL ? maxTokens : Math.min(32, maxTokens);
}

const offlineTransport: WorkerTransport = {
  async complete(input) {
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = actualOutputTokens(input.model, input.maxTokens);
    return {
      text: `offline ${input.prompt}`,
      usage: { cost: bill(input.model, inputTokens, outputTokens), outputTokens }
    };
  }
};

/** Sentinel: refuse the expensive default, cap tokens, cheap model only. */
function cheapRoute(step: MissionStep): WorkerStep {
  return {
    id: step.id,
    model: CHEAP_MODEL,
    prompt: step.prompt,
    inputTokens: Math.min(step.inputTokens, 256),
    maxTokens: Math.min(step.maxTokens, 512)
  };
}

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

/**
 * Ungated comparison path: expensive default, same research mission, loops for
 * more sources until the $1 mission budget is gone. No governor.
 */
async function nakedAgent(): Promise<{
  died: true;
  reason: "BUDGET_EXHAUSTED";
  spent_usd: number;
  budget_usd: number;
  completed_mission: false;
  calls: Array<{ round: number; stepId: string; model: string; cost: number; spent_usd: number }>;
}> {
  const calls: Array<{ round: number; stepId: string; model: string; cost: number; spent_usd: number }> = [];
  let spentUsd = 0;
  let round = 0;
  while (spentUsd < missionBudgetUsd) {
    round += 1;
    for (const step of researchSteps) {
      const response = await offlineTransport.complete({
        model: EXPENSIVE_MODEL,
        prompt: `${step.prompt} (round ${round}; keep gathering sources)`,
        maxTokens: step.maxTokens,
        inputTokens: step.inputTokens
      });
      const cost = response.usage?.cost ?? 0;
      spentUsd = roundUsd(spentUsd + cost);
      calls.push({ round, stepId: step.id, model: EXPENSIVE_MODEL, cost, spent_usd: spentUsd });
      if (spentUsd >= missionBudgetUsd) {
        return { died: true, reason: "BUDGET_EXHAUSTED", spent_usd: spentUsd, budget_usd: missionBudgetUsd, completed_mission: false, calls };
      }
    }
  }
  return { died: true, reason: "BUDGET_EXHAUSTED", spent_usd: spentUsd, budget_usd: missionBudgetUsd, completed_mission: false, calls };
}

const sentinelSteps = [...researchSteps, synthesisStep].map(cheapRoute);
const watchedA = watchedAgent("watched-a");
const watchedB = watchedAgent("watched-b");
const [a, b, naked] = await Promise.all([
  watchedA.worker.run(sentinelSteps),
  watchedB.worker.run(sentinelSteps),
  nakedAgent()
]);

console.log(JSON.stringify({
  mode: "offline",
  session_budget_usd: sessionBudgetUsd,
  mission_budget_usd: missionBudgetUsd,
  default_model: EXPENSIVE_MODEL,
  sentinel_routing: "cheap-by-default",
  watched_a: { result: a, governor: watchedA.governor.snapshot(), events: watchedA.ledger.all() },
  watched_b: { result: b, governor: watchedB.governor.snapshot(), events: watchedB.ledger.all() },
  naked
}, null, 2));
