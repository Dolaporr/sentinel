import { BudgetGovernor } from "../governor/governor.js";
import { ReservationLedger } from "../governor/ledger.js";
import type { GovernorSnapshot, PriceEntry } from "../governor/types.js";
import { SharedWorker, type WorkerStep, type WorkerTransport } from "../worker/shared-worker.js";

export const MISSION_BUDGET_USD = 0.25;
export const SESSION_CEILING_USD = 3;
export const CHEAP_MODEL = "openai/gpt-4.1-mini";
export const EXPENSIVE_MODEL = "openai/gpt-4.1";
export const RESERVATION_SAFETY_MULTIPLIER = 1.25;

export const prices: Record<string, PriceEntry> = {
  [CHEAP_MODEL]: { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6, verifiedAt: "2026-09-08T00:00:00.000Z" },
  [EXPENSIVE_MODEL]: { inputPerMillionUsd: 2, outputPerMillionUsd: 8, verifiedAt: "2026-09-08T00:00:00.000Z" }
};

export const roundUsd = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

export interface MissionStep {
  id: string;
  kind: "web_search" | "fetch_page" | "synthesize";
  prompt: string;
  inputTokens: number;
  maxTokens: number;
}

/** Open-ended research: search, fetch pages, then keep gathering if ungated. */
export const researchSteps: MissionStep[] = [
  { id: "web_search", kind: "web_search", prompt: "web search for primary sources", inputTokens: 4_000, maxTokens: 20_000 },
  { id: "fetch_1", kind: "fetch_page", prompt: "fetch first search-result page", inputTokens: 12_000, maxTokens: 24_000 },
  { id: "fetch_2", kind: "fetch_page", prompt: "fetch second search-result page", inputTokens: 12_000, maxTokens: 24_000 },
  { id: "fetch_3", kind: "fetch_page", prompt: "fetch third search-result page", inputTokens: 12_000, maxTokens: 24_000 }
];

export const synthesisStep: MissionStep = {
  id: "synthesize",
  kind: "synthesize",
  prompt: "synthesize gathered sources into a finished answer",
  inputTokens: 8_000,
  maxTokens: 16_000
};

export function worstCaseUsd(model: string, inputTokens: number, maxTokens: number): number {
  const price = prices[model];
  if (!price) throw new Error(`No verified price entry for ${model}.`);
  const base = (inputTokens * price.inputPerMillionUsd + maxTokens * price.outputPerMillionUsd) / 1_000_000;
  return roundUsd(base * RESERVATION_SAFETY_MULTIPLIER);
}

export function bill(model: string, inputTokens: number, outputTokens: number): number {
  const price = prices[model];
  if (!price) throw new Error(`No verified price entry for ${model}.`);
  return roundUsd((inputTokens * price.inputPerMillionUsd + outputTokens * price.outputPerMillionUsd) / 1_000_000);
}

export function cheapRoute(step: MissionStep): WorkerStep {
  return {
    id: step.id,
    model: CHEAP_MODEL,
    prompt: step.prompt,
    inputTokens: Math.min(step.inputTokens, 256),
    maxTokens: Math.min(step.maxTokens, 512)
  };
}

export const sentinelSteps: WorkerStep[] = [...researchSteps, synthesisStep].map(cheapRoute);

export function createOfflineTransport(): WorkerTransport {
  return {
    async complete(input) {
      const inputTokens = input.inputTokens ?? 0;
      const outputTokens = input.model === EXPENSIVE_MODEL ? input.maxTokens : Math.min(32, input.maxTokens);
      return {
        text: `offline ${input.prompt}`,
        usage: { cost: bill(input.model, inputTokens, outputTokens), outputTokens }
      };
    }
  };
}

export function createSentinel(id: string, transport: WorkerTransport, reservationTtlMs = 30_000) {
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({
    budgetUsd: MISSION_BUDGET_USD,
    reservationTtlMs,
    reservationSafetyMultiplier: RESERVATION_SAFETY_MULTIPLIER,
    maxStepBudgetFraction: 0.25,
    prices
  }, ledger);
  return { worker: new SharedWorker(governor, transport, id), governor, ledger };
}

export type PromptFor = (step: MissionStep, round: number) => string;

const defaultPromptFor: PromptFor = (step, round) => `${step.prompt} (round ${round}; keep gathering sources)`;

