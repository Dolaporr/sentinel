import { ReservationLedger } from "./ledger.js";
import type { Admission, AdmissionRefusalReason, GovernorEventName, GovernorSnapshot, PriceEntry, Reservation, ReservationRequest } from "./types.js";

export interface GovernorConfig {
  budgetUsd: number;
  reservationTtlMs: number;
  reservationSafetyMultiplier: number;
  prices: Readonly<Record<string, PriceEntry>>;
}

const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

/** A single-process serialized governor. All state transitions go through atomic(). */
export class BudgetGovernor {
  private committedExact = 0;
  private committedEstimated = 0;
  private reservedTotal = 0;
  private quarantined = false;
  private readonly reservations = new Map<string, Reservation>();
  private mutexTail: Promise<void> = Promise.resolve();

  constructor(private readonly config: GovernorConfig, private readonly ledger: ReservationLedger) {
    if (config.budgetUsd <= 0) throw new Error("budgetUsd must be positive.");
    if (config.reservationTtlMs <= 0) throw new Error("reservationTtlMs must be positive.");
    if (config.reservationSafetyMultiplier < 1) throw new Error("reservationSafetyMultiplier must be >= 1.");
  }

  async reserve(request: ReservationRequest): Promise<Admission> {
    return this.atomic(async () => {
      const nowMs = request.nowMs ?? Date.now();
      this.expireUnlocked(nowMs);
      if (this.quarantined) return this.refuse("QUARANTINED", request, {});
      if (this.reservations.has(request.attemptId)) return this.refuse("DUPLICATE_ATTEMPT", request, {});
      const price = this.config.prices[request.model];
      if (!price) return this.refuse("MODEL_UNPRICED", request, { model: request.model });
      const baseWorstCase = (request.inputTokens * price.inputPerMillionUsd + request.maxTokens * price.outputPerMillionUsd) / 1_000_000;
      const amountUsd = round(baseWorstCase * this.config.reservationSafetyMultiplier);
      if (this.totalCommitted() + this.reservedTotal + amountUsd > this.config.budgetUsd) {
        return this.refuse("BUDGET_EXCEEDED", request, { amount_usd: amountUsd });
      }
      const reservation: Reservation = {
        attemptId: request.attemptId,
        logicalCallId: request.logicalCallId,
        model: request.model,
        amountUsd,
        expiresAtMs: nowMs + this.config.reservationTtlMs,
        state: "active",
        safetyMultiplier: this.config.reservationSafetyMultiplier
      };
      this.reservations.set(reservation.attemptId, reservation);
      this.reservedTotal = round(this.reservedTotal + amountUsd);
      this.record("RESERVATION_CREATED", reservation, amountUsd, null, {
        model: request.model,
        input_tokens: request.inputTokens,
        max_tokens: request.maxTokens,
        input_per_million_usd: price.inputPerMillionUsd,
        output_per_million_usd: price.outputPerMillionUsd,
        base_worst_case_usd: baseWorstCase,
        reservation_safety_multiplier: this.config.reservationSafetyMultiplier,
        expires_at_ms: reservation.expiresAtMs
      });
      return { admitted: true, reservation };
    });
  }

  async commitExact(attemptId: string, costUsd: number): Promise<boolean> {
    return this.atomic(async () => {
      const reservation = this.reservations.get(attemptId);
      if (!reservation || reservation.state !== "active") return this.rejectLate(attemptId, costUsd, "exact_result_after_reservation_resolution");
      this.closeReservation(reservation);
      this.committedExact = round(this.committedExact + costUsd);
      this.record("COST_COMMITTED", reservation, costUsd, "exact", { cost_source: "exact" });
      if (costUsd > reservation.amountUsd) {
        this.quarantined = true;
        this.record("OVER_RESERVATION", reservation, costUsd - reservation.amountUsd, "exact", {
          exact_cost_usd: costUsd,
          reserved_usd: reservation.amountUsd,
          admissions_quarantined: true
        });
      }
      return true;
    });
  }

