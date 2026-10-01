/**
 * exact: the provider reported what it billed. estimated: Sentinel computed it.
 * not_billed: the provider refused before any inference ran (rejected or
 * unfunded credentials), so nothing was billed -- $0, but inferred from the
 * refusal rather than reported, which is why it is neither of the other two.
 */
export type CostSource = "exact" | "estimated" | "not_billed";

export interface PriceEntry {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  verifiedAt: string;
}

export interface ReservationRequest {
  attemptId: string;
  logicalCallId: string;
  model: string;
  inputTokens: number;
  maxTokens: number;
  nowMs?: number;
}

export type ReservationState = "active" | "expired" | "committed" | "released";

export interface Reservation {
  attemptId: string;
  logicalCallId: string;
  model: string;
  amountUsd: number;
  inputTokens: number;
  maxTokens: number;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  expiresAtMs: number;
  state: ReservationState;
  safetyMultiplier: number;
}

export type GovernorEventName =
  | "RESERVATION_CREATED"
  | "RESERVATION_EXPIRED"
  | "COST_COMMITTED"
  | "RESERVATION_RELEASED"
  | "MODEL_REFUSED"
  | "BUDGET_REFUSED"
  | "OVER_RESERVATION"
  | "LATE_RESULT_REJECTED"
  | "MISSION_COMPLETE"
  | "QUARANTINED_UNPRODUCTIVE";

export interface GovernorEvent {
  ts: string;
  seq: number;
  event: GovernorEventName;
  attempt_id: string | null;
  logical_call_id: string | null;
  amount_usd: number | null;
  committed_exact: number;
  committed_estimated: number;
  reserved_total: number;
  budget_usd: number;
  cost_source: CostSource | null;
  raw: Record<string, unknown>;
}

export interface GovernorSnapshot {
  committedExact: number;
  committedEstimated: number;
  reservedTotal: number;
  budgetUsd: number;
  quarantined: boolean;
  /** Reservations still in flight. */
  activeReservations: number;
  /** In-flight reservations plus resolved ones still inside the retention window. Copied on access. */
  reservations: ReadonlyMap<string, Reservation>;
}

export type AdmissionRefusalReason = "MODEL_UNPRICED" | "BUDGET_EXCEEDED" | "DUPLICATE_ATTEMPT" | "LOGICAL_CALL_IN_FLIGHT" | "QUARANTINED";

export type Admission =
  | { admitted: true; reservation: Reservation }
  | { admitted: false; reason: AdmissionRefusalReason };