export async function runNakedAgent(transport: WorkerTransport, promptFor: PromptFor = defaultPromptFor) {
  const calls: Array<{ round: number; stepId: string; model: string; cost: number; spent_usd: number }> = [];
  let spentUsd = 0;
  let round = 0;
  while (spentUsd < MISSION_BUDGET_USD) {
    round += 1;
    for (const step of researchSteps) {
      const response = await transport.complete({
        model: EXPENSIVE_MODEL,
        prompt: promptFor(step, round),
        maxTokens: step.maxTokens,
        inputTokens: step.inputTokens
      });
      const cost = response.usage?.cost ?? 0;
      spentUsd = roundUsd(spentUsd + cost);
      calls.push({ round, stepId: step.id, model: EXPENSIVE_MODEL, cost, spent_usd: spentUsd });
      if (spentUsd >= MISSION_BUDGET_USD) {
        return { died: true as const, reason: "BUDGET_EXHAUSTED" as const, spent_usd: spentUsd, budget_usd: MISSION_BUDGET_USD, completed_mission: false as const, calls };
      }
    }
  }
  return { died: true as const, reason: "BUDGET_EXHAUSTED" as const, spent_usd: spentUsd, budget_usd: MISSION_BUDGET_USD, completed_mission: false as const, calls };
}

export async function runGovernedExpensiveAgent(
  transport: WorkerTransport,
  promptFor: PromptFor = defaultPromptFor,
  reservationTtlMs = 30_000
): Promise<{
  survived: true;
  died: false;
  refusal: string;
  spent_usd: number;
  remaining_usd: number;
  budget_usd: number;
  completed_mission: false;
  calls: Array<{ round: number; stepId: string; model: string; reserved_usd: number; cost: number; spent_usd: number }>;
  governor: GovernorSnapshot;
  events: ReturnType<ReservationLedger["all"]>;
}> {
  const ledger = new ReservationLedger();
  const governor = new BudgetGovernor({
    budgetUsd: MISSION_BUDGET_USD,
    reservationTtlMs,
    reservationSafetyMultiplier: RESERVATION_SAFETY_MULTIPLIER,
    maxStepBudgetFraction: 1,
    prices
  }, ledger);
  const calls: Array<{ round: number; stepId: string; model: string; reserved_usd: number; cost: number; spent_usd: number }> = [];
  let round = 0;
  while (true) {
    round += 1;
    for (const step of researchSteps) {
      const admission = await governor.reserve({
        attemptId: `governed-expensive:${step.id}:r${round}:${crypto.randomUUID()}`,
        logicalCallId: `governed-expensive:${step.id}:r${round}`,
        model: EXPENSIVE_MODEL,
        inputTokens: step.inputTokens,
        maxTokens: step.maxTokens
      });
      if (!admission.admitted) {
        await governor.finishMission({ completed: false, reason: `admission_refused:${admission.reason}` });
        const snap = governor.snapshot();
        const spentUsd = roundUsd(snap.committedExact + snap.committedEstimated);
        return {
          survived: true,
          died: false,
          refusal: admission.reason,
          spent_usd: spentUsd,
          remaining_usd: roundUsd(MISSION_BUDGET_USD - spentUsd),
          budget_usd: MISSION_BUDGET_USD,
          completed_mission: false,
          calls,
          governor: snap,
          events: ledger.all()
        };
      }
      try {
        const response = await transport.complete({
          model: EXPENSIVE_MODEL,
          prompt: promptFor(step, round),
          maxTokens: step.maxTokens,
          inputTokens: step.inputTokens
        });
        const cost = response.usage?.cost;
        if (typeof cost === "number") await governor.commitExact(admission.reservation.attemptId, cost);
        else await governor.commitEstimated(admission.reservation.attemptId, "missing_usage_cost", response.usage?.outputTokens);
        const snap = governor.snapshot();
        const spentUsd = roundUsd(snap.committedExact + snap.committedEstimated);
        calls.push({
          round,
          stepId: step.id,
          model: EXPENSIVE_MODEL,
          reserved_usd: admission.reservation.amountUsd,
          cost: typeof cost === "number" ? cost : 0,
          spent_usd: spentUsd
        });
      } catch (error) {
        await governor.commitEstimated(admission.reservation.attemptId, `transport_error:${error instanceof Error ? error.name : "unknown"}`);
        await governor.finishMission({ completed: false, reason: "worker_call_failed" });
        const snap = governor.snapshot();
        const spentUsd = roundUsd(snap.committedExact + snap.committedEstimated);
        return {
          survived: true,
          died: false,
          refusal: "WORKER_CALL_FAILED",
          spent_usd: spentUsd,
          remaining_usd: roundUsd(MISSION_BUDGET_USD - spentUsd),
          budget_usd: MISSION_BUDGET_USD,
          completed_mission: false,
          calls,
          governor: snap,
          events: ledger.all()
        };
      }
    }
  }
}