  async commitEstimated(attemptId: string, reason: string): Promise<boolean> {
    return this.atomic(async () => {
      const reservation = this.reservations.get(attemptId);
      if (!reservation || reservation.state !== "active") return this.rejectLate(attemptId, null, reason);
      this.closeReservation(reservation);
      this.committedEstimated = round(this.committedEstimated + reservation.amountUsd);
      this.record("COST_COMMITTED", reservation, reservation.amountUsd, "estimated", { cost_source: "estimated", reason });
      return true;
    });
  }

  async expire(nowMs = Date.now()): Promise<void> { await this.atomic(async () => this.expireUnlocked(nowMs)); }

  async finishMission(input: { completed: boolean; reason: string }): Promise<void> {
    await this.atomic(async () => {
      const completed = input.completed && !this.quarantined;
      const event: GovernorEventName = completed ? "MISSION_COMPLETE" : "QUARANTINED_UNPRODUCTIVE";
      if (!completed) this.quarantined = true;
      this.record(event, null, null, null, {
        reason: input.reason,
        mission_completed: completed,
        completion_blocked_by_quarantine: input.completed && !completed,
        active_reservations: [...this.reservations.values()].filter((reservation) => reservation.state === "active").length
      });
    });
  }

  snapshot(): GovernorSnapshot {
    return {
      committedExact: this.committedExact,
      committedEstimated: this.committedEstimated,
      reservedTotal: this.reservedTotal,
      budgetUsd: this.config.budgetUsd,
      quarantined: this.quarantined,
      reservations: new Map(this.reservations)
    };
  }

  private expireUnlocked(nowMs: number): void {
    for (const reservation of this.reservations.values()) {
      if (reservation.state === "active" && reservation.expiresAtMs <= nowMs) {
        reservation.state = "expired";
        this.reservedTotal = round(this.reservedTotal - reservation.amountUsd);
        this.record("RESERVATION_EXPIRED", reservation, reservation.amountUsd, null, { released_amount_usd: reservation.amountUsd, expired_at_ms: nowMs });
      }
    }
  }

  private closeReservation(reservation: Reservation): void {
    reservation.state = "committed";
    this.reservedTotal = round(this.reservedTotal - reservation.amountUsd);
  }

  private rejectLate(attemptId: string, amount: number | null, reason: string): false {
    this.quarantined = true;
    this.record("LATE_RESULT_REJECTED", this.reservations.get(attemptId) ?? null, amount, null, { attempt_id: attemptId, reason, admissions_quarantined: true });
    return false;
  }

  private refuse(reason: AdmissionRefusalReason, request: ReservationRequest, raw: Record<string, unknown>): Admission {
    const event: GovernorEventName = reason === "MODEL_UNPRICED" ? "MODEL_REFUSED" : "BUDGET_REFUSED";
    this.record(event, null, null, null, { reason, attempt_id: request.attemptId, logical_call_id: request.logicalCallId, ...raw });
    return { admitted: false, reason };
  }

  private record(event: GovernorEventName, reservation: Reservation | null, amount: number | null, costSource: "exact" | "estimated" | null, raw: Record<string, unknown>): void {
    this.ledger.append({
      event,
      attempt_id: reservation?.attemptId ?? null,
      logical_call_id: reservation?.logicalCallId ?? null,
      amount_usd: amount,
      committed_exact: this.committedExact,
      committed_estimated: this.committedEstimated,
      reserved_total: this.reservedTotal,
      budget_usd: this.config.budgetUsd,
      cost_source: costSource,
      raw
    });
  }

  private totalCommitted(): number { return round(this.committedExact + this.committedEstimated); }

  private async atomic<T>(operation: () => Promise<T>): Promise<T> {
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const previous = this.mutexTail;
    this.mutexTail = previous.then(() => gate);
    await previous;
    try { return await operation(); } finally { unlock(); }
  }
}
