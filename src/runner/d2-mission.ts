import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

/**
 * Deliberately divides by 3.5 rather than the usual chars/4 heuristic, so the
 * figure over-counts slightly. Input tokens feed the worst-case bound, and an
 * over-count errs high -- the safe direction. Never use this to compute a
 * billed amount; billed cost comes from the provider's usage.cost.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// --- The corpus -------------------------------------------------------------
// The mission reads real text that is really in the prompt. Earlier revisions
// declared thousands of input tokens while sending an 80-token one-liner about
// fetching pages the model had no tool for, so the reservation was computed
// against a prompt that never existed and the model replied asking what was
// meant. Every token counted below is a token actually sent.

const CORPUS_DIR = resolve(process.cwd(), "fixtures", "corpus");
const CORPUS_FILES = ["01-incident-postmortem.md", "02-design-tradeoffs.md", "03-measurement-study.md"] as const;

export interface CorpusDocument { id: string; title: string; text: string; }

export const corpus: CorpusDocument[] = CORPUS_FILES.map((file) => {
  const text = readFileSync(resolve(CORPUS_DIR, file), "utf8");
  const heading = text.split("\n").find((line) => line.startsWith("## "))?.slice(3).trim() ?? file;
  return { id: file.replace(/\.md$/, ""), title: heading, text };
});

const corpusBlock = corpus
  .map((doc) => `<source id="${doc.id}" title="${doc.title}">\n${doc.text}\n</source>`)
  .join("\n\n");

// --- Mission steps ----------------------------------------------------------

export interface MissionStep {
  id: string;
  kind: "extract" | "synthesize";
  /** Full prompt actually sent. inputTokens is derived from this, never declared. */
  buildPrompt: (round: number) => string;
  maxTokens: number;
}

function extractStep(doc: CorpusDocument, index: number): MissionStep {
  return {
    id: `extract_${index + 1}`,
    kind: "extract",
    maxTokens: 1_500,
    buildPrompt: (round) =>
      `You are compiling a research brief on cost controls for metered model APIs.\n\n` +
      `Below are three source documents. They are synthetic fixtures written for this exercise, ` +
      `not real-world reporting -- treat them as the only evidence available and do not import outside facts.\n\n` +
      `${corpusBlock}\n\n` +
      `Task (pass ${round}): extract the substantive findings from source "${doc.id}" specifically. ` +
      `For each finding give a one-line claim followed by the source id and a short supporting quotation. ` +
      `Note explicitly where this source disagrees with or qualifies the other two.`
  };
}

export const researchSteps: MissionStep[] = corpus.map(extractStep);

export const synthesisStep: MissionStep = {
  id: "synthesize",
  kind: "synthesize",
  maxTokens: 3_000,
  buildPrompt: (round) =>
    `You are compiling a research brief on cost controls for metered model APIs.\n\n` +
    `Below are three source documents. They are synthetic fixtures written for this exercise, ` +
    `not real-world reporting -- treat them as the only evidence available and do not import outside facts.\n\n` +
    `${corpusBlock}\n\n` +
    `Task (pass ${round}): synthesise the three sources into a structured brief. Cover where a spend ` +
    `ceiling should sit and why, what each alternative position fails at, and how a worst-case cost bound ` +
    `should be calibrated. Cite source ids inline for every claim. Close with the strongest objection a ` +
    `reviewer could raise against the position you have argued.`
};

export const missionSteps: MissionStep[] = [...researchSteps, synthesisStep];

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

/**
 * Sentinel policy: cheap model, capped OUTPUT. It deliberately does not clamp
 * input -- the corpus is the mission, and truncating it would leave Sentinel
 * solving an easier problem than the agents it is being compared against.
 */
export const SENTINEL_OUTPUT_CAP = 1_200;

