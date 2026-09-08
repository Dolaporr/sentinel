import { BudgetGovernor } from "../governor/governor.js";

export interface WorkerTransport {
  complete(input: { model: string; prompt: string; maxTokens: number }): Promise<{ text: string; usage?: { cost?: number } }>;
}

export interface WorkerStep {
  id: string;
  model: string;
  prompt: string;
  inputTokens: number;
  maxTokens: number;
}

export interface WorkerRunResult {
  completed: boolean;
  outputs: Array<{ stepId: string; text: string }>;
  refusal?: string;
}

/** Shared loop used by both watched agents. Transport injection keeps it offline-testable. */
export class SharedWorker {
  constructor(private readonly governor: BudgetGovernor, private readonly transport: WorkerTransport, private readonly workerId: string) {}

  async run(steps: readonly WorkerStep[]): Promise<WorkerRunResult> {
    const outputs: Array<{ stepId: string; text: string }> = [];
    for (const step of steps) {
      const admission = await this.governor.reserve({
        attemptId: `${this.workerId}:${step.id}:${crypto.randomUUID()}`,
        logicalCallId: `${this.workerId}:${step.id}`,
        model: step.model,
        inputTokens: step.inputTokens,
        maxTokens: step.maxTokens
      });
      if (!admission.admitted) {
        await this.governor.finishMission({ completed: false, reason: `admission_refused:${admission.reason}` });
        return { completed: false, outputs, refusal: admission.reason };
      }
      try {
        const response = await this.transport.complete({ model: step.model, prompt: step.prompt, maxTokens: step.maxTokens });
        if (typeof response.usage?.cost === "number") await this.governor.commitExact(admission.reservation.attemptId, response.usage.cost);
        else await this.governor.commitEstimated(admission.reservation.attemptId, "missing_usage_cost");
        outputs.push({ stepId: step.id, text: response.text });
      } catch (error) {
        await this.governor.commitEstimated(admission.reservation.attemptId, `transport_error:${error instanceof Error ? error.name : "unknown"}`);
        await this.governor.finishMission({ completed: false, reason: "worker_call_failed" });
        return { completed: false, outputs, refusal: "WORKER_CALL_FAILED" };
      }
    }
    await this.governor.finishMission({ completed: true, reason: "all_steps_completed" });
    if (this.governor.snapshot().quarantined) {
      return { completed: false, outputs, refusal: "QUARANTINED" };
    }
    return { completed: true, outputs };
  }
}
