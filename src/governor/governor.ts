import { ReservationLedger } from "./ledger.js";
import type { Admission, AdmissionRefusalReason, CostSource, GovernorEventName, GovernorSnapshot, PriceEntry, Reservation, ReservationRequest } from "./types.js";

export interface GovernorConfig {
  budgetUsd: number;
  reservationTtlMs: number;
  reservationSafetyMultiplier: number;
  maxStepBudgetFraction: number;
  prices: Readonly<Record<string, PriceEntry>>;
  /**
   * How long a resolved (committed or expired) attempt id is remembered.
   * Within this window, reusing the id is refused as DUPLICATE_ATTEMPT, so a
   * late result for the original can never land in a reused slot. After it,
   * the id is forgotten -- a late result is still rejected and quarantines,
   * because an unknown attempt id is rejected exactly like a resolved one.
   * Default: the larger of 10 x reservationTtlMs and one hour.
   */
  resolvedRetentionMs?: number;
}

interface Resolved { reservation: Reservation; resolvedAtMs: number }

const round = (value: number) => Math.round(value * 1_000_000_000) / 1_000_000_000;

/** A single-process serialized governor. All state transitions go through atomic(). */
export class BudgetGovernor {
  private committedExact = 0;
  private committedEstimated = 0;
  private reservedTotal = 0;
  private quarantined = false;
  // In flight only. Admission and expiry touch this map, so their cost is set
  // by concurrency, not by how many calls the process has ever made.
  private readonly active = new Map<string, Reservation>();
  private readonly activeByLogicalCall = new Map<string, string>();
  // Resolved, oldest first (Map keeps insertion order), pruned once past the
  // retention window. Before this, every reservation was kept forever and
  // every reserve() scanned all of them: harmless in a mission, a memory leak
  // and an O(n^2) slowdown in a proxy that runs for weeks.
  private readonly resolved = new Map<string, Resolved>();
  private readonly retentionMs: number;
  private mutexTail: Promise<void> = Promise.resolve();

  constructor(private readonly config: GovernorConfig, private readonly ledger: ReservationLedger) {
    if (config.budgetUsd <= 0) throw new Error("budgetUsd must be positive.");
    if (config.reservationTtlMs <= 0) throw new Error("reservationTtlMs must be positive.");
    if (config.reservationSafetyMultiplier < 1) throw new Error("reservationSafetyMultiplier must be >= 1.");
    if (config.maxStepBudgetFraction <= 0 || config.maxStepBudgetFraction > 1) throw new Error("maxStepBudgetFraction must be in (0, 1].");
    this.retentionMs = config.resolvedRetentionMs ?? Math.max(10 * config.reservationTtlMs, 3_600_000);
    if (!(this.retentionMs > 0)) throw new Error("resolvedRetentionMs must be positive.");
  }

