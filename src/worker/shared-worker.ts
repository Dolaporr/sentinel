import { BudgetGovernor } from "../governor/governor.js";

export interface WorkerTransport {
  complete(input: { model: string; prompt: string; maxTokens: number; inputTokens?: number }): Promise<{ text: string; usage?: { cost?: number; outputTokens?: number } }>;
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
    for (const step of steps) this.governor.assertStepFitsBudget(step);
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
        const response = await this.completeBeforeDeadline(admission.reservation.expiresAtMs, { model: step.model, prompt: step.prompt, maxTokens: step.maxTokens, inputTokens: step.inputTokens });
        if (typeof response.usage?.cost === "number") await this.governor.commitExact(admission.reservation.attemptId, response.usage.cost);
        else await this.governor.commitEstimated(
          admission.reservation.attemptId,
          "missing_usage_cost",
          response.usage?.outputTokens ?? this.estimateOutputTokens(response.text)
        );
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

  private async completeBeforeDeadline(expiresAtMs: number, input: { model: string; prompt: string; maxTokens: number; inputTokens?: number }): Promise<{ text: string; usage?: { cost?: number; outputTokens?: number } }> {
    const remainingMs = Math.max(1, expiresAtMs - Date.now() - 1);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("reservation_deadline_exceeded")), remainingMs); });
    try { return await Promise.race([this.transport.complete(input), deadline]); }
    finally { if (timeout) clearTimeout(timeout); }
  }

  private estimateOutputTokens(text: string): number {
    return text.length === 0 ? 0 : Math.ceil(text.length / 4);
  }
}
