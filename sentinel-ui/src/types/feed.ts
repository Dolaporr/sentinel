export type AgentType = 'naked' | 'governed-expensive' | 'sentinel' | string;

export type SchemaFeedEventType =
  | 'BALANCE_READ'
  | 'KEY_CREATED'
  | 'INFERENCE_INTENT'
  | 'INFERENCE_CALL'
  | 'KEY_STATUS_READ'
  | 'KEY_REVOKED'
  | 'RECONCILIATION_FAILED'
  | 'RESERVATION_CREATED'
  | 'RESERVATION_EXPIRED'
  | 'COST_COMMITTED'
  | 'MODEL_REFUSED'
  | 'BUDGET_REFUSED'
  | 'OVER_RESERVATION'
  | 'LATE_RESULT_REJECTED'
  | 'MISSION_COMPLETE'
  | 'QUARANTINED_UNPRODUCTIVE';

export type ExtendedFeedEventType =
  | SchemaFeedEventType
  | 'CALL_REFUSED'
  | 'MODEL_ESCALATED'
  | 'LOOP_DETECTED'
  | 'SPEND_VELOCITY_BREACH'
  | 'AGENT_DIED'
  | string;

export interface RawFeedEvent {
  ts: string;
  seq: number;
  event: ExtendedFeedEventType;
  actor?: string;
  agent?: AgentType;
  key_id?: string | null;
  orbio_balance?: number | null;
  orbio_spent?: number | null;
  key_state?: 'active' | 'revoked' | null;
  reason?: string;
  threshold?: number | null;
  raw?: Record<string, any>;
  reservation_id?: string | null;
  logical_call_id?: string | null;
  committed_exact?: number;
  committed_estimated?: number;
  reserved_total?: number;
  cost_source?: 'exact' | 'estimated' | null;
  reservation_safety_multiplier?: number;
  mission_state?: 'complete' | 'quarantined_unproductive' | null;
  committed_total?: number;
  budget_remaining?: number;
  payload?: Record<string, any>;
  [key: string]: any;
}

export interface ParsedEvent extends RawFeedEvent {
  parsedAgent: AgentType;
  timestampMs: number;
  relativeMs: number;
  displayCost?: number;
  humanDescription: string;
  isDecision: boolean;
  isFailure: boolean;
  isDeathTrigger: boolean;
  isCompleteTrigger: boolean;
  isKnownEvent: boolean;
}

export interface AgentRunState {
  agent: AgentType;
  name: string;
  model: string;
  status: 'IDLE' | 'RUNNING' | 'HALTED' | 'COMPLETED';
  initialBudget: number;
  budgetRemaining: number; // Can be negative on overspend!
  committedTotal: number;
  reservedTotal: number;
  callCount: number;
  inFlightIntentCount: number;
  refusalCount: number;
  failureCount: number;
  burnRatePerSec: number;
  isOvershot: boolean;
  overshootAmount: number;
  keyState?: 'active' | 'revoked' | null;
  causeOfDeath?: {
    event: string;
    reason: string;
    threshold?: number;
    value?: number;
    timestampMs: number;
  };
  missionState?: 'complete' | 'quarantined_unproductive' | 'died' | 'running' | null;
  lastEvent?: ParsedEvent;
  eventHistory: ParsedEvent[];
}