  async reserve(request: ReservationRequest): Promise<Admission> {
    return this.atomic(async () => {
      const nowMs = request.nowMs ?? Date.now();
      this.expireUnlocked(nowMs);
      if (this.quarantined) return this.refuse("QUARANTINED", request, {});
      if (this.active.has(request.attemptId) || this.resolved.has(request.attemptId)) return this.refuse("DUPLICATE_ATTEMPT", request, {});
      if (this.activeByLogicalCall.has(request.logicalCallId)) return this.refuse("LOGICAL_CALL_IN_FLIGHT", request, {});
      const price = this.config.prices[request.model];
      if (!price) return this.refuse("MODEL_UNPRICED", request, { model: request.model });
      const { baseWorstCase, amountUsd } = this.estimateWorstCase(request.model, request.inputTokens, request.maxTokens);
      if (this.totalCommitted() + this.reservedTotal + amountUsd > this.config.budgetUsd) {
        return this.refuse("BUDGET_EXCEEDED", request, { amount_usd: amountUsd });
      }
      const reservation: Reservation = {
        attemptId: request.attemptId,
        logicalCallId: request.logicalCallId,
        model: request.model,
        amountUsd,
        inputTokens: request.inputTokens,
        maxTokens: request.maxTokens,
        inputPerMillionUsd: price.inputPerMillionUsd,
        outputPerMillionUsd: price.outputPerMillionUsd,
        expiresAtMs: nowMs + this.config.reservationTtlMs,
        state: "active",
        safetyMultiplier: this.config.reservationSafetyMultiplier
      };
      this.active.set(reservation.attemptId, reservation);
      this.activeByLogicalCall.set(reservation.logicalCallId, reservation.attemptId);
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

  async commitExact(attemptId: string, costUsd: number, nowMs = Date.now()): Promise<boolean> {
    return this.atomic(async () => {
      this.expireUnlocked(nowMs);
      const reservation = this.active.get(attemptId);
      if (!reservation) return this.rejectLate(attemptId, costUsd, "exact_result_after_reservation_resolution");
      this.closeReservation(reservation, nowMs);
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

  async commitEstimated(attemptId: string, reason: string, outputTokens?: number, nowMs = Date.now()): Promise<boolean> {
    return this.atomic(async () => {
      this.expireUnlocked(nowMs);
      const reservation = this.active.get(attemptId);
      if (!reservation) return this.rejectLate(attemptId, null, reason);
      const estimatedCost = outputTokens === undefined
        ? reservation.amountUsd
        : this.estimateObservedOutput(reservation, outputTokens);
      this.closeReservation(reservation, nowMs);
      this.committedEstimated = round(this.committedEstimated + estimatedCost);
      this.record("COST_COMMITTED", reservation, estimatedCost, "estimated", {
        cost_source: "estimated", reason, estimated_output_tokens: outputTokens ?? null,
        estimated_from_observed_output: outputTokens !== undefined
      });
      return true;
    });
  }

  /**
   * Close a reservation with nothing spent, because the provider refused the
   * call before running it. Not a commit: committed totals do not move, and
   * the event is tagged not_billed, never exact or estimated. A late signal
   * is refused (false) but does not quarantine -- no money is in question.
   */
  async releaseUnbilled(attemptId: string, reason: string, nowMs = Date.now()): Promise<boolean> {
    return this.atomic(async () => {
      this.expireUnlocked(nowMs);
      const reservation = this.active.get(attemptId);
      if (!reservation) {
        this.record("LATE_RESULT_REJECTED", this.resolved.get(attemptId)?.reservation ?? null, 0, null, { attempt_id: attemptId, reason, cost_source: "not_billed", admissions_quarantined: false });
        return false;
      }
      reservation.state = "released";
      this.reservedTotal = round(this.reservedTotal - reservation.amountUsd);
      this.retire(reservation, nowMs);
      this.record("RESERVATION_RELEASED", reservation, 0, "not_billed", { cost_source: "not_billed", reason, released_amount_usd: reservation.amountUsd });
      return true;
    });
  }

  async expire(nowMs = Date.now()): Promise<void> { await this.atomic(async () => this.expireUnlocked(nowMs)); }

  assertStepFitsBudget(input: { model: string; inputTokens: number; maxTokens: number }): void {
    if (!this.config.prices[input.model]) return;
    const { amountUsd } = this.estimateWorstCase(input.model, input.inputTokens, input.maxTokens);
    if (amountUsd > this.config.budgetUsd) {
      throw new Error(`Step worst-case $${amountUsd.toFixed(6)} exceeds mission budget $${this.config.budgetUsd.toFixed(6)}.`);
    }
    const permitted = this.config.budgetUsd * this.config.maxStepBudgetFraction;
    if (amountUsd > permitted) {
      throw new Error(`Step worst-case $${amountUsd.toFixed(6)} exceeds the configured ${(this.config.maxStepBudgetFraction * 100).toFixed(0)}% mission-budget fraction ($${permitted.toFixed(6)}).`);
    }
  }

  async finishMission(input: { completed: boolean; reason: string }): Promise<void> {
    await this.atomic(async () => {
      const completed = input.completed && !this.quarantined;
      const event: GovernorEventName = completed ? "MISSION_COMPLETE" : "QUARANTINED_UNPRODUCTIVE";
      if (!completed) this.quarantined = true;
      this.record(event, null, null, null, {
        reason: input.reason,
        mission_completed: completed,
        completion_blocked_by_quarantine: input.completed && !completed,
        active_reservations: this.active.size
      });
    });
  }

  snapshot(): GovernorSnapshot {
    const active = this.active;
    const resolved = this.resolved;
    return {
      committedExact: this.committedExact,
      committedEstimated: this.committedEstimated,
      reservedTotal: this.reservedTotal,
      budgetUsd: this.config.budgetUsd,
      quarantined: this.quarantined,
      activeReservations: active.size,
      // Built only if read: the proxy takes several snapshots per request and
      // almost never looks at individual reservations.
      get reservations() {
        const all = new Map<string, Reservation>();
        for (const [id, entry] of resolved) all.set(id, entry.reservation);
        for (const [id, reservation] of active) all.set(id, reservation);
        return all;
      }
    };
  }

  private expireUnlocked(nowMs: number): void {
    for (const reservation of this.active.values()) {
      if (reservation.expiresAtMs <= nowMs) {
        reservation.state = "expired";
        this.reservedTotal = round(this.reservedTotal - reservation.amountUsd);
        this.retire(reservation, nowMs);
        this.record("RESERVATION_EXPIRED", reservation, reservation.amountUsd, null, { released_amount_usd: reservation.amountUsd, expired_at_ms: nowMs });
      }
    }
    this.pruneResolved(nowMs);
  }

  private closeReservation(reservation: Reservation, nowMs: number): void {
    reservation.state = "committed";
    this.reservedTotal = round(this.reservedTotal - reservation.amountUsd);
    this.retire(reservation, nowMs);
  }

  /** Active -> resolved. Deleting from a Map while iterating it is safe in JS. */
  private retire(reservation: Reservation, nowMs: number): void {
    this.active.delete(reservation.attemptId);
    if (this.activeByLogicalCall.get(reservation.logicalCallId) === reservation.attemptId) {
      this.activeByLogicalCall.delete(reservation.logicalCallId);
    }
    this.resolved.set(reservation.attemptId, { reservation, resolvedAtMs: nowMs });
  }

  /** Oldest first; stops at the first entry still inside the window. */
  private pruneResolved(nowMs: number): void {
    for (const [attemptId, entry] of this.resolved) {
      if (entry.resolvedAtMs + this.retentionMs > nowMs) break;
      this.resolved.delete(attemptId);
    }
  }

  private rejectLate(attemptId: string, amount: number | null, reason: string): false {
    this.quarantined = true;
    this.record("LATE_RESULT_REJECTED", this.resolved.get(attemptId)?.reservation ?? null, amount, null, { attempt_id: attemptId, reason, admissions_quarantined: true });
    return false;
  }

  private refuse(reason: AdmissionRefusalReason, request: ReservationRequest, raw: Record<string, unknown>): Admission {
    const event: GovernorEventName = reason === "MODEL_UNPRICED" ? "MODEL_REFUSED" : "BUDGET_REFUSED";
    this.record(event, null, null, null, { reason, attempt_id: request.attemptId, logical_call_id: request.logicalCallId, ...raw });
    return { admitted: false, reason };
  }

  private record(event: GovernorEventName, reservation: Reservation | null, amount: number | null, costSource: CostSource | null, raw: Record<string, unknown>): void {
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

  private estimateWorstCase(model: string, inputTokens: number, maxTokens: number): { baseWorstCase: number; amountUsd: number } {
    const price = this.config.prices[model];
    if (!price) throw new Error(`No verified price entry for ${model}.`);
    const baseWorstCase = (inputTokens * price.inputPerMillionUsd + maxTokens * price.outputPerMillionUsd) / 1_000_000;
    return { baseWorstCase, amountUsd: round(baseWorstCase * this.config.reservationSafetyMultiplier) };
  }

  private estimateObservedOutput(reservation: Reservation, outputTokens: number): number {
    const boundedOutput = Math.max(0, Math.min(reservation.maxTokens, outputTokens));
    const base = (reservation.inputTokens * reservation.inputPerMillionUsd + boundedOutput * reservation.outputPerMillionUsd) / 1_000_000;
    return round(base * reservation.safetyMultiplier);
  }

  private async atomic<T>(operation: () => Promise<T>): Promise<T> {
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const previous = this.mutexTail;
    this.mutexTail = previous.then(() => gate);
    await previous;
    try { return await operation(); } finally { unlock(); }
  }
}