export function cheapRoute(step: MissionStep, round = 1): WorkerStep {
  const prompt = step.buildPrompt(round);
  return {
    id: step.id,
    model: CHEAP_MODEL,
    prompt,
    inputTokens: estimateTokens(prompt),
    maxTokens: Math.min(step.maxTokens, SENTINEL_OUTPUT_CAP)
  };
}

export const sentinelSteps: WorkerStep[] = missionSteps.map((step) => cheapRoute(step));

export function createOfflineTransport(): WorkerTransport {
  return {
    async complete(input) {
      const inputTokens = input.inputTokens ?? 0;
      // Offline stand-in for real completion length. The live run's observed
      // ceiling utilisation was ~10%; this keeps the mock in that neighbourhood
      // rather than pretending every call saturates its ceiling.
      const outputTokens = Math.min(input.maxTokens, Math.round(input.maxTokens * 0.6));
      return {
        text: `offline completion for ${input.prompt.slice(0, 60)}...`,
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

const defaultPromptFor: PromptFor = (step, round) => step.buildPrompt(round);

export async function runNakedAgent(transport: WorkerTransport, promptFor: PromptFor = defaultPromptFor) {
  const calls: Array<{ round: number; stepId: string; model: string; cost: number; spent_usd: number }> = [];
  let spentUsd = 0;
  let round = 0;
  while (spentUsd < MISSION_BUDGET_USD) {
    round += 1;
    for (const step of missionSteps) {
      const prompt = promptFor(step, round);
      const response = await transport.complete({
        model: EXPENSIVE_MODEL,
        prompt,
        maxTokens: step.maxTokens,
        inputTokens: estimateTokens(prompt)
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
  refused_step: string | null;
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

  const stop = (refusal: string, refusedStep: string | null) => {
    const snap = governor.snapshot();
    const spentUsd = roundUsd(snap.committedExact + snap.committedEstimated);
    return {
      survived: true as const,
      died: false as const,
      refusal,
      refused_step: refusedStep,
      spent_usd: spentUsd,
      remaining_usd: roundUsd(MISSION_BUDGET_USD - spentUsd),
      budget_usd: MISSION_BUDGET_USD,
      completed_mission: false as const,
      calls,
      governor: snap,
      events: ledger.all()
    };
  };

  while (true) {
    round += 1;
    for (const step of missionSteps) {
      const prompt = promptFor(step, round);
      const inputTokens = estimateTokens(prompt);
      const admission = await governor.reserve({
        attemptId: `governed-expensive:${step.id}:r${round}:${crypto.randomUUID()}`,
        logicalCallId: `governed-expensive:${step.id}:r${round}`,
        model: EXPENSIVE_MODEL,
        inputTokens,
        maxTokens: step.maxTokens
      });
      if (!admission.admitted) {
        await governor.finishMission({ completed: false, reason: `admission_refused:${admission.reason}` });
        return stop(admission.reason, step.id);
      }
      try {
        const response = await transport.complete({
          model: EXPENSIVE_MODEL,
          prompt,
          maxTokens: step.maxTokens,
          inputTokens
        });
        const cost = response.usage?.cost;
        if (typeof cost === "number") await governor.commitExact(admission.reservation.attemptId, cost);
        else await governor.commitEstimated(admission.reservation.attemptId, "missing_usage_cost", response.usage?.outputTokens);
        const snap = governor.snapshot();
        calls.push({
          round,
          stepId: step.id,
          model: EXPENSIVE_MODEL,
          reserved_usd: admission.reservation.amountUsd,
          cost: typeof cost === "number" ? cost : 0,
          spent_usd: roundUsd(snap.committedExact + snap.committedEstimated)
        });
      } catch (error) {
        await governor.commitEstimated(admission.reservation.attemptId, `transport_error:${error instanceof Error ? error.name : "unknown"}`);
        await governor.finishMission({ completed: false, reason: "worker_call_failed" });
        return stop("WORKER_CALL_FAILED", step.id);
      }
    }
  }
}
